import { describe, expect, it } from "vitest";
import { GrokHookCalls } from "../src/grok-hooks";
import { AcpClient } from "../src/acp";
import { ClaudeBackend } from "../src/claude-backend";
import { CodexBackend } from "../src/codex-backend";
import { MuseBackend } from "../src/muse-backend";
import type { AcpBackend } from "../src/acp-backend";

const start = (prompt_id = "p1", event_name = "stop") => ({ sessionUpdate: "hook_run_started", event_name, prompt_id, count: 1 });
const result = (prompt_id = "p1", event_name = "stop", failed = false) => ({
  sessionUpdate: "hook_execution", event_name, prompt_id,
  runs: [{ name: "global/test-hook", status: failed
    ? { status: "failed", elapsed_ms: 3000, error: "exit code 1: intentional hook failure" }
    : { status: "success", elapsed_ms: 3000 } }],
});

describe("Grok lifecycle hook calls (#215)", () => {
  it("matches delayed results by prompt and session, independently of arrival order", () => {
    const hooks = new GrokHookCalls();
    const first = hooks.update(start(), "parent")![0];
    const second = hooks.update(start("p2"), "parent")![0];
    const child = hooks.update(start("p1", "subagent_stop"), "child")![0];
    expect(new Set([first.toolCallId, second.toolCallId, child.toolCallId]).size).toBe(3);
    expect(hooks.update(result(), "parent")![0]).toMatchObject({ toolCallId: first.toolCallId, status: "completed" });
    expect(hooks.update(result("p1", "subagent_stop"), "child")![0]).toMatchObject({ toolCallId: child.toolCallId, status: "completed" });
    expect(hooks.finish("parent")).toMatchObject([{ update: { toolCallId: second.toolCallId, status: "failed", title: "Stop hook interrupted" } }]);
    expect(hooks.finish()).toEqual([]);
  });

  it("renders cold-replayed failures without requiring a start, and deduplicates both rails", () => {
    const hooks = new GrokHookCalls();
    const update = hooks.update(result("p1", "stop", true), "parent", { eventId: "e1" })![0];
    expect(update).toMatchObject({ sessionUpdate: "tool_call", status: "failed", title: "Stop hook failed (global/test-hook)" });
    expect(update.content?.[0].content.text).toBe("stop hook (global/test-hook) failed, ignored: exit code 1: intentional hook failure");
    expect(hooks.update(result("p1", "stop", true), "parent", { eventId: "e1" })).toEqual([]);
  });

  it("ignores unrelated hooks, malformed starts and unrelated notifications", () => {
    const hooks = new GrokHookCalls();
    expect(hooks.update(start("p1", "pre_tool_use"), "s")).toEqual([]);
    expect(hooks.update({ ...start(), count: 0 }, "s")).toEqual([]);
    expect(hooks.update({ ...start(), count: "1" }, "s")).toEqual([]);
    expect(hooks.update({ ...result(), runs: null }, "s")).toEqual([]);
    expect(hooks.update({ ...result(), runs: [{ name: "unknown", status: { status: "future" } }] }, "s")).toEqual([]);
    expect(hooks.update({ ...result(), runs: [] }, "s")).toEqual([]);
    expect(hooks.update({ sessionUpdate: "response_completed" }, "s")).toBeNull();
    expect(hooks.finish()).toEqual([]);
  });

  it("keeps a batch running on a duplicate start and reports mixed outcomes", () => {
    const hooks = new GrokHookCalls();
    const first = hooks.update({ ...start(), count: 3 }, "s")![0];
    expect(hooks.update(start(), "s")).toEqual([]);
    const update = hooks.update({ ...result(), runs: [
      ...result().runs, ...result("p1", "stop", true).runs,
      { name: "skipped", status: { status: "skipped" } },
    ] }, "s")![0];
    expect(update).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: first.toolCallId, status: "failed" });
    expect(update.content?.[0].content.text).toContain("intentional hook failure");
    expect(hooks.finish()).toEqual([]);
  });

  it("distinguishes a blocking hook from an ignored failure and allows a fresh replay", () => {
    const hooks = new GrokHookCalls();
    const blocked = { ...result(), runs: [{ name: "gate", status: { status: "failed", blocked: true, error: "Tests failed" } }] };
    const first = hooks.update(blocked, "s", { eventId: "same" })![0];
    expect(first.title).toBe("Stop hook blocked (gate)");
    expect(first.content?.[0].content.text).toBe("stop hook (gate) blocked: Tests failed");
    hooks.reset();
    expect(hooks.update(blocked, "s", { eventId: "same" })).toHaveLength(1);
  });
});

