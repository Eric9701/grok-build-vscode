/**
 * Desktop-only file-tree panel: CSS + boot script injected into the chat
 * document after load (does not touch getHtml / chat.js).
 *
 * Layout:
 *   - Full-width `.top-bar` stays outside the chat/file shell (edge-to-edge).
 *   - Panel toggle lives in the top bar (right end); closed = panel takes no space.
 *   - Opening files replaces the tree with a tabbed viewer; editing is
 *     opt-in and text-only. Multiple files can be open at once (one tab each).
 *
 * Class prefix `desk-ft-` keeps styles from colliding with chat.css.
 * Runs via webContents.executeJavaScript (bypasses CSP nonce) after each
 * HTML load so renderer reloads re-mount the panel.
 *
 * File-type glyphs: Seti UI (MIT) via {@link buildFileIconDataUrlMap}.
 *
 * Pure helpers below (`anyTabDirty`, `revertTabEdits`, `revealInFolderLabel`,
 * `tabFileName`) are unit-tested; keep them free of DOM / Electron.
 */
import { buildFileIconDataUrlMap, fileIconId, monochromeIconIds } from "./file-icons";

/** Minimal open-tab fields the pure helpers need. */
export interface DeskFtTabLike {
  dirty: boolean;
  text: string;
  originalText: string;
}

/** True when any open tab has unsaved edits (window-close / leave gate). */
export function anyTabDirty(tabs: Iterable<DeskFtTabLike>): boolean {
  for (const t of tabs) {
    if (t.dirty) return true;
  }
  return false;
}

/**
 * Restore a tab's editor text to the last loaded/saved snapshot and clear dirty.
 * Mutates and returns the same object (panel boot script style).
 */
export function revertTabEdits<T extends DeskFtTabLike>(tab: T): T {
  tab.text = tab.originalText;
  tab.dirty = false;
  return tab;
}

/** OS-local label for "reveal this file in the system file manager". */
export function revealInFolderLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Reveal in Explorer";
  return "Show in file manager";
}

/** Basename for a tab label (posix + win separators). */
export function tabFileName(relPath: string): string {
  const norm = String(relPath || "").replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : norm || "untitled";
}

/** Styles scoped under `.desk-ft-*` — never bare element rules that could hit chat.
 *  Row rhythm reuses the rail CSS custom properties defined on `body` in chat.css
 *  (`--rail-row-*`, `--rail-hover-bg`, …) so the tree and projects rail match. */
