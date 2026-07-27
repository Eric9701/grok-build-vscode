import { describe, it, expect } from "vitest";
import {
  aptabaseHost,
  osNameFromPlatform,
  shouldSendTelemetry,
  buildSessionStartEvent,
  sessionStartSurface,
  postEvent,
  APTABASE_APP_KEY_PROD,
  APTABASE_APP_KEY_DEV,
} from "../src/telemetry";

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
      {
        installId: "i", mode: "agent", model: "m", effort: "",
        showThinking: false, expandToolDetails: false, steerByDefault: false,
        chatFontScale: 100, readRepliesAloud: false,
        soundNotifications: false, sessionOrigin: "local", clientDevice: "desktop",
      },
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

describe("buildSessionStartEvent", () => {
  const sys = {
    appVersion: "1.4.24",
    osName: "macOS",
    osVersion: "23.6.0",
    locale: "en",
    isDebug: false,
  };
  const props = {
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
    sessionOrigin: "local" as const,
    clientDevice: "desktop" as const,
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
  const base = {
    installId: "i",
    mode: "agent",
    model: "grok-4.5",
    effort: "high",
    chatFontScale: 125,
    readRepliesAloud: true,
    soundNotifications: true,
    sessionOrigin: "local" as const,
    clientDevice: "desktop" as const,
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
      { ...base, showThinking: false, expandToolDetails: false, steerByDefault: false, host: "Visual Studio Code" },
      sys, "s", "2026-07-17T00:00:00.000Z",
    );
    expect(ev.props.showThinking).toBe(false);
    expect(ev.props.steerByDefault).toBe(false);
    expect("remoteFontScale" in ev.props).toBe(false);
    expect("remoteReadRepliesAloud" in ev.props).toBe(false);
    // Still no content, ever — only the anonymous install id and config values.
    expect(Object.keys(ev.props).sort()).toEqual(
      [
        "chatFontScale", "clientDevice", "effort", "expandToolDetails", "host",
        "installId", "mode", "model", "readRepliesAloud", "sessionOrigin",
        "showThinking", "soundNotifications", "steerByDefault",
      ],
    );
  });
});
