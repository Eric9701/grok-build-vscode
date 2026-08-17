import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  ClaudeBackend,
  claudeModeId,
  configStateFromClaudeOptions,
  isClaudeCredentialError,
  listClaudeSessions,
  modelsFromClaudeConfigOptions,
  normalizeClaudePermissionParams,
  normalizeClaudePromptResult,
  normalizeClaudeSessionResponse,
  normalizeClaudeUpdate,
  resolveClaudeAgentAcpAdapter,
} from "../src/claude-backend";

describe("Claude adapter spawn", () => {
  it("runs Electron as Node and points the SDK at the user's Claude CLI", () => {
    const spec = new ClaudeBackend({ adapterPath: "adapter.js", nodePath: "electron.exe" }).spawn({
      cliPath: "claude.exe",
      cwd: "C:\\repo",
      env: { ELECTRON_RUN_AS_NODE: "0", KEEP_ME: "yes" },
    });
    expect(spec.env).toMatchObject({
      CLAUDE_CODE_EXECUTABLE: "claude.exe",
      ELECTRON_RUN_AS_NODE: "1",
      KEEP_ME: "yes",
    });
    expect(spec.args).toEqual(["adapter.js"]);
  });

  it("does not pass a hide-subscription flag", () => {
    // Deliberate: `--hide-claude-auth` would reject subscription accounts that
    // already work in official Claude Code. We never handle the credential.
    const spec = new ClaudeBackend({ adapterPath: "adapter.js" }).spawn({
      cliPath: "claude",
      cwd: "/repo",
      env: {},
    });
    expect(spec.args.join(" ")).not.toMatch(/hide-claude-auth/);
  });

  it("resolves the adapter through package.json bin, not the unexported package root", () => {
    const resolved = resolveClaudeAgentAcpAdapter();
    expect(resolved.replace(/\\/g, "/")).toMatch(/@agentclientprotocol\/claude-agent-acp\/dist\/index\.js$/);
    expect(() => require.resolve("@agentclientprotocol/claude-agent-acp")).toThrow(/ERR_PACKAGE_PATH_NOT_EXPORTED|No "exports" main defined/);
  });

  it("joins the manifest directory with the declared bin", () => {
    const resolved = resolveClaudeAgentAcpAdapter(
      () => path.join("C:", "ext", "node_modules", "@agentclientprotocol", "claude-agent-acp", "package.json"),
      () => JSON.stringify({ bin: { "claude-agent-acp": "dist/index.js" } }),
    );
    expect(resolved).toBe(path.join("C:", "ext", "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js"));
  });
});

