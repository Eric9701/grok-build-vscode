import { describe, it, expect, vi } from "vitest";
import {
  AcpClient,
  ACP_DELEGATED_FS_CAPABILITIES,
  ACP_IMAGE_READ_FS_CAPABILITIES,
  acpClientCapabilities,
  buildGrokAgentArgs,
} from "../src/acp";

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
  it("emits the live context count from the session/update envelope", () => {
    const { client } = clientWithFakeProc();
    const seen: number[] = [];
    client.on("contextUsage", (used) => seen.push(used));

    for (const totalTokens of [5487, 5487, 15781, 16015, 0]) {
      (client as any).onLine(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
          _meta: { totalTokens },
        },
      }));
    }

    expect(seen).toEqual([5487, 15781, 16015]);
  });

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

describe("AcpClient child-stream demux", () => {
  const parentId = "sess-parent";
  const childId = "sess-child";

  function feed(client: AcpClient, sessionId: string | undefined, update: object, meta?: object) {
    (client as any).onLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        ...(sessionId ? { sessionId } : {}),
        update,
        ...(meta ? { _meta: meta } : {}),
      },
    }));
  }

  it("emits a child stream — never the parent message path — when sessionId differs", () => {
    const { client } = clientWithFakeProc();
    (client as any).sessionId = parentId;
    const parentChunks: string[] = [];
    const child: unknown[] = [];
    client.on("messageChunk", (text: string) => parentChunks.push(text));
    client.on("thoughtChunk", (text: string) => parentChunks.push("T:" + text));
    client.on("toolCall", (payload: unknown) => parentChunks.push("tool"));
    client.on("childStream", (ev: unknown) => child.push(ev));

    feed(client, childId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child-prose" } });
    feed(client, childId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "child-think" } });
    feed(client, childId, { sessionUpdate: "tool_call", toolCallId: "t-child", title: "list_dir" });
    feed(client, parentId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent-prose" } });

    expect(parentChunks).toEqual(["parent-prose"]);
    expect(child).toEqual([
      { childSessionId: childId, route: { event: "messageChunk", text: "child-prose" }, meta: undefined },
      { childSessionId: childId, route: { event: "thoughtChunk", text: "child-think" }, meta: undefined },
      { childSessionId: childId, route: { event: "toolCall", payload: { sessionUpdate: "tool_call", toolCallId: "t-child", title: "list_dir" } }, meta: undefined },
    ]);
  });

  it("treats a missing sessionId as the parent conversation (legacy CLI)", () => {
    const { client } = clientWithFakeProc();
    (client as any).sessionId = parentId;
    const parentChunks: string[] = [];
    const child: unknown[] = [];
    client.on("messageChunk", (text: string) => parentChunks.push(text));
    client.on("childStream", (ev: unknown) => child.push(ev));
    feed(client, undefined, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "legacy" } });
    expect(parentChunks).toEqual(["legacy"]);
    expect(child).toEqual([]);
  });

  it("does not emit a hidden user_message_chunk", () => {
    const { client } = clientWithFakeProc();
    (client as any).sessionId = parentId;
    const seen: unknown[] = [];
    client.on("userMessageChunk", (text: string) => seen.push(text));
    client.on("childStream", (ev: unknown) => seen.push(ev));
    feed(client, parentId, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "<system-reminder>wake</system-reminder>" },
      _meta: { hideFromScrollback: true },
    });
    expect(seen).toEqual([]);
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
// #79: grok's image-aware read_file only runs when we do not advertise
// readTextFile. That workaround was measured on 1.0.4; apply it only there.
describe("acpClientCapabilities", () => {
  it("withholds readTextFile on grok 1.0.x", () => {
    expect(acpClientCapabilities("grok", "1.0.4")).toEqual(ACP_IMAGE_READ_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "grok 1.0.0 (abc) [stable]")).toEqual(ACP_IMAGE_READ_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "1.1.0").fs).not.toHaveProperty("readTextFile");
  });

  it("keeps the delegated handshake on grok 0.2.117", () => {
    expect(acpClientCapabilities("grok", "0.2.117")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "grok 0.2.117 (x) [stable]")).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });
  });

  it("keeps the delegated handshake for Codex", () => {
    expect(acpClientCapabilities("codex")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("codex", "1.0.4")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
  });

  it("keeps the delegated handshake when the grok version is unknown", () => {
    expect(acpClientCapabilities("grok")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", "unparseable")).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
    expect(acpClientCapabilities("grok", null)).toEqual(ACP_DELEGATED_FS_CAPABILITIES);
  });
});

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
