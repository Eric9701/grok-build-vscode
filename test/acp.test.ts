import { describe, it, expect, vi } from "vitest";
import { AcpClient, buildGrokAgentArgs } from "../src/acp";

// Unit tests for AcpClient internals that don't need a real subprocess. We
// stand up the client with a fake writable proc and drive `request`/`onLine`
// directly.
function clientWithFakeProc(): { client: AcpClient; written: string[] } {
  const client = new AcpClient({ cliPath: "x", cwd: "/", log: () => {} });
  const written: string[] = [];
  (client as any).proc = {
    killed: false,
    stdin: { writable: true, write: (s: string) => written.push(s) },
  };
  return { client, written };
}

describe("AcpClient notification metadata", () => {
  it("preserves session/update metadata on routed text events", () => {
    const { client } = clientWithFakeProc();
    const seen: unknown[] = [];
    client.on("userMessageChunk", (text, meta) => seen.push({ text, meta }));

    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "restored" },
        },
        _meta: { agentTimestampMs: 1_783_845_298_123, isReplay: true },
      },
    }));

    expect(seen).toEqual([{
      text: "restored",
      meta: { agentTimestampMs: 1_783_845_298_123, isReplay: true },
    }]);
  });

  it("preserves metadata on persisted xAI lifecycle events", () => {
    const { client } = clientWithFakeProc();
    const seen: unknown[] = [];
    client.on("subagentLifecycle", (update, meta) => seen.push({ update, meta }));

    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        update: { sessionUpdate: "turn_completed", prompt_id: "p1" },
        _meta: { agentTimestampMs: 1_783_845_299_456, isReplay: true },
      },
    }));

    expect(seen).toEqual([{
      update: { sessionUpdate: "turn_completed", prompt_id: "p1" },
      meta: { agentTimestampMs: 1_783_845_299_456, isReplay: true },
    }]);
  });
});

describe("AcpClient permission responses", () => {
  it("can decline a request when no safe option was offered", () => {
    const { client, written } = clientWithFakeProc();
    expect(client.respondPermissionCancelled(9)).toBe(true);
    expect(JSON.parse(written[0])).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  it("surfaces accepted writes for every user response", async () => {
    const { client } = clientWithFakeProc();
    (client as any).sessionId = "session-1";

    expect(client.respondPermission(1, "allow-once")).toBe(true);
    expect(client.respondExitPlan(2, "approved")).toBe(true);
    expect(client.respondExitPlanUnavailable(3)).toBe(true);
    expect(client.respondQuestion(4, { Pick: "One" })).toBe(true);
    expect(client.respondQuestionCancelled(5)).toBe(true);
    await expect(client.cancel()).resolves.toBe(true);
  });
});

describe("AcpClient Plan terminal environment", () => {
  it("strips agent-supplied environment overrides from allowed Plan commands", async () => {
    const { client, written } = clientWithFakeProc();
    const create = vi.fn(() => ({ terminalId: "t-1" }));
    client.planActive = true;
    (client as any).terminal = { create };

    await (client as any).handleServerRequest({
      id: 12,
      method: "terminal/create",
      params: {
        command: "node --version",
        cwd: "/workspace",
        env: [
          { name: "NODE_OPTIONS", value: "--require ./evil.js" },
          { name: "PATH", value: "/attacker/bin" },
        ],
      },
    });

    expect(create).toHaveBeenCalledWith({
      command: "node --version",
      cwd: "/workspace",
    });
    expect(JSON.parse(written[0])).toEqual({
      jsonrpc: "2.0",
      id: 12,
      result: { terminalId: "t-1" },
    });
  });

  it("preserves agent-supplied environment overrides outside Plan mode", async () => {
    const { client } = clientWithFakeProc();
    const create = vi.fn(() => ({ terminalId: "t-1" }));
    client.planActive = false;
    (client as any).terminal = { create };
    const env = [{ name: "EXAMPLE", value: "kept" }];

    await (client as any).handleServerRequest({
      id: 13,
      method: "terminal/create",
      params: { command: "custom-command", env },
    });

    expect(create).toHaveBeenCalledWith({ command: "custom-command", env });
  });
});

describe("AcpClient.request timer lifecycle", () => {
  it("clears the per-request timeout when the response arrives (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      const { client } = clientWithFakeProc();
      const before = vi.getTimerCount();

      const p = (client as any).request("session/set_mode", { modeId: "plan" }); // id = 1
      expect(vi.getTimerCount()).toBe(before + 1); // timeout armed

      (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
      await p;

      expect(vi.getTimerCount()).toBe(before); // timeout cleared on response
    } finally {
      vi.useRealTimers();
    }
  });
});

// #3/#4 (thanks @shugav for the crash report): the startup crash was the bogus
// `max` value, not reasoningEffort itself — grok accepts none|minimal|low|medium|
// high|xhigh, and the flag must precede the `stdio` subcommand.
describe("buildGrokAgentArgs", () => {
  it("starts ACP sessions with the stdio subcommand when no effort is set", () => {
    expect(buildGrokAgentArgs()).toEqual(["agent", "stdio"]);
  });

  it("forwards a valid effort as --reasoning-effort before the stdio subcommand", () => {
    expect(buildGrokAgentArgs("high")).toEqual(["agent", "--reasoning-effort", "high", "stdio"]);
    expect(buildGrokAgentArgs("none")).toEqual(["agent", "--reasoning-effort", "none", "stdio"]);
    expect(buildGrokAgentArgs("xhigh")).toEqual(["agent", "--reasoning-effort", "xhigh", "stdio"]);
  });
});
