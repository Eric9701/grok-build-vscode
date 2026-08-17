import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import * as telemetry from "../src/telemetry";
import {
  aptabaseHost,
  osNameFromPlatform,
  shouldSendTelemetry,
  buildSessionStartEvent,
  sanitizeSessionStartProps,
  sessionStartHostKind,
  sessionStartSurface,
  telemetryStringLooksSensitive,
  SESSION_START_ALLOWED_KEYS,
  postEvent,
  APTABASE_APP_KEY_PROD,
  APTABASE_APP_KEY_DEV,
  OFFICIAL_EXTENSION_ID,
  type SessionStartPropKey,
  type SessionStartProps,
} from "../src/telemetry";
import { DESKTOP_APP_SHORT_NAME } from "../src/desktop/host-dialogs";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { normalizeRepoPath } from "../src/sessions";

const REQUIRED: SessionStartProps = {
  installId: "i",
  mode: "agent",
  model: "m",
  effort: "",
  showThinking: false,
  expandToolDetails: false,
  steerByDefault: false,
  chatFontScale: 100,
  readRepliesAloud: false,
  soundNotifications: false,
  sessionOrigin: "local",
  clientDevice: "desktop",
  hostKind: "vscode",
  appPurpose: "knowledge",
  voiceConfigured: false,
  voiceStreaming: true,
  voiceLanguageSet: false,
  grokConnected: true,
  codexConnected: false,
  claudeConnected: false,
};

describe("aptabaseHost — region from app key", () => {
  it("resolves EU and US keys to their ingest hosts", () => {
    expect(aptabaseHost("A-EU-5074036690")).toBe("https://eu.aptabase.com");
    expect(aptabaseHost("A-US-1234567890")).toBe("https://us.aptabase.com");
  });
  it("returns undefined (sending disabled) for self-hosted or malformed keys", () => {
    expect(aptabaseHost("A-DEV-0000000000")).toBeUndefined();
    expect(aptabaseHost("nonsense")).toBeUndefined();
  });
});

describe("postEvent never throws (telemetry can't impact the user)", () => {
  it("swallows a build/serialize failure instead of throwing", () => {
    // A circular event fails JSON.stringify *before* any network call, so this
    // exercises the try/catch with zero network — proving a malformed event can
    // never bubble into the caller's turn.
    const circular: any = { eventName: "session_start" };
    circular.self = circular;
    expect(() => postEvent(APTABASE_APP_KEY_PROD, circular)).not.toThrow();
  });
  it("is a no-op for an app key with no resolvable region (no network, no throw)", () => {
    const ev = buildSessionStartEvent(
      REQUIRED,
      { appVersion: "1", osName: "macOS", osVersion: "1", locale: "en", isDebug: true },
      "s",
      "2026-06-29T00:00:00.000Z",
    );
    expect(() => postEvent("A-DEV-0000000000", ev)).not.toThrow();
  });
});

describe("prod vs dev app keys", () => {
  it("are distinct EU projects (so probe traffic can't land in prod)", () => {
    expect(APTABASE_APP_KEY_PROD).not.toBe(APTABASE_APP_KEY_DEV);
    expect(aptabaseHost(APTABASE_APP_KEY_PROD)).toBe("https://eu.aptabase.com");
    expect(aptabaseHost(APTABASE_APP_KEY_DEV)).toBe("https://eu.aptabase.com");
  });
});

describe("osNameFromPlatform", () => {
  it("maps Node platforms to human OS names, passing through the unknown", () => {
    expect(osNameFromPlatform("darwin")).toBe("macOS");
    expect(osNameFromPlatform("win32")).toBe("Windows");
    expect(osNameFromPlatform("linux")).toBe("Linux");
    expect(osNameFromPlatform("freebsd")).toBe("freebsd");
  });
});

describe("shouldSendTelemetry — all gates must allow", () => {
  it("only sends when global setting AND our opt-in AND official build are all on", () => {
    expect(shouldSendTelemetry(true, true, true)).toBe(true);
    expect(shouldSendTelemetry(false, true, true)).toBe(false); // VS Code global off wins
    expect(shouldSendTelemetry(true, false, true)).toBe(false); // our opt-out
    expect(shouldSendTelemetry(true, true, false)).toBe(false); // a fork build never reports
    expect(shouldSendTelemetry(false, false, false)).toBe(false);
  });
});