describe("Claude session model mapping", () => {
  const configOptions = [
    {
      id: "model",
      currentValue: "claude-opus-4-6",
      options: [
        { value: "default", name: "Default" },
        { value: "claude-opus-4-6", name: "Opus", description: "strongest" },
        { value: "claude-sonnet-4-6", name: "Sonnet" },
      ],
    },
    {
      id: "effort",
      currentValue: "high",
      options: [
        { value: "default", name: "Default" },
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
    { id: "mode", currentValue: "plan" },
  ];

  it("turns configOptions into the host picker envelope", () => {
    const models = modelsFromClaudeConfigOptions(configOptions);
    expect(models.currentModelId).toBe("claude-opus-4-6");
    expect(models.availableModels).toHaveLength(3);
    expect(models.availableModels[1]).toMatchObject({
      modelId: "claude-opus-4-6",
      name: "Opus",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [{ value: "low" }, { value: "high" }],
      },
    });
  });

  it("fills models on session/new so the picker is not empty", () => {
    const normalized = normalizeClaudeSessionResponse({ sessionId: "s1", configOptions });
    expect(normalized.sessionId).toBe("s1");
    expect(normalized.models.currentModelId).toBe("claude-opus-4-6");
    expect(normalized.models.availableModels).toHaveLength(3);
  });
});

describe("Claude output and usage normalization", () => {
  it("feeds usage_update window without treating billed used as occupancy", () => {
    expect(normalizeClaudeUpdate({ sessionUpdate: "usage_update", used: 12, size: 200000 }, { replay: false }))
      .toEqual({
        update: { sessionUpdate: "usage_update", used: 12, size: 200000 },
        meta: { replay: false },
        contextWindow: 200000,
        usageUpdateUsed: 12,
      });
  });

  it("lifts a session title off session_info_update", () => {
    expect(normalizeClaudeUpdate({ sessionUpdate: "session_info_update", title: " Named " }))
      .toEqual({ sessionTitle: "Named" });
  });

  it("maps prompt usage into existing meta and keeps occupancy off the billed total", () => {
    const result = normalizeClaudePromptResult({
      stopReason: "end_turn",
      usage: {
        totalTokens: 35671,
        inputTokens: 2,
        outputTokens: 12,
        cachedReadTokens: 25408,
        cachedWriteTokens: 10249,
        thoughtTokens: 3,
      },
    });
    expect(result._meta).toMatchObject({
      totalTokens: 35659,
      cachedWriteTokens: 10249,
      reasoningTokens: 3,
      usage: {
        totalTokens: 35671,
        inputTokens: 2,
        outputTokens: 12,
        cachedReadTokens: 25408,
        cachedWriteTokens: 10249,
        reasoningTokens: 3,
      },
    });
  });
});

describe("Claude permission and mode mapping", () => {
  it("synthesizes a title only when the adapter left the card untitled", () => {
    const untitled = normalizeClaudePermissionParams({
      toolCall: { kind: "execute", rawInput: { command: "npm test" } },
      options: [{ optionId: "allow_once" }],
    });
    expect(untitled.toolCall.title).toBe("npm test");
    const titled = { toolCall: { title: "Edit src.ts", kind: "edit" }, options: [] };
    expect(normalizeClaudePermissionParams(titled)).toEqual(titled);
  });

  it("maps host Agent/Auto-accept onto Claude permission modes", () => {
    expect(claudeModeId("yolo")).toBe("bypassPermissions");
    expect(claudeModeId("agent")).toBe("default");
    expect(claudeModeId("plan")).toBe("plan");
    expect(new ClaudeBackend().setMode("sid", "yolo")).toEqual({
      method: "session/set_mode",
      params: { sessionId: "sid", modeId: "bypassPermissions" },
    });
  });

  it("reads model, effort, and mode from configOptions", () => {
    expect(configStateFromClaudeOptions({
      configOptions: [
        { id: "model", currentValue: "claude-sonnet-4-6" },
        { id: "effort", currentValue: "low" },
        { id: "mode", currentValue: "bypassPermissions" },
      ],
    }, {})).toEqual({
      modelId: "claude-sonnet-4-6",
      reasoningEffort: "low",
      modeId: "bypassPermissions",
    });
  });
});

describe("Claude session listing", () => {
  it("passes cwd, filters the checkout, and stops when there is no cursor", async () => {
    const calls: Array<string | undefined> = [];
    const result = await listClaudeSessions(async (cursor) => {
      calls.push(cursor);
      return {
        sessions: [
          { sessionId: "one", cwd: "C:\\GitHub\\Repo", title: "One", updatedAt: "2026-08-01T00:00:00.000Z" },
          { sessionId: "other", cwd: "C:\\GitHub\\Elsewhere", title: "Other" },
        ],
      };
    }, "c:\\github\\repo", "win32");
    expect(calls).toEqual([undefined]);
    expect(result).toEqual({
      sessions: [
        { sessionId: "one", cwd: "C:\\GitHub\\Repo", title: "One", updatedAt: "2026-08-01T00:00:00.000Z" },
      ],
      nextCursor: null,
    });
  });
});

describe("Claude auth classification", () => {
  it("matches the adapter's login and subscription-refusal text, not quota", () => {
    expect(isClaudeCredentialError({ message: "Not logged in · Please run /login" })).toBe(true);
    expect(isClaudeCredentialError({ message: "Session expired. Please run /login to sign in again." })).toBe(true);
    expect(isClaudeCredentialError({ message: "This integration does not support using claude.ai subscriptions." })).toBe(true);
    expect(isClaudeCredentialError({ message: "quota exhausted for this account" })).toBe(false);
    expect(new ClaudeBackend().isCredentialError({ message: "authentication required" })).toBe(true);
  });
});
