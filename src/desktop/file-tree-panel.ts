/**
 * Desktop-only file-tree panel: CSS + boot script injected into the chat
 * document after load (does not touch getHtml / chat.js).
 *
 * Class prefix `desk-ft-` keeps styles from colliding with chat.css.
 * Runs via webContents.executeJavaScript (bypasses CSP nonce) after each
 * HTML load so renderer reloads re-mount the panel.
 */

/** Styles scoped under `.desk-ft-*` — never bare element rules that could hit chat. */
export const FILE_TREE_PANEL_CSS = `
/* body is still chat.css's column flex; the shell is the only layout child. */
body.desk-with-ft > .desk-ft-shell {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}
body.desk-with-ft > script {
  /* Already executed — keep them out of the flex layout. */
  display: none;
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
}
.desk-ft-panel {
  flex: 0 0 240px;
  width: 240px;
  max-width: 45%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--vscode-editorWidget-border, #454545);
  background: var(--vscode-sideBar-background, #252526);
  color: var(--vscode-foreground, #ccc);
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 12px;
  z-index: 20;
}
body.desk-ft-collapsed .desk-ft-panel {
  flex-basis: 28px;
  width: 28px;
  max-width: 28px;
}
.desk-ft-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
  flex-shrink: 0;
  min-height: 28px;
  box-sizing: border-box;
}
.desk-ft-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}
body.desk-ft-collapsed .desk-ft-title,
body.desk-ft-collapsed .desk-ft-filter,
body.desk-ft-collapsed .desk-ft-body {
  display: none !important;
}
.desk-ft-toggle {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
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
.desk-ft-toggle:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
}
.desk-ft-filter {
  margin: 6px 6px 0;
  padding: 4px 8px;
  border: 1px solid var(--vscode-input-border, #3c3c3c);
  border-radius: 4px;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #ccc);
  font: inherit;
  outline: none;
  box-sizing: border-box;
  width: calc(100% - 12px);
  flex-shrink: 0;
}
.desk-ft-filter:focus {
  border-color: var(--vscode-focusBorder, #007fd4);
}
.desk-ft-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 4px 0 8px;
}
.desk-ft-row {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px 2px 0;
  cursor: default;
  user-select: none;
  white-space: nowrap;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  width: 100%;
  text-align: left;
  box-sizing: border-box;
}
.desk-ft-row:hover {
  background: var(--vscode-list-hoverBackground, #2a2d2e);
}
.desk-ft-row:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: -1px;
}
.desk-ft-twist {
  flex: 0 0 16px;
  width: 16px;
  text-align: center;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  font-size: 10px;
}
.desk-ft-icon {
  flex: 0 0 16px;
  width: 16px;
  text-align: center;
  opacity: 0.85;
  font-size: 12px;
}
.desk-ft-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.desk-ft-empty,
.desk-ft-error,
.desk-ft-more {
  padding: 8px 10px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  font-size: 11px;
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
.desk-ft-node.desk-ft-open > .desk-ft-row .desk-ft-twist {
  transform: none;
}
`;

/**
 * Boot script source. Receives the preload bridge as `window.grokDesktopFileTree`.
 * Idempotent: re-running after reload remounts a single panel.
 */
export function fileTreePanelBootSource(): string {
  // Built as a function body so executeJavaScript can wrap it. No TypeScript —
  // this string runs in the renderer.
  return `(() => {
  const api = window.grokDesktopFileTree;
  if (!api || typeof api.list !== "function") return { ok: false, reason: "no bridge" };

  const COLLAPSE_KEY = "desk-ft-collapsed";
  const FILTER_KEY = "desk-ft-filter";

  // Tear down a previous mount (reload / re-inject).
  const prevShell = document.getElementById("desk-ft-shell");
  if (prevShell) {
    const chat = prevShell.querySelector(".desk-ft-chat");
    if (chat) {
      while (chat.firstChild) document.body.insertBefore(chat.firstChild, prevShell);
    }
    prevShell.remove();
  }
  document.getElementById("desk-ft-style")?.remove();
  document.body.classList.remove("desk-ft-collapsed", "desk-with-ft");

  const style = document.createElement("style");
  style.id = "desk-ft-style";
  style.textContent = ${JSON.stringify(FILE_TREE_PANEL_CSS)};
  document.head.appendChild(style);

  const shell = document.createElement("div");
  shell.id = "desk-ft-shell";
  shell.className = "desk-ft-shell";

  const chatCol = document.createElement("div");
  chatCol.className = "desk-ft-chat";

  // Move non-script body children into the chat column (preserves chat.js nodes).
  const toMove = [];
  for (const child of Array.from(document.body.childNodes)) {
    if (child.nodeType === 1) {
      const el = child;
      if (el.tagName === "SCRIPT") continue;
      if (el.id === "desk-ft-style") continue;
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

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "desk-ft-toggle";
  toggle.id = "desk-ft-toggle";
  toggle.title = "Collapse file tree";
  toggle.setAttribute("aria-expanded", "true");
  toggle.textContent = "›";

  header.appendChild(title);
  header.appendChild(toggle);

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

  panel.appendChild(header);
  panel.appendChild(filter);
  panel.appendChild(body);

  shell.appendChild(chatCol);
  shell.appendChild(panel);
  // Insert shell before any remaining scripts.
  const firstScript = document.body.querySelector("script");
  if (firstScript) document.body.insertBefore(shell, firstScript);
  else document.body.appendChild(shell);

  document.body.classList.add("desk-with-ft");

  function applyCollapsed(collapsed) {
    document.body.classList.toggle("desk-ft-collapsed", collapsed);
    toggle.textContent = collapsed ? "‹" : "›";
    toggle.title = collapsed ? "Expand file tree" : "Collapse file tree";
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (_) { /* */ }
  }

  try {
    if (localStorage.getItem(COLLAPSE_KEY) === "1") applyCollapsed(true);
  } catch (_) { /* */ }

  toggle.addEventListener("click", () => {
    applyCollapsed(!document.body.classList.contains("desk-ft-collapsed"));
  });

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

  function iconFor(kind) {
    return kind === "dir" ? "📁" : "📄";
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
    row.style.paddingLeft = (6 + depth * 12) + "px";
    row.title = entry.relPath;

    const twist = document.createElement("span");
    twist.className = "desk-ft-twist";
    twist.textContent = entry.kind === "dir" ? twistGlyph(false) : "";

    const icon = document.createElement("span");
    icon.className = "desk-ft-icon";
    icon.textContent = iconFor(entry.kind);

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
        try {
          const r = await api.open(entry.relPath);
          if (r && r.ok === false) {
            console.warn("[desk-ft] open failed:", r.error || r.reason);
          }
        } catch (e) {
          console.warn("[desk-ft] open error", e);
        }
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

  async function boot() {
    try {
      const rootInfo = await api.root();
      if (rootInfo && rootInfo.name) {
        title.textContent = rootInfo.name;
        title.title = rootInfo.root || rootInfo.name;
      }
    } catch (_) { /* */ }
    await fillDir(body, "");
    applyFilter(body);
  }

  void boot();
  return { ok: true };
})()`;
}
