// The waiting indicator says nothing about how long it has been waiting, and a
// turn has no deadline the user can see: session/prompt tolerates 30 minutes of
// CLI silence (src/acp-timeout.ts) before it gives up. So "working" and
// "wedged" look identical, and #126 was reported as "keeps spinning ... no way
// to tell whats wrong". A running count is the smallest honest signal.
//
// Drives the REAL media/chat.js in happy-dom. chat.js is eval'd in the window's
// realm, so its setInterval and Date are the WINDOW's — vitest fake timers
// patch globalThis and would never reach them. The tick is captured and the
// clock driven explicitly instead.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

function bootWaiting() {
  const h = bootWebview();
  const win = h.window as any;
  const ticks: Array<() => void> = [];
  const cleared: number[] = [];
  let id = 0;
  const realSetInterval = win.setInterval;
  win.setInterval = (fn: () => void, ms: number) => {
    if (ms === 1000) {
      ticks.push(fn);
      return ++id;
    }
    return realSetInterval(fn, ms);
  };
  win.clearInterval = (handle: number) => { cleared.push(handle); };
  let now = 1_700_000_000_000;
  win.Date.now = () => now;
  const advance = (ms: number) => { now += ms; for (const fn of ticks.slice()) fn(); };
  dispatch(h.window, { type: "userMessage", text: "do it", chips: [] });
  dispatch(h.window, { type: "agentStart" });
  return { ...h, advance, cleared, ticks };
}

const counter = (doc: Document) => doc.querySelector(".grokking-elapsed") as HTMLElement | null;

describe("the waiting indicator counts how long it has been waiting (#126)", () => {
  it("is there from the first frame, with no threshold to cross", () => {
    // A delay meant nothing was on screen at exactly the moment someone starts
    // wondering whether the turn is stuck. The row itself only lives from
    // agentStart to the first content, so on a fast turn it already comes and
    // goes in about a second — the number adds no churn the row does not have.
    const h = bootWaiting();
    expect(h.doc.querySelector(".grokking")).not.toBeNull();
    expect(counter(h.doc)!.textContent).toBe("\u00b7 0s");
  });

  it("keeps counting, in units that stay readable as the wait grows", () => {
    const h = bootWaiting();
    h.advance(21_000);
    expect(counter(h.doc)!.textContent).toBe("\u00b7 21s");
    h.advance(1_826_000); // half an hour later — the idle cap is 30 minutes
    expect(counter(h.doc)!.textContent).toBe("\u00b7 30m 47s");
  });

  it("is hidden from screen readers, because it changes every second", () => {
    const h = bootWaiting();
    expect(counter(h.doc)!.getAttribute("aria-hidden")).toBe("true");
    // The announced label is still the verb alone, not the running number.
    expect(h.doc.querySelector(".grokking")!.getAttribute("aria-label")).not.toMatch(/\d+s/);
  });

  it("sits outside the shimmering label, so the number is not painted transparent", () => {
    // .grokking-label clips a gradient with -webkit-text-fill-color: transparent.
    // A counter inside it would inherit that and read as decoration, not data.
    const h = bootWaiting();
    h.advance(25_000);
    expect(h.doc.querySelector(".grokking-label .grokking-elapsed")).toBeNull();
    expect(counter(h.doc)!.parentElement!.className).toBe("grokking");
  });

  it("goes away with the indicator when content finally arrives, and stops its timer", () => {
    const h = bootWaiting();
    h.advance(25_000);
    expect(counter(h.doc)).not.toBeNull();
    dispatch(h.window, { type: "messageChunk", text: "here it is" });
    expect(h.doc.querySelector(".grokking")).toBeNull();
    expect(counter(h.doc)).toBeNull();
    expect(h.cleared.length).toBeGreaterThan(0);
  });

  it("stops counting on its own if the node is detached by some other path", () => {
    // The timer is armed per element precisely so it cannot outlive the node —
    // history hydration nulls state.grokkingEl while the node stays on screen,
    // so a state-keyed timer would have been the wrong lifetime.
    const h = bootWaiting();
    h.advance(25_000);
    const el = h.doc.querySelector(".grokking") as HTMLElement;
    el.parentElement!.removeChild(el);
    h.advance(5_000);
    expect(h.cleared.length).toBeGreaterThan(0);
  });
});
