// Privacy-first, cookieless usage telemetry via Aptabase. We send exactly ONE
// event — `session_start`, on the first real user message of a session (never
// empty sessions) — carrying only an anonymous install id + a low-cardinality
// settings snapshot (mode/model/effort, host kind, feature flags, provider
// connection, voice configured/streaming). No content (prompts, code, paths)
// is ever sent, and the IP is used by Aptabase only to derive country, then
// discarded. The whole
// thing is gated on VS Code's global telemetry setting + `grok.telemetry.enabled`.
//
// This module is pure + fire-and-forget: the builders have no I/O (unit-tested),
// and `postEvent` never throws or blocks the caller. `sanitizeSessionStartProps`
// is the only path into the event props object — unknown keys and path-like /
// free-text values are dropped.
import * as https from "node:https";

// Aptabase ingestion app keys (region-prefixed write-only keys meant to ship in
// the client, not secrets). Two projects keep test traffic out of the real
// analytics: the **extension always reports to PROD** (dev host, local install,
// and the published Marketplace build alike); the **DEV** key is used only by the
// `telemetry:probe` script / tests, so probe traffic lands in a separate project.
export const APTABASE_APP_KEY_PROD = "A-EU-2294571902";
export const APTABASE_APP_KEY_DEV = "A-EU-5074036690";

/** The label Aptabase shows as the SDK that sent the event. */
export const TELEMETRY_SDK = "grok-vscode-phuryn";

/** The publisher.name id of the official build. The Aptabase app key is a
 *  write-only client key that necessarily ships in the vsix, so a fork that
 *  rebuilds carries it too — but a fork can only be *published* under its own
 *  publisher, so its `context.extension.id` differs. Gating telemetry on this id
 *  keeps forks' usage out of the official project (they simply never send). */
export const OFFICIAL_EXTENSION_ID = "PawelHuryn.grok-vscode-phuryn";

export interface SystemProps {
  appVersion: string;
  osName: string;
  osVersion: string;
  locale: string;
  isDebug: boolean;
}

export type TelemetryHostKind = "desktop" | "vscode";
export type TelemetryAppPurpose = "knowledge" | "coding";
export type TelemetryMode = "agent" | "plan" | "yolo";
export type TelemetryEffort = "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type TelemetrySessionOrigin = "local" | "remote";
export type TelemetryClientDevice = "desktop" | "mobile";

export interface SessionStartProps {
  /** Anonymous, per-install GUID — a property like model/effort, not an identity. */
  installId: string;
  mode: string;
  model: string;
  effort: string;
  /** Webview-only configuration, so we can see which defaults people keep.
   *  Values only, no content. Disclosed in docs/privacy.md. */
  showThinking: boolean;
  expandToolDetails: boolean;
  steerByDefault: boolean;
  /** Effective local VS Code chat zoom, as a displayed percentage. */
  chatFontScale: number;
  readRepliesAloud: boolean;
  soundNotifications: boolean;
  sessionOrigin: TelemetrySessionOrigin;
  clientDevice: TelemetryClientDevice;
  /** Coarse product surface. `desktop` is Grok Build Desktop; everything else
   *  (VS Code, Cursor, Antigravity, …) is `vscode`. */
  hostKind: TelemetryHostKind;
  appPurpose: TelemetryAppPurpose;
  /** Omitted (undefined) when no snapshot exists for the session's cwd. */
  voiceConfigured?: boolean;
  voiceStreaming: boolean;
  /** True when a language code is set. The code itself is free text, so it is
   *  never sent — see `grok.voiceLanguage`. */
  voiceLanguageSet: boolean;
  /** Omitted (undefined) until the first providerState refresh. */
  grokConnected?: boolean;
  codexConnected?: boolean;
  claudeConnected?: boolean;
  /** Browser-owned AFK Pilot preferences. Omitted until a remote reports them. */
  remoteFontScale?: number;
  remoteReadRepliesAloud?: boolean;
  /** Host application name (`vscode.env.appName`) — allowlisted product names
   *  only ("Visual Studio Code", "Cursor", "Antigravity", "Grok Build Desktop").
   *  Omitted when the host doesn't report one or the name is not in the list. */
  host?: string;
}

export interface AptabaseEvent {
  timestamp: string;
  sessionId: string;
  eventName: string;
  systemProps: Record<string, unknown>;
  props: Record<string, string | number | boolean>;
}

export type SessionStartPropKey = (typeof SESSION_START_ALLOWED_KEYS)[number];

/** Closed key set the builder will emit. Extra keys on the input are dropped. */
export const SESSION_START_ALLOWED_KEYS = [
  "installId",
  "mode",
  "model",
  "effort",
  "showThinking",
  "expandToolDetails",
  "steerByDefault",
  "chatFontScale",
  "readRepliesAloud",
  "soundNotifications",
  "sessionOrigin",
  "clientDevice",
  "remoteFontScale",
  "remoteReadRepliesAloud",
  "host",
  "hostKind",
  "appPurpose",
  "voiceConfigured",
  "voiceStreaming",
  "voiceLanguageSet",
  "grokConnected",
  "codexConnected",
  "claudeConnected",
] as const;

