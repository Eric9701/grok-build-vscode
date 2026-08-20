import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

function completeTurn(window: Window, text = "hello") {
  dispatch(window, { type: "userMessage", text });
  dispatch(window, { type: "agentStart" });
  dispatch(window, { type: "messageChunk", text: "sure" });
  dispatch(window, { type: "promptComplete", meta: { totalTokens: 10 } });
  dispatch(window, { type: "agentEnd" });
}

describe("per-turn thumbs (#114)", () => {
  it("hides thumbs until the host advertises availability", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    completeTurn(window);
    expect(doc.querySelector(".msg-thumbs")).toBeNull();
  });

  it("puts thumbs next to Copy on a completed Grok agent footer", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    dispatch(window, { type: "feedbackAvailability", available: true });
    completeTurn(window);
    const actions = doc.querySelector(".msg.agent .msg-actions") as HTMLElement;
    expect(actions.hidden).toBe(false);
    expect(actions.querySelector(".msg-copy-btn")).toBeTruthy();
    expect(actions.querySelector(".msg-thumb-up")).toBeTruthy();
    expect(actions.querySelector(".msg-thumb-down")).toBeTruthy();
    const thumbs = actions.querySelector(".msg-thumbs") as HTMLElement;
    const ts = actions.querySelector(".msg-timestamp") as HTMLElement;
    expect(thumbs.nextElementSibling).toBe(ts);
  });

  it("does not offer thumbs on Codex or Claude", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "gpt", provider: "codex" });
    dispatch(window, { type: "feedbackAvailability", available: true });
    completeTurn(window);
    expect(doc.querySelector(".msg-thumbs")).toBeNull();
  });

  it("offers thumbs only on the latest completed turn and can clear", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    dispatch(window, { type: "feedbackAvailability", available: true });
    completeTurn(window, "first");
    completeTurn(window, "second");
    posted.length = 0;
    const footers = [...doc.querySelectorAll(".msg.agent .msg-actions")] as HTMLElement[];
    expect(footers).toHaveLength(2);
    expect(footers[0].querySelector(".msg-thumbs")).toBeNull();
    expect(footers[1].querySelector(".msg-thumbs")).toBeTruthy();
    click(window, footers[1].querySelector(".msg-thumb-up")!);
    expect(posted).toEqual([{ type: "turnFeedback", rating: 1 }]);
    dispatch(window, { type: "turnFeedbackAck", rating: 1 });
    expect(footers[1].querySelector(".msg-thumb-up")!.getAttribute("aria-pressed")).toBe("true");
    posted.length = 0;
    click(window, footers[1].querySelector(".msg-thumb-up")!);
    expect(posted[0]).toMatchObject({ type: "turnFeedback", rating: 0 });
  });

  it("still offers thumbs after a steered turn, without a bubble index", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    dispatch(window, { type: "feedbackAvailability", available: true });
    dispatch(window, { type: "userMessage", text: "start" });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "working" });
    dispatch(window, { type: "userMessage", text: "steer", steer: true });
    dispatch(window, { type: "messageChunk", text: "done" });
    dispatch(window, { type: "promptComplete", meta: { totalTokens: 10 } });
    dispatch(window, { type: "agentEnd" });
    posted.length = 0;
    const footers = [...doc.querySelectorAll(".msg.agent .msg-actions")] as HTMLElement[];
    const actions = footers[footers.length - 1];
    expect(actions.querySelector(".msg-thumbs")).toBeTruthy();
    click(window, actions.querySelector(".msg-thumb-down")!);
    expect(posted[0]).toEqual({ type: "turnFeedback", rating: -1 });
  });

  it("drops thumbs when rewind truncates the live turn", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    dispatch(window, { type: "feedbackAvailability", available: true });
    completeTurn(window, "first");
    completeTurn(window, "second");
    expect(doc.querySelector(".msg-thumbs")).toBeTruthy();
    dispatch(window, { type: "truncateMessages", surviving: 1 });
    expect(doc.querySelector(".msg-thumbs")).toBeNull();
  });

  it("adds thumbs to the live finished turn when availability arrives late", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    completeTurn(window);
    expect(doc.querySelector(".msg-thumbs")).toBeNull();
    dispatch(window, { type: "feedbackAvailability", available: true });
    expect(doc.querySelector(".msg.agent .msg-thumbs")).toBeTruthy();
  });

  it("does not add thumbs to restored session/load turns", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    dispatch(window, { type: "feedbackAvailability", available: true });
    dispatch(window, { type: "historyReplay", active: true });
    completeTurn(window, "restored");
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".msg-thumbs")).toBeNull();
  });

  it("restores thumbs on the live footer after a focus-swap snapshot", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    dispatch(window, { type: "historyReplay", active: true });
    completeTurn(window, "warm");
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".msg-thumbs")).toBeNull();
    dispatch(window, { type: "feedbackAvailability", available: true });
    dispatch(window, { type: "turnFeedbackAck", rating: 1 });
    const actions = doc.querySelector(".msg.agent .msg-actions") as HTMLElement;
    expect(actions.querySelector(".msg-thumbs")).toBeTruthy();
    expect(actions.querySelector(".msg-thumb-up")!.getAttribute("aria-pressed")).toBe("true");
    posted.length = 0;
    click(window, actions.querySelector(".msg-thumb-down")!);
    expect(posted[0]).toEqual({ type: "turnFeedback", rating: -1 });
  });

  it("hides thumbs when the host latches availability off", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    dispatch(window, { type: "feedbackAvailability", available: true });
    completeTurn(window);
    expect(doc.querySelector(".msg-thumbs")).toBeTruthy();
    dispatch(window, { type: "feedbackAvailability", available: false });
    expect(doc.querySelector(".msg-thumbs")).toBeNull();
  });
});
