// Remote uplink — the OUTBOUND leg of remote control. Dials the relay over
// ws(s) with a device token, ferries the host<->webview protocol in the frames
// defined in remote-frames.ts, and reconnects with backoff. No inbound port on
// the dev box; the relay pairs this connection with browser clients.
//
// **Authorization boundary.** Every HostMsg that can reach a remote client
// passes through {@link mayDeliverRemoteHostMsg} here, at the socket write —
// including catch-up snapshots. Callers may pre-filter (sidebar `deliverRemote`
// still does, for transform + postTap), but a forgotten pre-filter cannot
// bypass this gate.

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
import { isSelfScopedOutbound, mayDeliverRemoteHostMsg } from "./remote-policy";

/**
 * Live project-scope inputs for the outbound write gate. Re-read on every
 * send so a just-closed folder cannot leak through a stale snapshot of the set.
 */
export interface RemoteUplinkAuth {
  /** Currently authorized session/repo cwds (open folders + worktrees). */
  authorizedCwds: () => readonly string[];
  /**
   * Session/repo cwd that owns conversation payload for this client. Used when
   * the write call does not pass an explicit `scopeCwd` (snapshots, etc.).
   */
  scopeCwdForClient: (clientId: string) => string | undefined;
  /**
   * True when this client may receive a delivery whose payload is scoped to
   * `scopeCwd`. Defaults to sameCwd(scopeCwdForClient(id), scopeCwd) when
   * omitted. Sidebar supplies a richer check (selected repo cwd OR active
   * session cwd) so repo-scoped fan-out still reaches worktree sessions.
   */
  clientOwnsScope?: (clientId: string, scopeCwd: string) => boolean;
  sameCwd: (a: string, b: string) => boolean;
}

/**
 * Recipients that own `scopeCwd`. Pure — unit-tested independently of the socket.
 * When `clientOwnsScope` is absent, ownership is `sameCwd(scopeCwdForClient, scope)`.
 */
export function filterRecipientsOwningScope(
  clientIds: readonly string[],
  scopeCwd: string,
  auth: Pick<RemoteUplinkAuth, "scopeCwdForClient" | "clientOwnsScope" | "sameCwd">,
): string[] {
  const out: string[] = [];
  for (const id of clientIds) {
    if (auth.clientOwnsScope) {
      if (auth.clientOwnsScope(id, scopeCwd)) out.push(id);
      continue;
    }
    const owned = auth.scopeCwdForClient(id);
    if (owned !== undefined && auth.sameCwd(owned, scopeCwd)) out.push(id);
  }
  return out;
}

/**
 * Typed delivery target for a host→client write. Callers still name recipients
 * and (when project-scoped) the originating scope; the uplink derives nothing
 * from a free-form cwd alone — it re-filters recipients to owners of that scope
 * and re-checks {@link mayDeliverRemoteHostMsg}.
 *
 * What remains caller-supplied: the client id list and the scope string. A later
 * pass could replace both with session/repo handles only.
 */
export interface RemoteDeliveryTarget {
  clientIds: readonly string[];
  /** Project scope that owns the payload; omit for device-global messages. */
  scopeCwd?: string;
}

