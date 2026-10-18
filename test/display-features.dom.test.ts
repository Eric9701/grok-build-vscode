import { describe, expect, it, vi } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";
import { GrokHookCalls } from "../src/grok-hooks";

describe("thinking Show Less (#216)", () => {
  it.each([false, true])("collapses, returns focus to the header and remains usable after more text (replay=%s)", async (replaying) => {
    const { window, doc } = bootWebview();
    if (replaying) dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "thoughtChunk", text: "First thought" });
    if (replaying) {
      dispatch(window, { type: "thoughtChunk", text: " and more" });
      dispatch(window, { type: "historyReplay", active: false });
    }
    const header = doc.querySelector(".thinking-header") as HTMLElement;
    const body = doc.querySelector(".thinking-body") as HTMLElement;
    const less = doc.querySelector(".thinking-show-less") as HTMLButtonElement;
    const scroll = vi.spyOn(header, "scrollIntoView");
    expect(less.hidden).toBe(true);
    click(window, header);
    expect(less.hidden).toBe(false);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    if (!replaying) {
      dispatch(window, { type: "thoughtChunk", text: " and more" });
      dispatch(window, { type: "promptComplete", meta: {} });
    }
    expect(body.textContent).toBe("First thought and more");
    click(window, less);
    expect(body.hidden).toBe(true);
    expect(less.hidden).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(doc.activeElement).toBe(header);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    header.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(body.hidden).toBe(false);
    expect(less.hidden).toBe(false);
    header.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(body.hidden).toBe(true);
    expect(less.hidden).toBe(true);
  });
});

describe("hook rows (#215)", () => {
  it("shows SubagentStop activity and errors only inside the child card", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "spawn", title: "spawn_subagent", rawInput: { description: "Child", subagent_type: "explore" } } });
    dispatch(window, { type: "subagentUpdate", update: { sessionUpdate: "subagent_spawned", subagent_id: "child", child_session_id: "child" } });
    const hooks = new GrokHookCalls();
    const starting = hooks.update({ sessionUpdate: "hook_run_started", event_name: "subagent_stop", prompt_id: "p", count: 1 }, "child")![0];
    dispatch(window, { type: "childStream", childSessionId: "child", event: "toolCall", call: starting });
    expect(doc.querySelector(".subagent-tool")?.textContent).toContain("Running SubagentStop hook");
    expect(doc.querySelector(".subagent-tool .blink-dots")).not.toBeNull();
    const finished = hooks.update({ sessionUpdate: "hook_execution", event_name: "subagent_stop", prompt_id: "p", runs: [{ name: "child hook", status: { status: "failed", error: "child failure" } }] }, "child")![0];
    dispatch(window, { type: "childStream", childSessionId: "child", event: "toolCallUpdate", call: finished });
    expect(doc.querySelector(".subagent-tool .blink-dots")).toBeNull();
    expect(doc.querySelector(".subagent-tool .tool-error")?.textContent).toContain("child failure");
    expect(doc.querySelectorAll(".tool-flat, .tool-group")).toHaveLength(0);
  });

  it.each([false, true])("leaves nothing behind when the Stop hook succeeds (cold replay=%s)", (replaying) => {
    const { window, doc } = bootWebview();
    const hooks = new GrokHookCalls();
    const send = (update: any) => {
      for (const call of hooks.update(update, "parent") ?? []) {
        dispatch(window, { type: call.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call });
      }
    };
    if (replaying) dispatch(window, { type: "historyReplay", active: true });
    else {
      dispatch(window, { type: "agentStart" });
      dispatch(window, { type: "messageChunk", text: "The reply is ready." });
      send({ sessionUpdate: "hook_run_started", event_name: "stop", prompt_id: "p1", count: 1 });
      expect(doc.querySelector(".tool-group.in-progress .tool-group-label")?.textContent).toBe("Running Stop hook");
    }
    send({ sessionUpdate: "hook_execution", event_name: "stop", prompt_id: "p1",
      runs: [{ name: "global/tts", status: { status: "success", elapsed_ms: 2400 } }] });
    if (replaying) dispatch(window, { type: "historyReplay", active: false });
    dispatch(window, { type: "promptComplete", meta: {} });
    dispatch(window, { type: "agentEnd", meta: {} });
    expect(doc.body.textContent).not.toContain("Stop hook");
    expect(doc.querySelectorAll(".tool-flat, .tool-group")).toHaveLength(0);
    if (!replaying) expect(doc.body.textContent).toContain("The reply is ready.");
  });

  it.each([false, true])("shows running activity and the failure diagnostic (cold replay=%s)", (replaying) => {
    const { window, doc } = bootWebview();
    const hooks = new GrokHookCalls();
    const send = (update: any) => {
      for (const call of hooks.update(update, "parent") ?? []) {
        dispatch(window, { type: call.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call });
      }
    };
    if (replaying) dispatch(window, { type: "historyReplay", active: true });
    else {
      dispatch(window, { type: "agentStart" });
      dispatch(window, { type: "messageChunk", text: "The reply is ready." });
      send({ sessionUpdate: "hook_run_started", event_name: "stop", prompt_id: "p1", count: 1 });
      expect(doc.querySelector(".tool-group.in-progress .tool-group-label")?.textContent).toBe("Running Stop hook");
      expect(doc.body.classList.contains("turn-busy")).toBe(true);
    }
    send({ sessionUpdate: "hook_execution", event_name: "stop", prompt_id: "p1", runs: [{
      name: "global/test-hook-error", status: { status: "failed", elapsed_ms: 3000,
        error: "exit code 1: intentional hook failure <script>bad()</script>" },
    }] });
    if (replaying) dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".tool-group.in-progress")).toBeNull();
    if (!replaying) expect(doc.body.classList.contains("turn-busy")).toBe(true);
    dispatch(window, { type: "promptComplete", meta: {} });
    dispatch(window, { type: "agentEnd", meta: {} });
    expect(doc.querySelector(".tool-group.in-progress")).toBeNull();
    expect(doc.querySelector(".tool-error")?.textContent).toBe(
      "stop hook (global/test-hook-error) failed, ignored: exit code 1: intentional hook failure <script>bad()</script>");
    expect(doc.querySelector(".tool-error script")).toBeNull();
    expect(doc.body.classList.contains("turn-busy")).toBe(false);
    expect(doc.querySelector(".tool-failed")?.textContent).toContain("Stop hook failed");
  });
});