const ALLOWED_MODES = new Set<string>(["agent", "plan", "yolo"]);
const ALLOWED_EFFORTS = new Set<string>(["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const ALLOWED_ORIGINS = new Set<string>(["local", "remote"]);
const ALLOWED_DEVICES = new Set<string>(["desktop", "mobile"]);
const ALLOWED_HOST_KINDS = new Set<string>(["desktop", "vscode"]);
const ALLOWED_PURPOSES = new Set<string>(["knowledge", "coding"]);
/** Product names we already distinguish in analytics. Unknown names are omitted
 *  rather than forwarded — `vscode.env.appName` is otherwise free text. */
const ALLOWED_HOSTS = new Set<string>([
  "Visual Studio Code",
  "Visual Studio Code - Insiders",
  "Cursor",
  "Antigravity",
  "Grok Build Desktop",
  "VSCodium",
  "Code - OSS",
]);

const INSTALL_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
/** Picker / CLI model ids: `grok-build`, `grok-4.5`, `gpt-5.6-sol`. Empty = CLI default. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

const PATH_LIKE_RE = /[\\/]|^[A-Za-z]:|\.\./;

/**
 * True when a string looks like a filesystem path, URI, or free-text sentence.
 * Allowlisted host product names are the only multi-word strings we ever send.
 */
export function telemetryStringLooksSensitive(value: string): boolean {
  if (!value) return false;
  if (PATH_LIKE_RE.test(value)) return true;
  if (/\s/.test(value) && !ALLOWED_HOSTS.has(value)) return true;
  if (value.length > 80) return true;
  return false;
}

function isSafeInstallId(value: string): boolean {
  return INSTALL_ID_RE.test(value) && !telemetryStringLooksSensitive(value);
}

function isSafeModelId(value: string): boolean {
  if (value === "") return true;
  return MODEL_ID_RE.test(value) && !telemetryStringLooksSensitive(value);
}

function pickEnum(value: unknown, allowed: Set<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!allowed.has(value)) return undefined;
  if (telemetryStringLooksSensitive(value)) return undefined;
  return value;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function pickBoundedInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.round(value);
  if (n < min || n > max) return undefined;
  return n;
}

/**
 * Allowlist + type/enum/path gate for `session_start` props. Unknown keys,
 * wrong types, out-of-range numbers, and path-like / free-text strings are
 * dropped. The builder never copies input through.
 */
export function sanitizeSessionStartProps(raw: unknown): Record<string, string | number | boolean> {
  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const picked: Record<string, string | number | boolean> = {};

  const installId = typeof src.installId === "string" && isSafeInstallId(src.installId)
    ? src.installId
    : undefined;
  if (installId !== undefined) picked.installId = installId;

  const mode = pickEnum(src.mode, ALLOWED_MODES);
  if (mode !== undefined) picked.mode = mode;

  if (typeof src.model === "string" && isSafeModelId(src.model)) picked.model = src.model;

  const effort = pickEnum(src.effort, ALLOWED_EFFORTS);
  if (effort !== undefined) picked.effort = effort;

  const showThinking = pickBoolean(src.showThinking);
  if (showThinking !== undefined) picked.showThinking = showThinking;
  const expandToolDetails = pickBoolean(src.expandToolDetails);
  if (expandToolDetails !== undefined) picked.expandToolDetails = expandToolDetails;
  const steerByDefault = pickBoolean(src.steerByDefault);
  if (steerByDefault !== undefined) picked.steerByDefault = steerByDefault;

  const chatFontScale = pickBoundedInt(src.chatFontScale, 60, 300);
  if (chatFontScale !== undefined) picked.chatFontScale = chatFontScale;

  const readRepliesAloud = pickBoolean(src.readRepliesAloud);
  if (readRepliesAloud !== undefined) picked.readRepliesAloud = readRepliesAloud;
  const soundNotifications = pickBoolean(src.soundNotifications);
  if (soundNotifications !== undefined) picked.soundNotifications = soundNotifications;

  const sessionOrigin = pickEnum(src.sessionOrigin, ALLOWED_ORIGINS);
  if (sessionOrigin !== undefined) picked.sessionOrigin = sessionOrigin;
  const clientDevice = pickEnum(src.clientDevice, ALLOWED_DEVICES);
  if (clientDevice !== undefined) picked.clientDevice = clientDevice;

  const remoteFontScale = pickBoundedInt(src.remoteFontScale, 80, 160);
  if (remoteFontScale !== undefined) picked.remoteFontScale = remoteFontScale;
  const remoteReadRepliesAloud = pickBoolean(src.remoteReadRepliesAloud);
  if (remoteReadRepliesAloud !== undefined) picked.remoteReadRepliesAloud = remoteReadRepliesAloud;

  const host = pickEnum(src.host, ALLOWED_HOSTS);
  if (host !== undefined) picked.host = host;

  const hostKind = pickEnum(src.hostKind, ALLOWED_HOST_KINDS);
  if (hostKind !== undefined) picked.hostKind = hostKind;
  const appPurpose = pickEnum(src.appPurpose, ALLOWED_PURPOSES);
  if (appPurpose !== undefined) picked.appPurpose = appPurpose;

  const voiceConfigured = pickBoolean(src.voiceConfigured);
  if (voiceConfigured !== undefined) picked.voiceConfigured = voiceConfigured;
  const voiceStreaming = pickBoolean(src.voiceStreaming);
  if (voiceStreaming !== undefined) picked.voiceStreaming = voiceStreaming;
  const voiceLanguageSet = pickBoolean(src.voiceLanguageSet);
  if (voiceLanguageSet !== undefined) picked.voiceLanguageSet = voiceLanguageSet;

  const grokConnected = pickBoolean(src.grokConnected);
  if (grokConnected !== undefined) picked.grokConnected = grokConnected;
  const codexConnected = pickBoolean(src.codexConnected);
  if (codexConnected !== undefined) picked.codexConnected = codexConnected;
  const claudeConnected = pickBoolean(src.claudeConnected);
  if (claudeConnected !== undefined) picked.claudeConnected = claudeConnected;

  // The allowlist is the only way a key can leave. A picker for an unlisted
  // name writes into `picked` and is dropped here.
  const out: Record<string, string | number | boolean> = {};
  for (const key of SESSION_START_ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(picked, key)) out[key] = picked[key];
  }
  return out;
}