export const FILE_TREE_PANEL_CSS = `
/* body is still chat.css's column flex; shell sits under the full-width top bar.
   With the projects rail (body.has-rail), body is row: rail | .app-main column. */
body.desk-with-ft:not(.has-rail) {
  display: flex;
  flex-direction: column;
}
body.desk-with-ft.has-rail {
  display: flex;
  flex-direction: row;
  align-items: stretch;
}
body.desk-with-ft .top-bar {
  flex-shrink: 0;
  width: 100%;
  max-width: none;
  box-sizing: border-box;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
  z-index: 30;
}
body.desk-with-ft > .desk-ft-shell,
body.desk-with-ft .app-main > .desk-ft-shell {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: row;
}
body.desk-with-ft > script {
  display: none;
}
body.desk-with-ft.has-rail > .app-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.desk-ft-shell {
  display: flex;
  flex-direction: row;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  width: 100%;
}
.desk-ft-chat {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  /* Main chat surface — panel uses a different fill so the open panel
     reads as its own region rather than continuing this column. */
  background: var(--vscode-sideBar-background, #252526);
}
/* Panel hidden entirely when closed — takes no space (resizer too). */
body.desk-ft-closed .desk-ft-panel,
body.desk-ft-closed .desk-ft-resizer {
  display: none !important;
}
.desk-ft-panel {
  /* Width driven by --desk-ft-width (JS + localStorage); defaults below.
     Shrinkable rather than rigid: the stored width is the width it WANTS, not a
     width it insists on. Refusing to shrink meant that as the window narrowed,
     rail + chat + panel eventually exceeded the viewport and the whole row
     reflowed at once — which is what read as the panels jumping. Now it gives
     ground gradually and returns to the stored width when there is room again,
     because the flex basis never changed.
     The floor stops it collapsing into a useless sliver; the ceiling stops a
     width dragged out on a wide monitor from swallowing the conversation when
     the same window is later made small. */
  /* RIGID on purpose. A shrinkable panel looks like the right answer for a
     narrowing window and is the wrong one: flex distributes shrinkage across
     every shrinkable item, so dragging THIS panel made the browser re-shrink
     the rail, and part of each drag was absorbed as shrink instead of becoming
     width — the panel lagged the cursor and the other panel moved on its own.
     The real fix for a too-small window is to clamp the stored widths in JS on
     resize, so the conversation keeps a floor; that is not done yet, and until
     it is, rigid is the behaviour people were not complaining about. */
  flex: 0 0 var(--desk-ft-width, 280px);
  width: var(--desk-ft-width, 280px);
  max-width: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: none;
  /* Distinct from the chat column (sideBar) so the open panel reads as its
     own region — editor-background is darker under the desktop theme tokens. */
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-foreground, #ccc);
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  /* Match projects rail type scale (--rail-row-* from chat.css body). */
  font-size: var(--rail-row-font-size, 13px);
  line-height: var(--rail-row-line-height, 1.5);
  z-index: 20;
  overflow: hidden;
  /* Action labels respond to PANEL width (resizable), not the window. */
  container-type: inline-size;
  container-name: desk-ft;
}
/* The border between chat column and file panel IS the drag handle: it
   occupies exactly the 1px a divider would, has no fill of its own, and only
   changes colour on hover/drag. The grab area is widened invisibly by ::after
   so a 1px line is still easy to hit. */
.desk-ft-resizer {
  box-sizing: border-box;
  flex: 0 0 1px;
  width: 1px;
  margin: 0;
  padding: 0;
  border: none;
  border-left: 1px solid var(--vscode-editorWidget-border, #454545);
  background: transparent;
  cursor: col-resize;
  z-index: 25;
  align-self: stretch;
  position: relative;
  transition: border-left-color 100ms ease;
}
/* Invisible hit area — wider than the line, no paint of its own. */
.desk-ft-resizer::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  right: -4px;
}
.desk-ft-resizer:hover,
.desk-ft-resizer.desk-ft-resizing {
  border-left-color: var(--vscode-focusBorder, #007fd4);
}
body.desk-ft-resizing {
  cursor: col-resize !important;
  user-select: none !important;
}
body.desk-ft-resizing * {
  cursor: col-resize !important;
  user-select: none !important;
}
.desk-ft-header {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
  flex-shrink: 0;
  min-height: var(--rail-row-min-height, 30px);
  box-sizing: border-box;
  overflow: hidden;
}
/* Project name at the left of the tab strip — not a tab; click → tree. */
.desk-ft-title {
  flex: 0 1 auto;
  /* Uncapped by default. The 40% cap below exists to stop a long project name
     crowding out the tabs, which is only a problem when there ARE tabs — with
     none open the strip is empty and truncating "GROK-REMOTE" to "GROK-REM..."
     hides information for no one's benefit. */
  max-width: none;
  min-width: 0;
  min-height: var(--rail-row-min-height, 30px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  padding: 4px 8px;
  margin: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  line-height: var(--rail-row-line-height, 1.5);
  cursor: default;
  text-align: left;
  box-sizing: border-box;
  position: relative;
}
/* Tabs present: the name yields to them. Scoped through the shared parent
   because the title is the FIRST child and a sibling combinator only looks
   forward. :has() rather than a class toggled from JS, so the rule cannot drift
   out of sync with what is actually rendered. */
.desk-ft-header:has(.desk-ft-tab) .desk-ft-title {
  max-width: 40%;
}
button.desk-ft-title {
  cursor: pointer;
}
button.desk-ft-title:hover {
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06));
}
button.desk-ft-title:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: -1px;
}
.desk-ft-tabs {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}
.desk-ft-tab {
  flex: 0 1 auto;
  max-width: 160px;
  min-width: 56px;
  min-height: var(--rail-row-min-height, 30px);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 4px 4px 10px;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 1.3;
  box-sizing: border-box;
  position: relative;
}
.desk-ft-tab:hover {
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06));
}
/* Selected tab must read as selected at a glance — not only a border tint. */
.desk-ft-tab.desk-ft-tab-active {
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-tab-activeBackground, var(--vscode-editor-background, #1e1e1e));
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--vscode-focusBorder, #007fd4);
}
.desk-ft-tab:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: -1px;
  z-index: 1;
}
.desk-ft-title::after,
.desk-ft-tab::after {
  content: "";
  position: absolute;
  top: 4px;
  right: 0;
  bottom: 4px;
  width: 1px;
  background: var(--vscode-editorWidget-border, #454545);
  pointer-events: none;
}
.desk-ft-tab-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.desk-ft-tab-dirty {
  flex: 0 0 auto;
  width: 8px;
  color: var(--vscode-charts-yellow, #cca700);
  font-size: 14px;
  line-height: 1;
  text-align: center;
}
.desk-ft-tab-dirty:empty {
  display: none;
}
.desk-ft-tab-close {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  font: inherit;
  line-height: 1;
}
.desk-ft-tab-close:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.12));
  color: var(--vscode-foreground, #ccc);
}
.desk-ft-tab-close svg {
  width: 12px;
  height: 12px;
  display: block;
}
.desk-ft-filter {
  margin: 6px 6px 0;
  padding: 4px 8px;
  border: 1px solid var(--vscode-input-border, #3c3c3c);
  border-radius: 4px;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #ccc);
  font: inherit;
  font-size: var(--rail-row-font-size, 13px);
  outline: none;
  box-sizing: border-box;
  width: calc(100% - 12px);
  flex-shrink: 0;
}
.desk-ft-filter:focus {
  border-color: var(--vscode-focusBorder, #007fd4);
}
body.desk-ft-viewing .desk-ft-filter {
  display: none !important;
}
.desk-ft-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 1px 0 5px;
}
body.desk-ft-viewing .desk-ft-body {
  display: none !important;
}
.desk-ft-row {
  /* relative: hover ⋯ overlays the trailing edge (see .desk-ft-row-actions). */
  position: relative;
  display: flex;
  align-items: center;
  /* Tight lead→label gap: chevron/icon + name read as one unit (not rail's 6px). */
  gap: 2px;
  min-height: var(--rail-row-min-height, 30px);
  padding: 4px 4px 4px 0;
  cursor: default;
  user-select: none;
  white-space: nowrap;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--rail-row-font-size, 13px);
  line-height: var(--rail-row-line-height, 1.5);
  width: 100%;
  text-align: left;
  box-sizing: border-box;
  border-radius: var(--rail-row-radius, 5px);
}
.desk-ft-row:hover {
  background: var(--rail-hover-bg, var(--vscode-list-hoverBackground, #2a2d2e));
}
.desk-ft-row:focus-visible {
  outline: 2px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: -1px;
}
/* Hover ⋯ — same overlay model as .rail-session-actions: absolute over the row
   with a gradient scrim matching the row surface so a long name slides UNDER the
   button instead of being squeezed. The rail also has an .active scrim variant
   because a selected session paints list-activeSelectionBackground; tree rows
   have no selected paint today, so one scrim (hover) is enough. */
.desk-ft-row-actions {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  display: flex;
  flex: none;
  gap: 1px;
  opacity: 0;
  pointer-events: none;
  transition: opacity .1s ease;
  background: linear-gradient(
    to right,
    transparent 0%,
    var(--rail-hover-bg, var(--vscode-list-hoverBackground, #2a2d2e)) 28%
  );
  padding-left: 14px;
  border-radius: 4px;
}
.desk-ft-row:hover .desk-ft-row-actions,
.desk-ft-row:focus-within .desk-ft-row-actions {
  opacity: 1;
  pointer-events: auto;
}
.desk-ft-action-btn {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  width: 25px;
  height: 24px;
  padding: 0;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
/* Icons sit on the row's own hover surface — no darker per-icon chip (Codex /
   rail pattern). Focus outline remains for keyboard. */
.desk-ft-action-btn:hover {
  color: var(--vscode-foreground, #ccc);
  background: transparent;
}
.desk-ft-action-btn:focus-visible {
  outline: 2px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: -1px;
}
.desk-ft-action-btn svg {
  width: 12px;
  height: 12px;
  display: block;
}
/* No hover means no hover-reveal: force the ⋯ visible and in-flow on touch so
   it does not permanently cover the trailing name (mirrors rail @media). */
@media (hover: none) {
  .desk-ft-row-actions {
    position: static;
    right: auto;
    top: auto;
    transform: none;
    flex: 0 0 auto;
    opacity: 1;
    pointer-events: auto;
    background: transparent;
    padding-left: 0;
  }
  .desk-ft-action-btn {
    width: 32px;
    height: 30px;
  }
}
/* Single leading glyph column (Codex / VS Code): dir chevron OR file icon —
   never both, never an empty disclosure spacer beside the icon. Same 16px
   box so root files and folders share one left edge. */
.desk-ft-lead {
  --desk-ft-lead-size: 16px;
  flex: 0 0 var(--desk-ft-lead-size);
  width: var(--desk-ft-lead-size);
  height: var(--desk-ft-lead-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  flex-shrink: 0;
}
/* Disclosure chevron — fill the lead box; stroke is slightly heavier than
   default Lucide so a line glyph matches a filled Seti icon's visual weight. */
.desk-ft-twist {
  color: var(--vscode-descriptionForeground, #9d9d9d);
}
.desk-ft-twist svg {
  width: var(--desk-ft-lead-size, 16px);
  height: var(--desk-ft-lead-size, 16px);
  display: block;
  /* Optical weight vs filled 16px Seti icons (stroke paints inside the box). */
  stroke-width: 2.5;
}
/* File Seti icon in the same lead column as the folder chevron. */
.desk-ft-icon {
  opacity: 0.95;
}
.desk-ft-icon img,
.desk-ft-icon-img {
  width: var(--desk-ft-lead-size, 16px);
  height: var(--desk-ft-lead-size, 16px);
  display: block;
  object-fit: contain;
}
/* Seti glyphs with no fill of their own. Shown as a mask tinted by CSS rather
   than an <img>, because an SVG with no fill defaults to BLACK and a data-URL
   <img> cannot inherit a colour — a third of the set (rust, swift, vue, pdf,
   lock, db, the generic text icon…) was near-invisible on the dark theme.

   The tint is a THEME TOKEN, not opacity on the text colour: the desktop
   defines --vscode-descriptionForeground explicitly for both modes (#9d9d9d
   dark / #6e6e6e light), which lands at the same visual weight as the coloured
   Seti glyphs sitting next to it rather than shouting over them. Opacity would
   have given a different answer per background. */
.desk-ft-icon-mono {
  background-color: var(
    --vscode-icon-foreground,
    var(--vscode-descriptionForeground, currentColor)
  );
  -webkit-mask-image: var(--desk-ft-icon-mask);
  mask-image: var(--desk-ft-icon-mask);
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: contain;
  mask-size: contain;
}
.desk-ft-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--rail-row-font-size, 13px);
  line-height: var(--rail-row-line-height, 1.5);
}
.desk-ft-empty,
.desk-ft-error,
.desk-ft-more {
  padding: 8px 10px 8px var(--rail-indent, 16px);
  color: var(--vscode-descriptionForeground, #9d9d9d);
  font-size: 12px;
}
.desk-ft-error {
  color: var(--vscode-errorForeground, #f48771);
}
.desk-ft-children {
  display: none;
}
.desk-ft-node.desk-ft-open > .desk-ft-children {
  display: block;
}
/* Top-bar panel toggle (Lucide panel-right). Deliberately identical to
   chat.css's .icon-btn — the muted descriptionForeground, no padding, no
   border, the same 8px radius — because it sits in the same row as History and
   the overflow menu, and had been reading as a boxed, brighter, off-centre
   outlier. The glyph was off-centre for a concrete reason: a padding-left
   inside a fixed 28px box centres within what is LEFT of it. The old
   border-left was doing double duty as a separator; that is now its own
   element (.desk-ft-top-sep), because a border on the button will always
   distort the button. */
.desk-ft-top-toggle {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.desk-ft-top-toggle svg {
  width: 16px;
  height: 16px;
  display: block;
}
.desk-ft-top-toggle:hover {
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
}
/* The separator, as its own element rather than a border on the button. Only
   this desktop control exists after the ⋯ overflow — remote clients never mount
   it, so the divider is absent there by construction. Inset vertically so it
   reads as a divider between groups rather than a full-height rule. */
.desk-ft-top-sep {
  flex: 0 0 1px;
  width: 1px;
  align-self: stretch;
  margin: 4px 6px;
  background: var(--vscode-editorWidget-border, rgba(128,128,128,.35));
}
/* Rail collapse toggle (Lucide panel-left) — desktop shell only */
.desk-rail-toggle {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground, #ccc);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.desk-rail-toggle svg {
  width: 16px;
  height: 16px;
  display: block;
}
.desk-rail-toggle:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
}
.rail-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
}
.rail-toolbar .rail-search {
  flex: 1 1 auto;
  min-width: 0;
}
body.desk-rail-collapsed #projects-rail {
  display: none !important;
}
/* When the rail is collapsed, body is no longer a two-column host. */
body.desk-rail-collapsed.has-rail {
  flex-direction: column;
}
body.desk-rail-collapsed.has-rail .app-main {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
}
/* Re-open control on the left of the top bar while the rail is collapsed. */
.desk-rail-open-btn {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  margin-right: 4px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground, #ccc);
  cursor: pointer;
  display: none;
  align-items: center;
  justify-content: center;
}
.desk-rail-open-btn svg {
  width: 16px;
  height: 16px;
  display: block;
}
.desk-rail-open-btn:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
}
body.desk-rail-collapsed .desk-rail-open-btn {
  display: inline-flex;
}
/* File viewer (replaces tree — not side-by-side) */
.desk-ft-viewer {
  display: none;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}
body.desk-ft-viewing .desk-ft-viewer {
  display: flex;
}
/* Viewer action toolbar (Preview / Edit source / Save / Cancel / ⋯).
   Tabs + the project name handle navigation; no Back or breadcrumb. */
.desk-ft-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
  flex-shrink: 0;
  font-size: 11px;
  min-height: 28px;
  box-sizing: border-box;
}
/* Overflow (⋯) host for Open / Reveal — stays icon-only. */
.desk-ft-overflow {
  flex: 0 0 auto;
  margin-left: auto;
  position: relative;
  display: inline-flex;
}
.desk-ft-overflow-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  cursor: pointer;
  font: inherit;
}
.desk-ft-overflow-btn svg { display: block; }
.desk-ft-overflow-btn:hover,
.desk-ft-overflow-btn[aria-expanded="true"] {
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
}
.desk-ft-overflow-menu {
  display: none;
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
  z-index: 40;
  min-width: 200px;
  padding: 4px;
  margin: 0;
  list-style: none;
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 6px;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
  box-shadow: 0 4px 16px rgba(0,0,0,0.35);
}
.desk-ft-overflow-menu.desk-ft-open {
  display: block;
}
.desk-ft-overflow-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground, #ccc);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: left;
  box-sizing: border-box;
}
.desk-ft-overflow-item svg {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  display: block;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}
.desk-ft-overflow-item:hover {
  background: var(--vscode-list-hoverBackground, #2a2d2e);
}
.desk-ft-overflow-item:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: -1px;
}
/* Row overflow menu — body-fixed (panel is overflow:auto and would clip it).
   Opened from the hover ⋯ or right-click; positioned in layout px via the same
   zoom-aware maths as the rail menu (chatZoomFactor / unzoomClientPx). */
.desk-ft-ctx-menu {
  position: fixed;
  right: auto;
  top: auto;
  z-index: 50;
}
.desk-ft-viewer-action {
  /* Icon + optional label; narrow panel drops the label via container query. */
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 26px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.desk-ft-viewer-action svg { display: block; flex-shrink: 0; }
.desk-ft-action-label {
  display: none;
  line-height: 1;
}
/* Labels when the panel is wide enough — panel width, not window width. */
@container desk-ft (min-width: 340px) {
  .desk-ft-viewer-action .desk-ft-action-label {
    display: inline;
  }
  .desk-ft-viewer-action {
    padding: 0 8px;
  }
}
.desk-ft-viewer-action:hover:not(:disabled) {
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
}
.desk-ft-viewer-action:disabled {
  cursor: default;
  opacity: 0.45;
}
.desk-ft-viewer-action.desk-ft-active {
  /* Which of Preview/Edit-source you are in. Filled rather than outlined —
     an outline alone is easy to miss at 15px. */
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  border-color: var(--vscode-editorWidget-border, #454545);
}
.desk-ft-viewer-action:focus-visible,
.desk-ft-overflow-btn:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: 1px;
}
.desk-ft-editor {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 240px;
  box-sizing: border-box;
  resize: none;
  border: none;
  outline: none;
  padding: 0;
  background: transparent;
  color: var(--vscode-foreground, #ccc);
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre;
  tab-size: 2;
}
.desk-ft-notice {
  flex: 0 0 auto;
  padding: 5px 10px;
  color: var(--vscode-errorForeground, #f48771);
  font-size: 11px;
  border-top: 1px solid var(--vscode-editorWidget-border, #454545);
}
.desk-ft-notice:empty { display: none; }
.desk-ft-viewer-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px;
  background: var(--vscode-editor-background, #1e1e1e);
}
.desk-ft-viewer-body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  font-size: 12px;
  line-height: 1.45;
  color: var(--vscode-foreground, #ccc);
}
/* Markdown preview: typography lives in chat.css under the shared
   .msg.agent .body / .desk-ft-md selectors (links, code, tables, lists).
   Only layout constraints that are panel-specific stay here. */
.desk-ft-viewer-body .desk-ft-md {
  color: var(--vscode-foreground, #ccc);
}
/* A table in a narrow panel scrolls INSIDE its own wrapper — letting it widen
   the preview would push the whole panel sideways. */
.desk-ft-viewer-body .desk-ft-md .md-table-wrap {
  max-width: 100%;
}
.desk-ft-viewer-body img {
  max-width: 100%;
  height: auto;
  display: block;
}
`;

