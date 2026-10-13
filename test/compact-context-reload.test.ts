/**
 * #195: "Context 80%, then /compact, then reload — still 80%."
 *
 * Drives the real send → client events → persist path, then a fresh sidebar
 * over the same state, so the figure a reload paints is the figure the
 * compaction left behind. Event orders are the ones measured on the pinned
 * adapters (research/claude-acp.md) and grok 1.0.46.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import { contextUsageFromLog, type SessionMetaOverrides } from "../src/sessions";
import type { HostMsg } from "../src/protocol";

type Script = (client: any) => void;

const control = {
  promptScript: undefined as Script | undefined,
  promptMeta: {} as Record<string, unknown>,
  sessionInfo: undefined as unknown,
};

vi.mock("../src/acp", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  const actual = await importOriginal<typeof import("../src/acp")>();
  class FakeAcpClient extends EventEmitter {
    setHumanWaitActive = vi.fn();
    provider: string;
    usesClientPlanGate = false;
    sessionId: string | undefined;
    availableModels: { modelId: string; name: string }[] = [];
    availableCommands: { name: string }[] = [];
    currentModelId = "fake-model";
    constructor(opts: { backend?: { provider?: string } }) {
      super();
      this.provider = opts.backend?.provider ?? "grok";
    }
    async start(): Promise<void> {
      this.emit("initialized", { protocolVersion: 1, serverInfo: { version: "1.0.46" } });
    }
    async newSession(): Promise<{ sessionId: string }> {
      this.sessionId = "conv-1";
      this.emit("session", { sessionId: this.sessionId });
      return { sessionId: this.sessionId };
    }
    async loadSession(sessionId: string): Promise<{ sessionId: string }> {
      this.sessionId = sessionId;
      this.emit("session", { sessionId });
      this.emit("sessionLoaded", { sessionId });
      return { sessionId };
    }
    async prompt(): Promise<Record<string, unknown>> {
      control.promptScript?.(this);
      const meta = control.promptMeta;
      this.emit("promptComplete", meta);
      return meta;
    }
    async getSessionInfo(): Promise<unknown> {
      return control.sessionInfo;
    }
    async dispose(): Promise<void> {}
    async setMode(): Promise<void> {}
    supportsInterject(): boolean { return false; }
    isCredentialError(): boolean { return false; }
  }
  return { ...actual, AcpClient: FakeAcpClient };
});

import { GrokSidebar } from "../src/sidebar";

const META_KEY = "grok.sessionMeta";

function makeSidebar(provider: "grok" | "codex" | "claude", memento: Record<string, unknown>): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.startTurnDiffBaseline = vi.fn();
  sidebar.pendingTurnDiffCaptures = new WeakSet();
  sidebar.providerConnectionState = { grok: provider === "grok", codex: provider === "codex", claude: provider === "claude" };
  sidebar.providerConnections = vi.fn(() => sidebar.providerConnectionState);
  sidebar.connectedProviders = vi.fn(() => [provider]);
  sidebar.usableProviders = vi.fn(() => [provider]);
  sidebar.providerNeedsLogin = {};
  sidebar.providerCliVersions = {};
  sidebar.remoteClients = new RemoteClientState<Session>("/repo");
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.provider = provider;
  sidebar.focused.cwd = "/repo";
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.sessionCache = new Map();
  sidebar.loginReprobeTimers = new Map();
  sidebar.turnOrderTimers = new Set();
  sidebar.pendingConfirms = new Map();
  sidebar.fullImagePaths = new Map();
  sidebar.pendingAttach = new Set();
  sidebar.sessionStartTails = new WeakMap();
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
    showErrorMessage: vi.fn(async () => undefined),
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
  sidebar.context = { globalStorageUri: { fsPath: "/repo" }, subscriptions: [] };
  sidebar.terminalManager = { create: vi.fn(), disposeAll: vi.fn(), ownedBy: vi.fn(() => ({ create: vi.fn() })), releaseOwnedBy: vi.fn(() => 0) };
  sidebar.workspaceRoot = vi.fn(() => "/repo");
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || "/repo");
  sidebar.locateProvider = vi.fn(() => "/fake/cli");
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
  sidebar.retainUploadedFilesForSession = vi.fn(async () => {});
  sidebar.rememberProjectProvider = vi.fn(async () => {});
  sidebar.reportSessionStart = vi.fn();
  sidebar.noteSessionActivity = vi.fn();
  sidebar.maybeGenerateTitle = vi.fn();
  sidebar.postChips = vi.fn();
  sidebar.refreshImplicitChip = vi.fn();
  sidebar.settleUnavailablePlanTurn = vi.fn();
  sidebar.recoverAuthAndResend = vi.fn(async () => false);
  sidebar.bindSubscriptionUsage = vi.fn();
  sidebar.refreshSubscriptionUsage = vi.fn(async () => {});
  sidebar.setStatus = (session: Session, status: Session["status"]) => { session.status = status; };
  sidebar.posted = [] as HostMsg[];
  sidebar.emit = (session: Session, message: HostMsg) => {
    if (message.type === "clearMessages") session.buffer = [];
    else session.buffer.push(message);
    sidebar.posted.push(message);
  };
  sidebar.view = { webview: { postMessage: (message: HostMsg) => sidebar.posted.push(message) } };
  return sidebar;
}

function contextFrames(sidebar: any): { used?: number; window?: number }[] {
  return sidebar.posted.filter((m: HostMsg) => m.type === "contextUsage");
}

function reset(): void {
  control.promptScript = undefined;
  control.promptMeta = {};
  control.sessionInfo = undefined;
}

const WINDOW = 258400;
const BIG = 206000; // ~80% of the window

/** One ordinary turn that leaves the conversation at ~80%. */
async function seedTurn(sidebar: any): Promise<void> {
  control.promptScript = (client) => client.emit("adapterUsageUpdate", BIG, WINDOW);
  control.promptMeta = { totalTokens: BIG + 5, usage: { inputTokens: BIG, outputTokens: 5, totalTokens: BIG + 5 } };
  await sidebar.handleSend("fill the context", true);
}