describe("sessionStartSurface", () => {
  it("classifies local as desktop and splits remote touch from desktop browsers", () => {
    expect(sessionStartSurface("local", true)).toEqual({
      sessionOrigin: "local",
      clientDevice: "desktop",
    });
    expect(sessionStartSurface("remote", false)).toEqual({
      sessionOrigin: "remote",
      clientDevice: "desktop",
    });
    expect(sessionStartSurface("remote", true)).toEqual({
      sessionOrigin: "remote",
      clientDevice: "mobile",
    });
  });
});

describe("sessionStartHostKind", () => {
  it("is desktop only for the standalone app; every editor host is vscode", () => {
    expect(sessionStartHostKind(true)).toBe("desktop");
    expect(sessionStartHostKind(false)).toBe("vscode");
  });
});

describe("buildSessionStartEvent", () => {
  const sys = {
    appVersion: "1.4.24",
    osName: "macOS",
    osVersion: "23.6.0",
    locale: "en",
    isDebug: false,
  };
  const props: SessionStartProps = {
    ...REQUIRED,
    installId: "abc-123",
    mode: "yolo",
    model: "grok-build",
    effort: "high",
  };
  const ev = buildSessionStartEvent(props, sys, "sess-1", "2026-06-29T00:00:00.000Z");

  it("emits a single session_start with the supplied id + timestamp", () => {
    expect(ev.eventName).toBe("session_start");
    expect(ev.sessionId).toBe("sess-1");
    expect(ev.timestamp).toBe("2026-06-29T00:00:00.000Z");
  });

  it("carries the install id + mode/model/effort as props (no content)", () => {
    expect(ev.props).toEqual({
      installId: "abc-123",
      mode: "yolo",
      model: "grok-build",
      effort: "high",
      showThinking: false,
      expandToolDetails: false,
      steerByDefault: false,
      chatFontScale: 100,
      readRepliesAloud: false,
      soundNotifications: false,
      sessionOrigin: "local",
      clientDevice: "desktop",
      hostKind: "vscode",
      appPurpose: "knowledge",
      voiceConfigured: false,
      voiceStreaming: true,
      voiceLanguageSet: false,
      grokConnected: true,
      codexConnected: false,
      claudeConnected: false,
    });
  });

  it("reports system props incl. a versioned sdk label", () => {
    expect(ev.systemProps.osName).toBe("macOS");
    expect(ev.systemProps.appVersion).toBe("1.4.24");
    expect(ev.systemProps.sdkVersion).toBe("grok-vscode-phuryn@1.4.24");
    expect(ev.systemProps.isDebug).toBe(false);
  });
});

// Webview configuration + the host app ride session_start so we can see
// which defaults people keep and which VS Code fork they're on (the extension
// behaves differently across Cursor / Antigravity). Config values and an app
// name — the same class of anonymous property as mode/model/effort, never content.
describe("session_start — feature flags + host (analytics)", () => {
  const sys = { appVersion: "1", osName: "Windows", osVersion: "10", locale: "en", isDebug: false };
  const base: SessionStartProps = {
    ...REQUIRED,
    model: "grok-4.5",
    effort: "high",
    chatFontScale: 125,
    readRepliesAloud: true,
    soundNotifications: true,
  };

  it("carries the three flags and the host name", () => {
    const ev = buildSessionStartEvent(
      { ...base, showThinking: true, expandToolDetails: false, steerByDefault: true, host: "Cursor" },
      sys, "s", "2026-07-17T00:00:00.000Z",
    );
    expect(ev.props).toMatchObject({
      showThinking: true,
      expandToolDetails: false,
      steerByDefault: true,
      chatFontScale: 125,
      readRepliesAloud: true,
      soundNotifications: true,
      sessionOrigin: "local",
      clientDevice: "desktop",
      host: "Cursor",
      hostKind: "vscode",
    });
  });

  it("includes reported AFK Pilot preferences without replacing the local values", () => {
    const ev = buildSessionStartEvent(
      {
        ...base,
        showThinking: false,
        expandToolDetails: true,
        steerByDefault: false,
        remoteFontScale: 140,
        remoteReadRepliesAloud: false,
        sessionOrigin: "remote",
        clientDevice: "mobile",
      },
      sys, "s", "2026-07-17T00:00:00.000Z",
    );
    expect(ev.props).toMatchObject({
      chatFontScale: 125,
      readRepliesAloud: true,
      remoteFontScale: 140,
      remoteReadRepliesAloud: false,
      sessionOrigin: "remote",
      clientDevice: "mobile",
      expandToolDetails: true,
    });
  });

  it("omits host entirely when the app doesn't report one — never sends a blank", () => {
    const ev = buildSessionStartEvent(
      { ...base, showThinking: false, expandToolDetails: false, steerByDefault: false },
      sys, "s", "2026-07-17T00:00:00.000Z",
    );
    expect("host" in ev.props).toBe(false);
  });

  it("sends false as false — a flag left at its default is a real data point", () => {
    const ev = buildSessionStartEvent(
      {
        ...base,
        showThinking: false,
        expandToolDetails: false,
        steerByDefault: false,
        remoteFontScale: 140,
        remoteReadRepliesAloud: false,
        host: "Visual Studio Code",
      },
      sys, "s", "2026-07-17T00:00:00.000Z",
    );
    expect(ev.props.showThinking).toBe(false);
    expect(ev.props.steerByDefault).toBe(false);
    expect(ev.props.remoteFontScale).toBe(140);
    expect(ev.props.remoteReadRepliesAloud).toBe(false);
    // Still no content, ever — only the anonymous install id and config values.
    // Optional fields ride the same closed set when they are present.
    expect(Object.keys(ev.props).sort()).toEqual([...SESSION_START_ALLOWED_KEYS].sort());
  });

  it("pins the closed property set the builder is allowed to emit", () => {
    expect([...SESSION_START_ALLOWED_KEYS]).toEqual([
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
    ]);
  });
});

