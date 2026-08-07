/**
 * Desktop-only file-tree panel: CSS + boot script injected into the chat
 * document after load (does not touch getHtml / chat.js).
 *
 * Layout:
 *   - Full-width `.top-bar` stays outside the chat/file shell (edge-to-edge).
 *   - Panel toggle lives in the top bar (right end); closed = panel takes no space.
 *   - Opening a file replaces the tree with a read-only viewer + breadcrumb.
 *
 * Class prefix `desk-ft-` keeps styles from colliding with chat.css.
 * Runs via webContents.executeJavaScript (bypasses CSP nonce) after each
 * HTML load so renderer reloads re-mount the panel.
 *
 * File-type glyphs: Seti UI (MIT) via {@link buildFileIconDataUrlMap}.
 */
import { buildFileIconDataUrlMap, fileIconId } from "./file-icons";

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
/* Panel hidden entirely when closed — takes no space. */
body.desk-ft-closed .desk-ft-panel {
  display: none !important;
}
.desk-ft-panel {
  flex: 0 0 280px;
  width: 280px;
  max-width: 45%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--vscode-editorWidget-border, #454545);
  /* Distinct from the chat column (sideBar) so the open panel reads as its
     own region — editor-background is darker under the desktop theme tokens. */
  background: var(--vscode-editor-background, #1e1e1e);
  box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.04);
  color: var(--vscode-foreground, #ccc);
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  /* Match projects rail type scale (--rail-row-* from chat.css body). */
  font-size: var(--rail-row-font-size, 13px);
  line-height: var(--rail-row-line-height, 1.5);
  z-index: 20;
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
  gap: var(--rail-row-gap, 6px);
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
.desk-ft-twist {
  flex: 0 0 16px;
  width: 16px;
  text-align: center;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  font-size: 10px;
  line-height: 1;
}
.desk-ft-icon {
  flex: 0 0 var(--rail-icon-size, 14px);
  width: var(--rail-icon-size, 14px);
  height: var(--rail-icon-size, 14px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0.95;
}
.desk-ft-icon img,
.desk-ft-icon-img {
  width: var(--rail-icon-size, 14px);
  height: var(--rail-icon-size, 14px);
  display: block;
  object-fit: contain;
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
.desk-ft-crumb-back {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--vscode-textLink-foreground, #3794ff);
  cursor: pointer;
  font: inherit;
  padding: 2px 6px 2px 0;
  margin-right: 4px;
}
.desk-ft-crumb-back:hover {
  text-decoration: underline;
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
  // Compact extension → Seti id table for the renderer (mirrors fileIconId).
  // Keep in sync with src/desktop/file-icons.ts fileIconId().
  const iconIdFn = fileIconId.toString();
  return `(() => {
  const api = window.grokDesktopFileTree;
  if (!api || typeof api.list !== "function") return { ok: false, reason: "no bridge" };

  const OPEN_KEY = "desk-ft-open";
  const FILTER_KEY = "desk-ft-filter";
  const RAIL_OPEN_KEY = "desk-rail-open";
  // Seti UI (MIT) data-URLs — bundled at inject time; no network fetch.
  const SETI_ICONS = ${JSON.stringify(iconMap)};
  const fileIconId = ${iconIdFn};
  // Lucide panel-left / panel-right — same convention as AFK Pilot + Codex.
  const ICON_PANEL_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>';
  const ICON_PANEL_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>';

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

  viewer.appendChild(crumb);
  viewer.appendChild(viewerBody);

  panel.appendChild(header);
  panel.appendChild(filter);
  panel.appendChild(body);
  panel.appendChild(viewer);

  shell.appendChild(chatCol);
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
    topToggle.addEventListener("click", () => {
      applyOpen(document.body.classList.contains("desk-ft-closed"));
    });
  }

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

  function twistGlyph(open) {
    return open ? "▼" : "▶";
  }

  /** Seti UI icon id + data-URL for a tree entry (see media/file-icons). */
  function iconFor(kind, name) {
    const id = fileIconId(kind, name);
    const src = SETI_ICONS[id] || SETI_ICONS.default || "";
    return { id: id, src: src };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Minimal markdown for read-only preview (not a full parser).
  function renderMarkdown(src) {
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

  function showTree() {
    viewRelPath = null;
    document.body.classList.remove("desk-ft-viewing");
    viewerBody.textContent = "";
    crumb.textContent = "";
  }

  function renderCrumb(relPath) {
    crumb.textContent = "";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "desk-ft-crumb-back";
    back.textContent = "← Back";
    back.title = "Back to file tree";
    back.addEventListener("click", () => showTree());
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
  }

  async function openFileView(relPath) {
    if (!api.read) {
      // Older host without read channel — fall back to OS open.
      try { await api.open(relPath); } catch (_) { /* */ }
      return;
    }
    let result;
    try {
      result = await api.read(relPath);
    } catch (e) {
      console.warn("[desk-ft] read error", e);
      return;
    }
    if (result && result.openExternal) {
      try { await api.open(relPath); } catch (_) { /* */ }
      return;
    }
    if (!result || result.ok === false) {
      if (result && result.reason === "open externally") {
        try { await api.open(relPath); } catch (_) { /* */ }
      } else {
        console.warn("[desk-ft] read failed:", result && (result.reason || result.error));
      }
      return;
    }

    viewRelPath = relPath;
    document.body.classList.add("desk-ft-viewing");
    // Ensure panel is open when viewing a file.
    applyOpen(true);
    renderCrumb(relPath);
    viewerBody.textContent = "";

    if (result.kind === "image" && result.dataUrl) {
      const img = document.createElement("img");
      img.src = result.dataUrl;
      img.alt = relPath;
      viewerBody.appendChild(img);
      return;
    }

    if (result.kind === "markdown") {
      const wrap = document.createElement("div");
      wrap.className = "desk-ft-md";
      wrap.innerHTML = renderMarkdown(result.text || "");
      viewerBody.appendChild(wrap);
      return;
    }

    const pre = document.createElement("pre");
    pre.textContent = result.text || "";
    viewerBody.appendChild(pre);
  }

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
    // Indent matches rail session indent rhythm (--rail-indent ≈ 16px step).
    const indent = 8 + depth * 12;
    row.style.paddingLeft = indent + "px";
    row.title = entry.relPath;

    const twist = document.createElement("span");
    twist.className = "desk-ft-twist";
    twist.textContent = entry.kind === "dir" ? twistGlyph(false) : "";

    const icon = document.createElement("span");
    icon.className = "desk-ft-icon";
    const ic = iconFor(entry.kind, entry.name);
    icon.setAttribute("data-icon", ic.id);
    if (ic.src) {
      const img = document.createElement("img");
      img.className = "desk-ft-icon-img";
      img.src = ic.src;
      img.alt = "";
      img.draggable = false;
      icon.appendChild(img);
    }

    const name = document.createElement("span");
    name.className = "desk-ft-name";
    name.textContent = entry.name;

    row.appendChild(twist);
    row.appendChild(icon);
    row.appendChild(name);
    node.appendChild(row);

    if (entry.kind === "dir") {
      const kids = document.createElement("div");
      kids.className = "desk-ft-children";
      node.appendChild(kids);
      let loaded = false;
      row.addEventListener("click", async () => {
        const open = node.classList.toggle("desk-ft-open");
        twist.textContent = twistGlyph(open);
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
    showTree();
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