/**
 * Boot script source. Receives the preload bridge as `window.grokDesktopFileTree`.
 * Idempotent: re-running after reload remounts a single panel.
 *
 * @param iconsDir optional override for unit tests (defaults to media/file-icons).
 */
export function fileTreePanelBootSource(iconsDir?: string): string {
  // Built as a function body so executeJavaScript can wrap it. No TypeScript —
  // this string runs in the renderer.
  const iconMap = buildFileIconDataUrlMap(iconsDir);
  // Which of those are drawn in the row's own colour rather than shown as-is.
  const monoIds = monochromeIconIds(iconsDir);
  // Compact extension → Seti id table for the renderer (mirrors fileIconId).
  // Keep in sync with src/desktop/file-icons.ts fileIconId().
  const iconIdFn = fileIconId.toString();
  // Platform-local "Reveal in …" wording baked at inject time (no process in renderer).
  const revealLabel = revealInFolderLabel();
  return `(() => {
  // Lucide (ISC), inlined rather than fetched: the panel is injected into an
  // already-loaded document and must not depend on another network or disk read
  // to draw its own toolbar. currentColor throughout so they follow the theme
  // the way the rest of the chrome does.
  const FT_ICON = {
    // book-open-text
    preview:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M16 12h2"/><path d="M16 8h2"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 12h2"/><path d="M6 8h2"/></svg>',
    // code
    code:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
    // pencil
    edit:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
    // save
    save:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>',
    // rotate-ccw — cancel / discard edits
    cancel:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
    // app-window
    openExternal:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/></svg>',
    // folder-open — reveal in file manager
    reveal:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>',
    // ellipsis
    more:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
    // x — tab close
    close:
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  };
  const REVEAL_LABEL = ${JSON.stringify(revealLabel)};

  const api = window.grokDesktopFileTree;
  if (!api || typeof api.list !== "function") return { ok: false, reason: "no bridge" };

  const OPEN_KEY = "desk-ft-open";
  const FILTER_KEY = "desk-ft-filter";
  const RAIL_OPEN_KEY = "desk-rail-open";
  const WIDTH_KEY = "desk-ft-width";
  const WIDTH_DEFAULT = 280;
  const WIDTH_MIN = 200;
  const WIDTH_CHAT_MIN = 280;
  // Seti UI (MIT) data-URLs — bundled at inject time; no network fetch.
  const SETI_ICONS = ${JSON.stringify(iconMap)};
  // Seti glyphs carrying no fill of their own — painted with the row's text
  // colour instead of shown as-is, which would be black on a dark theme.
  const SETI_MONO = new Set(${JSON.stringify(monoIds)});
  const fileIconId = ${iconIdFn};
  // Lucide panel-left / panel-right — same convention as AFK Pilot + Codex.
  const ICON_PANEL_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>';
  const ICON_PANEL_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>';
  // Lucide chevron-right / chevron-down — VS Code / Codex disclosure shape (not triangles).
  // stroke-width 2.5 + 16px CSS box so the line glyph matches Seti icon weight.
  const ICON_CHEVRON_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  const ICON_CHEVRON_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  // Tear down a previous mount (reload / re-inject).
  const prevShell = document.getElementById("desk-ft-shell");
  if (prevShell) {
    const chat = prevShell.querySelector(".desk-ft-chat");
    const host = prevShell.parentElement || document.body;
    if (chat) {
      while (chat.firstChild) host.insertBefore(chat.firstChild, prevShell);
    }
    prevShell.remove();
  }
  document.getElementById("desk-ft-style")?.remove();
  document.getElementById("desk-ft-top-toggle")?.remove();
  // Its separator is a sibling now, not a border on the button — so it needs
  // removing too, or a re-inject leaves one behind on every reload.
  document.getElementById("desk-ft-top-sep")?.remove();
  document.getElementById("desk-rail-toggle")?.remove();
  document.getElementById("desk-rail-open-btn")?.remove();
  document.body.classList.remove("desk-ft-closed", "desk-with-ft", "desk-ft-viewing", "desk-ft-collapsed", "desk-rail-collapsed");

  const style = document.createElement("style");
  style.id = "desk-ft-style";
  style.textContent = ${JSON.stringify(FILE_TREE_PANEL_CSS)};
  document.head.appendChild(style);

  const shell = document.createElement("div");
  shell.id = "desk-ft-shell";
  shell.className = "desk-ft-shell";

  const chatCol = document.createElement("div");
  chatCol.className = "desk-ft-chat";

  // Host for chat+panel shell: .app-main when the projects rail is present
  // (desktop multi-folder), otherwise body. Never absorb #projects-rail.
  const layoutHost = document.querySelector(".app-main") || document.body;

  // Top bar stays in the host (full width of the chat column); everything else
  // in the host moves into the chat column beside the file panel.
  const toMove = [];
  for (const child of Array.from(layoutHost.childNodes)) {
    if (child.nodeType === 1) {
      const el = child;
      if (el.tagName === "SCRIPT") continue;
      if (el.id === "desk-ft-style") continue;
      if (el.id === "projects-rail") continue;
      if (el.classList && el.classList.contains("top-bar")) continue;
      if (el.id === "desk-ft-shell") continue;
      toMove.push(el);
    }
  }
  for (const el of toMove) chatCol.appendChild(el);

  const panel = document.createElement("aside");
  panel.id = "desk-ft-panel";
  panel.className = "desk-ft-panel";
  panel.setAttribute("aria-label", "Workspace files");

  const header = document.createElement("div");
  header.className = "desk-ft-header";

  // Project name is NOT a tab — click returns to the tree (keeps open tabs).
  const title = document.createElement("button");
  title.type = "button";
  title.className = "desk-ft-title";
  title.id = "desk-ft-title";
  title.textContent = "Files";
  title.title = "Show file tree";
  title.setAttribute("aria-label", "Show file tree");

  const tabsEl = document.createElement("div");
  tabsEl.className = "desk-ft-tabs";
  tabsEl.id = "desk-ft-tabs";
  tabsEl.setAttribute("role", "tablist");
  tabsEl.setAttribute("aria-label", "Open files");

  header.appendChild(title);
  header.appendChild(tabsEl);

  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "desk-ft-filter";
  filter.id = "desk-ft-filter";
  filter.placeholder = "Filter…";
  filter.autocomplete = "off";
  filter.spellcheck = false;

  const body = document.createElement("div");
  body.className = "desk-ft-body";
  body.id = "desk-ft-body";

  // Viewer replaces the tree (not side-by-side).
  const viewer = document.createElement("div");
  viewer.className = "desk-ft-viewer";
  viewer.id = "desk-ft-viewer";
  viewer.setAttribute("aria-label", "File preview");

  const toolbar = document.createElement("div");
  toolbar.className = "desk-ft-toolbar";
  toolbar.id = "desk-ft-toolbar";

  const viewerBody = document.createElement("div");
  viewerBody.className = "desk-ft-viewer-body";
  viewerBody.id = "desk-ft-viewer-body";

  const viewerNotice = document.createElement("div");
  viewerNotice.className = "desk-ft-notice";
  viewerNotice.id = "desk-ft-notice";

  viewer.appendChild(toolbar);
  viewer.appendChild(viewerBody);
  viewer.appendChild(viewerNotice);

  panel.appendChild(header);
  panel.appendChild(filter);
  panel.appendChild(body);
  panel.appendChild(viewer);

  const resizer = document.createElement("div");
  resizer.className = "desk-ft-resizer";
  resizer.id = "desk-ft-resizer";
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.setAttribute("aria-label", "Resize file panel");
  resizer.title = "Drag to resize";

  shell.appendChild(chatCol);
  shell.appendChild(resizer);
  shell.appendChild(panel);
  // Insert shell after the top bar (or at start of host).
  const topBarEl = layoutHost.querySelector(":scope > .top-bar") || layoutHost.querySelector(".top-bar");
  if (topBarEl && topBarEl.parentElement === layoutHost) {
    if (topBarEl.nextSibling) layoutHost.insertBefore(shell, topBarEl.nextSibling);
    else layoutHost.appendChild(shell);
  } else {
    const firstScript = layoutHost.querySelector("script") || document.body.querySelector("script");
    if (firstScript && firstScript.parentElement === layoutHost) {
      layoutHost.insertBefore(shell, firstScript);
    } else {
      layoutHost.appendChild(shell);
    }
  }

  document.body.classList.add("desk-with-ft");

  // Panel toggle in the top bar (right end).
  const topBar = document.querySelector(".top-bar");
  let topToggle = document.getElementById("desk-ft-top-toggle");
  if (!topToggle && topBar) {
    // Separator first, as a sibling. It used to be a border-left on the button,
    // which is what made the button look boxed and pushed its glyph off centre.
    if (!document.getElementById("desk-ft-top-sep")) {
      const sep = document.createElement("span");
      sep.id = "desk-ft-top-sep";
      sep.className = "desk-ft-top-sep";
      sep.setAttribute("aria-hidden", "true");
      topBar.appendChild(sep);
    }
    topToggle = document.createElement("button");
    topToggle.type = "button";
    topToggle.id = "desk-ft-top-toggle";
    topToggle.className = "desk-ft-top-toggle";
    topToggle.setAttribute("aria-label", "Toggle file panel");
    topBar.appendChild(topToggle);
  }

  let rootLabel = "Files";
  let viewRelPath = null; // null = tree mode (viewer hidden)
  // Open files keyed by relPath; stamp/dirty/originalText are per tab.
  const openTabs = new Map();
  let activeRelPath = null;
  let confirmSeq = 0;
  let tabOrder = [];

  function currentFile() {
    return activeRelPath ? openTabs.get(activeRelPath) || null : null;
  }

  function tabFileName(relPath) {
    const norm = String(relPath || "").replace(/\\\\/g, "/");
    const parts = norm.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : norm || "untitled";
  }

  function anyDirty() {
    for (const t of openTabs.values()) {
      if (t.dirty) return true;
    }
    return false;
  }

  function clampPanelWidth(px) {
    const shellW = shell.getBoundingClientRect().width || window.innerWidth || 800;
    const maxByChat = Math.max(WIDTH_MIN, Math.floor(shellW - WIDTH_CHAT_MIN));
    const maxByFrac = Math.floor(shellW * 0.7);
    const max = Math.max(WIDTH_MIN, Math.min(maxByChat, maxByFrac));
    const n = Math.round(Number(px));
    if (!Number.isFinite(n)) return WIDTH_DEFAULT;
    return Math.min(max, Math.max(WIDTH_MIN, n));
  }

  function applyPanelWidth(px, persist) {
    const w = clampPanelWidth(px);
    panel.style.setProperty("--desk-ft-width", w + "px");
    // Drag path persists; window-narrow reclamp paints only so a later grow
    // can restore the user's drag width from localStorage.
    if (persist !== false) {
      try { localStorage.setItem(WIDTH_KEY, String(w)); } catch (_) { /* */ }
    }
    return w;
  }

  // Restore persisted width (bounded) before first paint of open panel.
  let startWidth = WIDTH_DEFAULT;
  try {
    const savedW = localStorage.getItem(WIDTH_KEY);
    if (savedW != null && savedW !== "") startWidth = clampPanelWidth(savedW);
  } catch (_) { /* */ }
  applyPanelWidth(startWidth);

  // Drag-to-resize between chat and panel.
  (function wireResizer() {
    let dragging = false;
    let startX = 0;
    let startW = 0;
    resizer.addEventListener("pointerdown", (e) => {
      if (document.body.classList.contains("desk-ft-closed")) return;
      dragging = true;
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      document.body.classList.add("desk-ft-resizing");
      resizer.classList.add("desk-ft-resizing");
      try { resizer.setPointerCapture(e.pointerId); } catch (_) { /* */ }
      e.preventDefault();
    });
    const onMove = (e) => {
      if (!dragging) return;
      // Panel is on the right: drag left → wider, drag right → narrower.
      const delta = startX - e.clientX;
      applyPanelWidth(startW + delta);
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("desk-ft-resizing");
      resizer.classList.remove("desk-ft-resizing");
      try { resizer.releasePointerCapture(e.pointerId); } catch (_) { /* */ }
    };
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
    resizer.addEventListener("pointercancel", onUp);
    // Register with chat.js so a window-narrow reclamp can share the deficit
    // with the projects rail (proportional shrink from stored drag widths).
    // Full-screen video fires resize mid-transition with a meaningless width —
    // chat's wireFullscreenSafeReclamp skips those; we share that path.
    function preferredPanelWidth() {
      try {
        const s = localStorage.getItem(WIDTH_KEY);
        if (s != null && s !== "") {
          const n = Math.round(Number(s));
          if (Number.isFinite(n) && n > 0) return n;
        }
      } catch (_) { /* */ }
      return panel.getBoundingClientRect().width || WIDTH_DEFAULT;
    }
    if (typeof window.__grokRegisterSidePanel === "function") {
      window.__grokRegisterSidePanel({
        id: "panel",
        min: WIDTH_MIN,
        maxFrac: 0.7,
        isOpen: () => !document.body.classList.contains("desk-ft-closed"),
        preferredWidth: preferredPanelWidth,
        applyWidth: (px) => { applyPanelWidth(px, false); },
      });
    }
    const reclampPanel = () => {
      if (typeof window.__grokReclampSidePanels === "function") {
        window.__grokReclampSidePanels();
        return;
      }
      // Fallback when chat.js is not present (should not happen on desk).
      const cur = panel.getBoundingClientRect().width;
      if (cur > 0) applyPanelWidth(cur, false);
    };
    const wireFs = window.GrokWebviewHelpers && window.GrokWebviewHelpers.wireFullscreenSafeReclamp;
    if (typeof wireFs === "function") {
      wireFs(reclampPanel);
    } else {
      window.addEventListener("resize", () => {
        if (document.fullscreenElement) return;
        reclampPanel();
      });
      document.addEventListener("fullscreenchange", () => {
        if (!document.fullscreenElement) reclampPanel();
      });
    }
  })();

  function applyOpen(open) {
    document.body.classList.toggle("desk-ft-closed", !open);
    if (topToggle) {
      topToggle.innerHTML = ICON_PANEL_RIGHT;
      topToggle.title = open ? "Hide file panel" : "Show file panel";
      topToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch (_) { /* */ }
  }

  // Default closed (takes no space). Legacy "collapsed" key treated as closed.
  let startOpen = false;
  try {
    const v = localStorage.getItem(OPEN_KEY);
    if (v === "1") startOpen = true;
    if (v === null && localStorage.getItem("desk-ft-collapsed") === "0") startOpen = true;
  } catch (_) { /* */ }
  applyOpen(startOpen);

  if (topToggle) {
    topToggle.addEventListener("click", async () => {
      const opening = document.body.classList.contains("desk-ft-closed");
      if (!opening && !(await confirmLeaveDirty())) return;
      applyOpen(opening);
    });
  }

  title.addEventListener("click", () => { void showTree(); });

  panel.addEventListener("keydown", (event) => {
    const file = currentFile();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && file && file.editing) {
      event.preventDefault();
      event.stopPropagation();
      void saveFile();
    }
  });

  // Projects rail collapse — button lives in .rail-top (getHtml / AFK Pilot shape).
  // Fall back to injecting into a legacy .rail-toolbar if an older shell is open.
  const rail = document.getElementById("projects-rail");
  const topBarForRail = document.querySelector(".top-bar");
  if (rail && topBarForRail) {
    let railToggle = document.getElementById("desk-rail-toggle");
    if (!railToggle) {
      const host = rail.querySelector(".rail-top") || rail.querySelector(".rail-toolbar");
      if (host) {
        railToggle = document.createElement("button");
        railToggle.type = "button";
        railToggle.id = "desk-rail-toggle";
        railToggle.className = "rail-icon-btn";
        railToggle.innerHTML = ICON_PANEL_LEFT;
        railToggle.setAttribute("aria-label", "Hide projects");
        host.appendChild(railToggle);
      }
    }
    let railOpenBtn = document.getElementById("desk-rail-open-btn");
    if (!railOpenBtn) {
      railOpenBtn = document.createElement("button");
      railOpenBtn.type = "button";
      railOpenBtn.id = "desk-rail-open-btn";
      railOpenBtn.className = "desk-rail-open-btn";
      railOpenBtn.innerHTML = ICON_PANEL_LEFT;
      railOpenBtn.title = "Show projects";
      railOpenBtn.setAttribute("aria-label", "Show projects");
      topBarForRail.insertBefore(railOpenBtn, topBarForRail.firstChild);
    }
    function applyRailOpen(open) {
      document.body.classList.toggle("desk-rail-collapsed", !open);
      if (railToggle) {
        railToggle.title = open ? "Hide projects" : "Show projects";
        railToggle.setAttribute("aria-expanded", open ? "true" : "false");
      }
      try { localStorage.setItem(RAIL_OPEN_KEY, open ? "1" : "0"); } catch (_) { /* */ }
    }
    let railStartOpen = true;
    try {
      if (localStorage.getItem(RAIL_OPEN_KEY) === "0") railStartOpen = false;
    } catch (_) { /* */ }
    applyRailOpen(railStartOpen);
    if (railToggle && !railToggle.dataset.wired) {
      railToggle.dataset.wired = "1";
      railToggle.addEventListener("click", () => applyRailOpen(false));
    }
    if (railOpenBtn && !railOpenBtn.dataset.wired) {
      railOpenBtn.dataset.wired = "1";
      railOpenBtn.addEventListener("click", () => applyRailOpen(true));
    }
  }

  try {
    const saved = localStorage.getItem(FILTER_KEY);
    if (saved) filter.value = saved;
  } catch (_) { /* */ }

  function filterText() {
    return (filter.value || "").trim().toLowerCase();
  }

  function matchesFilter(name) {
    const q = filterText();
    if (!q) return true;
    return name.toLowerCase().includes(q);
  }

  function applyFilter(rootEl) {
    const q = filterText();
    const nodes = rootEl.querySelectorAll(":scope > .desk-ft-node");
    let visible = 0;
    for (const node of nodes) {
      const name = node.getAttribute("data-name") || "";
      const childBox = node.querySelector(":scope > .desk-ft-children");
      let childVisible = 0;
      if (childBox) {
        applyFilter(childBox);
        childVisible = childBox.querySelectorAll(".desk-ft-node").length
          ? [...childBox.querySelectorAll(":scope > .desk-ft-node")].filter(
              (n) => n.style.display !== "none"
            ).length
          : 0;
      }
      const show = !q || matchesFilter(name) || childVisible > 0;
      node.style.display = show ? "" : "none";
      if (show) visible++;
    }
    return visible;
  }

  filter.addEventListener("input", () => {
    try { localStorage.setItem(FILTER_KEY, filter.value); } catch (_) { /* */ }
    applyFilter(body);
  });

  /** Plain disclosure chevron SVG (VS Code / Codex > / v shape) — not triangles. */
  function twistGlyph(open) {
    return open ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT;
  }

  /** Seti UI icon id + data-URL for a *file* entry (dirs use chevron only). */
  function iconFor(kind, name) {
    if (kind === "dir") return { id: "", src: "", mono: false };
    let id = fileIconId(kind, name);
    let src = SETI_ICONS[id];
    // Falling back to \`default\` must also fall back to ITS colour treatment,
    // not keep the requested id's — \`default\` is one of the mono glyphs.
    if (!src) { id = SETI_ICONS.default ? "default" : id; src = SETI_ICONS.default || ""; }
    return { id: id, src: src, mono: SETI_MONO.has(id) };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Prefer the conversation's renderer — same document, already loaded, and it
  // does bullets, tables, blockquotes, links and italics that the fallback
  // below never did. The fallback stays for the case where chat.js has not
  // finished evaluating when a preview opens; it is a degraded view of the same
  // file, not a different one.
  function renderMarkdown(src) {
    const shared = window.__grokRenderMarkdown;
    if (typeof shared === "function") {
      try { return shared(src); } catch (_) { /* fall through */ }
    }
    return renderMarkdownFallback(src);
  }

  // Minimal markdown for read-only preview (not a full parser).
  function renderMarkdownFallback(src) {
    const lines = String(src).split(/\\r?\\n/);
    const out = [];
    let inCode = false;
    let code = [];
    for (const line of lines) {
      if (line.startsWith("\`\`\`")) {
        if (inCode) {
          out.push("<pre><code>" + escapeHtml(code.join("\\n")) + "</code></pre>");
          code = [];
          inCode = false;
        } else {
          inCode = true;
        }
        continue;
      }
      if (inCode) { code.push(line); continue; }
      if (/^###\\s+/.test(line)) {
        out.push("<h3>" + escapeHtml(line.replace(/^###\\s+/, "")) + "</h3>");
      } else if (/^##\\s+/.test(line)) {
        out.push("<h2>" + escapeHtml(line.replace(/^##\\s+/, "")) + "</h2>");
      } else if (/^#\\s+/.test(line)) {
        out.push("<h1>" + escapeHtml(line.replace(/^#\\s+/, "")) + "</h1>");
      } else if (line.trim() === "") {
        out.push("");
      } else {
        let t = escapeHtml(line);
        t = t.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
        t = t.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
        out.push("<p>" + t + "</p>");
      }
    }
    if (inCode) out.push("<pre><code>" + escapeHtml(code.join("\\n")) + "</code></pre>");
    return out.join("");
  }

  // chat.js owns uiConfirm. Its public host-message seam is the only supported
  // way for injected panel code to use that same in-page dialog. The optional
  // second action is added to that dialog only for the Reload/Overwrite choice;
  // Cancel, Escape, and backdrop dismissal all resolve to the safe outcome.
  function requestSharedConfirm(opts, secondLabel) {
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      let timer = null;
      let closingSharedDialog = false;
      const id = "desk-file-confirm-" + (++confirmSeq);
      const settle = (value) => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        if (timer) clearTimeout(timer);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === "Escape") settle("cancel");
      };
      const onClick = (event) => {
        const target = event.target;
        const button = target && target.closest ? target.closest("button") : null;
        if (button && button.classList.contains("desk-ft-secondary-choice")) {
          event.preventDefault();
          event.stopImmediatePropagation();
          closingSharedDialog = true;
          const cancel = button.parentElement && button.parentElement.querySelector(".confirm-btn:not(.confirm-primary):not(.confirm-danger)");
          if (cancel) cancel.click();
          settle("second");
          return;
        }
        if (button && (button.classList.contains("confirm-primary") || button.classList.contains("confirm-danger"))) {
          settle("confirm");
          return;
        }
        if (button && button.textContent === "Cancel") {
          if (closingSharedDialog) return;
          settle("cancel");
          return;
        }
        if (target && target.classList && target.classList.contains("confirm-overlay")) {
          settle("cancel");
        }
      };
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
      if (typeof MutationObserver === "function") {
        observer = new MutationObserver(() => {
          const overlay = document.querySelector(".confirm-overlay:not([data-desk-ft-owned])");
          if (!overlay) return;
          overlay.setAttribute("data-desk-ft-owned", id);
          if (!secondLabel) return;
          const actions = overlay.querySelector(".confirm-actions");
          if (!actions || actions.querySelector(".desk-ft-secondary-choice")) return;
          const extra = document.createElement("button");
          extra.type = "button";
          extra.className = "confirm-btn confirm-primary desk-ft-secondary-choice";
          extra.textContent = secondLabel;
          actions.insertBefore(extra, actions.firstChild);
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
      // If an older chat bundle has no uiConfirm seam, fail closed rather than
      // leaving a dirty file action hanging forever.
      timer = setTimeout(() => settle("cancel"), 5000);
      try {
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "uiConfirmRequest",
          id,
          title: opts.title,
          body: opts.body,
          confirmLabel: opts.confirmLabel,
          danger: !!opts.danger,
        }}));
      } catch (_) {
        settle("cancel");
      }
      void closingSharedDialog;
    });
  }

  function askConfirm(opts) {
    return requestSharedConfirm(opts).then((choice) => choice === "confirm");
  }

  function dirtyNow() {
    const file = currentFile();
    return !!(file && file.dirty);
  }

  function updateDirtyUi() {
    // In-place dirty dots — do not rebuild tabs on every keystroke.
    for (const tab of tabsEl.querySelectorAll(".desk-ft-tab")) {
      const rel = tab.getAttribute("data-rel");
      const file = rel ? openTabs.get(rel) : null;
      const dirty = tab.querySelector(".desk-ft-tab-dirty");
      if (dirty) dirty.textContent = file && file.dirty ? "•" : "";
    }
    const save = toolbar.querySelector(".desk-ft-save");
    if (save) save.disabled = !dirtyNow();
    // Cancel is mounted only while dirty — rebuild the toolbar when the flag flips.
    const cancel = toolbar.querySelector(".desk-ft-cancel");
    if (dirtyNow() && !cancel) {
      const f = currentFile();
      if (f) renderToolbar(f.relPath);
    } else if (!dirtyNow() && cancel) {
      cancel.remove();
    }
  }

  async function confirmLeaveDirty() {
    // Window close / panel hide / project rebind: any dirty tab blocks.
    if (!anyDirty()) return true;
    return askConfirm({
      title: "Discard changes?",
      body: "Your edits have not been saved.",
      confirmLabel: "Discard",
      danger: true,
    });
  }

  async function confirmDiscardTab(file) {
    if (!file || !file.dirty) return true;
    return askConfirm({
      title: "Discard changes?",
      body: "Your edits have not been saved.",
      confirmLabel: "Discard",
      danger: true,
    });
  }

  // Main process close hook: dirty if ANY tab has unsaved work.
  window.__grokDeskFtBeforeClose = () => confirmLeaveDirty();

  function renderTabs() {
    tabsEl.textContent = "";
    for (const rel of tabOrder) {
      const file = openTabs.get(rel);
      if (!file) continue;
      const tab = document.createElement("div");
      tab.className = "desk-ft-tab" + (rel === activeRelPath && viewRelPath ? " desk-ft-tab-active" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", rel === activeRelPath && !!viewRelPath ? "true" : "false");
      tab.setAttribute("data-rel", rel);
      tab.title = rel;
      tab.tabIndex = 0;

      const name = document.createElement("span");
      name.className = "desk-ft-tab-name";
      name.textContent = tabFileName(rel);

      const dirty = document.createElement("span");
      dirty.className = "desk-ft-tab-dirty";
      dirty.setAttribute("aria-label", "Unsaved changes");
      dirty.textContent = file.dirty ? "•" : "";

      const close = document.createElement("button");
      close.type = "button";
      close.className = "desk-ft-tab-close";
      close.innerHTML = FT_ICON.close;
      close.title = "Close";
      close.setAttribute("aria-label", "Close " + tabFileName(rel));
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void closeTab(rel);
      });

      tab.appendChild(name);
      tab.appendChild(dirty);
      tab.appendChild(close);
      tab.addEventListener("click", () => { void activateTab(rel); });
      tab.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void activateTab(rel);
        }
      });
      tabsEl.appendChild(tab);
    }
  }

  async function activateTab(relPath) {
    if (!openTabs.has(relPath)) return false;
    // Flush editor text into the outgoing tab before switching.
    syncEditorIntoActive();
    activeRelPath = relPath;
    viewRelPath = relPath;
    document.body.classList.add("desk-ft-viewing");
    applyOpen(true);
    setViewerNotice("");
    renderToolbar(relPath);
    renderViewerBody();
    renderTabs();
    return true;
  }

  function syncEditorIntoActive() {
    const file = currentFile();
    if (!file) return;
    const editor = viewerBody.querySelector(".desk-ft-editor");
    if (editor) {
      file.text = editor.value;
      file.dirty = editor.value !== file.originalText;
    }
  }

  async function closeTab(relPath) {
    const file = openTabs.get(relPath);
    if (!file) return false;
    if (relPath === activeRelPath) syncEditorIntoActive();
    if (!(await confirmDiscardTab(openTabs.get(relPath)))) return false;
    openTabs.delete(relPath);
    tabOrder = tabOrder.filter((r) => r !== relPath);
    if (activeRelPath === relPath) {
      activeRelPath = tabOrder.length ? tabOrder[tabOrder.length - 1] : null;
      if (activeRelPath) {
        viewRelPath = activeRelPath;
        setViewerNotice("");
        renderToolbar(activeRelPath);
        renderViewerBody();
        renderTabs();
      } else {
        viewRelPath = null;
        document.body.classList.remove("desk-ft-viewing");
        viewerBody.textContent = "";
        viewerNotice.textContent = "";
        toolbar.textContent = "";
        renderTabs();
      }
    } else {
      renderTabs();
    }
    return true;
  }

  async function showTree() {
    // Return to tree without closing tabs — nothing discarded, no confirm.
    // Project name button and closing the last tab both land here.
    syncEditorIntoActive();
    viewRelPath = null;
    document.body.classList.remove("desk-ft-viewing");
    viewerBody.textContent = "";
    viewerNotice.textContent = "";
    toolbar.textContent = "";
    renderTabs();
    return true;
  }

  async function clearAllTabs() {
    if (!(await confirmLeaveDirty())) return false;
    openTabs.clear();
    tabOrder = [];
    activeRelPath = null;
    viewRelPath = null;
    document.body.classList.remove("desk-ft-viewing");
    viewerBody.textContent = "";
    viewerNotice.textContent = "";
    toolbar.textContent = "";
    renderTabs();
    return true;
  }

  function setViewerNotice(message) {
    viewerNotice.textContent = message || "";
  }

  function editorValue() {
    const editor = viewerBody.querySelector(".desk-ft-editor");
    const file = currentFile();
    return editor ? editor.value : (file ? file.text : "");
  }

  function renderViewerBody() {
    const file = currentFile();
    if (!file) return;
    viewerBody.textContent = "";
    const source = file.text;
    if (file.kind === "image" && file.dataUrl) {
      const img = document.createElement("img");
      img.src = file.dataUrl;
      img.alt = file.relPath;
      viewerBody.appendChild(img);
      return;
    }
    const code = file.kind === "markdown" ? file.mode === "code" : file.editing;
    if (code) {
      const editor = document.createElement("textarea");
      editor.className = "desk-ft-editor";
      editor.value = source;
      editor.spellcheck = false;
      editor.setAttribute("aria-label", "Edit " + file.relPath);
      editor.addEventListener("input", () => {
        file.text = editor.value;
        file.dirty = editor.value !== file.originalText;
        updateDirtyUi();
      });
      viewerBody.appendChild(editor);
      return;
    }
    if (file.kind === "markdown" && file.mode === "preview") {
      const wrap = document.createElement("div");
      wrap.className = "desk-ft-md";
      wrap.innerHTML = renderMarkdown(source);
      viewerBody.appendChild(wrap);
      return;
    }
    const pre = document.createElement("pre");
    pre.textContent = source;
    viewerBody.appendChild(pre);
  }

  function setViewerMode(mode, editing) {
    const file = currentFile();
    if (!file) return;
    syncEditorIntoActive();
    file.mode = mode;
    file.editing = !!editing;
    renderToolbar(file.relPath);
    renderViewerBody();
    updateDirtyUi();
    if (file.editing) {
      const editor = viewerBody.querySelector(".desk-ft-editor");
      if (editor) editor.focus();
    }
  }

  async function cancelChanges() {
    const file = currentFile();
    if (!file || !file.dirty) return false;
    const ok = await askConfirm({
      title: "Cancel changes?",
      body: "This discards your unsaved edits and restores the last loaded version.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return false;
    file.text = file.originalText;
    file.dirty = false;
    renderViewerBody();
    // Rebuild so Cancel is gone the moment the tab is clean (not merely hidden).
    renderToolbar(file.relPath);
    updateDirtyUi();
    return true;
  }

  // Shared by the tab-toolbar ⋯ menu and the tree-row overflow (⋯ / right-click).
  let ctxMenuEl = null;
  // Anchor of the open row menu — capture-phase outside-click must NOT close when
  // the click is on this node, or the button's own toggle reopens it (rail scar:
  // second click on the same ⋯ appeared to do nothing).
  let ctxMenuAnchorEl = null;

  function closeOverflowMenu() {
    const menu = toolbar.querySelector(".desk-ft-overflow-menu");
    const btn = toolbar.querySelector(".desk-ft-overflow-btn");
    if (menu) menu.classList.remove("desk-ft-open");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function closeContextMenu() {
    if (ctxMenuEl) {
      ctxMenuEl.remove();
      ctxMenuEl = null;
    }
    ctxMenuAnchorEl = null;
  }

  function closeAllMenus() {
    closeOverflowMenu();
    closeContextMenu();
  }

  const mkItem = (menu, cls, icon, label, onClick) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "desk-ft-overflow-item" + (cls ? " " + cls : "");
    item.setAttribute("role", "menuitem");
    item.innerHTML = icon + "<span>" + escapeHtml(label) + "</span>";
    item.title = label;
    item.setAttribute("aria-label", label);
    item.addEventListener("click", async () => {
      closeAllMenus();
      await onClick();
    });
    menu.appendChild(item);
    return item;
  };

  /** Body zoom helpers — do not re-derive; the rail's openRailMenu uses the same. */
  function ftZoomHelpers() {
    const h = window.GrokWebviewHelpers || {};
    return {
      chatZoomFactor: typeof h.chatZoomFactor === "function" ? h.chatZoomFactor : function () { return 1; },
      unzoomClientPx: typeof h.unzoomClientPx === "function" ? h.unzoomClientPx : function (px) { return px; },
    };
  }

  /**
   * Tree-row overflow: files get Open + Reveal; folders Reveal only.
   * \`anchor\` is either the ⋯ button (Element) or a pointer {clientX,clientY}
   * from right-click. \`opts.toggle\` + \`opts.menuKey\` make a second click on
   * the same ⋯ close rather than reopen (rail openRailMenu pattern).
   */
  function openRowMenu(anchor, relPath, kind, opts) {
    const menuKey = (opts && opts.menuKey) || "";
    const allowToggle = !!(opts && opts.toggle);
    const wasMine = !!ctxMenuEl && !!menuKey && ctxMenuEl.dataset.anchorId === menuKey;
    closeAllMenus();
    if (allowToggle && wasMine) return;

    const menu = document.createElement("div");
    menu.className = "desk-ft-overflow-menu desk-ft-open desk-ft-ctx-menu";
    menu.setAttribute("role", "menu");
    if (menuKey) menu.dataset.anchorId = menuKey;
    if (kind !== "dir") {
      // desk-ft-open-ext kept for e2e / contract that still look for this affordance.
      mkItem(menu, "desk-ft-open-ext", FT_ICON.openExternal, "Open in default app", async () => {
        try { await api.open(relPath); } catch (_) { /* */ }
      });
    }
    if (typeof api.reveal === "function") {
      mkItem(menu, "desk-ft-reveal", FT_ICON.reveal, REVEAL_LABEL, async () => {
        try { await api.reveal(relPath); } catch (_) { /* */ }
      });
    }
    // Older host without reveal + a folder → nothing to show.
    if (!menu.childNodes.length) return;
    document.body.appendChild(menu);
    ctxMenuEl = menu;
    ctxMenuAnchorEl = (anchor && anchor.nodeType === 1) ? anchor : null;

    // Flip up / pull left rather than run off the viewport. Body \`zoom\` scales
    // visual rects; fixed style top/left are layout px — unzoomClientPx converts
    // (zoom 1 is a no-op). Same maths as openRailMenu in chat.js.
    const helpers = ftZoomHelpers();
    const z = helpers.chatZoomFactor();
    const size = menu.getBoundingClientRect();
    const gap = 4;
    const menuH = helpers.unzoomClientPx(size.height, z);
    const menuW = helpers.unzoomClientPx(size.width, z);
    const vh = helpers.unzoomClientPx(window.innerHeight, z);
    const vw = helpers.unzoomClientPx(window.innerWidth, z);
    let top;
    let left;
    if (anchor && typeof anchor.getBoundingClientRect === "function") {
      const box = anchor.getBoundingClientRect();
      top = helpers.unzoomClientPx(box.bottom, z) + gap;
      if (top + menuH > vh - 8) top = Math.max(8, helpers.unzoomClientPx(box.top, z) - menuH - gap);
      left = helpers.unzoomClientPx(box.right, z) - menuW;
      left = Math.max(8, Math.min(left, vw - menuW - 8));
    } else {
      // Right-click: place at the pointer, still zoom-corrected and clamped.
      const cx = (anchor && typeof anchor.clientX === "number") ? anchor.clientX : 0;
      const cy = (anchor && typeof anchor.clientY === "number") ? anchor.clientY : 0;
      top = helpers.unzoomClientPx(cy, z);
      left = helpers.unzoomClientPx(cx, z);
      if (top + menuH > vh - 8) top = Math.max(8, vh - menuH - 8);
      if (left + menuW > vw - 8) left = Math.max(8, vw - menuW - 8);
    }
    menu.style.top = Math.round(top) + "px";
    menu.style.left = Math.round(left) + "px";
    const first = menu.querySelector(".desk-ft-overflow-item:not(:disabled)");
    if (first) first.focus();
  }

  /** Right-click entry point — same menu as the ⋯ button, pointer-anchored. */
  function showRowContextMenu(event, relPath, kind) {
    event.preventDefault();
    event.stopPropagation();
    openRowMenu(
      { clientX: event.clientX, clientY: event.clientY },
      relPath,
      kind,
      { menuKey: "ctx:" + relPath },
    );
  }

  function renderToolbar(relPath) {
    toolbar.textContent = "";
    const file = currentFile();

    if (file && (file.kind === "markdown" || file.kind === "text" || file.kind === "json")) {
      const action = (icon, label, onClick, extraClass) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "desk-ft-viewer-action" + (extraClass ? " " + extraClass : "");
        // Icon + responsive text label (hidden by container query when narrow).
        // title + aria-label stay in both states.
        const labelText = label === "Save (Ctrl+S)" ? "Save" : label;
        b.innerHTML = icon + '<span class="desk-ft-action-label">' + escapeHtml(labelText) + "</span>";
        b.title = label;
        b.setAttribute("aria-label", label);
        b.addEventListener("click", onClick);
        toolbar.appendChild(b);
        return b;
      };

      if (file.kind === "markdown") {
        // Markdown gets Preview/Code and NOT Edit: switching to Code already
        // makes the source editable, so an Edit button beside it would be a
        // second control for the thing you just did.
        action(
          FT_ICON.preview,
          "Preview",
          () => setViewerMode("preview", file.editing),
          file.mode === "preview" ? "desk-ft-active" : "",
        );
        action(
          FT_ICON.code,
          "Edit source",
          () => setViewerMode("code", true),
          file.mode === "code" ? "desk-ft-active" : "",
        );
      } else if (!file.editing) {
        // Plain text and JSON have no rendered form to toggle against, so Edit
        // is the only way in.
        action(FT_ICON.edit, "Edit", () => setViewerMode("code", true));
      }

      if (file.editing) {
        const saveBtn = action(
          FT_ICON.save,
          "Save (Ctrl+S)",
          () => { void saveFile(); },
          "desk-ft-save",
        );
        saveBtn.disabled = !file.dirty;
      }

      // Cancel only exists while dirty — never mounted clean, removed on revert.
      if (file.dirty) {
        action(
          FT_ICON.cancel,
          "Cancel",
          () => { void cancelChanges(); },
          "desk-ft-cancel",
        );
      }
    }

    // ⋯ overflow: Open in default app + Reveal in Finder/Explorer/file manager.
    const overflow = document.createElement("div");
    overflow.className = "desk-ft-overflow";
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "desk-ft-overflow-btn";
    moreBtn.innerHTML = FT_ICON.more;
    moreBtn.title = "More actions";
    moreBtn.setAttribute("aria-label", "More actions");
    moreBtn.setAttribute("aria-haspopup", "menu");
    moreBtn.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "desk-ft-overflow-menu";
    menu.setAttribute("role", "menu");

    // desk-ft-open-ext kept for e2e / contract that still look for this affordance.
    mkItem(menu, "desk-ft-open-ext", FT_ICON.openExternal, "Open in default app", async () => {
      try { await api.open(relPath); } catch (_) { /* */ }
    });
    if (typeof api.reveal === "function") {
      mkItem(menu, "desk-ft-reveal", FT_ICON.reveal, REVEAL_LABEL, async () => {
        try { await api.reveal(relPath); } catch (_) { /* */ }
      });
    }

    moreBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = !menu.classList.contains("desk-ft-open");
      closeAllMenus();
      if (open) {
        menu.classList.add("desk-ft-open");
        moreBtn.setAttribute("aria-expanded", "true");
      }
    });
    overflow.appendChild(moreBtn);
    overflow.appendChild(menu);
    toolbar.appendChild(overflow);
  }

  // Dismiss overflow / row menu on outside click / Escape / resize.
  document.addEventListener("click", (event) => {
    const t = event.target;
    if (t && t.closest && t.closest(".desk-ft-overflow")) return;
    if (t && t.closest && t.closest(".desk-ft-ctx-menu")) return;
    // Anchor click is a TOGGLE — capture would close before the button reopens.
    if (ctxMenuAnchorEl && ctxMenuAnchorEl.contains && ctxMenuAnchorEl.contains(t)) return;
    closeAllMenus();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAllMenus();
  }, true);
  window.addEventListener("resize", closeContextMenu);
  // Right-click outside a tree row closes a lingering context menu.
  document.addEventListener("contextmenu", (event) => {
    const t = event.target;
    if (t && t.closest && t.closest(".desk-ft-row")) return;
    closeContextMenu();
  }, true);
  // The menu is position:fixed, so scrolling the tree slides the rows out from
  // under it and leaves it pointing at whatever landed there instead. Capture,
  // because the scroll happens on the inner tree container.
  document.addEventListener("scroll", closeContextMenu, true);

  async function openFileView(relPath, force) {
    // Already open: just activate (unless force-reload after conflict).
    if (!force && openTabs.has(relPath)) {
      await activateTab(relPath);
      return { ok: true, kind: openTabs.get(relPath).kind || "text" };
    }
    if (!api.read) {
      // Older host without read channel — fall back to OS open.
      try { await api.open(relPath); } catch (_) { /* */ }
      return { ok: false, reason: "no read channel", openExternal: true };
    }
    // Flush outgoing editor before replacing/adding a tab.
    syncEditorIntoActive();
    let result;
    try {
      result = await api.read(relPath);
    } catch (e) {
      console.warn("[desk-ft] read error", e);
      return { ok: false, reason: String((e && e.message) || e) };
    }
    if (result && result.openExternal) {
      try { await api.open(relPath); } catch (_) { /* */ }
      return { ok: true, openExternal: true };
    }
    if (!result || result.ok === false) {
      if (result && (result.reason === "open externally" || result.openExternal)) {
        try { await api.open(relPath); } catch (_) { /* */ }
        return { ok: true, openExternal: true };
      }
      console.warn("[desk-ft] read failed:", result && (result.reason || result.error));
      return { ok: false, reason: (result && (result.reason || result.error)) || "read failed" };
    }

    const state = {
      relPath,
      kind: result.kind,
      text: result.text || "",
      originalText: result.text || "",
      // Per-tab conflict stamp — never share across files.
      stamp: result.stamp || (result.details && result.details.stamp),
      // The absolute path this tab was READ at. Sent back on save so the host
      // can refuse if the same relative path now resolves somewhere else —
      // otherwise a tab left open on one project writes into the next one.
      absPath: result.absPath,
      dataUrl: result.dataUrl,
      mode: result.kind === "markdown" ? "preview" : "read",
      editing: false,
      dirty: false,
    };
    const existed = openTabs.has(relPath);
    openTabs.set(relPath, state);
    if (!existed) tabOrder.push(relPath);
    activeRelPath = relPath;
    viewRelPath = relPath;
    document.body.classList.add("desk-ft-viewing");
    // Ensure panel is open when viewing a file.
    applyOpen(true);
    setViewerNotice("");
    renderToolbar(relPath);
    renderViewerBody();
    renderTabs();
    return { ok: true, kind: result.kind || "text" };
  }

  async function saveFile() {
    const file = currentFile();
    if (!file || !file.editing || !api.save || !file.stamp) return false;
    const text = editorValue();
    setViewerNotice("");
    let result;
    try {
      result = await api.save({ relPath: file.relPath, text, stamp: file.stamp, absPath: file.absPath });
    } catch (e) {
      setViewerNotice(String((e && e.message) || e));
      return false;
    }
    if (result && result.ok) {
      file.text = text;
      file.originalText = text;
      file.dirty = false;
      file.stamp = result.stamp;
      updateDirtyUi();
      return true;
    }
    if (result && result.reason === "changed") {
      const choice = await requestSharedConfirm({
        title: "File changed on disk",
        body: "Reload the agent's version, or keep your edits and overwrite it.",
        confirmLabel: "Reload",
        danger: true,
      }, "Overwrite");
      if (choice === "confirm") {
        await openFileView(file.relPath, true);
        return false;
      }
      if (choice === "second") {
        let fresh;
        try { fresh = await api.read(file.relPath); } catch (_) { fresh = null; }
        if (!fresh || !fresh.ok || !(fresh.stamp || (fresh.details && fresh.details.stamp))) {
          setViewerNotice("Could not reload the current file version.");
          return false;
        }
        // Stamp is still per-file — only refresh THIS tab's version.
        file.stamp = fresh.stamp || fresh.details.stamp;
        let overwrite;
        try { overwrite = await api.save({ relPath: file.relPath, text, stamp: file.stamp, absPath: file.absPath }); } catch (_) { overwrite = null; }
        if (overwrite && overwrite.ok) {
          file.text = text;
          file.originalText = text;
          file.dirty = false;
          file.stamp = overwrite.stamp;
          updateDirtyUi();
          return true;
        }
        setViewerNotice((overwrite && overwrite.reason) || "Overwrite refused");
        return false;
      }
      return false;
    }
    setViewerNotice((result && result.reason) || "Save refused");
    return false;
  }

  // Host → panel open (chat file links). Containment re-checked by api.read.
  window.__grokDeskFtOpen = function (relPath) {
    if (typeof relPath !== "string" || !relPath) {
      return Promise.resolve({ ok: false, reason: "invalid path" });
    }
    return openFileView(relPath);
  };

  function makeNode(entry) {
    const node = document.createElement("div");
    node.className = "desk-ft-node";
    node.setAttribute("data-name", entry.name);
    node.setAttribute("data-rel", entry.relPath);
    node.setAttribute("data-kind", entry.kind);

    const depth = entry.relPath.split("/").length - 1;
    // div + role=button (not a real <button>): the hover ⋯ is a real button and
    // nesting buttons is invalid HTML. Same shape as .rail-session rows.
    const row = document.createElement("div");
    row.className = "desk-ft-row";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.setAttribute("data-kind", entry.kind);
    // Indent matches rail session indent rhythm (--rail-indent ≈ 16px step).
    const indent = 8 + depth * 12;
    row.style.paddingLeft = indent + "px";
    row.title = entry.relPath;

    // Single lead column (Codex / VS Code): chevron for dirs, Seti icon for
    // files — same indent box, no empty disclosure spacer on file rows.
    const lead = document.createElement("span");
    lead.className = "desk-ft-lead";
    lead.setAttribute("aria-hidden", "true");
    if (entry.kind === "dir") {
      lead.classList.add("desk-ft-twist");
      lead.innerHTML = twistGlyph(false);
    } else {
      lead.classList.add("desk-ft-icon");
      const ic = iconFor(entry.kind, entry.name);
      lead.setAttribute("data-icon", ic.id);
      if (ic.src && ic.mono) {
        // No fill of its own: paint it with the row's text colour via a mask,
        // so it follows the theme instead of rendering black on a dark one.
        const glyph = document.createElement("span");
        glyph.className = "desk-ft-icon-img desk-ft-icon-mono";
        glyph.style.setProperty("--desk-ft-icon-mask", 'url("' + ic.src + '")');
        lead.appendChild(glyph);
      } else if (ic.src) {
        const img = document.createElement("img");
        img.className = "desk-ft-icon-img";
        img.src = ic.src;
        img.alt = "";
        img.draggable = false;
        lead.appendChild(img);
      }
    }

    const name = document.createElement("span");
    name.className = "desk-ft-name";
    name.textContent = entry.name;

    // Hover ⋯ — primary affordance; right-click is a second trigger for the same
    // menu. Absolute overlay + scrim so long names slide under it (rail pattern).
    const actions = document.createElement("div");
    actions.className = "desk-ft-row-actions";
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "desk-ft-action-btn desk-ft-menu-btn";
    menuBtn.innerHTML = FT_ICON.more;
    menuBtn.title = "More actions";
    menuBtn.setAttribute("aria-label", "More actions");
    menuBtn.setAttribute("aria-haspopup", "menu");
    const menuKey = "row:" + entry.relPath;
    menuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      openRowMenu(menuBtn, entry.relPath, entry.kind, { menuKey: menuKey, toggle: true });
    });
    // Enter/Space on the ⋯ must not also activate the row under it.
    menuBtn.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    actions.appendChild(menuBtn);

    row.appendChild(lead);
    row.appendChild(name);
    row.appendChild(actions);
    node.appendChild(row);

    // Right-click keeps working as a file-tree convention once the menu is shared.
    row.addEventListener("contextmenu", (event) => {
      showRowContextMenu(event, entry.relPath, entry.kind);
    });

    let activateRow;
    if (entry.kind === "dir") {
      const kids = document.createElement("div");
      kids.className = "desk-ft-children";
      node.appendChild(kids);
      let loaded = false;
      activateRow = async () => {
        const open = node.classList.toggle("desk-ft-open");
        lead.innerHTML = twistGlyph(open);
        if (open && !loaded) {
          loaded = true;
          await fillDir(kids, entry.relPath);
          applyFilter(body);
        }
      };
    } else {
      activateRow = async () => {
        await openFileView(entry.relPath);
      };
    }

    row.addEventListener("click", async (event) => {
      // Clicks on the ⋯ (or future action buttons) must not open the file/folder.
      if (event.target && event.target.closest && event.target.closest(".desk-ft-row-actions")) return;
      await activateRow();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // Only when the ROW itself has focus — the ⋯ is a real button.
      if (event.target !== row) return;
      event.preventDefault();
      void activateRow();
    });
    return node;
  }

  async function fillDir(container, relPath) {
    container.textContent = "";
    const loading = document.createElement("div");
    loading.className = "desk-ft-empty";
    loading.textContent = "Loading…";
    container.appendChild(loading);
    let result;
    try {
      result = await api.list(relPath);
    } catch (e) {
      container.textContent = "";
      const err = document.createElement("div");
      err.className = "desk-ft-error";
      err.textContent = String((e && e.message) || e);
      container.appendChild(err);
      return;
    }
    container.textContent = "";
    if (!result || result.ok === false) {
      const err = document.createElement("div");
      err.className = "desk-ft-error";
      err.textContent = (result && (result.reason || result.error)) || "Failed to list";
      container.appendChild(err);
      return;
    }
    if (!result.entries.length) {
      const empty = document.createElement("div");
      empty.className = "desk-ft-empty";
      empty.textContent = "Empty folder";
      container.appendChild(empty);
      return;
    }
    for (const entry of result.entries) {
      container.appendChild(makeNode(entry));
    }
    if (result.truncated) {
      const more = document.createElement("div");
      more.className = "desk-ft-more";
      more.textContent = "Folder truncated (too many entries)";
      container.appendChild(more);
    }
  }

  // Bumped by every rebind. Switching projects quickly starts a second rebind
  // while the first is still awaiting clearAllTabs, api.root() and fillDir — and
  // whichever finished LAST won the DOM, not whichever project you actually
  // ended on. The result was the previous project's rows, or one of its files,
  // sitting under the new project's name. The save path is already bound to the
  // absolute path a tab was read at, so nothing could be written to the wrong
  // place; this is about not showing the wrong thing in the first place.
  let rebindGen = 0;

  async function rebindToCurrentRoot() {
    const gen = ++rebindGen;
    const stale = () => gen !== rebindGen;
    // Drop every open tab so we do not show B's files under A's project.
    if (!(await clearAllTabs())) return;
    if (stale()) return;
    body.textContent = "";
    try {
      const rootInfo = await api.root();
      if (stale()) return;
      if (rootInfo && rootInfo.name) {
        rootLabel = rootInfo.name;
        title.textContent = rootInfo.name;
        title.title = rootInfo.root || rootInfo.name;
      } else if (rootInfo && rootInfo.root) {
        rootLabel = rootInfo.root;
        title.textContent = rootInfo.root;
        title.title = rootInfo.root;
      }
    } catch (_) { /* */ }
    if (stale()) return;
    await fillDir(body, "");
    if (stale()) return;
    applyFilter(body);
  }

  async function boot() {
    await rebindToCurrentRoot();
  }

  // Project switch changes api.root() but the tree was built once — rebind so
  // visible rows and subsequent read/open stay on the same project.
  if (typeof api.onRootChanged === "function") {
    try {
      api.onRootChanged(() => {
        void rebindToCurrentRoot();
      });
    } catch (_) { /* older host without the channel */ }
  }

  void boot();
  return { ok: true };
})()`;
}
