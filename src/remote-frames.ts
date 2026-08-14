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

/** Optional richer-device fields on hello / link/start. */
export type RelayClientMeta = {
  clientLabel?: string;
  platform?: "win" | "mac" | "linux";
  osLabel?: string;
};

/** Inputs shared by `buildLinkStartBody` and `helloFrame` for client metadata. */
export type RelayClientSource = {
  platform: string;
  release: string;
  appName: string;
  isDesktop: boolean;
};

/** extension -> relay */
export type UplinkFrame =
  | { t: "hello"; proto: number; device?: { name?: string }; client?: RelayClientMeta }
  | { t: "host"; msg: HostMsg }
  | { t: "host-to"; clientIds: string[]; msg: HostMsg }
  | { t: "snapshot"; clientId: string; msgs: HostMsg[] };

/** relay -> extension */
export type RelayFrame =
  | { t: "client-ready"; clientId: string; tabToken?: string }
  | { t: "client-left"; clientId: string }
  | { t: "msg"; clientId: string; msg: WebviewMsg }
  | { t: "clients"; count: number };

export function helloFrame(deviceName?: string, clientSource?: RelayClientSource): UplinkFrame {
  const client = clientSource ? relayClientMeta(clientSource) : undefined;
  const hasClient = !!client && !!(client.clientLabel || client.platform || client.osLabel);
  return {
    t: "hello",
    proto: REMOTE_PROTO_VERSION,
    ...(deviceName ? { device: { name: deviceName } } : {}),
    ...(hasClient ? { client } : {}),
  };
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
    case "remotePreferences":
      if (
        typeof value.fontScale !== "number" ||
        !Number.isFinite(value.fontScale) ||
        value.fontScale < 80 ||
        value.fontScale > 160 ||
        typeof value.readRepliesAloud !== "boolean" ||
        (value.summarizeRepliesAloud !== undefined && typeof value.summarizeRepliesAloud !== "boolean") ||
        typeof value.usesTouch !== "boolean"
      ) return null;
      return {
        type: "remotePreferences",
        fontScale: value.fontScale,
        readRepliesAloud: value.readRepliesAloud,
        ...(value.summarizeRepliesAloud !== undefined
          ? { summarizeRepliesAloud: value.summarizeRepliesAloud }
          : {}),
        usesTouch: value.usesTouch,
      };
    case "summarizeSpeech":
      return Number.isSafeInteger(value.requestId) && typeof value.text === "string"
        ? { type: "summarizeSpeech", requestId: value.requestId as number, text: value.text }
        : null;
    case "requestImageFull":
      // Shape-check only; the host still has to recognise the handle. This just
      // keeps anything path-like from reaching that lookup in the first place.
      return typeof value.fullId === "string" && REMOTE_TAB_TOKEN_RE.test(value.fullId)
        ? { type: "requestImageFull", fullId: value.fullId }
        : null;
    case "selectRepo":
    case "clearAllSessions":
      return isRemoteCwd(value.cwd) ? msg as WebviewMsg : null;
    case "toggleRepoPin":
      return isRemoteCwd(value.cwd) && typeof value.pinned === "boolean"
        ? msg as WebviewMsg
        : null;
    case "setRepoArchived":
      return isRemoteCwd(value.cwd) && typeof value.archived === "boolean"
        ? msg as WebviewMsg
        : null;
    case "setRepoColor":
      // Shape only: the host still allowlists the colour id and re-checks the
      // cwd against the live catalog. Empty string is a valid "none".
      return isRemoteCwd(value.cwd) && typeof value.color === "string"
        ? msg as WebviewMsg
        : null;
    // Shape-checked here like its repo-level sibling rather than riding the
    // `default` passthrough: the host validates too, but a malformed message
    // that reaches the host has already crossed the boundary this parser exists
    // to hold. `cwd` is optional — the host falls back to its own lookup.
    case "toggleSessionPin":
      return isRemoteSessionId(value.id) &&
        typeof value.pinned === "boolean" &&
        (value.cwd === undefined || isRemoteCwd(value.cwd))
        ? msg as WebviewMsg
        : null;
    case "resumeSession":
      return isRemoteSessionId(value.id) &&
        (value.cwd === undefined || isRemoteCwd(value.cwd))
        ? msg as WebviewMsg
        : null;
    case "renameSession":
    case "deleteSession":
      // cwd is optional and, when present, must look like a repo path. The host
      // still matches it against its OWN catalog before acting, so this only
      // keeps obvious rubbish off the wire.
      return isRemoteSessionId(value.id) &&
        (value.cwd === undefined || isRemoteCwd(value.cwd))
        ? msg as WebviewMsg
        : null;
    case "addMentionFile":
      return isRemoteMentionPath(value.relPath) ? msg as WebviewMsg : null;
    // Project browse/save. cwd must look like a catalog path; relPath must be
    // relative (or empty for the repo root on list). Host still runs
    // resolveRemoteFileRoot + resolveTreePath — this only keeps garbage off the wire.
    case "listProjectDir":
      return isRemoteCwd(value.cwd) &&
        (value.relPath === undefined ||
          value.relPath === "" ||
          isRemoteMentionPath(value.relPath))
        ? msg as WebviewMsg
        : null;
    case "readProjectFile":
      return isRemoteCwd(value.cwd) && isRemoteMentionPath(value.relPath)
        ? msg as WebviewMsg
        : null;
    case "writeProjectFile": {
      // Existing-file save only: stamp + expectedAbsPath are mandatory so the
      // host can refuse a stale tab or a cross-project relPath collision.
      if (!isRemoteCwd(value.cwd) || !isRemoteMentionPath(value.relPath)) return null;
      if (typeof value.text !== "string") return null;
      if (!isRemoteCwd(value.expectedAbsPath)) return null;
      const stamp = value.stamp;
      if (
        !stamp ||
        typeof stamp !== "object" ||
        typeof (stamp as { mtimeMs?: unknown }).mtimeMs !== "number" ||
        !Number.isFinite((stamp as { mtimeMs: number }).mtimeMs) ||
        typeof (stamp as { size?: unknown }).size !== "number" ||
        !Number.isFinite((stamp as { size: number }).size)
      ) {
        return null;
      }
      return msg as WebviewMsg;
    }
    case "uploadFile":
      return isRemoteUploadName(value.name) ? msg as WebviewMsg : null;
    case "pasteImage":
      if (typeof value.mimeType !== "string" || typeof value.data !== "string") return null;
      if (
        value.previewId !== undefined &&
        (typeof value.previewId !== "string" || !REMOTE_TAB_TOKEN_RE.test(value.previewId))
      ) return null;
      return {
        type: "pasteImage",
        mimeType: value.mimeType,
        data: value.data,
        ...(value.previewId !== undefined ? { previewId: value.previewId } : {}),
      };
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
 *  service, so there is no user SETTING. A development build can override it
 *  (see {@link resolveRelayUrl}); a published one never can. */
export const REMOTE_RELAY_URL = "wss://afkpilot.com";

/** Environment variable a DEVELOPMENT build reads instead of the constant. */
export const RELAY_URL_ENV = "GROK_RELAY_URL";

/**
 * The relay this build should actually use.
 *
 * Production ignores the environment entirely: a packaged desktop app
 * (`app.isPackaged`) and a published extension (`ExtensionMode.Production`) are
 * both production, so nobody running a real build can be talked into pointing
 * their client — and their linked device token — at someone else's relay. That
 * is the whole reason there is no user setting, and the gate here is what keeps
 * it true while still letting a build run from source reach staging.
 *
 * The alternative was editing the constant and remembering to change it back,
 * which is how a staging URL reached the public repo once already.
 *
 * Anything malformed falls back to the constant rather than throwing: a typo in
 * a shell variable should cost you a staging session, not a working client.
 */
export function resolveRelayUrl(opts: {
  isProduction: boolean;
  env?: Record<string, string | undefined>;
}): string {
  if (opts.isProduction) return REMOTE_RELAY_URL;
  const raw = (opts.env ?? {})[RELAY_URL_ENV];
  if (typeof raw !== "string") return REMOTE_RELAY_URL;
  const trimmed = raw.trim();
  // Empty authority, before parsing. ws is a special scheme, so the URL parser
  // resolves `wss:///relay` to host `relay` — it silently promotes the first
  // path segment to a hostname. Falling back is the honest reading of a value
  // that named no host, and it keeps this function's rule ("an authority is
  // required") true rather than nearly true.
  if (/^wss?:\/\/\//i.test(trimmed)) return REMOTE_RELAY_URL;
  // Parsed, not pattern-matched. A prefix test waves through authorities the
  // URL parser rejects (`wss://relay.test:bad`), and that value reaches
  // `new WebSocket()` in remote-uplink and throws synchronously — the opposite
  // of the fallback promised above.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return REMOTE_RELAY_URL;
  }
  // ws/wss only: any other scheme would send a device token somewhere it
  // cannot go. An authority is required — `wss://` alone names nothing.
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return REMOTE_RELAY_URL;
  if (!parsed.host) return REMOTE_RELAY_URL;
  // Credentials in the URL would be logged wherever the relay URL is logged.
  if (parsed.username || parsed.password) return REMOTE_RELAY_URL;
  // No query or fragment. Callers append `/uplink` and `/api/…` to this value,
  // so `wss://relay.test?x=1` would build `wss://relay.test?x=1/uplink` — a dead
  // endpoint that reads like the relay is down rather than like a bad variable.
  if (parsed.search || parsed.hash) return REMOTE_RELAY_URL;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
}

/**
 * A relay URL reduced to what is safe to write into a log: scheme and host.
 *
 * Everything that logs a relay URL goes through this. A base path is accepted
 * by {@link resolveRelayUrl} (a relay can live behind a prefix), so the path may
 * carry something the owner would not want in an output channel or in a pasted
 * terminal dump — and scheme plus host already answers the only question a log
 * line is asked here, which is *which relay is this*.
 */
export function redactRelayUrl(relayUrl: string): string {
  try {
    const u = new URL(String(relayUrl).trim());
    if (u.host) return `${u.protocol}//${u.host}`;
  } catch {
    /* fall through */
  }
  return "(unparseable relay url)";
}

/** ws(s)://relay[/base] + device token -> the uplink endpoint URL. */
export function buildUplinkUrl(relayUrl: string, token: string): string {
  return `${relayUrl.replace(/\/+$/, "")}/uplink?token=${encodeURIComponent(token)}`;
}

/** ws(s)://relay -> http(s)://relay, for the REST link endpoints + browser pages. */
export function httpBaseFromRelayUrl(relayUrl: string): string {
  return relayUrl.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:").replace(/\/+$/, "");
}

/** OS string embedded in the legacy device name ("Windows 11", "macOS", …). */
export function deviceOsLabel(platform: string, release: string): string {
  if (platform === "win32") {
    // Windows 11 reports kernel 10.0.22000+; Windows 10 stays below.
    const build = Number(release.split(".")[2] ?? "0");
    return build >= 22000 ? "Windows 11" : "Windows 10";
  }
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

/** "Dell (Windows 11)" — how this machine introduces itself to the relay
 *  (shown on the link-approval page and the portal's device list). Hostname +
 *  a human OS label; the workspace path deliberately stays out of it. */
export function deviceDisplayName(hostname: string, platform: string, release: string): string {
  const os = deviceOsLabel(platform, release);
  return hostname ? `${hostname} (${os})` : os;
}

/** Coarse platform token the relay's richer device rows accept. */
export function devicePlatformCode(platform: string): "win" | "mac" | "linux" | undefined {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  return undefined;
}

/** Client product label for richer device rows. Desktop is never derived
 *  from `appName` — the desktop host's name would otherwise become
 *  "Grok Build Desktop extension". */
export function deviceClientLabel(appName: string, isDesktop: boolean): string {
  if (isDesktop) return "Desktop app";
  if (appName === "Visual Studio Code") return "VS Code extension";
  if (appName === "Cursor") return "Cursor extension";
  if (appName === "Antigravity") return "Antigravity extension";
  const name = String(appName || "").trim();
  return name ? `${name} extension` : "extension";
}

const RELAY_DEVICE_FIELD_MAX = 64;

/** Relay `/api/link/start` optional fields: trim, drop control chars, max 64. */
export function sanitizeRelayDeviceField(value: string): string {
  return String(value).replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, RELAY_DEVICE_FIELD_MAX);
}

export type LinkStartBody = {
  name: string;
  installId: string;
} & RelayClientMeta;

/** Same mapped `clientLabel` / `platform` / `osLabel` as link/start — omit empty. */
export function relayClientMeta(input: RelayClientSource): RelayClientMeta {
  const clientLabel = sanitizeRelayDeviceField(deviceClientLabel(input.appName, input.isDesktop));
  const platform = devicePlatformCode(input.platform);
  const osLabel = sanitizeRelayDeviceField(deviceOsLabel(input.platform, input.release));
  return {
    ...(clientLabel ? { clientLabel } : {}),
    ...(platform ? { platform } : {}),
    ...(osLabel ? { osLabel } : {}),
  };
}

/** POST `/api/link/start` body. `name` stays the legacy "HOST (Windows 11)"
 *  form so older relays keep working; the three extra fields are optional. */
export function buildLinkStartBody(input: {
  hostname: string;
  platform: string;
  release: string;
  installId: string;
  appName: string;
  isDesktop: boolean;
}): LinkStartBody {
  return {
    name: deviceDisplayName(input.hostname, input.platform, input.release),
    installId: input.installId,
    ...relayClientMeta(input),
  };
}

export const INITIAL_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;

/** Reconnect backoff: double up to the cap. */
export function nextBackoffMs(prev: number): number {
  return Math.min(Math.max(prev, INITIAL_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
}
