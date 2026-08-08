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
 * The same probe {@link viewRelocationTarget} runs, published to the webview so
 * the gear can offer destinations that exist. Capability, never `env.appName`.
 */
export function hostAcceptedSecondarySideBar(availableCommands: readonly string[]): boolean {
  return availableCommands.includes(SECONDARY_CONTAINER_ID);
}

/**
 * Where to move the view at activation, or null to leave it where it is.
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
 * Moves ONCE, tracked by the caller. Re-homing on every activation would drag
 * the view back out of wherever the user deliberately put it, every launch.
 */
export function viewRelocationTarget(opts: {
  availableCommands: readonly string[];
  alreadyRelocated: boolean;
}): string | null {
  if (opts.alreadyRelocated) return null;
  if (hostAcceptedSecondarySideBar(opts.availableCommands)) return null;
  return PANEL_CONTAINER_ID;
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
