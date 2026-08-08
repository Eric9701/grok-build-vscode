// View placement. The view is default-homed in the SECONDARY side bar
// (`viewsContainers.secondarySidebar`, VS Code >= 1.106 — hence the engines
// floor), with one extension-owned container contributed per dock location so
// the gear-menu "Move view" items can move the view DIRECTLY via the internal
// `vscode.moveViews` command (the one GitLens uses for its layout switch) — no
// quickpick. This exists because Cursor's primary-side-bar context menu hides
// the built-in "Move To" entry, and a one-click mover is useful everywhere.

export const GROK_VIEW_ID = "grok.chat";

/** Contributed containers, one per dock location (package.json prefixes each id
 *  with `workbench.view.extension.`). `grokSidebar` homes the view; the other
 *  two are empty by default (an empty container renders nothing) and exist only
 *  as `vscode.moveViews` targets. */
export const SECONDARY_CONTAINER_ID = "workbench.view.extension.grokSidebar";
export const PRIMARY_CONTAINER_ID = "workbench.view.extension.grokPrimary";
export const PANEL_CONTAINER_ID = "workbench.view.extension.grokPanel";

/** Which edge the panel must be docked on for a destination to mean what its
 *  menu label says. */
export type PanelPosition = "right" | "bottom";

/** Resolve a gear-menu destination to the container `vscode.moveViews` should
 *  target, or null for an unknown location (callers fall back to the built-in
 *  destination picker preselected on the Grok view). */
export function moveViewContainerFor(location: unknown): string | null {
  if (location === "panel" || location === "panel-right" || location === "panel-bottom") {
    return PANEL_CONTAINER_ID;
  }
  if (location === "sidebar") return PRIMARY_CONTAINER_ID;
  if (location === "auxiliarybar") return SECONDARY_CONTAINER_ID;
  return null;
}

/**
 * The panel edge a destination demands, or null to leave the workbench layout
 * alone.
 *
 * Only the two edge-explicit destinations move the panel. They exist for hosts
 * that refuse an extension container in the secondary side bar (Cursor reserves
 * it for its own agent UI): there, "To Right Panel" is the closest thing to
 * "To Secondary Side Bar" the host will actually accept, and it is only the
 * closest thing if the panel is docked right — otherwise the chat lands in a
 * short strip along the bottom, which is not what the label promised.
 *
 * Plain `"panel"` — what the menu sends where the secondary side bar exists,
 * and what every extension built before this change sends — stays null on
 * purpose. Panel position is workbench-wide, so moving it drags Terminal,
 * Problems and Output along; a menu item that never claimed an edge must not
 * rearrange the workbench behind the user's back.
 */
export function panelPositionFor(location: unknown): PanelPosition | null {
  if (location === "panel-right") return "right";
  if (location === "panel-bottom") return "bottom";
  return null;
}

/**
 * Whether the host actually created our secondary-side-bar container.
 *
 * The same probe {@link viewPlacementCorrection} runs, published to the webview so
 * the gear can offer destinations that exist. Capability, never `env.appName`.
 */
export function hostAcceptedSecondarySideBar(availableCommands: readonly string[]): boolean {
  return availableCommands.includes(SECONDARY_CONTAINER_ID);
}

/** What we remember about where the chat lives. Stored under
 *  {@link VIEW_PLACEMENT_KEY}. */
export interface PlacementRecord {
  /**
   * Version whose activation issued the one automatic correction there is.
   *
   * Its PRESENCE is the gate, not its value: the correction happens once per
   * install and never again. It was once-per-version, which looked right — an
   * update is when a refused container gets re-registered and the layout can
   * reset — but it cannot survive contact with how people actually move views.
   * The editor's own Move To leaves no trace we can read, and no API reports a
   * view's location back, so a user who moved the chat with the host's menu is
   * indistinguishable from one who never touched it. Correcting again would
   * haul their deliberate placement back, on every release, forever.
   *
   * Once is enough because the move does not silently fail: instrumenting a real
   * Cursor showed `moveViews` succeeding every time. The premise behind retrying
   * — that an attempt might have been lost — was simply false.
   *
   * The version is kept for diagnostics: it says which release did it.
   */
  correctedByVersion?: string;
  /**
   * The `moveView` location the user last picked from our own Move view menu.
   *
   * Remembered rather than merely used as a "stop correcting" flag, because
   * those two readings conflict the moment placement drifts back — which it
   * does: reinstalling re-registers the view against a container this host
   * refuses, and the chat reappears in Explorer. Suppressing correction would
   * strand a user who had already told us where they wanted it. So a choice
   * does not switch the correction off; it changes where the correction aims.
   */
  chosenLocation?: string;
  /**
   * The user moved the view through the HOST'S OWN picker, so where it ended up
   * is unknowable to us — that picker can create containers we never named, and
   * no API reports a view's location back.
   *
   * Suppresses the automatic correction permanently, and that is the point: the
   * correction's default is a guess, and a guess must not overrule a choice just
   * because the choice is illegible to us. Without this, the first update after
   * someone moved the chat to the secondary side bar would haul it back to the
   * primary one, every release, for as long as they kept putting it back.
   */
  pickedOwnLocation?: boolean;
}

export const VIEW_PLACEMENT_KEY = "grok.viewPlacement";

/** Location value that means "hand off to the host's own destination picker"
 *  — deliberately mapped to no container. */
export const PICK_LOCATION = "pick";

/** Record what the user chose, so a later correction restores it rather than
 *  overriding it. Two shapes, because the two kinds of choice differ in whether
 *  we can see the outcome. */