describe("the three hosts are distinguishable in analytics", () => {
  // Grok Build Desktop reports through the SAME shared send path as the
  // extension (sidebar.ts → host.appName → `host`), and its extensionId
  // resolves to the official publisher.name, so the fork gate lets it through.
  // What identifies it is this property — without it, desktop sessions would be
  // indistinguishable from VS Code ones in the same project.
  const props = (host?: string, hostKind: SessionStartProps["hostKind"] = "vscode"): SessionStartProps => ({
    ...REQUIRED,
    installId: "i-1",
    model: "grok-build",
    effort: "high",
    hostKind,
    ...(host ? { host } : {}),
  });
  const sys = {
    appVersion: "3.1.0",
    osName: "Windows",
    osVersion: "10.0.26200",
    locale: "en",
    isDebug: false,
  };

  it("tags desktop sessions with Grok Build Desktop and hostKind desktop", () => {
    const ev = buildSessionStartEvent(
      props(DESKTOP_APP_SHORT_NAME, "desktop"), sys, "s-1", "2026-08-07T00:00:00.000Z",
    );
    expect(ev.props.host).toBe("Grok Build Desktop");
    expect(ev.props.hostKind).toBe("desktop");
  });

  it("keeps the editor's own name for the extension, and omits it when unknown", () => {
    const code = buildSessionStartEvent(
      props("Visual Studio Code"), sys, "s-2", "2026-08-07T00:00:00.000Z",
    );
    expect(code.props.host).toBe("Visual Studio Code");
    expect(code.props.hostKind).toBe("vscode");
    // Absent host is unknown, not blank — an empty string would look like a
    // fourth product in the dashboard.
    const unknown = buildSessionStartEvent(
      props(), sys, "s-3", "2026-08-07T00:00:00.000Z",
    );
    expect("host" in unknown.props).toBe(false);
  });
});

