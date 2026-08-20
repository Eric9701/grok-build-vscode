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
    expect(actions.dataset.userBubbleIndex).toBe("0");
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

  it("posts turnFeedback with the visible bubble index and can clear", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    dispatch(window, { type: "feedbackAvailability", available: true });
    completeTurn(window, "first");
    completeTurn(window, "second");
    posted.length = 0;
    const footers = [...doc.querySelectorAll(".msg.agent .msg-actions")] as HTMLElement[];
    expect(footers).toHaveLength(2);
    expect(footers[0].dataset.userBubbleIndex).toBe("0");
    expect(footers[1].dataset.userBubbleIndex).toBe("1");
    click(window, footers[0].querySelector(".msg-thumb-up")!);
    expect(posted).toEqual([{
      type: "turnFeedback",
      userBubbleIndex: 0,
      rating: 1,
      totalUserBubbles: 2,
    }]);
    dispatch(window, { type: "turnFeedbackAck", userBubbleIndex: 0, rating: 1 });
    expect(footers[0].querySelector(".msg-thumb-up")!.getAttribute("aria-pressed")).toBe("true");
    posted.length = 0;
    click(window, footers[0].querySelector(".msg-thumb-up")!);
    expect(posted[0]).toMatchObject({ type: "turnFeedback", userBubbleIndex: 0, rating: 0 });
  });

  it("skips steer bubbles when numbering the turn that gets the footer", () => {
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
    const actions = doc.querySelector(".msg.agent .msg-actions") as HTMLElement;
    expect(actions.dataset.userBubbleIndex).toBe("0");
    click(window, actions.querySelector(".msg-thumb-down")!);
    expect(posted[0]).toMatchObject({ userBubbleIndex: 0, rating: -1, totalUserBubbles: 1 });
  });

  it("adds thumbs to already-finished turns when availability arrives late", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    completeTurn(window);
    expect(doc.querySelector(".msg-thumbs")).toBeNull();
    dispatch(window, { type: "feedbackAvailability", available: true });
    expect(doc.querySelector(".msg.agent .msg-thumbs")).toBeTruthy();
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