export interface RemoteUplinkOptions {
  /** ws(s)://relay-host[:port] — the relay's base URL. */
  relayUrl: string;
  /** Long-lived device token from the link flow. */
  token: string;
  deviceName?: string;
  /** Ordered catch-up (already remote-transformed) for a newly-ready browser client. */
  snapshot: (clientId: string) => HostMsg[];
  /**
   * Project authorization for every outbound HostMsg. Required — without it
   * the uplink refuses to send (fail closed).
   */
  auth: RemoteUplinkAuth;
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

/**
 * Filter HostMsgs through the project-scope gate. Pure helper — also the unit-
 * test surface for "snapshot carrying closed-project data is scrubbed".
 */
export function filterAuthorizedOutbound(
  msgs: readonly HostMsg[],
  authorizedCwds: readonly string[],
  scopeCwd: string | undefined,
  sameCwd: (a: string, b: string) => boolean,
): HostMsg[] {
  return msgs.filter((msg) =>
    mayDeliverRemoteHostMsg(msg, authorizedCwds, scopeCwd, sameCwd),
  );
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
  broadcast(msg: HostMsg, scopeCwd?: string): void {
    if (!this.authorizeWrite(msg, scopeCwd)) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(hostFrame(msg)));
      } catch {
        /* teardown race; reconnect handles it */
      }
    }
  }

  /**
   * Send one host message only to the named browser clients.
   * Prefer {@link deliver} with a {@link RemoteDeliveryTarget}; this overload
   * keeps existing call sites.
   */
  broadcastTo(clientIds: string[], msg: HostMsg, scopeCwd?: string): void {
    this.deliver({ clientIds, scopeCwd }, msg);
  }

  /**
   * Socket write with a typed delivery target. When `scopeCwd` is set, every
   * recipient must own that scope ({@link filterRecipientsOwningScope}); the
   * message is then gated with {@link mayDeliverRemoteHostMsg} for that scope.
   * Callers cannot widen delivery to tabs that merely share an authorized cwd
   * set — ownership is per-client.
   */
  deliver(target: RemoteDeliveryTarget, msg: HostMsg): void {
    const unique = [...new Set(target.clientIds)];
    if (!unique.length || this.ws?.readyState !== WebSocket.OPEN) return;
    // A frame that names its own project (`repoSessions`, `sessionName`) is
    // ABOUT that project, not payload from the recipient's conversation, so the
    // ownership filter below must not see it: the rail asks about a sibling
    // project by design and every answer was being dropped as "does not own
    // scope". authorizeWrite still checks the frame's own cwd against the live
    // authorized set, so this widens delivery, never authorization.
    const scopeCwd = isSelfScopedOutbound(msg.type) ? undefined : target.scopeCwd;

    if (scopeCwd !== undefined) {
      const owners = filterRecipientsOwningScope(unique, scopeCwd, this.opts.auth);
      for (const id of unique) {
        if (!owners.includes(id)) {
          this.opts.log(
            `[remote] dropped ${msg.type} for client ${id} (does not own scope: ${scopeCwd})`,
          );
        }
      }
      if (!owners.length) return;
      if (!this.authorizeWrite(msg, scopeCwd)) return;
      try {
        this.ws.send(JSON.stringify(hostToFrame(owners, msg)));
      } catch {
        /* teardown race; reconnect handles it */
      }
      return;
    }

    // No explicit scope: authorize each client against its own scope so a
    // multi-tab send cannot borrow another tab's open project.
    if (unique.length === 1) {
      const scope = this.opts.auth.scopeCwdForClient(unique[0]);
      if (!this.authorizeWrite(msg, scope)) return;
      try {
        this.ws.send(JSON.stringify(hostToFrame(unique, msg)));
      } catch {
        /* teardown race; reconnect handles it */
      }
      return;
    }
    const allowed: string[] = [];
    for (const id of unique) {
      const scope = this.opts.auth.scopeCwdForClient(id);
      if (this.authorizeWrite(msg, scope, /* silent */ true)) allowed.push(id);
      else {
        this.opts.log(
          `[remote] dropped ${msg.type} for client ${id} (project scope not authorized: ${scope ?? "<none>"})`,
        );
      }
    }
    if (!allowed.length) return;
    try {
      this.ws.send(JSON.stringify(hostToFrame(allowed, msg)));
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

  /**
   * Sole authorization check before any HostMsg is serialized onto the socket.
   * Returns false when the message must not leave.
   */
  private authorizeWrite(
    msg: HostMsg,
    scopeCwd: string | undefined,
    silent = false,
  ): boolean {
    const authorized = this.opts.auth.authorizedCwds();
    if (mayDeliverRemoteHostMsg(msg, authorized, scopeCwd, this.opts.auth.sameCwd)) {
      return true;
    }
    if (!silent) {
      this.opts.log(
        `[remote] dropped ${msg.type} (project scope not authorized: ${scopeCwd ?? "<none>"})`,
      );
    }
    return false;
  }

  private authorizedSnapshot(clientId: string, msgs: readonly HostMsg[]): HostMsg[] {
    const scope = this.opts.auth.scopeCwdForClient(clientId);
    const authorized = this.opts.auth.authorizedCwds();
    const kept = filterAuthorizedOutbound(
      msgs,
      authorized,
      scope,
      this.opts.auth.sameCwd,
    );
    if (kept.length < msgs.length) {
      const dropped = msgs.length - kept.length;
      this.opts.log(
        `[remote] scrubbed ${dropped} snapshot message(s) for ${clientId} (project scope not authorized: ${scope ?? "<none>"})`,
      );
    }
    return kept;
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
          // Authorization runs HERE on the snapshot payload — the only path that
          // does not go through broadcast/broadcastTo.
          try {
            this.opts.onClientReady?.(frame.clientId, frame.tabToken);
            const rawSnap = this.opts.snapshot(frame.clientId);
            const msgs = this.authorizedSnapshot(frame.clientId, rawSnap);
            ws.send(JSON.stringify(snapshotFrame(frame.clientId, msgs)));
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
