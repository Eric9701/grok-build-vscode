import { describe, expect, it, vi } from "vitest";

vi.mock("../src/acp", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  const actual = await importOriginal<typeof import("../src/acp")>();
  class FakeAcpClient extends EventEmitter {
    provider = "grok" as const;
    usesClientPlanGate = false;
    sessionId: string | undefined;
    availableModels: { modelId: string; name: string }[] = [];
    currentModelId = "fake-model";
    fsRead?: unknown;
    fsWrite?: unknown;
    terminal?: unknown;
    constructor(_opts: { log: (msg: string) => void }) {
      super();
    }
    async start(): Promise<void> {
      this.emit("initialized", { protocolVersion: 1, serverInfo: { version: "0.2.117" } });
    }
    async newSession(): Promise<{ sessionId: string }> {
      this.sessionId = "new-session";
      this.emit("session", { sessionId: this.sessionId });
      return { sessionId: this.sessionId };
    }
    async loadSession(sessionId: string): Promise<{ sessionId: string }> {
      this.sessionId = sessionId;
      this.emit("session", { sessionId });
      this.emit("messageChunk", "replayed turn");
      this.emit("sessionLoaded", { sessionId });
      return { sessionId };
    }
    async dispose(): Promise<void> {}
    async setMode(): Promise<void> {}
    isCredentialError(): boolean {
      return false;
    }
  }
  return { ...actual, AcpClient: FakeAcpClient };
});

import { OpenClock, formatMs, formatOpenTimings } from "../src/open-timing";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";

describe("formatMs", () => {
  it("prints whole milliseconds", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(437)).toBe("437ms");
    expect(formatMs(2100)).toBe("2100ms");
    expect(formatMs(3010)).toBe("3010ms");
  });

  it("does not pretend to know a duration it was not given", () => {
    expect(formatMs(NaN)).toBe("?");
    expect(formatMs(-1)).toBe("?");
  });
});

describe("formatOpenTimings", () => {
  it("emits the five-phase session-open line", () => {
    expect(formatOpenTimings({
      totalMs: 3010,
      phases: [
        { name: "dispose", ms: 120 },
        { name: "version", ms: 40, note: "cached" },
        { name: "spawn+init", ms: 300 },
        { name: "load", ms: 2100 },
        { name: "replay(post)", ms: 450 },
      ],
      events: 1234,
    })).toBe(
      "session open: dispose 120ms · version 40ms (cached) · spawn+init 300ms · load 2100ms · replay(post) 450ms · total 3010ms (events: 1234)",
    );
  });

  it("keeps a zero-cost phase on the line", () => {
    expect(formatOpenTimings({
      totalMs: 340,
      phases: [
        { name: "dispose", ms: 0 },
        { name: "version", ms: 40 },
        { name: "spawn+init", ms: 300 },
        { name: "load", ms: 0 },
        { name: "replay(post)", ms: 0 },
      ],
      events: 0,
    })).toBe(
      "session open: dispose 0ms · version 40ms · spawn+init 300ms · load 0ms · replay(post) 0ms · total 340ms (events: 0)",
    );
  });
});

describe("OpenClock", () => {
  it("records each named interval independently of the wall total", () => {
    let t = 1000;
    const clock = new OpenClock(() => t);
    clock.record("dispose", 120);
    clock.record("version", 40, "cached");
    t += 3010;
    expect(clock.summary(12)).toBe(
      "session open: dispose 120ms · version 40ms (cached) · total 3010ms (events: 12)",
    );
  });
});