describe("context meter after /compact and a reload (#195)", () => {
  beforeEach(reset);
  afterEach(reset);

  it("Codex: the compacted size arrives BEFORE completed and is what a reload shows", async () => {
    const memento: Record<string, unknown> = {};
    const sidebar = makeSidebar("codex", memento);
    await sidebar.startSession(undefined, sidebar.focused);
    const id = sidebar.focused.activeSessionId as string;
    await seedTurn(sidebar);
    expect((memento[META_KEY] as SessionMetaOverrides)[id].contextUsed).toBe(BIG);

    // codex-acp 1.11.0 + codex-cli 0.159.0, measured: started → usage → completed.
    const meta = { contextCompaction: { version: 1 } };
    control.promptScript = (client) => {
      client.emit("toolCall", { sessionUpdate: "tool_call", toolCallId: "cmp", title: "Compact conversation", kind: "think", status: "in_progress", _meta: meta });
      client.emit("adapterUsageUpdate", 12037, WINDOW);
      client.emit("toolCallUpdate", { sessionUpdate: "tool_call_update", toolCallId: "cmp", title: "Compact conversation", status: "completed", _meta: meta });
    };
    control.promptMeta = { totalTokens: 12037, usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, totalTokens: 12037 } };
    sidebar.posted = [];
    await sidebar.handleSend("/compact", true);

    expect(contextFrames(sidebar).at(-1)?.used).toBe(12037);
    const stored = (memento[META_KEY] as SessionMetaOverrides)[id];
    expect(stored.contextUsed).toBe(12037);
    expect(stored.contextPendingCompact).toBeUndefined();
    // A rewind refolds the log; it must land on the compacted size, not the old peak.
    expect(stored.usageLog?.at(-1)).toMatchObject({ contextUsed: 12037, compacted: true });
    expect(contextUsageFromLog(stored.usageLog).used).toBe(12037);

    const reloaded = makeSidebar("codex", memento);
    await reloaded.startSession(id, reloaded.focused);
    expect(contextFrames(reloaded).at(-1)).toEqual(expect.objectContaining({ used: 12037, window: WINDOW }));
    expect(contextFrames(reloaded).some((m) => m.used === BIG)).toBe(false);
  });

  it("Claude: the compacted size arrives AFTER completed and is what a reload shows", async () => {
    const memento: Record<string, unknown> = {};
    const sidebar = makeSidebar("claude", memento);
    await sidebar.startSession(undefined, sidebar.focused);
    const id = sidebar.focused.activeSessionId as string;
    await seedTurn(sidebar);

    // claude-agent-acp 0.76.0, measured: started → completed → status-less
    // postTokens enrichment → usage_update.
    const meta = { contextCompaction: { version: 1 }, claudeCode: { toolName: "compact" } };
    control.promptScript = (client) => {
      client.emit("toolCall", { sessionUpdate: "tool_call", toolCallId: "cmp", title: "Compact conversation", kind: "think", status: "in_progress", _meta: meta });
      client.emit("toolCallUpdate", { sessionUpdate: "tool_call_update", toolCallId: "cmp", status: "completed", _meta: meta });
      client.emit("toolCallUpdate", {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmp",
        _meta: { ...meta, contextCompaction: { version: 1, trigger: "manual", preTokens: BIG, postTokens: 3647 } },
      });
      client.emit("adapterUsageUpdate", 3647, WINDOW);
    };
    control.promptMeta = { totalTokens: 0, usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 0 } };
    await sidebar.handleSend("/compact", true);

    const stored = (memento[META_KEY] as SessionMetaOverrides)[id];
    expect(stored.contextUsed).toBe(3647);
    expect(stored.contextPendingCompact).toBeUndefined();
    expect(contextUsageFromLog(stored.usageLog).used).toBe(3647);

    const reloaded = makeSidebar("claude", memento);
    await reloaded.startSession(id, reloaded.focused);
    expect(contextFrames(reloaded).at(-1)).toEqual(expect.objectContaining({ used: 3647 }));
  });

  it("the next turn after a compaction grows from the compacted size, not the old peak", async () => {
    const memento: Record<string, unknown> = {};
    const sidebar = makeSidebar("codex", memento);
    await sidebar.startSession(undefined, sidebar.focused);
    const id = sidebar.focused.activeSessionId as string;
    await seedTurn(sidebar);
    const meta = { contextCompaction: { version: 1 } };
    control.promptScript = (client) => {
      client.emit("toolCall", { sessionUpdate: "tool_call", toolCallId: "cmp", status: "in_progress", _meta: meta });
      client.emit("adapterUsageUpdate", 12037, WINDOW);
      client.emit("toolCallUpdate", { sessionUpdate: "tool_call_update", toolCallId: "cmp", status: "completed", _meta: meta });
    };
    control.promptMeta = { totalTokens: 12037, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 12037 } };
    await sidebar.handleSend("/compact", true);

    control.promptScript = (client) => client.emit("adapterUsageUpdate", 14000, WINDOW);
    control.promptMeta = { totalTokens: 14010, usage: { inputTokens: 14000, outputTokens: 10, totalTokens: 14010 } };
    await sidebar.handleSend("next question", true);
    expect((memento[META_KEY] as SessionMetaOverrides)[id].contextUsed).toBe(14000);
  });

  it("Grok: a reload paints the live CLI's figure, not signals.json's pre-compact count", async () => {
    const memento: Record<string, unknown> = {};
    const sidebar = makeSidebar("grok", memento);
    // signals.json after /compact still reads the pre-compact count (grok 1.0.46).
    sidebar.emitContextUsage = vi.fn((session: Session) => {
      sidebar.emit(session, { type: "contextUsage", used: 28855, window: 256000 });
    });
    control.sessionInfo = { used: 7450, window: 256000 };
    await sidebar.startSession("grok-conv", sidebar.focused);
    await vi.waitFor(() => expect(contextFrames(sidebar).some((m) => m.used === 7450)).toBe(true));
    expect(sidebar.emitContextUsage).not.toHaveBeenCalled();
    expect(contextFrames(sidebar).some((m) => m.used === 28855)).toBe(false);
  });

  it("Grok: a CLI without session/info still gets the signals.json seed", async () => {
    const memento: Record<string, unknown> = {};
    const sidebar = makeSidebar("grok", memento);
    sidebar.emitContextUsage = vi.fn((session: Session) => {
      sidebar.emit(session, { type: "contextUsage", used: 28855, window: 256000 });
    });
    control.sessionInfo = "unsupported";
    await sidebar.startSession("grok-conv", sidebar.focused);
    await vi.waitFor(() => expect(sidebar.emitContextUsage).toHaveBeenCalledTimes(1));
    expect(contextFrames(sidebar).at(-1)?.used).toBe(28855);
  });
});