export function withUserChoice(
  prev: PlacementRecord | undefined,
  location: unknown,
): PlacementRecord {
  const base = { ...(prev ?? {}) };
  if (location === PICK_LOCATION) {
    // Their destination supersedes any earlier one of ours, and we cannot name
    // it — so drop the old target rather than leave a stale one to restore.
    delete base.chosenLocation;
    return { ...base, pickedOwnLocation: true };
  }
  if (typeof location === "string" && moveViewContainerFor(location)) {
    // A destination we CAN name: remember it and resume correcting, since this
    // one we are able to restore faithfully after an update resets it.
    delete base.pickedOwnLocation;
    return { ...base, chosenLocation: location };
  }
  return base;
}

/** Record that the one automatic correction has now happened. */
export function withAttempt(
  prev: PlacementRecord | undefined,
  extensionVersion: string,
): PlacementRecord {
  return { ...(prev ?? {}), correctedByVersion: extensionVersion };
}

/**
 * Where to move the view, or null to leave it where it is.
 *
 * The manifest homes the view in the secondary side bar. Cursor 3.15 refuses to
 * create that container — *"View containers cannot be contributed to the
 * Secondary Side Bar in Cursor. It is reserved for Cursor's agent UI"* — so the
 * view is dropped into Explorer, `workbench.view.extension.grokSidebar` never
 * registers, and `grok.open` fails with "command not found". The extension
 * cannot be opened at all there.
 *
 * The manifest is static and cannot branch per editor, so the correction has to
 * happen at runtime, using the same `vscode.moveViews` call the gear menu
 * already ships.
 *
 * Decided by CAPABILITY, never by `env.appName`: any fork adopting the same
 * restriction is handled without naming it, and a Cursor build that lifts the
 * restriction stops triggering this with no change here. Same reasoning as the
 * relay's rule — gate on the thing being present, not on a version or a brand.
 *
 * **Target is the PANEL, not the activity bar.** A panel docked right occupies
 * the same screen position and the same tall, narrow shape the chat was designed
 * for; the primary side bar puts it opposite the editor and competes with the
 * file tree for the space users already keep open. The caller pairs this with
 * `workbench.action.positionPanelRight` so the result is a secondary side bar in
 * everything but name.
 *
 * Fires ONCE PER VERSION automatically — which is also once per update, and an
 * update is exactly when the placement gets undone: reinstalling re-registers
 * the view against the container this host refuses, so the chat reappears in
 * Explorer. `force` (the palette command) ignores the gate entirely.
 *
 * Where it aims: the destination the user last picked from our menu if there is
 * one, else the panel.
 */
export function viewPlacementCorrection(opts: {
  availableCommands: readonly string[];
  placement: PlacementRecord | undefined;
  extensionVersion: string;
  /** The user asked for this by name (palette command) — no gate applies. */
  force?: boolean;
}): { containerId: string; panelPosition: PanelPosition | null } | null {
  const placement = opts.placement ?? {};
  // Placed by hand through the host's picker: we do not know where, so we must
  // not move it. Permanent, not once-per-version — an update resetting their
  // layout is the very moment this would do the most damage.
  if (!opts.force && placement.pickedOwnLocation) return null;
  if (!opts.force && placement.correctedByVersion !== undefined) return null;
  if (hostAcceptedSecondarySideBar(opts.availableCommands)) return null;

  const chosen = placement.chosenLocation;
  // Default is the ACTIVITY-BAR container, and the panel is NOT repositioned.
  //
  // Settled by instrumenting a real Cursor rather than by inference, after two
  // wrong theories:
  //
  //   containers: secondary=false primary=true panel=true  app=Cursor
  //   moving -> workbench.view.extension.grokPanel, panel right
  //   moved
  //
  // The move always succeeded. Cursor registers our panel container and then
  // renders it in the PRIMARY SIDE BAR — it honours the contribution but not its
  // declared location. So `grokPanel` and `grokPrimary` land in the same place
  // there, and aiming at the panel bought nothing while
  // `workbench.action.positionPanelRight` moved the user's Terminal, Problems
  // and Output across the window to achieve it. Same result, no collateral.
  //
  // Reaching that host's real panel or secondary side bar needs a LOCATION,
  // which no container id can name; its own Move To is the only route, and it
  // is a picker. The correction therefore aims at "somewhere ordinary and
  // reachable", not at a side of the screen.
  const containerId = (chosen && moveViewContainerFor(chosen)) || PRIMARY_CONTAINER_ID;
  // A destination the user picked by name may still move the panel — they asked
  // for that edge. Our own guess may not.
  const panelPosition = chosen ? panelPositionFor(chosen) : null;

  // Nothing to move it INTO. Cursor refuses only the secondary-side-bar
  // container, so this should not happen — but issuing a move at a container
  // that was never registered is how 3.2.8's attempt failed silently while
  // recording itself as a success, and a move that cannot land must not spend
  // the correction.
  if (!opts.availableCommands.includes(containerId)) return null;
  return { containerId, panelPosition };
}

/**
 * The command `grok.open` should execute to reveal the chat.
 *
 * It used to hardcode the secondary container, which is precisely what threw
 * when that container did not exist. The view's own auto-generated
 * `<viewId>.focus` is better in every case: it exists wherever the view is
 * registered and reveals it in place — including when the host has dropped it
 * into Explorer, which is the state a Cursor user is in before the relocation
 * lands.
 */
export function revealCommandFor(availableCommands: readonly string[]): string {
  const viewFocus = `${GROK_VIEW_ID}.focus`;
  if (availableCommands.includes(viewFocus)) return viewFocus;
  for (const id of [SECONDARY_CONTAINER_ID, PRIMARY_CONTAINER_ID, PANEL_CONTAINER_ID]) {
    if (availableCommands.includes(id)) return id;
  }
  // Nothing of ours registered. Returning the view focus is the likeliest to
  // exist of the options and keeps the failure to one command rather than none.
  return viewFocus;
}
