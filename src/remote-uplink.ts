// Remote uplink — the OUTBOUND leg of remote control. Dials the relay over
// ws(s) with a device token, ferries the host<->webview protocol in the frames
// defined in remote-frames.ts, and reconnects with backoff. No inbound port on
// the dev box; the relay pairs this connection with browser clients. The
// sidebar owns the policy gate; this module is pure transport.

import WebSocket from "ws";
import type { HostMsg, WebviewMsg } from "./protocol";
import {
  buildUplinkUrl,
  helloFrame,
  hostFrame,
  hostToFrame,
  snapshotFrame,
  parseRelayFrame,
  nextBackoffMs,
  INITIAL_BACKOFF_MS,
} from "./remote-frames";

export interface RemoteUplinkOptions {
  /** ws(s)://relay-host[:port] — the relay's base URL. */
  relayUrl: string;
  /** Long-lived device token from the link flow. */
  token: string;
  deviceName?: string;
  /** Ordered catch-up (already remote-transformed) for a newly-ready browser client. */
  snapshot: (clientId: string) => HostMsg[];
  /** A browser connection is ready to receive its client-specific snapshot. */
  onClientReady?: (clientId: string, tabToken?: string) => void;
  /** A specific browser connection has left the relay. */
  onClientLeft?: (clientId: string) => void;
  /** Authoritative surviving-client roster replayed after each uplink connect. */
  onClientRoster?: (clientIds: string[]) => void;
  /** The relay authoritatively rejected this device credential (close 4001). */
  onCredentialRevoked?: () => void;
  /** A browser client's webview->host message (already relayed + parsed). */
  onClientMessage: (clientId: string, msg: WebviewMsg) => void;
  log: (line: string) => void;
}

export class RemoteUplink {
  private ws?: WebSocket;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer?: NodeJS.Timeout;
  private disposed = false;
  private awaitingRosterCount = false;
  private reconnectRoster?: { expected: number; clientIds: Set<string> };

  constructor(private readonly opts: RemoteUplinkOptions) {}

  start(): void {
    this.connect();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Fan a host->webview message out to the relay (which broadcasts to this
   *  device's browser clients). Silently dropped while disconnected — a
   *  reconnecting client re-syncs via its own `ready` -> snapshot. */
  broadcast(msg: HostMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(hostFrame(msg)));
      } catch {
        /* teardown race; reconnect handles it */
      }
    }
  }

  /** Send one host message only to the named browser clients. */
  broadcastTo(clientIds: string[], msg: HostMsg): void {
    if (!clientIds.length || this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(hostToFrame([...new Set(clientIds)], msg)));
    } catch {
      /* teardown race; reconnect handles it */
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    try {
      this.ws?.close();
    } catch {
      /* best effort */
    }
    this.ws = undefined;
  }

  private connect(): void {
    if (this.disposed) return;
    const url = buildUplinkUrl(this.opts.relayUrl, this.opts.token);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.awaitingRosterCount = true;
      this.reconnectRoster = undefined;
      this.opts.log(`[remote] uplink connected to ${this.opts.relayUrl}`);
      ws.send(JSON.stringify(helloFrame(this.opts.deviceName)));
    });
    ws.on("message", (raw) => {
      const frame = parseRelayFrame(raw.toString());
      if (!frame) return;
      switch (frame.t) {
        case "client-ready":
          // The relay-side twin of the LAN bridge's ready->snapshot: catch this
          // one browser client up, routed back through the relay by clientId.
          try {
            this.opts.onClientReady?.(frame.clientId, frame.tabToken);
            ws.send(JSON.stringify(snapshotFrame(frame.clientId, this.opts.snapshot(frame.clientId))));
          } catch {
            /* teardown race */
          }
          if (this.reconnectRoster) {
            this.reconnectRoster.clientIds.add(frame.clientId);
            this.finishRosterIfComplete();
          }
          return;
        case "msg":
          try {
            this.opts.onClientMessage(frame.clientId, frame.msg);
          } catch (e) {
            this.opts.log(`[remote] dropped malformed client message: ${(e as Error)?.message ?? String(e)}`);
          }
          return;
        case "client-left":
          this.opts.onClientLeft?.(frame.clientId);
          this.reconnectRoster?.clientIds.delete(frame.clientId);
          return;
        case "clients":
          this.opts.log(`[remote] relay clients: ${frame.count}`);
          if (this.awaitingRosterCount) {
            this.awaitingRosterCount = false;
            this.reconnectRoster = { expected: frame.count, clientIds: new Set() };
          } else if (this.reconnectRoster) {
            this.reconnectRoster.expected = frame.count;
          }
          this.finishRosterIfComplete();
          return;
      }
    });
    ws.on("close", (code) => {
      if (this.disposed) return;
      // 4001 = relay rejected the token — retrying with the same token is
      // pointless; the user must re-link. Stop, loudly.
      if (code === 4001) {
        this.opts.log(`[remote] uplink rejected (revoked device token) — run "AFK Pilot: Link this device" again`);
        try {
          this.opts.onCredentialRevoked?.();
        } catch (e) {
          this.opts.log(`[remote] failed to handle revoked credential: ${(e as Error)?.message ?? String(e)}`);
        }
        return;
      }
      this.opts.log(`[remote] uplink disconnected (code ${code}); retrying in ${Math.round(this.backoff / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = nextBackoffMs(this.backoff);
    });
    ws.on("error", (e) => {
      this.opts.log(`[remote] uplink error: ${(e as Error).message}`);
      try {
        ws.close();
      } catch {
        /* triggers the close handler's retry */
      }
    });
  }

  private finishRosterIfComplete(): void {
    const roster = this.reconnectRoster;
    if (!roster || roster.clientIds.size < roster.expected) return;
    this.reconnectRoster = undefined;
    this.opts.onClientRoster?.([...roster.clientIds]);
  }
}