function harness(backend?: AcpBackend) {
  const client = new AcpClient({ cliPath: "unused", cwd: "/", log() {}, backend });
  client.sessionId = "parent";
  const writes: any[] = [];
  (client as any).proc = { stdin: { writable: true, write: (line: string) => writes.push(JSON.parse(line)) } };
  const calls: any[] = [], children: any[] = [], completed: any[] = [];
  client.on("toolCall", (call) => calls.push(call));
  client.on("toolCallUpdate", (call) => calls.push(call));
  client.on("childStream", (child) => children.push(child));
  client.on("promptComplete", (meta) => completed.push(meta));
  const notify = (update: any, sessionId = "parent", method = "_x.ai/session_notification", _meta?: any) => {
    (client as any).onLine(JSON.stringify({ jsonrpc: "2.0", method, params: { sessionId, update, _meta } }));
  };
  return { client, writes, calls, children, completed, notify };
}

describe("ACP hook routing", () => {
  it.each(["_x.ai/session_notification", "_x.ai/session/update", "session/update"])("routes %s through the existing tool channel", (method) => {
    const h = harness();
    h.notify(start(), "parent", method);
    h.notify(result("p1", "stop", true), "parent", method);
    expect(h.calls.map((call) => call.status)).toEqual(["in_progress", "failed"]);
    expect(h.calls[1].toolCallId).toBe(h.calls[0].toolCallId);
    expect(h.children).toEqual([]);
  });

  it("keeps the prompt pending through response_completed and the hook's execution", async () => {
    const h = harness();
    const pending = h.client.prompt("hi");
    h.notify({ sessionUpdate: "response_completed" });
    h.notify(start());
    expect(h.completed).toEqual([]);
    h.notify(result());
    expect(h.completed).toEqual([]);
    (h.client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: h.writes[0].id, result: { stopReason: "end_turn" } }));
    await pending;
    expect(h.completed).toHaveLength(1);
    expect(h.calls.map((call) => call.status)).toEqual(["in_progress", "completed"]);
  });

  it("routes a child's hook into its own card and ends only the parent's hooks on cancel", async () => {
    const h = harness();
    const pending = h.client.prompt("hi");
    h.notify(start());
    h.notify(start("child-prompt", "subagent_stop"), "child");
    (h.client as any).onLine(JSON.stringify({ jsonrpc: "2.0", id: h.writes[0].id, result: { stopReason: "cancelled" } }));
    await pending;
    expect(h.calls.map((call) => call.status)).toEqual(["in_progress", "failed"]);
    expect(h.children).toHaveLength(1);
    h.notify(result("child-prompt", "subagent_stop", true), "child");
    expect(h.children[1]).toMatchObject({ childSessionId: "child", route: { event: "toolCallUpdate", payload: { status: "failed" } } });
  });

  it("settles running hooks on disposal and rejects stale generations", async () => {
    const h = harness();
    h.notify(start(), "parent", "_x.ai/session_notification", { generation: -1 });
    expect(h.calls).toEqual([]);
    h.notify(start());
    await h.client.dispose();
    expect(h.calls.map((call) => call.status)).toEqual(["in_progress", "failed"]);
  });

  it("keeps replayed child hooks out of a parent whose wire ID differs during load", () => {
    const h = harness();
    (h.client as any).loadingChildSessionIds = new Set();
    h.notify({ sessionUpdate: "subagent_spawned", child_session_id: "child" }, "wire-parent", "_x.ai/session/update");
    h.notify(result("p1", "subagent_stop", true), "child", "_x.ai/session/update");
    h.notify(result(), "wire-parent", "_x.ai/session/update");
    expect(h.children).toHaveLength(1);
    expect(h.children[0]).toMatchObject({ childSessionId: "child", route: { event: "toolCall", payload: { title: "SubagentStop hook failed (global/test-hook)" } } });
    // The parent's hook succeeded and was never seen running: a success leaves no row.
    expect(h.calls).toHaveLength(0);
  });

  it.each([new ClaudeBackend(), new CodexBackend(), new MuseBackend()])("does not synthesize Grok hook calls for %s", (backend) => {
    const h = harness(backend);
    h.notify(start());
    h.notify(result());
    expect(h.calls).toEqual([]);
  });
});
