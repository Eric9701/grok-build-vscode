/**
 * Gear → Config & debug → Move view, against the REAL shipped chat.js.
 *
 * The menu has to adapt to the host, because one of them refuses a destination
 * the others have. Cursor 3.15 reserves the secondary side bar for its own agent
 * UI and will not create an extension container there, so "To Secondary Side
 * Bar" is a control that silently does nothing — and the panel, docked right, is
 * the same screen position under a different name.
 *
 * What these assert is the SHAPE of the menu per host, plus the message each
 * item sends. The mapping from message to workbench command is covered by
 * view-move.test.ts; this is the half that decides what a user is offered.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

type Caps = Record<string, boolean>;

function boot(capabilities: Caps, opts: { remote?: boolean } = {}): Harness {
  const h = bootWebview({ ready: true, remote: opts.remote });
  dispatch(h.window, {
    type: "initialState",
    effort: "",
    cwd: "/w",
    useCtrlEnter: false,
    extVersion: "9.9.9",
    showThinking: false,
    expandCommandOutputs: false,
    steerByDefault: false,
    soundNotifications: false,
    processingSound: false,
    readRepliesAloud: false,
    capabilities: { uploadFile: true, remoteVoice: true, ...capabilities },
  });
  return h;
}

/** Open the gear and descend into Config & debug, where Move view lives. */
function openMoveView(h: Harness): void {
  const gear = h.doc.getElementById("gear-btn") || h.doc.getElementById("rail-gear-btn");
  click(h.window, gear!);
  const configEntry = items(h).find((el) => /Config & debug/.test(text(el)));
  if (configEntry) click(h.window, configEntry);
}

function items(h: Harness): HTMLElement[] {
  return [...h.doc.querySelectorAll("#gear-popover .toolbar-popover-item")] as HTMLElement[];
}

function text(el: Element): string {
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

/** The Move view destinations, in menu order. */
function destinations(h: Harness): string[] {
  return items(h)
    .map(text)
    .filter((t) => /^To /.test(t));
}

function clickDestination(h: Harness, label: string): void {
  const el = items(h).find((e) => text(e) === label);
  if (!el) throw new Error(`no "${label}" in: ${destinations(h).join(" | ")}`);
  click(h.window, el);
}

/** Which ICON each destination carries, by the distinguishing path in the SVG.
 *  `M15 3v18` is the right-hand divider, `M9 3v18` the left, `M3 15h18` the
 *  bottom — the same three glyphs VS Code uses for its own layout controls. */
function iconEdge(h: Harness, label: string): "right" | "left" | "bottom" | "none" {
  const el = items(h).find((e) => text(e) === label);
  const svg = el?.innerHTML || "";
  if (svg.includes("M15 3v18")) return "right";
  if (svg.includes("M9 3v18")) return "left";
  if (svg.includes("M3 15h18")) return "bottom";
  return "none";
}

describe("Move view menu (DOM)", () => {
  it("offers the secondary side bar where the host actually has one", () => {
    const h = boot({ relocateView: true, secondarySideBar: true });
    openMoveView(h);
    expect(destinations(h)).toEqual([
      "To Secondary Side Bar",
      "To Primary Side Bar",
      "To Panel",
    ]);
  });

  it("treats a host that never sent the flag as having one", () => {
    // Opt-out polarity, same as relocateView: every extension built before
    // Cursor refused the container omits this and must keep its menu.
    const h = boot({ relocateView: true });
    openMoveView(h);
    expect(destinations(h)).toContain("To Secondary Side Bar");
    expect(destinations(h)).not.toContain("To Right Panel");
  });

  it("offers ONE item, the host's own picker, where the secondary side bar was refused", () => {
    // Instrumented Cursor: it keeps our other containers but ignores where they
    // declared they live, so every destination we can name lands in the primary
    // side bar. Three labels for one outcome, two of them untrue.
    const h = boot({ relocateView: true, secondarySideBar: false });
    openMoveView(h);
    const items_ = items(h)
      .map(text)
      .filter((t) => /^(To |Move view)/.test(t));
    expect(items_).toEqual(["Move view…"]);
  });

  it("sends the un-mappable destination, which is what reaches the host picker", () => {
    // `pick` maps to no container by design — the host falls through to its own
    // picker, which targets a LOCATION and can therefore reach docks no
    // container id of ours can address.
    const h = boot({ relocateView: true, secondarySideBar: false });
    openMoveView(h);
    const el = items(h).find((e) => text(e) === "Move view…");
    click(h.window, el!);
    expect(h.posted.filter((m) => m.type === "moveView")).toEqual([
      { type: "moveView", location: "pick" },
    ]);
  });

  it("keeps sending plain 'panel' where the layout must not be rearranged", () => {
    const h = boot({ relocateView: true, secondarySideBar: true });
    openMoveView(h);
    clickDestination(h, "To Panel");
    expect(h.posted.filter((m) => m.type === "moveView")).toEqual([
      { type: "moveView", location: "panel" },
    ]);
  });

  it("puts the right-edge glyph on the right-hand destination in both hosts", () => {
    // The icons are how the menu reads at a glance — a user picks the one whose
    // shading matches where they want the view, not the words.
    const vscode = boot({ relocateView: true, secondarySideBar: true });
    openMoveView(vscode);
    expect(iconEdge(vscode, "To Secondary Side Bar")).toBe("right");
    expect(iconEdge(vscode, "To Primary Side Bar")).toBe("left");
    expect(iconEdge(vscode, "To Panel")).toBe("bottom");

    // Where the menu collapses to the host's own picker there is one item, and
    // it keeps the same glyph rather than inventing a fourth.
    const cursor = boot({ relocateView: true, secondarySideBar: false });
    openMoveView(cursor);
    expect(iconEdge(cursor, "Move view…")).toBe("right");
  });

  it("hides the section on a host with no view containers", () => {
    const h = boot({ relocateView: false, showOutput: false });
    openMoveView(h);
    expect(destinations(h)).toEqual([]);
  });

  it("hides the section in the browser client — moveView is host-local", () => {
    // The relay drops the message, so offering the control would offer three
    // items that do nothing. Same treatment the rail gives its host-local
    // worktree entries.
    const h = boot({ relocateView: true, secondarySideBar: true }, { remote: true });
    openMoveView(h);
    expect(destinations(h)).toEqual([]);
  });
});
