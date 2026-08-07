/**
 * The rail's edge is a drag handle (owner request, 2026-08-07): no gutter, no
 * fill, no colour of its own — it IS the border, and only changes colour on
 * hover/drag.
 *
 * Mounted by chat.js next to the rail so BOTH rail hosts (Grok Build Desktop and
 * the AFK Pilot browser client) get it by construction, the same argument that
 * put the gear in the rail. VS Code has no rail mount, so nothing mounts there.
 *
 * The phone exclusion is NOT tested here — it is a CSS breakpoint owned by
 * web/chat.html, and `npm run e2e:touch` in the relay repo is its gate.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const withRail = (window: any) => {
  const el = window.document.createElement("aside");
  el.id = "projects-rail";
  el.hidden = true;
  const scroll = window.document.createElement("div");
  scroll.id = "rail-scroll";
  el.appendChild(scroll);
  const foot = window.document.createElement("div");
  foot.className = "rail-foot";
  el.appendChild(foot);
  window.document.body.appendChild(el);
};

const liveRail = (before = withRail): Harness => {
  const h = bootWebview({ ready: true, beforeScripts: before });
  dispatch(h.window, {
    type: "repos",
    entries: [{ cwd: "/proj", label: "proj", available: true, pinned: false, updatedAt: 1 }],
    selectedCwd: "/proj",
    activeCwd: "/proj",
  });
  return h;
};

/** jsdom has no layout, so the rail reports 0 width unless we say otherwise. */
function stubRailWidth(h: Harness, px: number) {
  const rail = h.doc.getElementById("projects-rail")!;
  (rail as any).getBoundingClientRect = () => ({
    width: px, height: 600, top: 0, left: 0, right: px, bottom: 600, x: 0, y: 0,
    toJSON: () => ({}),
  });
}

function drag(h: Harness, fromX: number, toX: number) {
  const handle = h.doc.getElementById("rail-resizer")!;
  const ev = (type: string, clientX: number) =>
    new h.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  // jsdom has no PointerEvent; MouseEvent carries clientX, which is all the
  // handler reads. pointerId is undefined and setPointerCapture is guarded.
  handle.dispatchEvent(Object.assign(ev("pointerdown", fromX), { pointerId: 1 }));
  handle.dispatchEvent(Object.assign(ev("pointermove", toX), { pointerId: 1 }));
  handle.dispatchEvent(Object.assign(ev("pointerup", toX), { pointerId: 1 }));
}

function railWidthVar(h: Harness): string {
  return h.doc.documentElement.style.getPropertyValue("--rail-width");
}

describe("rail resize handle (DOM)", () => {
  it("mounts immediately after the rail, and never in VS Code", () => {
    const h = liveRail();
    const rail = h.doc.getElementById("projects-rail")!;
    const handle = h.doc.getElementById("rail-resizer")!;
    expect(handle).toBeTruthy();
    // Immediately after: the handle has to sit on the rail's own edge.
    expect(rail.nextSibling).toBe(handle);
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");

    const vscode = bootWebview({ ready: true });
    dispatch(vscode.window, {
      type: "repos",
      entries: [{ cwd: "/w", label: "w", available: true, pinned: false, updatedAt: 1 }],
      selectedCwd: "/w",
      activeCwd: "/w",
    });
    // A repos frame for clear-all naming must not conjure a handle with no rail.
    expect(vscode.doc.getElementById("rail-resizer")).toBeNull();
  });

  it("dragging right widens the rail and persists on release", () => {
    const h = liveRail();
    stubRailWidth(h, 256);
    h.window.innerWidth = 1400;
    drag(h, 256, 356);
    expect(railWidthVar(h)).toBe("356px");
    // Persisted once, on release — not on every move.
    expect(h.window.localStorage.getItem("rail-width")).toBe("356px".replace("px", ""));
  });

  it("clamps to a minimum and never starves the conversation", () => {
    const h = liveRail();
    h.window.innerWidth = 1000;
    stubRailWidth(h, 256);
    drag(h, 256, 6); // far left
    expect(parseInt(railWidthVar(h), 10)).toBe(180);

    stubRailWidth(h, 256);
    drag(h, 256, 4000); // far right
    // min(50% of 1000, 1000 - 360) = 500 — half the window bites first here.
    expect(parseInt(railWidthVar(h), 10)).toBe(500);
  });

  it("restores a persisted width at boot, bounded by the window", () => {
    const seed = (window: any) => {
      window.localStorage.setItem("rail-width", "420");
      withRail(window);
    };
    const h = liveRail(seed);
    expect(railWidthVar(h)).toBe("420px");
  });

  it("a hostile persisted value cannot break the layout", () => {
    const seed = (window: any) => {
      window.localStorage.setItem("rail-width", "999999");
      withRail(window);
    };
    const h = liveRail(seed);
    const w = parseInt(railWidthVar(h), 10);
    expect(w).toBeGreaterThanOrEqual(180);
    expect(w).toBeLessThanOrEqual(Math.floor(h.window.innerWidth * 0.5));
  });
});
