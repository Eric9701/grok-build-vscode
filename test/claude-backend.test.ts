import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  ClaudeBackend,
  claudeModeId,
  claudeDefaultModelName,
  claudeModelDescription,
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
    expect(models.availableModels.map((m) => m.modelId))
      .toEqual(["claude-opus-4-6", "claude-sonnet-4-6"]);
    expect(models.availableModels.find((m) => m.modelId === "claude-opus-4-6")).toMatchObject({
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
    expect(normalized.models.availableModels).toHaveLength(2);
  });

  // The vendor's own list, measured out of claude-agent-acp on 2026-09-14.
  const shippedOptions = (currentValue: string) => [{
    id: "model",
    currentValue,
    options: [
      { value: "default", name: "Default (recommended)", description: "Opus (1M context)" },
      { value: "opus[1m]", name: "Opus 5", description: "Opus 5 with 1M context · Best for everyday, complex tasks" },
      { value: "sonnet", name: "Sonnet 5", description: "Sonnet 5 · Efficient for routine tasks" },
    ],
  }];

  it("keeps a policy row out of a list of models", () => {
    expect(modelsFromClaudeConfigOptions(shippedOptions("sonnet")).availableModels.map((m) => m.modelId))
      .toEqual(["opus[1m]", "sonnet"]);
  });

  // Dropping the row a session is ON would leave the picker with nothing
  // checked and the composer chip showing the raw id.
  it("keeps it when it is the model the session is actually on", () => {
    expect(modelsFromClaudeConfigOptions(shippedOptions("default")).availableModels.map((m) => m.modelId))
      .toEqual(["default", "opus[1m]", "sonnet"]);
  });

  // "Default (recommended)" says nothing; the row names what it resolves to,
  // and its value stays the vendor's `default`.
  it("labels the default row with the model it resolves to", () => {
    const row = modelsFromClaudeConfigOptions(shippedOptions("default")).availableModels[0];
    expect(row).toMatchObject({ modelId: "default", name: "Default (Opus 5)" });
  });

  // The picker promotes a description's lead over the name when it spells the
  // name out more fully, so a capability qualifier there becomes the model's
  // visible name everywhere — picker row AND composer chip.
  it("keeps a context size out of the model's name", () => {
    const opus = modelsFromClaudeConfigOptions(shippedOptions("sonnet"))
      .availableModels.find((m) => m.modelId === "opus[1m]");
    expect(opus.description).toBe("Opus 5 · Best for everyday, complex tasks");
  });
});

describe("claudeDefaultModelName", () => {
  const rows = [
    { value: "default", name: "Default (recommended)" },
    { value: "opus[1m]", name: "Opus 5.5", description: "Opus 5.5 with 1M context · Best for everyday, complex tasks" },
    { value: "opus", name: "Opus 5.5 (200K)", description: "Opus 5.5 with 200K context · x" },
    { value: "claude-fable-5-1[1m]", name: "Fable 5.1", description: "Fable 5.1 · Most capable" },
    { value: "sonnet", name: "Sonnet 5", description: "Sonnet 5 · Efficient for routine tasks" },
  ];

  it("names the row the adapter's description points at", () => {
    // The family and its context size pick one of two Opus rows.
    expect(claudeDefaultModelName("Opus (1M context)", rows)).toBe("Opus 5.5");
    expect(claudeDefaultModelName("Sonnet", rows)).toBe("Sonnet 5");
    expect(claudeDefaultModelName("Fable 5.1", rows)).toBe("Fable 5.1");
    // An older SDK's wording.
    expect(claudeDefaultModelName("Use the default model (currently Sonnet 5) · $3/$15 per Mtok", rows)).toBe("Sonnet 5");
  });

  it("falls back to the adapter's own words, never a guess", () => {
    // Two Opus rows and no context size to choose between them.
    expect(claudeDefaultModelName("Opus", rows)).toBe("Opus");
    // No row shares the resolved model: the adapter sends its id.
    expect(claudeDefaultModelName("claude-opus-6[1m]", rows)).toBe("claude-opus-6[1m]");
    expect(claudeDefaultModelName("Haiku (200K context)", rows)).toBe("Haiku, 200K context");
    expect(claudeDefaultModelName("", rows)).toBeUndefined();
    expect(claudeDefaultModelName(undefined, rows)).toBeUndefined();
  });
});

describe("claudeModelDescription", () => {
  it("strips the context qualifier wherever the vendor spells it", () => {
    expect(claudeModelDescription("Opus 5 with 1M context · Best for everyday")).toBe("Opus 5 · Best for everyday");
    expect(claudeModelDescription("Sonnet 5 with 200K context")).toBe("Sonnet 5");
    expect(claudeModelDescription("Opus 5 with 1.5M context · x")).toBe("Opus 5 · x");
  });

  it("leaves a description that is not one alone", () => {
    expect(claudeModelDescription("Sonnet 5 · Efficient for routine tasks"))
      .toBe("Sonnet 5 · Efficient for routine tasks");
    // "context" as prose, not as a window size.
    expect(claudeModelDescription("Best with a lot of context")).toBe("Best with a lot of context");
    expect(claudeModelDescription(undefined)).toBeUndefined();
    expect(claudeModelDescription(42)).toBeUndefined();
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
