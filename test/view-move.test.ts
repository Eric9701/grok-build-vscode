import { describe, it, expect } from "vitest";
import {
  GROK_VIEW_ID,
  hostAcceptedSecondarySideBar,
  moveViewContainerFor,
  PANEL_CONTAINER_ID,
  panelPositionFor,
  PRIMARY_CONTAINER_ID,
  revealCommandFor,
  SECONDARY_CONTAINER_ID,
  viewRelocationTarget,
} from "../src/view-move";

const VIEW_FOCUS = `${GROK_VIEW_ID}.focus`;
/** What VS Code registers: all three containers plus the view's focus command. */
const VSCODE = [SECONDARY_CONTAINER_ID, PRIMARY_CONTAINER_ID, PANEL_CONTAINER_ID, VIEW_FOCUS];
/** Cursor 3.15: the secondary container is refused, so its command never exists. */
const CURSOR = [PRIMARY_CONTAINER_ID, PANEL_CONTAINER_ID, VIEW_FOCUS];

describe("placing the view where the host will actually accept it", () => {
  it("leaves VS Code alone — the secondary side bar stays the intended home", () => {
    expect(viewRelocationTarget({ availableCommands: VSCODE, alreadyRelocated: false })).toBeNull();
  });

  it("moves to the PANEL when the secondary container was refused", () => {
    // Cursor drops the view into Explorer and never registers the container, so
    // grok.open threw "command not found" and the extension could not be opened.
    //
    // Panel rather than the primary side bar on purpose: docked right it is a
    // secondary side bar in everything but name — same position, same tall
    // narrow shape — where the primary side bar would sit opposite the editor
    // and fight the file tree for space.
    expect(viewRelocationTarget({ availableCommands: CURSOR, alreadyRelocated: false })).toBe(
      PANEL_CONTAINER_ID,
    );
  });

  it("moves once and never again", () => {
    // Re-homing on every activation would drag the view back out of wherever the
    // user deliberately put it, every launch.
    expect(viewRelocationTarget({ availableCommands: CURSOR, alreadyRelocated: true })).toBeNull();
  });

  it("decides on capability, not on which editor this is", () => {
    // No appName check anywhere: a fork adopting the same restriction is handled
    // without naming it, and a Cursor release that lifts it stops triggering
    // this with no code change.
    const restricted = VSCODE.filter((c) => c !== SECONDARY_CONTAINER_ID);
    expect(viewRelocationTarget({ availableCommands: restricted, alreadyRelocated: false })).toBe(
      PANEL_CONTAINER_ID,
    );
  });
});

describe("what grok.open executes", () => {
  it("focuses the view itself, which works wherever the view lives", () => {
    // Previously hardcoded the secondary container — exactly the command that
    // does not exist in Cursor, which is what users saw fail.
    expect(revealCommandFor(VSCODE)).toBe(VIEW_FOCUS);
    expect(revealCommandFor(CURSOR)).toBe(VIEW_FOCUS);
  });

  it("falls back to a container that exists when the view focus does not", () => {
    expect(revealCommandFor([PRIMARY_CONTAINER_ID, PANEL_CONTAINER_ID])).toBe(PRIMARY_CONTAINER_ID);
    expect(revealCommandFor([PANEL_CONTAINER_ID])).toBe(PANEL_CONTAINER_ID);
  });

  it("never returns the secondary container just because it is the default", () => {
    // The regression in one line: choosing a command by convention rather than
    // by whether the host registered it.
    expect(revealCommandFor(CURSOR)).not.toBe(SECONDARY_CONTAINER_ID);
  });
});

describe("what the gear may offer", () => {
  it("reports the secondary side bar available only when the host registered it", () => {
    expect(hostAcceptedSecondarySideBar(VSCODE)).toBe(true);
    expect(hostAcceptedSecondarySideBar(CURSOR)).toBe(false);
  });

  it("agrees with the relocation decision — one predicate, not two", () => {
    // Drifting apart would let the menu offer a destination activation had
    // already concluded the host refuses.
    for (const cmds of [VSCODE, CURSOR]) {
      const offersSecondary = hostAcceptedSecondarySideBar(cmds);
      const needsRelocation =
        viewRelocationTarget({ availableCommands: cmds, alreadyRelocated: false }) !== null;
      expect(offersSecondary).toBe(!needsRelocation);
    }
  });
});

describe("gear-menu Move view destinations", () => {
  it("maps each destination to its extension-owned container", () => {
    expect(moveViewContainerFor("panel")).toBe(PANEL_CONTAINER_ID);
    expect(moveViewContainerFor("sidebar")).toBe(PRIMARY_CONTAINER_ID);
    expect(moveViewContainerFor("auxiliarybar")).toBe(SECONDARY_CONTAINER_ID);
  });

  it("routes both edge-explicit destinations to the panel container", () => {
    expect(moveViewContainerFor("panel-right")).toBe(PANEL_CONTAINER_ID);
    expect(moveViewContainerFor("panel-bottom")).toBe(PANEL_CONTAINER_ID);
  });

  it("docks the panel only for the destinations whose label promises an edge", () => {
    expect(panelPositionFor("panel-right")).toBe("right");
    expect(panelPositionFor("panel-bottom")).toBe("bottom");
  });

  it("leaves the layout alone for plain 'panel' — including from older clients", () => {
    // Panel position is workbench-wide, so this also moves Terminal, Problems
    // and Output. A destination that never claimed an edge must not do that,
    // and every client built before the edge-explicit items sends this one.
    expect(panelPositionFor("panel")).toBeNull();
    expect(panelPositionFor("sidebar")).toBeNull();
    expect(panelPositionFor("auxiliarybar")).toBeNull();
    expect(panelPositionFor(undefined)).toBeNull();
  });

  it("returns null for anything else — callers fall back to the built-in picker", () => {
    expect(moveViewContainerFor(undefined)).toBeNull();
    expect(moveViewContainerFor("")).toBeNull();
    expect(moveViewContainerFor("editor")).toBeNull();
    expect(moveViewContainerFor(42)).toBeNull();
  });

  it("container ids carry the workbench prefix package.json contributions get", () => {
    for (const id of [PANEL_CONTAINER_ID, PRIMARY_CONTAINER_ID, SECONDARY_CONTAINER_ID]) {
      expect(id.startsWith("workbench.view.extension.")).toBe(true);
    }
  });
});
