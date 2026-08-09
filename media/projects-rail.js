// VS Code projects rail — dedicated renderer for the primary-side-bar view.
//
// Deliberately NOT media/chat.js: loading that would create a second chat client
// (ready handshake, tab identity, session ownership). This file only consumes
// catalog host messages and posts the same rail actions the host already handles.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const ICON = {
    folderClosed: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M2 10h20"/></svg>`,
    folderOpen: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`,
    plus: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
    pin: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="m5 17 2-7V5l-2-2h14l-2 2v5l2 7Z"/></svg>`,
    pinFilled: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="m5 17 2-7V5l-2-2h14l-2 2v5l2 7Z" fill="currentColor"/></svg>`,
    ellipsis: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`,
    trash: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`,
    pencil: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`,
    archive: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>`,
    archiveRestore: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h4"/><path d="M20 8v11a2 2 0 0 1-2 2h-4"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/></svg>`,
  };

  // Preview depth matches the browser rail's expanded cap so one refresh is enough.
  const PREVIEW_LIMIT = 20;
  // Cross-project RECENT is a shorter shortcut list — deliberately not PREVIEW_LIMIT.
  // Keep in lockstep with RAIL_RECENT_CAP in src/projects-rail.ts.
  const RECENT_CAP = 10;

  /** Palette the host accepts — ids match REPO_COLOR_IDS in sessions.ts. */
  const REPO_COLOR_SWATCHES = [
    { id: "", label: "None" },
    { id: "blue", label: "Blue" },
    { id: "teal", label: "Teal" },
    { id: "green", label: "Green" },
    { id: "amber", label: "Amber" },
    { id: "coral", label: "Coral" },
    { id: "purple", label: "Purple" },
  ];

  const state = {
    repos: [],
    currentCwd: "",
    activeCwd: "",
    activeSessionId: null,
    /** Sessions for the open workspace folder (from `sessions`). */
    currentSessions: [],
    currentSessionsKnown: false,
    /** cwd-key → { entries, dots, total } from `repoSessions`. */
    previews: {},
    previewsAsked: {},
    pinnedSessions: [],
    pinnedKnown: false,
    dots: {},
    filter: "",
    /** cwd-key → true when collapsed. Current project starts expanded. */
    collapsed: {},
  };

  let menuEl = null;
  let colorPickerEl = null;

  function sameCwd(a, b) {
    if (!a || !b) return false;
    const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return norm(a) === norm(b);
  }

  function cwdKey(cwd) {
    return String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  function leaf(cwd) {
    const parts = String(cwd || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || cwd || "";
  }

  function matchesFilter(text) {
    const q = state.filter.trim().toLowerCase();
    if (!q) return true;
    return String(text || "").toLowerCase().includes(q);
  }

  function partitionRepos() {
    // No fallback needed when the open folder has no Grok history yet: the host
    // passes it to discoverRepos as a trusted cwd, which adds a catalog row for
    // it (updatedAt 0). The current project is therefore always present here.
    const current = state.repos.find((r) => sameCwd(r.cwd, state.currentCwd));
    const other = state.repos
      .filter((r) => !sameCwd(r.cwd, state.currentCwd))
      .slice()
      .sort((a, b) => {
        const la = (a.label || leaf(a.cwd)).toLowerCase();
        const lb = (b.label || leaf(b.cwd)).toLowerCase();
        return la < lb ? -1 : la > lb ? 1 : 0;
      });
    return { current, other };
  }

  function applyDot(el, dot) {
    if (!el) return;
    const d = dot || "none";
    el.dataset.dot = d === "none" || !d ? "" : d;
  }

  function closeColorPicker() {
    if (colorPickerEl) {
      colorPickerEl.remove();
      colorPickerEl = null;
    }
  }

  /** Drop the action menu only. Colour picker is separate so "Set color" can
   *  close the menu and open the swatch grid in one click without the second
   *  step immediately dismissing itself. */
  function closeMenuOnly() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }

  function closeMenu() {
    closeMenuOnly();
    closeColorPicker();
  }

  function placePopover(el, anchor) {
    const rect = anchor.getBoundingClientRect();
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    let left = rect.right - mw;
    let top = rect.bottom + 2;
    if (left < 4) left = 4;
    if (top + mh > window.innerHeight - 4) top = Math.max(4, rect.top - mh - 2);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function openMenu(anchor, items) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "rail-menu";
    menu.setAttribute("role", "menu");
    for (const item of items) {
      if (item === null) {
        const sep = document.createElement("div");
        sep.className = "rail-menu-sep";
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rail-menu-item" + (item.danger ? " danger" : "");
      btn.setAttribute("role", "menuitem");
      btn.disabled = !!item.disabled;
      if (item.title) btn.title = item.title;
      btn.textContent = item.label;
      btn.onclick = (e) => {
        e.stopPropagation();
        // Menu only — onSelect may open the colour picker next.
        closeMenuOnly();
        if (!item.disabled && item.onSelect) item.onSelect();
      };
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    menuEl = menu;
    placePopover(menu, anchor);
  }

  /**
   * Six hues + empty "none". Host-persisted via setRepoColor; capability-gated
   * by colorSupported (field presence on catalog rows, never a version check).
   */
  function openColorPicker(anchor, repo) {
    closeColorPicker();
    if (!anchor || !repo) return;
    const current = typeof repo.color === "string" ? repo.color : "";
    const picker = document.createElement("div");
    picker.className = "rail-color-picker";
    picker.setAttribute("role", "listbox");
    picker.setAttribute("aria-label", "Project color");
    for (const sw of REPO_COLOR_SWATCHES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "rail-color-swatch" +
        (sw.id ? "" : " is-none") +
        (sw.id === current ? " is-selected" : "");
      if (sw.id) btn.dataset.repoColor = sw.id;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-label", sw.label);
      btn.setAttribute("aria-selected", sw.id === current ? "true" : "false");
      btn.title = sw.label;
      btn.onclick = (e) => {
        e.stopPropagation();
        closeColorPicker();
        // Skip a no-op write: re-picking the current colour should not churn the catalog.
        if (sw.id === current) return;
        vscode.postMessage({ type: "setRepoColor", cwd: repo.cwd, color: sw.id });
      };
      picker.appendChild(btn);
    }
    document.body.appendChild(picker);
    colorPickerEl = picker;
    placePopover(picker, anchor);
  }

  document.addEventListener("click", (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
    else if (colorPickerEl && !colorPickerEl.contains(e.target)) closeColorPicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  function requestPreviews() {
    for (const r of state.repos) {
      if (sameCwd(r.cwd, state.currentCwd)) continue;
      if (!r.available) continue;
      const key = cwdKey(r.cwd);
      if (state.previewsAsked[key]) continue;
      state.previewsAsked[key] = true;
      vscode.postMessage({ type: "listRepoSessions", cwd: r.cwd, limit: PREVIEW_LIMIT });
    }
  }

  function sessionsForRepo(repo) {
    if (sameCwd(repo.cwd, state.currentCwd)) {
      return {
        entries: state.currentSessions,
        known: state.currentSessionsKnown,
      };
    }
    const hit = state.previews[cwdKey(repo.cwd)];
    if (!hit) return { entries: [], known: false };
    return { entries: hit.entries || [], known: true };
  }

  /**
   * Whether the host can store a project folder colour. Same capability rule as
   * archive / pinnedSessions: `color` is present (even as `""`) on every row from
   * a host that knows about it, and omitted entirely by one that does not.
   */
  function colorSupported() {
    return state.repos.some((r) => typeof r.color === "string");
  }

  /**
   * Most-recent conversations across every loaded project + pinned rows.
   * Mirrors collectRecentSessions in src/projects-rail.ts (RECENT_CAP).
   * Duplication with PINNED / project lists is intentional — a shortcut.
   */
  function recentRows() {
    const byId = new Map();
    if (state.currentSessionsKnown) {
      for (const s of state.currentSessions) {
        if (s && s.id) byId.set(s.id, s);
      }
    }
    for (const key of Object.keys(state.previews)) {
      const entries = state.previews[key].entries || [];
      for (const s of entries) {
        if (s && s.id) byId.set(s.id, s);
      }
    }
    if (state.pinnedKnown) {
      for (const s of state.pinnedSessions || []) {
        if (!s || !s.id) continue;
        const prev = byId.get(s.id);
        byId.set(s.id, prev ? Object.assign({}, prev, s) : s);
      }
    }
    return [...byId.values()]
      .sort(
        (a, b) =>
          (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) ||
          String(b.id || "").localeCompare(String(a.id || "")),
      )
      .slice(0, RECENT_CAP);
  }

  function render() {
    const root = document.getElementById("rail-scroll");
    if (!root) return;
    root.classList.add("rail-rebuilding");
    root.innerHTML = "";
    closeMenu();

    const q = state.filter.trim();
    let shown = false;

    // Section order matches desktop: PINNED → RECENT → projects → archived.
    // Pinned first when the host has proven it speaks the frame — capability,
    // never a version. An older host that never sends pinnedSessions shows no
    // group rather than an empty one.
    if (state.pinnedKnown) {
      const pinned = state.pinnedSessions.filter(
        (s) => matchesFilter(s.displayName) || matchesFilter(repoLabelFor(s.cwd)),
      );
      if (pinned.length) {
        root.appendChild(sectionHead("Pinned"));
        const list = document.createElement("div");
        list.className = "rail-list rail-pinned";
        for (const s of pinned) {
          list.appendChild(renderSession(s, { cwd: s.cwd, available: true }, { showRepo: true }));
        }
        root.appendChild(list);
        shown = true;
      }
    }

    // RECENT sits above the project list: VS Code has no other cross-project
    // surface, so this is the jump list — not collapsible, hard-capped at 10.
    const recentAll = recentRows().filter(
      (s) => matchesFilter(s.displayName) || matchesFilter(repoLabelFor(s.cwd)),
    );
    if (recentAll.length) {
      root.appendChild(sectionHead("Recent"));
      const list = document.createElement("div");
      list.className = "rail-list rail-recent";
      for (const s of recentAll) {
        list.appendChild(renderSession(s, { cwd: s.cwd, available: true }, { showRepo: true }));
      }
      root.appendChild(list);
      shown = true;
    }

    const { current, other } = partitionRepos();
    const active = other.filter((r) => !r.archived);
    const archived = other.filter((r) => r.archived);

    // Open folder stays at the top of the *projects* (not above Pinned/Recent).
    if (current && (!q || repoHasMatch(current))) {
      root.appendChild(sectionHead("Current project"));
      const list = document.createElement("div");
      list.className = "rail-list rail-current";
      list.appendChild(renderRepo(current, { isCurrent: true }));
      root.appendChild(list);
      shown = true;
    }

    const visibleOther = active.filter((r) => !q || repoHasMatch(r));
    if (visibleOther.length) {
      root.appendChild(sectionHead("Other projects"));
      const list = document.createElement("div");
      list.className = "rail-list rail-other";
      for (const repo of visibleOther) list.appendChild(renderRepo(repo, { isCurrent: false }));
      root.appendChild(list);
      shown = true;
    }

    const visibleArchived = archived.filter((r) => !q || repoHasMatch(r));
    if (visibleArchived.length) {
      root.appendChild(sectionHead("Archived"));
      const list = document.createElement("div");
      list.className = "rail-list rail-archived";
      for (const repo of visibleArchived) list.appendChild(renderRepo(repo, { isCurrent: false }));
      root.appendChild(list);
      shown = true;
    }

    if (!shown) {
      const note = document.createElement("div");
      note.className = "rail-note";
      note.textContent = q ? "No matches." : "No projects yet";
      root.appendChild(note);
    }

    requestAnimationFrame(() => root.classList.remove("rail-rebuilding"));
  }

  function sectionHead(title) {
    const el = document.createElement("div");
    el.className = "rail-head";
    el.textContent = title;
    return el;
  }

  function repoLabelFor(cwd) {
    const hit = state.repos.find((r) => sameCwd(r.cwd, cwd));
    return hit?.label || leaf(cwd);
  }

  function repoHasMatch(repo) {
    if (matchesFilter(repo.label) || matchesFilter(leaf(repo.cwd))) return true;
    const { entries } = sessionsForRepo(repo);
    return entries.some((s) => matchesFilter(s.displayName));
  }

  function renderRepo(repo, opts) {
    const key = cwdKey(repo.cwd);
    // Current project starts open; others start open until the user folds them.
    const expanded = !state.collapsed[key];
    const sec = document.createElement("section");
    sec.className = "rail-repo" + (repo.available === false ? " unavailable" : "") + (expanded ? "" : " collapsed");
    sec.dataset.expanded = expanded ? "1" : "0";
    sec.dataset.cwd = repo.cwd;

    const head = document.createElement("div");
    head.className = "rail-repo-head";
    head.title = repo.cwd;
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.setAttribute("aria-expanded", String(expanded));
    head.setAttribute(
      "aria-label",
      (expanded ? "Collapse " : "Expand ") + (repo.label || leaf(repo.cwd)),
    );

    const twisty = document.createElement("span");
    twisty.className = "rail-twisty";
    twisty.innerHTML = expanded ? ICON.folderOpen : ICON.folderClosed;
    twisty.setAttribute("aria-hidden", "true");
    if (typeof repo.color === "string" && repo.color) {
      twisty.dataset.repoColor = repo.color;
    }
    head.appendChild(twisty);

    const name = document.createElement("span");
    name.className = "rail-repo-name";
    const label = document.createElement("span");
    label.className = "rail-repo-label";
    label.textContent = repo.label || leaf(repo.cwd);
    name.appendChild(label);
    head.appendChild(name);

    const toggle = () => {
      if (expanded) state.collapsed[key] = true;
      else delete state.collapsed[key];
      render();
    };
    head.onclick = (e) => {
      if (e.target.closest(".rail-repo-actions")) return;
      toggle();
    };
    head.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== head) return;
      e.preventDefault();
      head.click();
    };

    const actions = document.createElement("div");
    actions.className = "rail-repo-actions";
    actions.addEventListener("click", (e) => e.stopPropagation());

    // New session only for the open folder: local newSession always starts in
    // the workspace root (see newFocusedSession). Cross-project create would
    // need a cwd-bearing newSession the host does not have yet.
    if (opts.isCurrent && repo.available !== false) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "rail-action-btn";
      add.innerHTML = ICON.plus;
      add.title = "New session";
      add.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "newSession" });
      };
      actions.appendChild(add);
    }

    const archiveSupported = typeof repo.archived === "boolean";
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "rail-action-btn";
    menuBtn.innerHTML = ICON.ellipsis;
    menuBtn.title = "Project actions";
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const items = [];
      if (archiveSupported) {
        items.push({
          label: repo.archived ? "Move to Projects" : "Archive project",
          onSelect: () =>
            vscode.postMessage({
              type: "setRepoArchived",
              cwd: repo.cwd,
              archived: !repo.archived,
            }),
        });
        items.push(null);
      }
      // Folder colour — host-persisted, capability-gated the same way as archive
      // (`color` present on catalog rows). Swatch grid, not nested menu, so six
      // hues + none stay one glance away.
      if (colorSupported()) {
        items.push({
          label: "Set color",
          title: "Tint this project's folder icon so it is easy to find",
          onSelect: () => openColorPicker(menuBtn, repo),
        });
        items.push(null);
      }
      items.push({
        label: "Clear all history",
        danger: true,
        disabled: repo.available === false,
        onSelect: () => {
          if (!window.confirm(`Clear history for “${repo.label || leaf(repo.cwd)}”?`)) return;
          vscode.postMessage({ type: "clearAllSessions", cwd: repo.cwd });
        },
      });
      openMenu(menuBtn, items);
    };
    actions.appendChild(menuBtn);
    head.appendChild(actions);
    sec.appendChild(head);

    if (expanded) sec.appendChild(renderSessions(repo));
    return sec;
  }

  function renderSessions(repo) {
    const body = document.createElement("div");
    body.className = "rail-sessions";
    if (repo.available === false) {
      body.appendChild(note("Unavailable"));
      return body;
    }
    const { entries, known } = sessionsForRepo(repo);
    const filtered = entries.filter((s) => matchesFilter(s.displayName));
    if (!known) {
      body.appendChild(note("Loading…"));
      return body;
    }
    if (!filtered.length) {
      body.appendChild(note(state.filter.trim() ? "No matches." : "No sessions yet"));
      return body;
    }
    for (const s of filtered) body.appendChild(renderSession(s, repo, {}));
    return body;
  }

  function note(text) {
    const el = document.createElement("div");
    el.className = "rail-note";
    el.textContent = text;
    return el;
  }

  function renderSession(s, repo, opts) {
    const row = document.createElement("div");
    const active = !!(state.activeSessionId && s.id === state.activeSessionId);
    row.className = "rail-session" + (active ? " active" : "");
    row.title = s.displayName || "";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    if (active) row.setAttribute("aria-current", "true");
    row.dataset.sessionId = s.id || "";

    row.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== row) return;
      e.preventDefault();
      row.click();
    };

    const dot = document.createElement("span");
    dot.className = "history-row-dot";
    dot.setAttribute("data-session-dot", s.id);
    applyDot(dot, state.dots[s.id]);
    row.appendChild(dot);

    const label = document.createElement("span");
    label.className = "rail-session-name";
    label.textContent = s.displayName || "Untitled";
    row.appendChild(label);

    if (opts && opts.showRepo) {
      const where = document.createElement("span");
      where.className = "rail-session-repo";
      where.textContent = repoLabelFor(s.cwd);
      where.title = s.cwd || "";
      row.appendChild(where);
    }

    const isPinned = typeof s.pinnedAt === "number";
    if (isPinned) row.classList.add("pinned");

    const actions = document.createElement("div");
    actions.className = "rail-session-actions";

    if (state.pinnedKnown) {
      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "rail-action-btn rail-pin-btn" + (isPinned ? " active" : "");
      pinBtn.innerHTML = isPinned ? ICON.pinFilled : ICON.pin;
      pinBtn.title = isPinned ? "Unpin conversation" : "Pin conversation";
      pinBtn.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({
          type: "toggleSessionPin",
          id: s.id,
          cwd: s.cwd || repo.cwd,
          pinned: !isPinned,
        });
      };
      actions.appendChild(pinBtn);
    }

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "rail-action-btn";
    menuBtn.innerHTML = ICON.ellipsis;
    menuBtn.title = "Session actions";
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const cwd = s.cwd || repo.cwd;
      openMenu(menuBtn, [
        {
          label: "Rename",
          onSelect: () => {
            const next = window.prompt("Rename session", s.displayName || "");
            if (next == null) return;
            const name = next.trim();
            if (!name || name === s.displayName) return;
            vscode.postMessage({ type: "renameSession", id: s.id, name, cwd });
          },
        },
        {
          label: isPinned ? "Unpin conversation" : "Pin conversation",
          disabled: !state.pinnedKnown,
          onSelect: () =>
            vscode.postMessage({
              type: "toggleSessionPin",
              id: s.id,
              cwd,
              pinned: !isPinned,
            }),
        },
        null,
        {
          label: "Delete",
          danger: true,
          onSelect: () => {
            if (!window.confirm(`Delete “${s.displayName || "session"}”?`)) return;
            vscode.postMessage({ type: "deleteSession", id: s.id, name: s.displayName, cwd });
          },
        },
      ]);
    };
    actions.appendChild(menuBtn);
    row.appendChild(actions);

    // Plain resume — no selectRepo, no window reload. The host already trusts
    // any discovered catalog cwd for local sessions (localTrustedSessionCwds).
    row.onclick = () => {
      if (active) return;
      vscode.postMessage({
        type: "resumeSession",
        id: s.id,
        cwd: s.cwd || repo.cwd,
      });
    };

    return row;
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "repos": {
        state.repos = Array.isArray(msg.entries) ? msg.entries : [];
        state.currentCwd = msg.selectedCwd || "";
        state.activeCwd = msg.activeCwd || "";
        // Re-probe other projects when the catalog changes.
        state.previewsAsked = {};
        render();
        requestPreviews();
        break;
      }
      case "sessions": {
        // Local `sessions` is always the workspace root (repoScopeFor).
        if (msg.offset === 0 || msg.offset == null) {
          state.currentSessions = Array.isArray(msg.entries) ? msg.entries : [];
          state.currentSessionsKnown = true;
          if (msg.activeId != null) state.activeSessionId = msg.activeId || null;
          if (msg.dots && typeof msg.dots === "object") {
            Object.assign(state.dots, msg.dots);
          }
          render();
        }
        break;
      }
      case "repoSessions": {
        const key = cwdKey(msg.cwd);
        state.previews[key] = {
          entries: Array.isArray(msg.entries) ? msg.entries : [],
          total: msg.total || 0,
        };
        if (msg.dots && typeof msg.dots === "object") {
          Object.assign(state.dots, msg.dots);
        }
        render();
        break;
      }
      case "pinnedSessions": {
        state.pinnedSessions = Array.isArray(msg.entries) ? msg.entries : [];
        state.pinnedKnown = true;
        if (msg.dots && typeof msg.dots === "object") {
          Object.assign(state.dots, msg.dots);
        }
        render();
        break;
      }
      case "sessionDot": {
        if (msg.id) {
          state.dots[msg.id] = msg.dot;
          const el = document.querySelector(`[data-session-dot="${CSS.escape(msg.id)}"]`);
          applyDot(el, msg.dot);
        }
        break;
      }
      case "session":
      case "sessionName": {
        if (msg.sessionId) {
          state.activeSessionId = msg.sessionId;
          render();
        }
        break;
      }
      default:
        break;
    }
  }

  window.addEventListener("message", (e) => onMessage(e.data));

  const search = document.getElementById("rail-search");
  if (search) {
    search.addEventListener("input", () => {
      state.filter = search.value || "";
      render();
    });
  }

  // Export for tests (happy-dom harness).
  window.__grokProjectsRail = {
    state,
    render,
    onMessage,
    partitionRepos,
    sameCwd,
    recentRows,
    colorSupported,
    RECENT_CAP,
  };

  vscode.postMessage({ type: "ready" });
})();
