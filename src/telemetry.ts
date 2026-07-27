// Privacy-first, cookieless usage telemetry via Aptabase. We send exactly ONE
// event — `session_start`, on the first real user message of a session (never
// the primer / empty sessions) — carrying only an anonymous install id + the
// chosen mode/model/effort + UI configuration. No content (prompts, code, paths)
// is ever sent, and the IP is used by Aptabase only to derive country, then
// discarded. The whole
// thing is gated on VS Code's global telemetry setting + `grok.telemetry.enabled`.
//
// This module is pure + fire-and-forget: the builders have no I/O (unit-tested),
// and `postEvent` never throws or blocks the caller.
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
  sessionOrigin: "local" | "remote";
  clientDevice: "desktop" | "mobile";
  /** Browser-owned AFK Pilot preferences. Omitted until a remote reports them. */
  remoteFontScale?: number;
  remoteReadRepliesAloud?: boolean;
  /** Host application name (`vscode.env.appName`) — "Visual Studio Code",
   *  "Cursor", "Antigravity", … The extension runs in several forks whose
   *  behavior differs (see § Known limits: Cursor's Move-view gap, Antigravity's
   *  engine floor), so knowing the mix is what makes those trade-offs decidable.
   *  Omitted when the host doesn't report one. */
  host?: string;
}

export interface AptabaseEvent {
  timestamp: string;
  sessionId: string;
  eventName: string;
  systemProps: Record<string, unknown>;
  props: Record<string, unknown>;
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
  origin: "local" | "remote",
  remoteUsesTouch?: boolean,
): Pick<SessionStartProps, "sessionOrigin" | "clientDevice"> {
  return {
    sessionOrigin: origin,
    clientDevice: origin === "remote" && remoteUsesTouch ? "mobile" : "desktop",
  };
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
    props: {
      installId: props.installId,
      mode: props.mode,
      model: props.model,
      effort: props.effort,
      showThinking: props.showThinking,
      expandToolDetails: props.expandToolDetails,
      steerByDefault: props.steerByDefault,
      chatFontScale: props.chatFontScale,
      readRepliesAloud: props.readRepliesAloud,
      soundNotifications: props.soundNotifications,
      sessionOrigin: props.sessionOrigin,
      clientDevice: props.clientDevice,
      ...(props.remoteFontScale !== undefined ? { remoteFontScale: props.remoteFontScale } : {}),
      ...(props.remoteReadRepliesAloud !== undefined
        ? { remoteReadRepliesAloud: props.remoteReadRepliesAloud }
        : {}),
      // Omitted, never sent as "" — an absent host is unknown, not blank.
      ...(props.host ? { host: props.host } : {}),
    },
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
