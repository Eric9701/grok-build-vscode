// Extension <-> relay wire contract (Phase 1, topology B — the extension dials
// OUT to a relay; browsers connect to the same relay; the relay ferries the
// existing HostMsg/WebviewMsg protocol between them).
//
// Pure: types + parse/build helpers only, unit-testable grok-free. The relay
// repo keeps its own mirror of these frame shapes — the contract is these
// little envelopes, deliberately tiny so the mirror can't drift far. Browsers
// speak raw HostMsg/WebviewMsg JSON (the Phase-0 shim unchanged); only the
// extension<->relay leg wraps them in frames so the relay can route per client.

import { WEBVIEW_MESSAGE_TYPES, type HostMsg, type WebviewMsg } from "./protocol";

/** Bump when a frame shape changes incompatibly. The relay refuses a mismatched
 *  hello rather than mis-parsing — clients and extensions update independently. */
export const REMOTE_PROTO_VERSION = 1;

/** extension -> relay */
export type UplinkFrame =
  | { t: "hello"; proto: number; device?: { name?: string } }
  | { t: "host"; msg: HostMsg }
  | { t: "host-to"; clientIds: string[]; msg: HostMsg }
  | { t: "snapshot"; clientId: string; msgs: HostMsg[] };

/** relay -> extension */
export type RelayFrame =
  | { t: "client-ready"; clientId: string; tabToken?: string }
  | { t: "client-left"; clientId: string }
  | { t: "msg"; clientId: string; msg: WebviewMsg }
  | { t: "clients"; count: number };

export function helloFrame(deviceName?: string): UplinkFrame {
  return { t: "hello", proto: REMOTE_PROTO_VERSION, ...(deviceName ? { device: { name: deviceName } } : {}) };
}

export function hostFrame(msg: HostMsg): UplinkFrame {
  return { t: "host", msg };
}

export function hostToFrame(clientIds: string[], msg: HostMsg): UplinkFrame {
  return { t: "host-to", clientIds, msg };
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
      if (typeof f.clientId !== "string") return null;
      if (
        f.tabToken !== undefined &&
        (typeof f.tabToken !== "string" || !REMOTE_TAB_TOKEN_RE.test(f.tabToken))
      ) return null;
      return {
        t: "client-ready",
        clientId: f.clientId,
        ...(f.tabToken !== undefined ? { tabToken: f.tabToken } : {}),
      };
    case "client-left":
      return typeof f.clientId === "string" ? { t: "client-left", clientId: f.clientId } : null;
    case "msg":
      if (typeof f.clientId !== "string") return null;
      {
        const msg = parseRemoteWebviewMsg(f.msg);
        return msg ? { t: "msg", clientId: f.clientId, msg } : null;
      }
    case "clients":
      return typeof f.count === "number" ? { t: "clients", count: f.count } : null;
    default:
      return null;
  }
}

const WEBVIEW_TYPE_SET = new Set<string>(WEBVIEW_MESSAGE_TYPES);
const REMOTE_TAB_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const REMOTE_SUBMISSION_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const REMOTE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REMOTE_UPLOAD_NAME_RE = /^[^/\\\0-\x1f\x7f]{1,240}$/;
const REMOTE_UPLOAD_EXTENSION_RE = /\.(?:md|txt|pdf|csv|xlsx|docx)$/i;

function pathSegments(value: string): string[] {
  return value.split(/[\\/]/);
}

function hasOnlyConcretePathSegments(value: string): boolean {
  return pathSegments(value).every((part) => part !== "." && part !== "..");
}

function isRemoteCwd(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    /[\0-\x1f\x7f]/.test(value) ||
    !hasOnlyConcretePathSegments(value)
  ) return false;
  return value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function isRemoteSessionId(value: unknown): value is string {
  return typeof value === "string" &&
    REMOTE_SESSION_ID_RE.test(value) &&
    value !== "__proto__" &&
    value !== "prototype" &&
    value !== "constructor";
}

function isRemoteMentionPath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    !/[\0-\x1f\x7f]/.test(value) &&
    pathSegments(value).every((part) => !!part && part !== "." && part !== "..");
}

function isRemoteUploadName(value: unknown): value is string {
  return typeof value === "string" &&
    REMOTE_UPLOAD_NAME_RE.test(value) &&
    REMOTE_UPLOAD_EXTENSION_RE.test(value);
}

function parseRemoteWebviewMsg(msg: unknown): WebviewMsg | null {
  if (typeof msg !== "object" || msg === null) return null;
  const value = msg as Record<string, unknown>;
  if (typeof value.type !== "string" || !WEBVIEW_TYPE_SET.has(value.type)) return null;
  switch (value.type) {
    case "ready":
      return value.tabToken === undefined
        ? { type: "ready" }
        : (
        typeof value.tabToken === "string" &&
        REMOTE_TAB_TOKEN_RE.test(value.tabToken)
          ? { type: "ready", tabToken: value.tabToken }
          : null
        );
    case "send": {
      if (typeof value.text !== "string") return null;
      if (value.bare !== undefined && typeof value.bare !== "boolean") return null;
      if (
        value.queuedSendId !== undefined &&
        (typeof value.queuedSendId !== "string" ||
          !REMOTE_SUBMISSION_ID_RE.test(value.queuedSendId))
      ) return null;
      if (
        value.submissionId !== undefined &&
        (typeof value.submissionId !== "string" ||
          !REMOTE_TAB_TOKEN_RE.test(value.submissionId))
      ) return null;
      // Reconstruct this newly-extended payload instead of passing the remote
      // object wholesale. That keeps future send fields outside the host until
      // this boundary explicitly validates and copies them.
      return {
        type: "send",
        text: value.text,
        ...(value.bare !== undefined ? { bare: value.bare } : {}),
        ...(value.queuedSendId !== undefined ? { queuedSendId: value.queuedSendId } : {}),
        ...(value.submissionId !== undefined ? { submissionId: value.submissionId } : {}),
      };
    }
    case "selectRepo":
    case "clearAllSessions":
      return isRemoteCwd(value.cwd) ? msg as WebviewMsg : null;
    case "toggleRepoPin":
      return isRemoteCwd(value.cwd) && typeof value.pinned === "boolean"
        ? msg as WebviewMsg
        : null;
    case "resumeSession":
      return isRemoteSessionId(value.id) &&
        (value.cwd === undefined || isRemoteCwd(value.cwd))
        ? msg as WebviewMsg
        : null;
    case "renameSession":
    case "deleteSession":
      return isRemoteSessionId(value.id) ? msg as WebviewMsg : null;
    case "addMentionFile":
      return isRemoteMentionPath(value.relPath) ? msg as WebviewMsg : null;
    case "uploadFile":
      return isRemoteUploadName(value.name) ? msg as WebviewMsg : null;
    case "exitPlanAnswer": {
      const validRequestId = typeof value.requestId === "string" || typeof value.requestId === "number";
      if (
        !validRequestId ||
        (value.verdict !== "approved" && value.verdict !== "abandoned" && value.verdict !== "rejected")
      ) return null;
      if (value.comment !== undefined && typeof value.comment !== "string") return null;
      return {
        type: "exitPlanAnswer",
        requestId: value.requestId as number | string,
        verdict: value.verdict,
        ...(value.comment !== undefined ? { comment: value.comment } : {}),
      };
    }
    default:
      return msg as WebviewMsg;
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
