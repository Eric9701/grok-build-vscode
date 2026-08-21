// clearMessages marks the transcript pending-clear instead of destroying it.
// Replacement content in the same burst drops the old nodes after the new
// ones are in (never an empty paint). No replacement → next-frame flush, and
// the welcome appears as it always did.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const raf = (window: Window) =>
  new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

const messages = (doc: Document) => doc.getElementById("messages") as HTMLElement;
const welcome = (doc: Document) => doc.getElementById("welcome") as HTMLElement;
const welcomeStatus = (doc: Document) => {
  const ver = doc.getElementById("welcome-version") as HTMLElement | null;
  return (ver?.dataset?.status || ver?.textContent || "").trim();
};
const liveMsgs = (doc: Document) =>
  [...messages(doc).children].filter(
    (el) => el.id !== "welcome" && el.getAttribute("data-pending-clear") !== "1",
  );
const visualMsgs = (doc: Document) =>
  [...messages(doc).children].filter((el) => el.id !== "welcome");

describe("clearMessages defers destroying the transcript", () => {
  it("same-burst replacement never observes an empty transcript or an unhidden welcome", async () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "userMessage", text: "hello from before" });
    expect(welcome(doc).hidden).toBe(true);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("hello from before");

    let sawEmpty = false;
    let sawWelcomeUnhidden = false;
    const obs = new window.MutationObserver(() => {
      if (visualMsgs(doc).length === 0) sawEmpty = true;
      if (!welcome(doc).hidden) sawWelcomeUnhidden = true;
    });
    obs.observe(messages(doc), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "data-pending-clear"],
    });

    dispatch(window, { type: "clearMessages" });
    expect(welcome(doc).hidden).toBe(true);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("hello from before");
    expect(doc.querySelector(".msg.user")?.getAttribute("data-pending-clear")).toBe("1");
    expect(liveMsgs(doc)).toHaveLength(0);

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessage", text: "hello from before" });
    dispatch(window, { type: "historyReplay", active: false });
    await Promise.resolve();
    obs.disconnect();

    expect(sawEmpty).toBe(false);
    expect(sawWelcomeUnhidden).toBe(false);
    expect(welcome(doc).hidden).toBe(true);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("hello from before");
    expect(doc.querySelector(".msg.user")?.getAttribute("data-pending-clear")).toBeNull();
    expect(visualMsgs(doc).some((el) => el.classList.contains("user"))).toBe(true);
  });

  it("flushes to the welcome on the next frame when no replacement arrives", async () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "userMessage", text: "soon gone" });
    expect(welcome(doc).hidden).toBe(true);

    dispatch(window, { type: "clearMessages" });
    expect(welcome(doc).hidden).toBe(true);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("soon gone");
    expect(welcomeStatus(doc)).toBe("Starting");

    await raf(window);
    expect(doc.querySelector(".msg.user")).toBeNull();
    expect(welcome(doc).hidden).toBe(false);
    expect(welcomeStatus(doc)).toBe("Starting");
  });

  it("keeps the Connected onboarding confirmation across a session-swap clearMessages", async () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "onboarding", state: "provider-connected", provider: "codex" });
    const onb = doc.getElementById("welcome-onboarding")!;
    expect(onb.textContent).toContain("Connected");
    expect(onb.textContent).toContain("You can start working with OpenAI!");
    expect(welcome(doc).hidden).toBe(false);

    dispatch(window, { type: "clearMessages" });
    expect(onb.textContent).toContain("Connected");
    expect(onb.textContent).toContain("You can start working with OpenAI!");
    expect(welcome(doc).hidden).toBe(false);

    await raf(window);
    expect(doc.getElementById("welcome-onboarding")!.textContent).toContain("Connected");
    expect(welcome(doc).hidden).toBe(false);
  });

  it("no-project after clearMessages still replaces Starting with the empty-state card", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "userMessage", text: "old project chat" });
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "onboarding", state: "no-project" });

    expect(welcome(doc).hidden).toBe(false);
    expect(welcomeStatus(doc)).toBe("No project folder");
    expect(doc.getElementById("welcome-onboarding")!.textContent).toContain("No project folder");
    expect(doc.querySelector(".msg.user")).toBeNull();
  });

  it("preserves scrollTop across a same-burst resync", () => {
    let scrollTop = 0;
    let scrollHeight = 400;
    const { window, doc } = bootWebview({
      beforeScripts(win) {
        const el = win.document.getElementById("messages")!;
        Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
        Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
        Object.defineProperty(el, "scrollTop", {
          configurable: true,
          get: () => scrollTop,
          set: (value) => { scrollTop = Number(value); },
        });
      },
    });
    dispatch(window, { type: "userMessage", text: "keep me" });
    scrollTop = 140;
    scrollHeight = 800;

    dispatch(window, { type: "clearMessages" });
    expect(scrollTop).toBe(140);

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessage", text: "keep me" });
    expect(scrollTop).toBe(140);
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".msg.user")?.textContent).toContain("keep me");
  });
});
