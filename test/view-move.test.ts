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
  viewPlacementCorrection,
  withAttempt,
  withUserChoice,
  type PlacementRecord,
} from "../src/view-move";

const VIEW_FOCUS = `${GROK_VIEW_ID}.focus`;
/** What VS Code registers: all three containers plus the view's focus command. */
const VSCODE = [SECONDARY_CONTAINER_ID, PRIMARY_CONTAINER_ID, PANEL_CONTAINER_ID, VIEW_FOCUS];
/** Cursor 3.15: the secondary container is refused, so its command never exists. */
const CURSOR = [PRIMARY_CONTAINER_ID, PANEL_CONTAINER_ID, VIEW_FOCUS];

const V = "3.2.8";
const correct = (availableCommands: readonly string[], placement: PlacementRecord | undefined) =>
  viewPlacementCorrection({ availableCommands, placement, extensionVersion: V });

describe("placing the view where the host will actually accept it", () => {
  it("leaves VS Code alone — the secondary side bar stays the intended home", () => {
    expect(correct(VSCODE, undefined)).toBeNull();
  });

  it("moves to the ACTIVITY-BAR container when the secondary one was refused", () => {
    // Cursor drops the view into Explorer and never registers the container, so
    // grok.open threw "command not found" and the extension could not be opened.
    //
    // Not the panel container, though that is where this started. A host that
    // refuses one contributed location can honour another's contribution while
    // ignoring its location: instrumented Cursor accepts `grokPanel` and renders
    // it in the primary side bar anyway. Same landing place, so aim at the
    // container that says so.
    expect(correct(CURSOR, undefined)).toEqual({
      containerId: PRIMARY_CONTAINER_ID,
      panelPosition: null,
    });
  });

  it("never rearranges the whole workbench on its own initiative", () => {
    // `positionPanelRight` is workbench-wide — it carries Terminal, Problems and
    // Output across the window. It did exactly that in Cursor to reach a panel
    // the view was never going to appear in. A destination the user picked by
    // name may move the panel; our own guess may not.
    expect(correct(CURSOR, undefined)?.panelPosition).toBeNull();
    expect(correct(CURSOR, { chosenLocation: "panel-right" })?.panelPosition).toBe("right");
  });

  it("corrects once per version, not once ever", () => {
    expect(correct(CURSOR, { attemptedForVersion: V })).toBeNull();
    // An update is when the placement gets undone — reinstalling re-registers
    // the view against the container this host refuses — so an update is
    // exactly when the correction is due again. 3.2.8 stored a plain boolean
    // and its one silent failure was therefore permanent.
    expect(correct(CURSOR, { attemptedForVersion: "3.2.7" })).not.toBeNull();
  });

  it("restores where the USER put it, not our default", () => {
    // The conflict this resolves: a choice cannot mean "stop correcting", or a
    // user who already told us where they wanted it is the one left stranded
    // when placement drifts back.
    expect(correct(CURSOR, { chosenLocation: "panel-bottom" })).toEqual({
      containerId: PANEL_CONTAINER_ID,
      panelPosition: "bottom",
    });
    expect(correct(CURSOR, { chosenLocation: "sidebar" })).toEqual({
      containerId: PRIMARY_CONTAINER_ID,
      panelPosition: null,
    });
  });

  it("ignores a remembered choice the host cannot honour", () => {
    // Nothing to move it into. Issuing a move at a container that was never
    // registered is how 3.2.8's attempt failed silently while recording itself
    // as a success.
    expect(correct(CURSOR, { chosenLocation: "auxiliarybar" })).toBeNull();
    expect(correct([SECONDARY_CONTAINER_ID.replace("grokSidebar", "nothing")], undefined)).toBeNull();
  });

  it("decides on capability, not on which editor this is", () => {
    // No appName check anywhere: a fork adopting the same restriction is handled
    // without naming it, and a Cursor release that lifts it stops triggering
    // this with no code change.
    const restricted = VSCODE.filter((c) => c !== SECONDARY_CONTAINER_ID);
    expect(correct(restricted, undefined)).toEqual({
      containerId: PRIMARY_CONTAINER_ID,
      panelPosition: null,
    });
  });
});

describe("the placement record", () => {
  it("remembers a real destination and ignores anything else", () => {
    expect(withUserChoice(undefined, "panel-bottom")).toEqual({ chosenLocation: "panel-bottom" });
    expect(withUserChoice({ attemptedForVersion: V }, "sidebar")).toEqual({
      attemptedForVersion: V,
      chosenLocation: "sidebar",
    });
    // A destination we cannot map must not be stored — the correction would
    // then aim at nothing and quietly stop working.
    expect(withUserChoice(undefined, "editor")).toEqual({});
    expect(withUserChoice({ chosenLocation: "sidebar" }, 42)).toEqual({ chosenLocation: "sidebar" });
  });

  it("records the attempt without disturbing a remembered choice", () => {
    expect(withAttempt({ chosenLocation: "panel-bottom" }, V)).toEqual({
      chosenLocation: "panel-bottom",
      attemptedForVersion: V,
    });
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
      const needsCorrection =
        viewPlacementCorrection({
          availableCommands: cmds,
          placement: undefined,
          extensionVersion: V,
        }) !== null;
      expect(offersSecondary).toBe(!needsCorrection);
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