function makeSidebar(cwd: string): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar.providerConnectionState = { grok: true, codex: false };
  sidebar.providerConnections = vi.fn(() => sidebar.providerConnectionState);
  sidebar.connectedProviders = vi.fn(() => ["grok"]);
  sidebar.providerNeedsLogin = {};
  sidebar.providerCliVersions = {};
  sidebar.remoteClients = new RemoteClientState<Session>(cwd);
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.provider = "grok";
  sidebar.focused.cwd = cwd;
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.sessionCache = new Map();
  sidebar.loginReprobeTimers = new Map();
  sidebar.turnOrderTimers = new Set();
  sidebar.pendingConfirms = new Map();
  sidebar.fullImagePaths = new Map();
  sidebar.pendingAttach = new Set();
  sidebar.state = {
    get: vi.fn((key: string, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback),
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  sidebar.host = {
    canSwitchWorkspaceFolder: false,
    append: vi.fn(),
    appendLine: vi.fn(),
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback: unknown) => fallback,
      inspect: () => undefined,
      update: vi.fn(async () => {}),
    })),
    fs: {
      readFile: vi.fn(async () => Buffer.from("")),
      writeFile: vi.fn(async () => {}),
      createDirectory: vi.fn(async () => {}),
    },
  };
  sidebar.context = { globalStorageUri: { fsPath: cwd }, subscriptions: [] };
  sidebar.terminalManager = { create: vi.fn(), disposeAll: vi.fn(), ownedBy: vi.fn(() => ({ create: vi.fn() })), releaseOwnedBy: vi.fn(() => 0) };
  sidebar.workspaceRoot = vi.fn(() => cwd);
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  sidebar.locateProvider = vi.fn(() => "grok");
  sidebar.providerDefaultForProject = vi.fn(() => "");
  sidebar.configForcesAutoApprove = vi.fn(() => false);
  sidebar.confirmRepoForcedAutoApprove = vi.fn(async () => true);
  sidebar.stopVoiceInput = vi.fn();
  sidebar.queueInFlightPlanCommentsOnExit = vi.fn();
  sidebar.warnOAuthShadowOnce = vi.fn();
  sidebar.cacheProviderModels = vi.fn(async () => {});
  sidebar.modelsForSession = vi.fn(() => []);
  sidebar.updateSessionMeta = vi.fn(async () => {});
  sidebar.postSessionName = vi.fn();
  sidebar.postProviderState = vi.fn();
  sidebar.postSessionsList = vi.fn();
  sidebar.postRepoCatalog = vi.fn();
  sidebar.touch = vi.fn();
  sidebar.reapPool = vi.fn();
  sidebar.maybeFlushQueuedSends = vi.fn(async () => {});
  sidebar.emitContextUsage = vi.fn();
  sidebar.restoreUsage = vi.fn();
  sidebar.restorePersistedDraft = vi.fn();
  sidebar.sendRemoteSession = vi.fn();
  sidebar.sendRemoteClient = vi.fn();
  sidebar.sendRemoteHistorySnapshot = vi.fn();
  sidebar.mirrorToProjectsRail = vi.fn();
  sidebar.localizeHistoryMessage = (message: HostMsg) => message;
  sidebar.maybeUpdateCliOnUpgrade = vi.fn(async () => {});
  sidebar.maybePinBrokenCli = vi.fn(async () => {});
  sidebar.planModeCompatibility = vi.fn(async () => ({
    planModeAvailable: true,
    planModeVersionVerified: true,
    usedCache: true,
  }));
  sidebar.applyPlanModeCompatibility = vi.fn();
  sidebar.setProviderNeedsLogin = vi.fn();
  sidebar.buildEnv = vi.fn(() => ({ ...process.env }));
  sidebar.view = { webview: { postMessage: vi.fn() } };
  return sidebar;
}

describe("startSession open-timing line", () => {
  it("logs one summary with every phase after a fake-client resume", async () => {
    const sidebar = makeSidebar("/repo");
    const previous = { dispose: vi.fn(async () => {}) };
    sidebar.focused.client = previous;

    const client = await sidebar.startSession("resume-1", sidebar.focused);
    expect(client).toBeDefined();
    expect(previous.dispose).toHaveBeenCalledTimes(1);

    const lines = sidebar.host.appendLine.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((line: string) => line.startsWith("session open:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^session open: dispose \d+ms · version \d+ms \(cached\) · spawn\+init \d+ms · load \d+ms · replay\(post\) \d+ms · total \d+ms \(events: \d+\)$/,
    );
    expect(lines[0]).toContain("events: 1");
  });
});
