import { describe, it, expect, vi } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const exec = {
  type: "toolCall",
  call: {
    toolCallId: "big-output",
    kind: "execute",
    title: "Run node",
    rawInput: { command: "node big-output.js" },
  },
};

function bootWithGeometry() {
  let scrollHeight = 1000;
  const harness = bootWebview({
    beforeScripts(window) {
      const messages = window.document.getElementById("messages")!;
      Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeight });
      messages.scrollTop = 800;
    },
  });
  return { ...harness, grow: () => { scrollHeight = 1800; } };
}

describe("stick-to-bottom after expanded tool detail growth (#92)", () => {
  it("keeps following when the reader was already at the bottom", async () => {
    const { window, doc, grow } = bootWithGeometry();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    const messages = doc.getElementById("messages") as HTMLElement;
    messages.dispatchEvent(new window.Event("scroll"));
    dispatch(window, exec);
    grow();
    dispatch(window, {
      type: "commandOutput",
      command: "node big-output.js",
      output: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
      exitCode: 0,
      truncated: false,
    });

    await vi.waitFor(() => {
      expect(messages.scrollTop).toBe(1800);
    });
    expect(doc.getElementById("scroll-bottom-btn")!.classList.contains("visible")).toBe(false);
  });

  it("preserves position when the reader deliberately scrolled up", async () => {
    const { window, doc, grow } = bootWithGeometry();
    dispatch(window, {
      type: "initialState",
      effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "0",
      showThinking: false, expandCommandOutputs: true,
    });
    dispatch(window, exec);
    const messages = doc.getElementById("messages") as HTMLElement;
    messages.scrollTop = 500;
    messages.dispatchEvent(new window.Event("scroll"));
    expect(doc.getElementById("scroll-bottom-btn")!.classList.contains("visible")).toBe(true);

    grow();
    dispatch(window, {
      type: "commandOutput",
      command: "node big-output.js",
      output: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"),
      exitCode: 0,
      truncated: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(messages.scrollTop).toBe(500);
    expect(doc.getElementById("scroll-bottom-btn")!.classList.contains("visible")).toBe(true);
  });
});