describe("sanitizeSessionStartProps — allowlist, no paths, no free text", () => {
  it("drops unknown keys instead of copying the input through", () => {
    const out = sanitizeSessionStartProps({
      ...REQUIRED,
      prompt: "fix the login in src/app.ts",
      workspace: "C:\\Users\\me\\project",
      grokCliPath: "/usr/local/bin/grok",
      extra: true,
    });
    expect(out.prompt).toBeUndefined();
    expect(out.workspace).toBeUndefined();
    expect(out.grokCliPath).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(Object.keys(out).every((k) => (SESSION_START_ALLOWED_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it("rejects path-like and free-text values on every string field", () => {
    const dirty = {
      installId: "C:\\Users\\me\\AppData\\grok",
      mode: "please delete /tmp/secret",
      model: "C:\\Program Files\\grok\\grok.exe",
      effort: "/home/user/.grok",
      host: "/Users/me/projects/grok-build-vscode",
      hostKind: "desktop/../etc",
      appPurpose: "coding for /var/data",
      sessionOrigin: "remote\\share",
      clientDevice: "desktop browser at C:",
      showThinking: false,
      expandToolDetails: false,
      steerByDefault: false,
      chatFontScale: 100,
      readRepliesAloud: false,
      soundNotifications: false,
      voiceConfigured: true,
      voiceStreaming: true,
      voiceLanguageSet: true,
      grokConnected: true,
      codexConnected: false,
      claudeConnected: false,
    };
    const out = sanitizeSessionStartProps(dirty);
    expect(out).toEqual({
      showThinking: false,
      expandToolDetails: false,
      steerByDefault: false,
      chatFontScale: 100,
      readRepliesAloud: false,
      soundNotifications: false,
      voiceConfigured: true,
      voiceStreaming: true,
      voiceLanguageSet: true,
      grokConnected: true,
      codexConnected: false,
      claudeConnected: false,
    });
    for (const value of Object.values(out)) {
      if (typeof value === "string") {
        expect(telemetryStringLooksSensitive(value)).toBe(false);
      }
    }
  });

  it("never lets a path-like value survive buildSessionStartEvent", () => {
    const ev = buildSessionStartEvent(
      {
        ...REQUIRED,
        model: "../../../../etc/passwd",
        installId: "\\\\server\\share\\id",
        host: "D:\\workspace\\my-app",
        mode: "agent",
      } as SessionStartProps,
      { appVersion: "1", osName: "Windows", osVersion: "10", locale: "en", isDebug: true },
      "s",
      "2026-08-13T00:00:00.000Z",
    );
    expect(ev.props.model).toBeUndefined();
    expect(ev.props.installId).toBeUndefined();
    expect(ev.props.host).toBeUndefined();
    expect(ev.props.mode).toBe("agent");
    for (const value of Object.values(ev.props)) {
      if (typeof value === "string") {
        expect(telemetryStringLooksSensitive(value)).toBe(false);
      }
    }
  });

  it("accepts picker model ids and drops sentences / custom paths", () => {
    expect(sanitizeSessionStartProps({ ...REQUIRED, model: "grok-4.5" }).model).toBe("grok-4.5");
    expect(sanitizeSessionStartProps({ ...REQUIRED, model: "gpt-5.6-sol" }).model).toBe("gpt-5.6-sol");
    expect(sanitizeSessionStartProps({ ...REQUIRED, model: "" }).model).toBe("");
    expect(sanitizeSessionStartProps({ ...REQUIRED, model: "please rewrite README.md" }).model).toBeUndefined();
    expect(sanitizeSessionStartProps({ ...REQUIRED, model: "openai/gpt-5" }).model).toBeUndefined();
    expect(sanitizeSessionStartProps({ ...REQUIRED, effort: "max" }).effort).toBe("max");
    expect(sanitizeSessionStartProps({ ...REQUIRED, effort: "ultra" }).effort).toBe("ultra");
    expect(sanitizeSessionStartProps({ ...REQUIRED, effort: "ludicrous" }).effort).toBeUndefined();
    expect(sanitizeSessionStartProps({ ...REQUIRED, mode: "auto-accept" }).mode).toBeUndefined();
  });

  it("omits an unknown host name rather than forwarding free text", () => {
    const out = sanitizeSessionStartProps({ ...REQUIRED, host: "My Custom Fork 9000" });
    expect("host" in out).toBe(false);
  });

  it("keeps only finite numbers inside the documented zoom ranges", () => {
    expect(sanitizeSessionStartProps({ ...REQUIRED, chatFontScale: 125 }).chatFontScale).toBe(125);
    expect(sanitizeSessionStartProps({ ...REQUIRED, chatFontScale: 10 }).chatFontScale).toBeUndefined();
    expect(sanitizeSessionStartProps({ ...REQUIRED, remoteFontScale: 140 }).remoteFontScale).toBe(140);
    expect(sanitizeSessionStartProps({ ...REQUIRED, remoteFontScale: 400 }).remoteFontScale).toBeUndefined();
    expect(sanitizeSessionStartProps({ ...REQUIRED, chatFontScale: Number.NaN }).chatFontScale).toBeUndefined();
  });

  it("does not coerce strings into booleans or enums", () => {
    const out = sanitizeSessionStartProps({
      ...REQUIRED,
      showThinking: "true",
      grokConnected: "yes",
      hostKind: "extension",
      appPurpose: "Knowledge work",
    } as unknown as SessionStartProps);
    expect(out.showThinking).toBeUndefined();
    expect(out.grokConnected).toBeUndefined();
    expect(out.hostKind).toBeUndefined();
    expect(out.appPurpose).toBeUndefined();
  });

  it("emits every SESSION_START_ALLOWED_KEYS entry when a valid value is provided", () => {
    const valid: Record<SessionStartPropKey, string | number | boolean> = {
      installId: "install-1",
      mode: "agent",
      model: "grok-4.5",
      effort: "max",
      showThinking: false,
      expandToolDetails: true,
      steerByDefault: false,
      chatFontScale: 110,
      readRepliesAloud: true,
      soundNotifications: false,
      sessionOrigin: "remote",
      clientDevice: "mobile",
      remoteFontScale: 140,
      remoteReadRepliesAloud: false,
      host: "Cursor",
      hostKind: "desktop",
      appPurpose: "coding",
      voiceConfigured: true,
      voiceStreaming: false,
      voiceLanguageSet: true,
      grokConnected: false,
      codexConnected: true,
      claudeConnected: false,
    };
    const extra = { ...valid, unlistedPicker: true, prompt: "do not send" };
    const out = sanitizeSessionStartProps(extra);
    expect(Object.keys(out).sort()).toEqual([...SESSION_START_ALLOWED_KEYS].sort());
    for (const key of SESSION_START_ALLOWED_KEYS) {
      expect(out[key]).toBe(valid[key]);
    }
    expect(out.unlistedPicker).toBeUndefined();
  });
});

const SIDEBAR_SRC = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function sidebarMethodBody(signature: string): string {
  const start = SIDEBAR_SRC.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const next = SIDEBAR_SRC.indexOf("\n  private ", start + signature.length);
  return SIDEBAR_SRC.slice(start, next < 0 ? SIDEBAR_SRC.length : next);
}

function makeTelemetrySidebar(cwd = "/repo"): any {
  const instance = Object.create(GrokSidebar.prototype) as any;
  instance.lastProviderConnected = { grok: true, codex: false, claude: false };
  instance.lastVoiceConfiguredByCwd = new Map([[normalizeRepoPath(cwd), true]]);
  instance.locatedProviders = vi.fn(() => {
    throw new Error("reportSessionStart must not rediscover providers");
  });
  instance.locateProvider = vi.fn(() => {
    throw new Error("reportSessionStart must not locate a CLI");
  });
  instance.resolveVoiceApiKey = vi.fn(() => {
    throw new Error("reportSessionStart must not resolve a voice key");
  });
  instance.providerConnections = vi.fn(() => {
    throw new Error("reportSessionStart must not re-read provider connections");
  });
  instance.remoteClients = new RemoteClientState<Session>(cwd);
  instance.focused = new Session();
  instance.focused.provider = "grok";
  instance.focused.cwd = cwd;
  instance.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  instance.installId = vi.fn(() => "install-wired");
  instance.displayMode = vi.fn(() => "agent");
  instance.appPurpose = vi.fn(() => "coding");
  instance.chatFontScale = vi.fn(() => 1.25);
  instance.voiceSetting = vi.fn((_cwd: string, key: string, fallback: unknown) =>
    key === "voiceLanguage" ? "en" : fallback);
  instance.host = {
    isTelemetryEnabled: true,
    appName: "Visual Studio Code",
    language: "en",
    canSwitchWorkspaceFolder: false,
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback: unknown) => fallback,
    })),
  };
  instance.context = {
    extensionId: OFFICIAL_EXTENSION_ID,
    extensionVersion: "9.9.9",
    isProduction: true,
  };
  return instance;
}

describe("sidebar session_start wiring", () => {
  it("passes every allowed key into the payload builder from the call site", () => {
    const body = sidebarMethodBody("private reportSessionStart(");
    for (const key of SESSION_START_ALLOWED_KEYS) {
      // Origin/device ride the sessionStartSurface spread, not a bare key.
      if (key === "sessionOrigin" || key === "clientDevice") continue;
      expect(body, `reportSessionStart must pass ${key}`).toContain(`${key}:`);
    }
    expect(body).toContain("sessionStartSurface(");
    expect(body).not.toContain("locatedProviders(");
    expect(body).not.toContain("resolveVoiceApiKey(");
    expect(body).toContain("this.lastProviderConnected?.grok");
    expect(body).toContain("this.lastProviderConnected?.codex");
    expect(body).toContain("this.lastProviderConnected?.claude");
    expect(body).toContain("this.lastVoiceConfiguredByCwd.get(");
  });

  it("builds hostKind/appPurpose/flags from the last refresh snapshot, not a live probe", () => {
    const spy = vi.spyOn(telemetry, "buildSessionStartEvent");
    try {
      const sidebar = makeTelemetrySidebar("/repo");
      const session = sidebar.focused as Session;
      session.client = {
        currentModelId: "grok-4.5",
        currentReasoningEffort: "ultra",
      } as any;
      sidebar.reportSessionStart(session, "local");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        hostKind: "vscode",
        appPurpose: "coding",
        voiceConfigured: true,
        voiceStreaming: true,
        voiceLanguageSet: true,
        grokConnected: true,
        codexConnected: false,
        claudeConnected: false,
        chatFontScale: 125,
        readRepliesAloud: false,
        soundNotifications: false,
        showThinking: false,
        expandToolDetails: false,
        steerByDefault: false,
        model: "grok-4.5",
        effort: "ultra",
        sessionOrigin: "local",
        clientDevice: "desktop",
      });
      expect(sidebar.locatedProviders).not.toHaveBeenCalled();
      expect(sidebar.resolveVoiceApiKey).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("snapshots connected flags when providerState refreshes", () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.providerConnections = vi.fn(() => ({ grok: true, codex: true, claude: true }));
    sidebar.locatedProviders = vi.fn(() => ({ grok: true, codex: false, claude: true }));
    sidebar.providerCliVersions = {};
    sidebar.providerNeedsLogin = {};
    sidebar.providerStateMessage();
    expect(sidebar.lastProviderConnected).toEqual({ grok: true, codex: false, claude: true });
  });

  it("omits voice and provider flags when no snapshot exists (never a fake false)", () => {
    const spy = vi.spyOn(telemetry, "buildSessionStartEvent");
    try {
      const sidebar = makeTelemetrySidebar("/repo");
      sidebar.lastProviderConnected = null;
      sidebar.lastVoiceConfiguredByCwd = new Map();
      sidebar.reportSessionStart(sidebar.focused, "local");
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0] as Record<string, unknown>;
      expect(input.voiceConfigured).toBeUndefined();
      expect(input.grokConnected).toBeUndefined();
      expect(input.codexConnected).toBeUndefined();
      expect(input.claudeConnected).toBeUndefined();
      const props = telemetry.sanitizeSessionStartProps(
        telemetry.buildSessionStartEvent(
          input as any,
          { appVersion: "1.0.0", osName: "Windows" },
        ).props,
      );
      expect(props).not.toHaveProperty("voiceConfigured");
      expect(props).not.toHaveProperty("grokConnected");
      expect(props).not.toHaveProperty("codexConnected");
      expect(props).not.toHaveProperty("claudeConnected");
    } finally {
      spy.mockRestore();
    }
  });

  it("a voice snapshot for a DIFFERENT cwd does not answer for this one", () => {
    const spy = vi.spyOn(telemetry, "buildSessionStartEvent");
    try {
      const sidebar = makeTelemetrySidebar("/repo");
      sidebar.lastVoiceConfiguredByCwd = new Map([[normalizeRepoPath("/other"), true]]);
      sidebar.reportSessionStart(sidebar.focused, "local");
      expect((spy.mock.calls[0][0] as Record<string, unknown>).voiceConfigured).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("postVoiceConfigured rebuilds the map: stale keys from removed configs drop out", () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.focused = new Session();
    sidebar.focused.cwd = "/repo";
    sidebar.sessionCwd = vi.fn(() => "/repo");
    sidebar.resolveVoiceApiKey = vi.fn(() => "key");
    sidebar.voiceSetting = vi.fn((_c: string, _k: string, fb: unknown) => fb);
    sidebar.postLocal = vi.fn();
    sidebar.remoteClients = new RemoteClientState<Session>("/repo");
    sidebar.lastVoiceConfiguredByCwd = new Map([[normalizeRepoPath("/gone"), true]]);
    sidebar.postVoiceConfigured();
    expect(sidebar.lastVoiceConfiguredByCwd.has(normalizeRepoPath("/gone"))).toBe(false);
    expect(sidebar.lastVoiceConfiguredByCwd.get(normalizeRepoPath("/repo"))).toBe(true);
  });

});