/**
 * Base URL for the Aptabase ingest API, derived from the app key's region prefix
 * (`A-EU-…` / `A-US-…`). Returns undefined for `A-DEV-…` / malformed keys (self-
 * hosted needs an explicit host we don't support here), which disables sending.
 */
export function aptabaseHost(appKey: string): string | undefined {
  const region = appKey.split("-")[1];
  if (region === "EU") return "https://eu.aptabase.com";
  if (region === "US") return "https://us.aptabase.com";
  return undefined;
}

/** Map a Node `process.platform` to a human OS name for `systemProps.osName`. */
export function osNameFromPlatform(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

/** Telemetry sends only when ALL gates allow: VS Code's global setting, our own
 *  opt-out, AND this being the official build (so a republished fork never reports
 *  into the official project — see OFFICIAL_EXTENSION_ID). Default-on for the first
 *  two, but the global setting always wins. */
export function shouldSendTelemetry(
  globalEnabled: boolean,
  settingEnabled: boolean,
  isOfficialBuild: boolean,
): boolean {
  return globalEnabled && settingEnabled && isOfficialBuild;
}

/** Classify the surface that sent a session's first message. Local VS Code is
 * always desktop; AFK Pilot uses its coarse-pointer/hover touch signal. */
export function sessionStartSurface(
  origin: TelemetrySessionOrigin,
  remoteUsesTouch?: boolean,
): Pick<SessionStartProps, "sessionOrigin" | "clientDevice"> {
  return {
    sessionOrigin: origin,
    clientDevice: origin === "remote" && remoteUsesTouch ? "mobile" : "desktop",
  };
}

/** Desktop app vs every VS Code-compatible host (VS Code, Cursor, Antigravity). */
export function sessionStartHostKind(isDesktopHost: boolean): TelemetryHostKind {
  return isDesktopHost ? "desktop" : "vscode";
}

/** Build the Aptabase `session_start` event body. Pure — no clock, no network;
 *  the caller supplies `sessionId` + `timestamp` so it's deterministic in tests. */
export function buildSessionStartEvent(
  props: SessionStartProps,
  sys: SystemProps,
  sessionId: string,
  timestamp: string,
): AptabaseEvent {
  return {
    timestamp,
    sessionId,
    eventName: "session_start",
    systemProps: {
      isDebug: sys.isDebug,
      locale: sys.locale,
      osName: sys.osName,
      osVersion: sys.osVersion,
      appVersion: sys.appVersion,
      sdkVersion: `${TELEMETRY_SDK}@${sys.appVersion}`,
    },
    props: sanitizeSessionStartProps(props),
  };
}

/**
 * Fire-and-forget POST of an event to Aptabase. Never throws, never blocks — any
 * failure (offline, DNS, 4xx) is swallowed (optionally logged). A no-op if the
 * app key has no resolvable region host.
 */
export function postEvent(appKey: string, event: AptabaseEvent, log?: (msg: string) => void): void {
  const host = aptabaseHost(appKey);
  if (!host) return;
  try {
    const body = JSON.stringify(event);
    const url = new URL(`${host}/api/v0/event`);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "App-Key": appKey,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => res.resume(), // drain so the socket can close
    );
    req.on("error", (e) => log?.(`[telemetry] ${e.message}`));
    req.write(body);
    req.end();
  } catch (e) {
    log?.(`[telemetry] ${(e as Error).message}`);
  }
}
