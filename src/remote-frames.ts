// Extension <-> relay wire contract (Phase 1, topology B — the extension dials
// OUT to a relay; browsers connect to the same relay; the relay ferries the
// existing HostMsg/WebviewMsg protocol between them).
//
// Pure: types + parse/build helpers only, unit-testable grok-free. The relay
// repo keeps its own mirror of these frame shapes — the contract is these
// little envelopes, deliberately tiny so the mirror can't drift far. Browsers
// speak raw HostMsg/WebviewMsg JSON (the Phase-0 shim unchanged); only the
// extension<->relay leg wraps them in frames so the relay can route per client.

import type { HostMsg, WebviewMsg } from "./protocol";

/** Bump when a frame shape changes incompatibly. The relay refuses a mismatched
 *  hello rather than mis-parsing — clients and extensions update independently. */
export const REMOTE_PROTO_VERSION = 1;

/** extension -> relay */
export type UplinkFrame =
  | { t: "hello"; proto: number; device?: { name?: string } }
  | { t: "host"; msg: HostMsg }
  | { t: "snapshot"; clientId: string; msgs: HostMsg[] };

/** relay -> extension */
export type RelayFrame =
  | { t: "client-ready"; clientId: string }
  | { t: "msg"; clientId: string; msg: WebviewMsg }
  | { t: "clients"; count: number };

export function helloFrame(deviceName?: string): UplinkFrame {
  return { t: "hello", proto: REMOTE_PROTO_VERSION, ...(deviceName ? { device: { name: deviceName } } : {}) };
}

export function hostFrame(msg: HostMsg): UplinkFrame {
  return { t: "host", msg };
}

export function snapshotFrame(clientId: string, msgs: HostMsg[]): UplinkFrame {
  return { t: "snapshot", clientId, msgs };
}

/** Parse + shape-validate a relay->extension frame. null = drop (never throw). */
export function parseRelayFrame(raw: string): RelayFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const f = obj as Record<string, unknown>;
  switch (f.t) {
    case "client-ready":
      return typeof f.clientId === "string" ? { t: "client-ready", clientId: f.clientId } : null;
    case "msg":
      if (typeof f.clientId !== "string") return null;
      if (typeof f.msg !== "object" || f.msg === null || typeof (f.msg as { type?: unknown }).type !== "string") return null;
      return { t: "msg", clientId: f.clientId, msg: f.msg as WebviewMsg };
    case "clients":
      return typeof f.count === "number" ? { t: "clients", count: f.count } : null;
    default:
      return null;
  }
}

/** The relay the extension talks to. Fixed in code on purpose — the pairing
 *  flow, the web portal, and the gear "AFK Pilot" section all assume this one
 *  service, so there is no user setting; change it here (and rebuild) to point
 *  a local build elsewhere (e.g. the staging relay for testing). */
export const REMOTE_RELAY_URL = "wss://afkpilot.com";

/** ws(s)://relay[/base] + device token -> the uplink endpoint URL. */
export function buildUplinkUrl(relayUrl: string, token: string): string {
  return `${relayUrl.replace(/\/+$/, "")}/uplink?token=${encodeURIComponent(token)}`;
}

/** ws(s)://relay -> http(s)://relay, for the REST link endpoints + browser pages. */
export function httpBaseFromRelayUrl(relayUrl: string): string {
  return relayUrl.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:").replace(/\/+$/, "");
}

/** "Dell (Windows 11)" — how this machine introduces itself to the relay
 *  (shown on the link-approval page and the portal's device list). Hostname +
 *  a human OS label; the workspace path deliberately stays out of it. */
export function deviceDisplayName(hostname: string, platform: string, release: string): string {
  let os: string;
  if (platform === "win32") {
    // Windows 11 reports kernel 10.0.22000+; Windows 10 stays below.
    const build = Number(release.split(".")[2] ?? "0");
    os = build >= 22000 ? "Windows 11" : "Windows 10";
  } else if (platform === "darwin") {
    os = "macOS";
  } else if (platform === "linux") {
    os = "Linux";
  } else {
    os = platform;
  }
  return hostname ? `${hostname} (${os})` : os;
}

export const INITIAL_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;

/** Reconnect backoff: double up to the cap. */
export function nextBackoffMs(prev: number): number {
  return Math.min(Math.max(prev, INITIAL_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
}
