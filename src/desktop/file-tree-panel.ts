/**
 * Desktop-only file-tree panel: CSS + boot script injected into the chat
 * document after load (does not touch getHtml / chat.js).
 *
 * Layout:
 *   - Full-width `.top-bar` stays outside the chat/file shell (edge-to-edge).
 *   - Panel toggle lives in the top bar (right end); closed = panel takes no space.
 *   - Opening a file replaces the tree with a viewer + breadcrumb; editing is
 *     opt-in and text-only.
 *
 * Class prefix `desk-ft-` keeps styles from colliding with chat.css.
 * Runs via webContents.executeJavaScript (bypasses CSP nonce) after each
 * HTML load so renderer reloads re-mount the panel.
 *
 * File-type glyphs: Seti UI (MIT) via {@link buildFileIconDataUrlMap}.
 */
import { buildFileIconDataUrlMap, fileIconId, monochromeIconIds } from "./file-icons";

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
  /* Width driven by --desk-ft-width (JS + localStorage); defaults below. */
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
  gap: 4px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
  flex-shrink: 0;
  min-height: var(--rail-row-min-height, 30px);
  box-sizing: border-box;
}
.desk-ft-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--vscode-descriptionForeground, #9d9d9d);
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
/* Top-bar panel toggle (Lucide panel-right) */
.desk-ft-top-toggle {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  margin-left: 2px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground, #ccc);
  cursor: pointer;
  font-size: 14px;
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
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
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
.desk-ft-crumb {
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
/* Breadcrumb Back: toolbar button (not a text link) so it does not compete
   with real anchors inside markdown previews. */
.desk-ft-crumb-back {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-foreground, #ccc);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px 2px 6px;
  margin-right: 6px;
  line-height: 1.3;
}
.desk-ft-crumb-back svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  display: block;
}
.desk-ft-crumb-back:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
  text-decoration: none;
  color: var(--vscode-foreground, #ccc);
}
.desk-ft-crumb-back:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: 1px;
}
/* External-open affordance while a file is previewed in-panel. */
.desk-ft-open-ext {
  flex: 0 0 auto;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  cursor: pointer;
  font: inherit;
}
.desk-ft-open-ext svg { display: block; }
.desk-ft-open-ext:hover {
  color: var(--vscode-foreground, #ccc);
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
}
.desk-ft-crumb-seg {
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  cursor: pointer;
  font: inherit;
  padding: 2px 2px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desk-ft-crumb-seg:hover {
  color: var(--vscode-textLink-foreground, #3794ff);
}
.desk-ft-crumb-seg.desk-ft-crumb-current {
  color: var(--vscode-foreground, #ccc);
  cursor: default;
  font-weight: 600;
}
.desk-ft-crumb-sep {
  color: var(--vscode-descriptionForeground, #9d9d9d);
  opacity: 0.6;
  user-select: none;
}
.desk-ft-dirty-dot {
  color: var(--vscode-charts-yellow, #cca700);
  font-size: 16px;
  line-height: 0;
  margin-left: 2px;
}
.desk-ft-viewer-action {
  /* Icon-only: a square target rather than text padding, so the four actions
     read as one control group instead of four differently-sized chips. */
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
.desk-ft-viewer-action svg { display: block; }
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
.desk-ft-open-ext:focus-visible {
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
.desk-ft-viewer-body .desk-ft-md {
  font-size: 13px;
  line-height: 1.5;
  color: var(--vscode-foreground, #ccc);
}
.desk-ft-viewer-body .desk-ft-md h1,
.desk-ft-viewer-body .desk-ft-md h2,
.desk-ft-viewer-body .desk-ft-md h3 {
  margin: 0.8em 0 0.4em;
  font-weight: 600;
}
.desk-ft-viewer-body .desk-ft-md p {
  margin: 0.4em 0;
}
.desk-ft-viewer-body .desk-ft-md code {
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  font-size: 0.92em;
  background: var(--vscode-textCodeBlock-background, #1e1e1e);
  padding: 0 4px;
  border-radius: 3px;
}
.desk-ft-viewer-body .desk-ft-md pre {
  background: var(--vscode-textCodeBlock-background, #1e1e1e);
  padding: 8px;
  border-radius: 4px;
  overflow: auto;
}
/* Blocks the SHARED renderer emits. chat.css styles these only under
   .msg.agent .body, so the preview needs its own presentation — but from the
   same markup, which is what stops the two drifting the way the old private
   parser did (it simply dropped bullets and tables). */
.desk-ft-viewer-body .desk-ft-md ul,
.desk-ft-viewer-body .desk-ft-md ol {
  margin: 0.4em 0;
  padding-left: 1.5em;
}
.desk-ft-viewer-body .desk-ft-md ul { list-style-type: disc; }
.desk-ft-viewer-body .desk-ft-md ol { list-style-type: decimal; }
.desk-ft-viewer-body .desk-ft-md li { margin: 0.15em 0; }
.desk-ft-viewer-body .desk-ft-md li > ul { margin: 0.15em 0; list-style-type: circle; }
.desk-ft-viewer-body .desk-ft-md li > ul ul { list-style-type: square; }
.desk-ft-viewer-body .desk-ft-md blockquote {
  margin: 0.5em 0;
  padding-left: 10px;
  border-left: 2px solid var(--vscode-panel-border, #454545);
  color: var(--vscode-descriptionForeground, #9d9d9d);
}
.desk-ft-viewer-body .desk-ft-md hr {
  border: none;
  border-top: 1px solid var(--vscode-panel-border, #454545);
  margin: 0.9em 0;
}
/* A table in a narrow panel scrolls INSIDE its own wrapper — letting it widen
   the preview would push the whole panel sideways. */
.desk-ft-viewer-body .desk-ft-md .md-table-wrap {
  overflow-x: auto;
  margin: 0.5em 0;
  max-width: 100%;
}
.desk-ft-viewer-body .desk-ft-md table {
  border-collapse: collapse;
  font-size: 0.95em;
}
.desk-ft-viewer-body .desk-ft-md th,
.desk-ft-viewer-body .desk-ft-md td {
  border: 1px solid var(--vscode-panel-border, #454545);
  padding: 3px 7px;
  text-align: left;
  vertical-align: top;
}
.desk-ft-viewer-body .desk-ft-md th {
  font-weight: 600;
  background: var(--vscode-textCodeBlock-background, #1e1e1e);
}
.desk-ft-viewer-body .desk-ft-md a { color: var(--vscode-textLink-foreground, #4daafc); }
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
    // app-window
    openExternal:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/></svg>',
  };

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
  // Lucide arrow-left for breadcrumb Back.
  const ICON_ARROW_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';

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

  const title = document.createElement("div");
  title.className = "desk-ft-title";
  title.id = "desk-ft-title";
  title.textContent = "Files";

  header.appendChild(title);

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

  const crumb = document.createElement("div");
  crumb.className = "desk-ft-crumb";
  crumb.id = "desk-ft-crumb";

  const viewerBody = document.createElement("div");
  viewerBody.className = "desk-ft-viewer-body";
  viewerBody.id = "desk-ft-viewer-body";

  const viewerNotice = document.createElement("div");
  viewerNotice.className = "desk-ft-notice";
  viewerNotice.id = "desk-ft-notice";

  viewer.appendChild(crumb);
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
    topToggle = document.createElement("button");
    topToggle.type = "button";
    topToggle.id = "desk-ft-top-toggle";
    topToggle.className = "desk-ft-top-toggle";
    topToggle.setAttribute("aria-label", "Toggle file panel");
    topBar.appendChild(topToggle);
  }

  let rootLabel = "Files";
  let viewRelPath = null; // null = tree mode
  let currentFile = null;
  let confirmSeq = 0;

  function clampPanelWidth(px) {
    const shellW = shell.getBoundingClientRect().width || window.innerWidth || 800;
    const maxByChat = Math.max(WIDTH_MIN, Math.floor(shellW - WIDTH_CHAT_MIN));
    const maxByFrac = Math.floor(shellW * 0.7);
    const max = Math.max(WIDTH_MIN, Math.min(maxByChat, maxByFrac));
    const n = Math.round(Number(px));
    if (!Number.isFinite(n)) return WIDTH_DEFAULT;
    return Math.min(max, Math.max(WIDTH_MIN, n));
  }

  function applyPanelWidth(px) {
    const w = clampPanelWidth(px);
    panel.style.setProperty("--desk-ft-width", w + "px");
    try { localStorage.setItem(WIDTH_KEY, String(w)); } catch (_) { /* */ }
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
    window.addEventListener("resize", () => {
      // Re-clamp so a narrow window cannot leave the panel overgrown.
      const cur = panel.getBoundingClientRect().width;
      if (cur > 0) applyPanelWidth(cur);
    });
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

  panel.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && currentFile && currentFile.editing) {
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

  function breadcrumbSegments(relPath, label) {
    const segs = [{ label: label || "Files", relPath: "" }];
    const trimmed = (relPath || "").replace(/\\\\/g, "/").replace(/^\\/+|\\/+$/g, "");
    if (!trimmed) return segs;
    const parts = trimmed.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      segs.push({ label: part, relPath: acc });
    }
    return segs;
  }

  function dirtyNow() {
    return !!(currentFile && currentFile.dirty);
  }

  function updateDirtyUi() {
    const dot = crumb.querySelector(".desk-ft-dirty-dot");
    if (dot) dot.textContent = dirtyNow() ? "•" : "";
    const save = crumb.querySelector(".desk-ft-save");
    if (save) save.disabled = !dirtyNow();
  }

  async function confirmLeaveDirty() {
    if (!dirtyNow()) return true;
    return askConfirm({
      title: "Discard changes?",
      body: "Your edits have not been saved.",
      confirmLabel: "Discard",
      danger: true,
    });
  }

  window.__grokDeskFtBeforeClose = () => confirmLeaveDirty();

  async function showTree() {
    if (!(await confirmLeaveDirty())) return false;
    currentFile = null;
    viewRelPath = null;
    document.body.classList.remove("desk-ft-viewing");
    viewerBody.textContent = "";
    viewerNotice.textContent = "";
    crumb.textContent = "";
    return true;
  }

  function setViewerNotice(message) {
    viewerNotice.textContent = message || "";
  }

  function editorValue() {
    const editor = viewerBody.querySelector(".desk-ft-editor");
    return editor ? editor.value : (currentFile ? currentFile.text : "");
  }

  function renderViewerBody() {
    if (!currentFile) return;
    viewerBody.textContent = "";
    const source = editorValue();
    if (currentFile.kind === "image" && currentFile.dataUrl) {
      const img = document.createElement("img");
      img.src = currentFile.dataUrl;
      img.alt = currentFile.relPath;
      viewerBody.appendChild(img);
      return;
    }
    const code = currentFile.kind === "markdown" ? currentFile.mode === "code" : currentFile.editing;
    if (code) {
      const editor = document.createElement("textarea");
      editor.className = "desk-ft-editor";
      editor.value = source;
      editor.spellcheck = false;
      editor.setAttribute("aria-label", "Edit " + currentFile.relPath);
      editor.addEventListener("input", () => {
        currentFile.text = editor.value;
        currentFile.dirty = editor.value !== currentFile.originalText;
        updateDirtyUi();
      });
      viewerBody.appendChild(editor);
      return;
    }
    if (currentFile.kind === "markdown" && currentFile.mode === "preview") {
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
    if (!currentFile) return;
    currentFile.mode = mode;
    currentFile.editing = !!editing;
    renderCrumb(currentFile.relPath);
    renderViewerBody();
    updateDirtyUi();
    if (currentFile.editing) {
      const editor = viewerBody.querySelector(".desk-ft-editor");
      if (editor) editor.focus();
    }
  }

  function renderCrumb(relPath) {
    crumb.textContent = "";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "desk-ft-crumb-back";
    back.innerHTML = ICON_ARROW_LEFT + "<span>Back</span>";
    back.title = "Back to file tree";
    back.setAttribute("aria-label", "Back to file tree");
    back.addEventListener("click", () => { void showTree(); });
    crumb.appendChild(back);

    const segs = breadcrumbSegments(relPath, rootLabel);
    segs.forEach((seg, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "desk-ft-crumb-sep";
        sep.textContent = "/";
        crumb.appendChild(sep);
      }
      const isLast = i === segs.length - 1;
      const btn = document.createElement(isLast ? "span" : "button");
      if (!isLast) btn.type = "button";
      btn.className = "desk-ft-crumb-seg" + (isLast ? " desk-ft-crumb-current" : "");
      btn.textContent = seg.label;
      btn.title = seg.relPath || rootLabel;
      if (!isLast) {
        btn.addEventListener("click", async () => {
          if (seg.relPath === "") {
            showTree();
            return;
          }
          // Ancestor directory → return to tree (file view is one-file-at-a-time).
          showTree();
        });
      }
      crumb.appendChild(btn);
    });

    if (currentFile && (currentFile.kind === "markdown" || currentFile.kind === "text" || currentFile.kind === "json")) {
      const action = (icon, label, onClick, extraClass) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "desk-ft-viewer-action" + (extraClass ? " " + extraClass : "");
        b.innerHTML = icon;
        // Icon-only, so the accessible name and the tooltip are the only label
        // there is — both, not one: title alone is invisible to a screen reader
        // and aria-label alone shows nothing on hover.
        b.title = label;
        b.setAttribute("aria-label", label);
        b.addEventListener("click", onClick);
        crumb.appendChild(b);
        return b;
      };

      if (currentFile.kind === "markdown") {
        // Markdown gets Preview/Code and NOT Edit: switching to Code already
        // makes the source editable, so an Edit button beside it would be a
        // second control for the thing you just did.
        action(
          FT_ICON.preview,
          "Preview",
          () => setViewerMode("preview", currentFile.editing),
          currentFile.mode === "preview" ? "desk-ft-active" : "",
        );
        action(
          FT_ICON.code,
          "Edit source",
          () => setViewerMode("code", true),
          currentFile.mode === "code" ? "desk-ft-active" : "",
        );
      } else if (!currentFile.editing) {
        // Plain text and JSON have no rendered form to toggle against, so Edit
        // is the only way in.
        action(FT_ICON.edit, "Edit", () => setViewerMode("code", true));
      }

      if (currentFile.editing) {
        action(
          FT_ICON.save,
          "Save (Ctrl+S)",
          () => { void saveFile(); },
          "desk-ft-save",
        );
      }
      const dot = document.createElement("span");
      dot.className = "desk-ft-dirty-dot";
      dot.setAttribute("aria-label", "Unsaved changes");
      crumb.appendChild(dot);
    }

    // Explicit OS hand-off while previewing (fallback affordance).
    const openExt = document.createElement("button");
    openExt.type = "button";
    openExt.className = "desk-ft-open-ext";
    openExt.innerHTML = FT_ICON.openExternal;
    openExt.title = "Open in default app";
    openExt.setAttribute("aria-label", "Open in default app");
    openExt.addEventListener("click", async () => {
      try { await api.open(relPath); } catch (_) { /* */ }
    });
    crumb.appendChild(openExt);
    updateDirtyUi();
  }

  async function openFileView(relPath, force) {
    if (!force && currentFile && currentFile.relPath !== relPath && !(await confirmLeaveDirty())) return { ok: false, reason: "cancelled" };
    if (!api.read) {
      // Older host without read channel — fall back to OS open.
      try { await api.open(relPath); } catch (_) { /* */ }
      return { ok: false, reason: "no read channel", openExternal: true };
    }
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

    viewRelPath = relPath;
    currentFile = {
      relPath,
      kind: result.kind,
      text: result.text || "",
      originalText: result.text || "",
       stamp: result.stamp || (result.details && result.details.stamp),
      dataUrl: result.dataUrl,
      mode: result.kind === "markdown" ? "preview" : "read",
      editing: false,
      dirty: false,
    };
    document.body.classList.add("desk-ft-viewing");
    // Ensure panel is open when viewing a file.
    applyOpen(true);
    setViewerNotice("");
    renderCrumb(relPath);
    renderViewerBody();
    return { ok: true, kind: result.kind || "text" };
  }

  async function saveFile() {
    if (!currentFile || !currentFile.editing || !api.save || !currentFile.stamp) return false;
    const file = currentFile;
    const text = editorValue();
    setViewerNotice("");
    let result;
    try {
      result = await api.save({ relPath: file.relPath, text, stamp: file.stamp });
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
        file.stamp = fresh.stamp || fresh.details.stamp;
        let overwrite;
        try { overwrite = await api.save({ relPath: file.relPath, text, stamp: file.stamp }); } catch (_) { overwrite = null; }
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
    const row = document.createElement("button");
    row.type = "button";
    row.className = "desk-ft-row";
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

    row.appendChild(lead);
    row.appendChild(name);
    node.appendChild(row);

    if (entry.kind === "dir") {
      const kids = document.createElement("div");
      kids.className = "desk-ft-children";
      node.appendChild(kids);
      let loaded = false;
      row.addEventListener("click", async () => {
        const open = node.classList.toggle("desk-ft-open");
        lead.innerHTML = twistGlyph(open);
        if (open && !loaded) {
          loaded = true;
          await fillDir(kids, entry.relPath);
          applyFilter(body);
        }
      });
    } else {
      row.addEventListener("click", async () => {
        await openFileView(entry.relPath);
      });
    }
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

  async function rebindToCurrentRoot() {
    // Drop any open preview so we do not show B's file under A's breadcrumb.
    if (!(await showTree())) return;
    body.textContent = "";
    try {
      const rootInfo = await api.root();
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
    await fillDir(body, "");
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
