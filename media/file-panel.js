(function (root) {
  "use strict";

  const DEFAULT_WIDTH = 280;
  const MIN_WIDTH = 200;
  const MIN_CHAT_WIDTH = 280;
  const MOBILE_BREAKPOINT = 640;
  const EDITABLE_KINDS = new Set(["markdown", "json", "text"]);
  // Shared Seti lookup data. Hosts provide only a URL rooted in their own
  // scheme; the component chooses the asset and the browser lazily loads icons
  // that actually appear on screen. This keeps Node work and SVG/data-URL
  // payloads out of both the Electron injection and the phone round trip.
  const FILE_ICON_BY_NAME = {
    "package.json": "npm", "package-lock.json": "npm", "yarn.lock": "yarn",
    "pnpm-lock.yaml": "yarn", "cargo.toml": "rust", "cargo.lock": "lock",
    "go.mod": "go", "go.sum": "go", gemfile: "ruby", "gemfile.lock": "lock",
    dockerfile: "docker", "docker-compose.yml": "docker", "docker-compose.yaml": "docker",
    "compose.yml": "docker", "compose.yaml": "docker", makefile: "config",
    "cmakelists.txt": "config", "tsconfig.json": "typescript", "jsconfig.json": "javascript",
    ".gitignore": "git_ignore", ".gitattributes": "git", ".gitmodules": "git",
    ".editorconfig": "editorconfig", ".eslintrc": "config", ".eslintrc.js": "javascript",
    ".eslintrc.cjs": "javascript", ".eslintrc.json": "json", ".prettierrc": "config",
    ".prettierrc.js": "javascript", ".prettierrc.json": "json", ".env": "config",
    ".env.local": "config", ".env.development": "config", ".env.production": "config",
    license: "license", "license.md": "license", "license.txt": "license",
    "readme.md": "markdown", readme: "markdown", "changelog.md": "markdown",
  };
  const FILE_ICON_BY_SUFFIX = {
    ".d.ts": "typescript", ".test.ts": "typescript", ".spec.ts": "typescript",
    ".test.tsx": "react", ".spec.tsx": "react", ".test.js": "javascript",
    ".spec.js": "javascript", ".test.jsx": "react", ".spec.jsx": "react",
    ".module.css": "css", ".module.scss": "sass", ".module.sass": "sass",
  };
  const FILE_ICON_BY_EXTENSION = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "react",
    ts: "typescript", tsx: "react", json: "json", jsonc: "json", css: "css",
    scss: "sass", sass: "sass", less: "less", styl: "stylus", html: "html",
    htm: "html", xhtml: "html", vue: "vue", svelte: "svelte", md: "markdown",
    mdx: "markdown", markdown: "markdown", yml: "yml", yaml: "yml", xml: "xml",
    svg: "svg", png: "image", jpg: "image", jpeg: "image", gif: "image",
    webp: "image", ico: "image", bmp: "image", avif: "image", py: "python",
    pyi: "python", pyw: "python", go: "go", rs: "rust", java: "java", jar: "java",
    kt: "kotlin", kts: "kotlin", c: "c", h: "c", cpp: "cpp", cc: "cpp",
    cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "c-sharp", fs: "f-sharp",
    fsx: "f-sharp", rb: "ruby", erb: "ruby", php: "php", swift: "swift",
    lua: "lua", ps1: "powershell", psm1: "powershell", psd1: "powershell",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell", bat: "shell",
    cmd: "shell", pdf: "pdf", zip: "zip", gz: "zip", tgz: "zip", "7z": "zip",
    rar: "zip", tar: "zip", mp4: "video", webm: "video", mov: "video",
    avi: "video", mkv: "video", mp3: "audio", wav: "audio", ogg: "audio",
    flac: "audio", ttf: "font", otf: "font", woff: "font", woff2: "font",
    eot: "font", graphql: "graphql", gql: "graphql", prisma: "prisma", sql: "db",
    db: "db", sqlite: "db", sqlite3: "db", toml: "config", ini: "config",
    cfg: "config", conf: "config", env: "config", lock: "lock", ipynb: "notebook",
    hex: "hex", ex: "elixir", exs: "elixir", clj: "clojure", cljs: "clojure",
    cljc: "clojure", dart: "dart", elm: "elm", hs: "haskell", lhs: "haskell",
    ml: "ocaml", mli: "ocaml", asm: "asm", s: "asm", nim: "nim", zig: "zig",
    cr: "crystal", vala: "vala", d: "d", tf: "terraform", tfvars: "terraform",
    hcl: "terraform", bicep: "bicep", res: "rescript", resi: "rescript",
    re: "reasonml", rei: "reasonml", ejs: "ejs", pug: "pug", jade: "pug",
    hbs: "mustache", mustache: "mustache", docx: "word", doc: "word", rtf: "word",
    babelrc: "babel", gitignore: "git_ignore",
  };
  const MONOCHROME_FILE_ICONS = new Set([
    "asm", "audio", "babel", "c", "clock", "clojure", "d", "dart", "db", "default",
    "editorconfig", "f-sharp", "font", "haskell", "lock", "lua", "ocaml", "pdf", "pug",
    "reasonml", "rust", "settings", "svelte", "svg", "swift", "vala", "video", "vue",
    "word", "yarn",
  ]);

  function defaultFileIconId(kind, name) {
    if (kind === "dir") return "folder";
    const lower = String(name || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
    if (FILE_ICON_BY_NAME[lower]) return FILE_ICON_BY_NAME[lower];
    for (const suffix of Object.keys(FILE_ICON_BY_SUFFIX)) {
      if (lower.endsWith(suffix)) return FILE_ICON_BY_SUFFIX[suffix];
    }
    const dot = lower.lastIndexOf(".");
    const extension = dot >= 0 ? lower.slice(dot + 1) : "";
    if (extension && FILE_ICON_BY_EXTENSION[extension]) return FILE_ICON_BY_EXTENSION[extension];
    if (lower.startsWith(".") && dot === 0) return "config";
    return "default";
  }

  function fileName(relPath) {
    const parts = String(relPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(relPath || "") || "untitled";
  }

  function scopeKey(scopeId, relPath) {
    return String(scopeId || "") + "\0" + String(relPath || "");
  }

  function makeScopeState(scope) {
    return {
      scope,
      tabs: new Map(),
      order: [],
      activeRelPath: null,
      tree: null,
      rootLoad: null,
      expanded: new Set(),
      filter: "",
    };
  }

  function makeTab(scopeId, result) {
    const text = typeof result.text === "string" ? result.text : "";
    return {
      key: scopeKey(scopeId, result.relPath),
      scopeId,
      relPath: result.relPath,
      kind: result.kind,
      dataUrl: result.dataUrl,
      pretty: !!result.pretty,
      baselineText: text,
      draftText: text,
      stamp: result.stamp,
      // The identity belongs to the file that was opened. Overwrite may refresh
      // its version stamp, but never adopts a different absolute target.
      expectedAbsPath: result.absPath,
      mode: result.kind === "markdown" ? "preview" : "read",
      editing: false,
      dirty: false,
      saving: false,
      sentText: null,
      conflict: false,
      notice: "",
      readSeq: 0,
      saveSeq: 0,
    };
  }

  function applyDraft(tab, text) {
    tab.draftText = String(text);
    tab.dirty = tab.draftText !== tab.baselineText;
    return tab;
  }

  function applySaveSuccess(tab, sentText, result) {
    // The remote editor learned this the hard way: the textarea remains live
    // while Save is in flight. Only the captured payload reached the host.
    tab.baselineText = sentText;
    tab.stamp = result.stamp;
    tab.sentText = null;
    tab.saving = false;
    tab.conflict = false;
    tab.dirty = tab.draftText !== sentText;
    // Saving does not mean "I am finished with this file". Dropping out of edit
    // mode on every successful save meant a save mid-thought threw you back to
    // the read view and you had to click Edit again to carry on — for the very
    // common case of saving as you work. You leave editing by asking to.
    tab.editing = true;
    tab.notice = tab.dirty ? "Saved — you have typed more since." : "Saved.";
    return tab;
  }

  function anyDirty(scopes) {
    for (const state of scopes.values()) {
      for (const tab of state.tabs.values()) if (tab.dirty) return true;
    }
    return false;
  }

  function defaultConfirm(request) {
    const primary = request.actions && request.actions[0];
    const ok = typeof root.confirm === "function"
      ? root.confirm(request.title + "\n\n" + request.body)
      : false;
    return Promise.resolve(ok && primary ? primary.id : "cancel");
  }

  function panelIcon(side) {
    const x = side === "left" ? 9 : 15;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M' + x + ' 3v18"/></svg>';
  }

  const ICON = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    // book-open-text / code — the two Markdown modes, kept as the icon pair the
    // desktop panel has always used rather than a worded toggle. A worded
    // button made Markdown the odd one out beside the pencil every other text
    // file gets.
    preview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7v14"/><path d="M16 12h2"/><path d="M16 8h2"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/><path d="M6 12h2"/><path d="M6 8h2"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
  };

  function createFilePanel(options) {
    if (!options || !options.access) throw new Error("file panel requires an access adapter");
    const access = options.access;
    const ui = options.ui || {};
    const confirmChoice = typeof ui.confirm === "function" ? ui.confirm : defaultConfirm;
    const renderMarkdown = typeof ui.renderMarkdown === "function"
      ? ui.renderMarkdown
      : (source) => "<pre>" + escapeHtml(source) + "</pre>";
    const doc = options.document || root.document;
    const win = options.window || root;
    const mount = options.mount || {};
    const elementIds = mount.elementIds || {};
    const panelHost = mount.panelHost || doc.body;
    const scopes = new Map();
    const pendingControllers = new Set();
    const directorySeq = new Map();
    let currentScope = null;
    let currentState = null;
    let destroyed = false;
    let open = false;
    let treeMode = true;
    /** Which tab the live textarea belongs to, so a repaint only restores a
     *  caret into the same file it came from. */
    let editingTabKey = null;
    let renderedTreeState = null;
    let unsubscribeScope = null;
    let menu = null;

    const rootEl = doc.createElement("aside");
    rootEl.id = mount.id || "grok-file-panel";
    rootEl.className = "gfp-panel desk-ft-panel";
    rootEl.setAttribute("aria-label", "Workspace files");
    rootEl.hidden = true;

    const resizer = doc.createElement("div");
    resizer.className = "gfp-resizer desk-ft-resizer";
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.setAttribute("aria-label", "Resize file panel");
    resizer.hidden = true;

    const header = doc.createElement("div");
    header.className = "gfp-header desk-ft-header";
    const title = doc.createElement("button");
    title.type = "button";
    title.className = "gfp-title desk-ft-title";
    title.textContent = "Files";
    title.title = "Show file tree";
    const tabsEl = doc.createElement("div");
    tabsEl.className = "gfp-tabs desk-ft-tabs";
    tabsEl.setAttribute("role", "tablist");
    tabsEl.setAttribute("aria-label", "Open files");
    const closePanel = doc.createElement("button");
    closePanel.type = "button";
    closePanel.className = "gfp-close files-browse-close";
    closePanel.title = "Close";
    closePanel.setAttribute("aria-label", "Close file panel");
    closePanel.innerHTML = ICON.close;
    header.append(title, tabsEl, closePanel);

    const filter = doc.createElement("input");
    filter.type = "search";
    filter.className = "gfp-filter desk-ft-filter";
    filter.placeholder = "Filter…";
    filter.autocomplete = "off";
    filter.spellcheck = false;

    const tree = doc.createElement("div");
    tree.className = "gfp-tree desk-ft-body files-browse-body";
    const viewer = doc.createElement("div");
    viewer.className = "gfp-viewer desk-ft-viewer files-browse-viewer";
    viewer.hidden = true;

    if (elementIds.resizer) resizer.id = elementIds.resizer;
    if (elementIds.title) title.id = elementIds.title;
    if (elementIds.tabs) tabsEl.id = elementIds.tabs;
    if (elementIds.tree) tree.id = elementIds.tree;
    if (elementIds.viewer) viewer.id = elementIds.viewer;

    rootEl.append(header, filter, tree, viewer);
    panelHost.appendChild(resizer);
    panelHost.appendChild(rootEl);

    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "gfp-toggle desk-ft-top-toggle";
    toggle.setAttribute("aria-label", "Toggle file panel");
    toggle.innerHTML = panelIcon("right");
    toggle.addEventListener("click", () => setOpen(!open));
    closePanel.addEventListener("click", () => setOpen(false));
    title.addEventListener("click", showTree);
    filter.addEventListener("input", () => {
      if (!currentState) return;
      currentState.filter = filter.value;
      applyTreeFilter();
    });

    if (mount.toggleHost) mount.toggleHost.appendChild(toggle);

    function isOverlay() {
      if (mount.presentation === "overlay") return true;
      if (mount.presentation !== "responsive") return false;
      if (!dockHostIsDisplayed()) return true;
      const breakpoint = Number(mount.breakpointPx) || MOBILE_BREAKPOINT;
      return typeof win.matchMedia === "function" && win.matchMedia("(max-width: " + breakpoint + "px)").matches;
    }

    function dockHostIsDisplayed() {
      if (!mount.dockHost) return false;
      for (let element = mount.dockHost; element; element = element.parentElement) {
        if (element.hidden) return false;
        const style = typeof win.getComputedStyle === "function" ? win.getComputedStyle(element) : null;
        if (style && style.display === "none") return false;
      }
      return true;
    }

    function applyPresentation() {
      const overlay = isOverlay();
      rootEl.classList.toggle("gfp-overlay", overlay);
      rootEl.classList.toggle("gfp-docked", !overlay);
      // An overlay starts below the host's own bar, so it occupies the same band
      // the docked panel does instead of painting over the chrome — including,
      // on a phone, the button that just opened it. Measured rather than
      // hardcoded because the bar wraps to two rows on a narrow screen, and
      // re-measured here because this runs on every resize.
      // Its BOTTOM edge, not its height: the relay page has a second header
      // above this bar, and a height alone would start the panel that much too
      // high. Clamped at zero so a scrolled-away bar cannot push it off-screen.
      //
      // Resolved on every call rather than captured at mount, because WHICH bar
      // is on screen changes at runtime: the relay hides `.top-bar` and shows
      // `#session-head` the moment the host sends a project catalog. A captured
      // reference measured a hidden element, got zero, and left the overlay
      // covering the conversation header — the exact thing this offset exists to
      // prevent. Defaulting to the toggle's own container keeps it honest: the
      // panel starts below whichever bar its button lives in.
      const from = typeof mount.overlayTopFrom === "function"
        ? mount.overlayTopFrom()
        : mount.overlayTopFrom;
      const bar = overlay && (from || toggle.parentElement);
      const top = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
      rootEl.style.setProperty("--gfp-overlay-top", top + "px");
      resizer.hidden = !open || overlay;
      closePanel.hidden = !overlay;
      if (!overlay && mount.dockHost && rootEl.parentElement !== mount.dockHost) {
        mount.dockHost.appendChild(resizer);
        mount.dockHost.appendChild(rootEl);
      } else if (overlay && rootEl.parentElement !== panelHost) {
        panelHost.appendChild(resizer);
        panelHost.appendChild(rootEl);
      }
    }

    function setOpen(next) {
      open = !!next;
      rootEl.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.title = open ? "Hide file panel" : "Show file panel";
      applyPresentation();
      if (open && currentState && !currentState.tree) void loadRootTree();
      if (typeof options.onOpenChanged === "function") options.onOpenChanged(open);
    }

    function setPanelWidth(px, persist) {
      // What a drag may eat into is the ROW the panel shares with the chat, not
      // the panel's own column.
      //
      // Those are the same element on the desktop and different on the relay,
      // where the dock host is shrink-wrapped around the panel (`flex: 0 0
      // auto`). Measuring the column there returns the panel's own width, so
      // `hostWidth - MIN_CHAT_WIDTH` falls below MIN_WIDTH and the first drag
      // pins the panel at 200px with no way to enlarge it again.
      //
      // The host names the row instead of the component guessing: any
      // climb-until-an-ancestor-looks-wider rule is a heuristic that breaks the
      // next time either layout moves. `win.innerWidth` is not a substitute
      // either — on the relay the rail lives inside that width, so the chat
      // would be squeezed below its own minimum.
      // `widthPeer` is the element the panel must not starve — the chat column.
      // Available space is that column plus whatever the panel already occupies,
      // which is exactly the width the two of them share and nothing else.
      //
      // A whole-row basis is wrong for the same reason the panel's own column
      // was: on the relay the row also contains the project rail, so reserving
      // MIN_CHAT_WIDTH from the row let a drag squeeze the chat to ~150px on a
      // 1366px window and persist it.
      const peer = mount.widthPeer && mount.widthPeer.getBoundingClientRect().width;
      const hostWidth = (peer ? peer + rootEl.getBoundingClientRect().width : 0)
        || (mount.widthBasis && mount.widthBasis.getBoundingClientRect().width)
        || (rootEl.parentElement && rootEl.parentElement.getBoundingClientRect().width)
        || win.innerWidth || 800;
      const max = Math.max(MIN_WIDTH, Math.min(hostWidth * 0.7, hostWidth - MIN_CHAT_WIDTH));
      const value = Math.max(MIN_WIDTH, Math.min(max, Math.round(Number(px) || DEFAULT_WIDTH)));
      rootEl.style.setProperty("--gfp-width", value + "px");
      if (persist !== false && options.preferences && options.preferences.setWidth) {
        options.preferences.setWidth(value);
      }
      return value;
    }

    (function wireResize() {
      let dragging = false;
      let startX = 0;
      let startWidth = 0;
      resizer.addEventListener("pointerdown", (event) => {
        if (!open || isOverlay()) return;
        dragging = true;
        startX = event.clientX;
        startWidth = rootEl.getBoundingClientRect().width;
        rootEl.classList.add("gfp-resizing");
        try { resizer.setPointerCapture(event.pointerId); } catch (_) { /* noop */ }
        event.preventDefault();
      });
      resizer.addEventListener("pointermove", (event) => {
        if (dragging) setPanelWidth(startWidth + startX - event.clientX);
      });
      const stop = (event) => {
        if (!dragging) return;
        dragging = false;
        rootEl.classList.remove("gfp-resizing");
        try { resizer.releasePointerCapture(event.pointerId); } catch (_) { /* noop */ }
      };
      resizer.addEventListener("pointerup", stop);
      resizer.addEventListener("pointercancel", stop);
    })();

    function abortPending() {
      for (const controller of pendingControllers) controller.abort();
      pendingControllers.clear();
    }

    async function callAccess(method, scopeId, value) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      if (controller) pendingControllers.add(controller);
      try {
        return await access[method](scopeId, value, controller ? { signal: controller.signal } : undefined);
      } catch (error) {
        return { ok: false, reason: String(error && error.message || error || "Request failed") };
      } finally {
        if (controller) pendingControllers.delete(controller);
      }
    }

    function scopeState(scope) {
      let state = scopes.get(scope.id);
      if (!state) {
        state = makeScopeState(scope);
        scopes.set(scope.id, state);
      } else {
        state.scope = scope;
      }
      return state;
    }

    async function setScope(scope) {
      if (destroyed) return;
      const nextState = scope ? scopeState(scope) : null;
      if (currentState !== nextState) abortPending();
      currentState = nextState;
      currentScope = nextState ? nextState.scope : null;
      title.textContent = scope ? scope.label : "Files";
      title.title = scope && (scope.title || scope.label) || "Show file tree";
      filter.value = currentState ? currentState.filter : "";
      treeMode = !(currentState && currentState.activeRelPath);
      renderTabs();
      if (!currentState) {
        renderedTreeState = null;
        tree.textContent = "No repository selected.";
        viewer.textContent = "";
        viewer.hidden = true;
        tree.hidden = false;
        return;
      }
      if (treeMode) {
        showTree();
        if (open && !currentState.tree) await loadRootTree();
      } else {
        renderViewer();
      }
    }

    async function loadRootTree() {
      if (!currentScope || !currentState) return;
      const state = currentState;
      const scopeId = state.scope.id;
      // Hosts may reassert one scope from adjacent state/catalog events. Share
      // its in-flight root load so that one transition produces one request.
      // A late result is cached only on the scope that requested it and is
      // never rendered into whichever scope happens to be current by then.
      if (state.rootLoad) return state.rootLoad;
      tree.textContent = "";
      appendStatus(tree, "Loading…");
      state.rootLoad = (async () => {
        const result = await callAccess("list", scopeId, "");
        if (result && result.ok) state.tree = result;
        if (destroyed || currentState !== state) return;
        tree.textContent = "";
        if (!result || !result.ok) {
          appendStatus(tree, result && result.reason || "Could not list folder.", true);
          return;
        }
        renderRootTree(state);
      })();
      try {
        await state.rootLoad;
      } finally {
        state.rootLoad = null;
      }
    }

    function renderRootTree(state) {
      renderDirectory(tree, state.tree, "");
      renderedTreeState = state;
      applyTreeFilter();
    }

    function renderDirectory(container, result, parentRelPath) {
      container.textContent = "";
      if (!result.entries || !result.entries.length) {
        appendStatus(container, "Empty folder");
        return;
      }
      for (const entry of result.entries) container.appendChild(makeTreeNode(entry, parentRelPath));
      if (result.truncated) appendStatus(container, "Folder truncated — more entries exist.");
    }

    function makeTreeNode(entry) {
      const node = doc.createElement("div");
      node.className = "gfp-node desk-ft-node";
      node.dataset.name = entry.name;
      node.dataset.rel = entry.relPath;
      node.dataset.kind = entry.kind;
      const row = doc.createElement("div");
      row.className = "gfp-row desk-ft-row files-browse-row";
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.title = entry.relPath;
      const depth = String(entry.relPath).split("/").length - 1;
      row.style.setProperty("--gfp-depth", String(depth));
      const lead = doc.createElement("span");
      lead.className = "gfp-lead desk-ft-lead files-browse-row-icon";
      if (entry.kind === "dir") {
        lead.classList.add("desk-ft-twist");
        lead.innerHTML = ICON.chevronRight;
      }
      else renderFileIcon(lead, entry.name, entry.kind);
      const name = doc.createElement("span");
      name.className = "gfp-name desk-ft-name files-browse-row-name";
      name.textContent = entry.name;
      const actions = doc.createElement("div");
      actions.className = "gfp-row-actions desk-ft-row-actions";
      if (access.reveal || (entry.kind !== "dir" && access.openExternal)) {
        const more = doc.createElement("button");
        more.type = "button";
        more.className = "gfp-icon-button desk-ft-action-btn";
        more.innerHTML = ICON.more;
        more.title = "More actions";
        more.setAttribute("aria-label", "More actions");
        more.addEventListener("click", (event) => {
          event.stopPropagation();
          openRowMenu(more, entry);
        });
        actions.appendChild(more);
      }
      row.append(lead, name, actions);
      node.appendChild(row);
      if (entry.kind === "dir") {
        const children = doc.createElement("div");
        children.className = "gfp-children desk-ft-children";
        node.appendChild(children);
      }
      const activate = () => entry.kind === "dir" ? toggleDirectory(node, entry, lead) : openFile(entry.relPath);
      row.addEventListener("click", (event) => {
        if (event.target && event.target.closest && event.target.closest(".gfp-row-actions")) return;
        void activate();
      });
      if (access.reveal || (entry.kind !== "dir" && access.openExternal)) {
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openRowMenu(row, entry, event);
        });
      }
      row.addEventListener("keydown", (event) => {
        if (event.target === row && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          void activate();
        }
      });
      return node;
    }

    async function toggleDirectory(node, entry, lead) {
      if (!currentScope || !currentState) return;
      const children = node.querySelector(":scope > .gfp-children");
      const opening = !node.classList.contains("gfp-expanded");
      node.classList.toggle("gfp-expanded", opening);
      node.classList.toggle("desk-ft-open", opening);
      lead.innerHTML = opening ? ICON.chevronDown : ICON.chevronRight;
      if (!opening) {
        currentState.expanded.delete(entry.relPath);
        return;
      }
      currentState.expanded.add(entry.relPath);
      if (children.dataset.loaded === "1") return;
      appendStatus(children, "Loading…");
      const state = currentState;
      const scopeId = state.scope.id;
      const seq = (directorySeq.get(scopeKey(scopeId, entry.relPath)) || 0) + 1;
      directorySeq.set(scopeKey(scopeId, entry.relPath), seq);
      const result = await callAccess("list", scopeId, entry.relPath);
      if (
        destroyed || currentState !== state
        || directorySeq.get(scopeKey(scopeId, entry.relPath)) !== seq
      ) return;
      children.textContent = "";
      if (!result || !result.ok) {
        appendStatus(children, result && result.reason || "Could not list folder.", true);
        return;
      }
      children.dataset.loaded = "1";
      renderDirectory(children, result, entry.relPath);
      applyTreeFilter();
    }

    function renderFileIcon(host, name, kind) {
      const icons = ui.fileIcons;
      if (!icons || !icons.baseUrl) {
        host.innerHTML = ICON.file;
        return;
      }
      const id = typeof icons.idFor === "function"
        ? icons.idFor(kind, name)
        : icons.extensionToId
          ? iconIdFromTable(name, icons.extensionToId, icons.defaultId)
          : defaultFileIconId(kind, name);
      const src = joinUrl(icons.baseUrl, id + ".svg");
      const monochrome = Array.isArray(icons.monochromeIds)
        ? icons.monochromeIds.indexOf(id) >= 0
        : MONOCHROME_FILE_ICONS.has(id);
      if (monochrome) {
        // An external SVG with no fill defaults to black. Use it as a mask so
        // the same lazy-loaded asset follows the active host theme instead.
        const glyph = doc.createElement("span");
        glyph.className = "gfp-file-icon-mono desk-ft-icon-mono";
        glyph.style.setProperty("--gfp-icon-url", 'url("' + src.replace(/"/g, "%22") + '")');
        host.appendChild(glyph);
      } else {
        const img = doc.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.src = src;
        host.appendChild(img);
      }
    }

    function applyTreeFilter() {
      if (!currentState) return;
      const query = String(currentState.filter || "").trim().toLowerCase();
      function visit(container) {
        let visible = 0;
        for (const node of container.querySelectorAll(":scope > .gfp-node")) {
          const children = node.querySelector(":scope > .gfp-children");
          const childVisible = children ? visit(children) : 0;
          const matches = !query || String(node.dataset.name || "").toLowerCase().includes(query) || childVisible > 0;
          node.hidden = !matches;
          if (matches) visible++;
        }
        return visible;
      }
      visit(tree);
    }

    async function openFile(relPath, force) {
      if (!currentScope || !currentState || !relPath) return { ok: false, reason: "no repository scope" };
      const state = currentState;
      const scopeId = state.scope.id;
      if (!force && state.tabs.has(relPath)) {
        activateTab(relPath);
        return { ok: true };
      }
      const existing = state.tabs.get(relPath);
      const readSeq = existing ? ++existing.readSeq : 1;
      const result = await callAccess("read", scopeId, relPath);
      if (destroyed || currentState !== state) return { ok: false, reason: "scope changed" };
      if (existing && existing.readSeq !== readSeq) return { ok: false, reason: "superseded" };
      if (!result || !result.ok) {
        if (result && result.openExternal && access.openExternal) {
          return access.openExternal(scopeId, relPath);
        }
        showViewerError(relPath, result && result.reason || "Could not open file.");
        return result || { ok: false, reason: "read failed" };
      }
      const tab = makeTab(scopeId, result);
      state.tabs.set(relPath, tab);
      if (!state.order.includes(relPath)) state.order.push(relPath);
      state.activeRelPath = relPath;
      treeMode = false;
      renderTabs();
      renderViewer();
      setOpen(true);
      return { ok: true, kind: result.kind };
    }

    function activateTab(relPath) {
      if (!currentState || !currentState.tabs.has(relPath)) return;
      currentState.activeRelPath = relPath;
      treeMode = false;
      renderTabs();
      renderViewer();
    }

    async function closeTab(relPath) {
      if (!currentState) return false;
      const tab = currentState.tabs.get(relPath);
      if (!tab) return false;
      if (tab.dirty) {
        const answer = await confirmChoice({
          title: "Discard changes?",
          body: "Your edits have not been saved.",
          actions: [{ id: "discard", label: "Discard", danger: true }],
        });
        if (answer !== "discard") return false;
      }
      currentState.tabs.delete(relPath);
      currentState.order = currentState.order.filter((item) => item !== relPath);
      if (currentState.activeRelPath === relPath) {
        currentState.activeRelPath = currentState.order.length
          ? currentState.order[currentState.order.length - 1]
          : null;
      }
      renderTabs();
      if (currentState.activeRelPath) renderViewer();
      else showTree();
      return true;
    }

    function renderTabs() {
      tabsEl.textContent = "";
      if (!currentState) return;
      for (const relPath of currentState.order) {
        const tab = currentState.tabs.get(relPath);
        if (!tab) continue;
        const item = doc.createElement("div");
        item.className = "gfp-tab desk-ft-tab" + (!treeMode && currentState.activeRelPath === relPath ? " gfp-tab-active desk-ft-tab-active" : "");
        item.setAttribute("role", "tab");
        item.dataset.rel = relPath;
        item.title = relPath;
        item.tabIndex = 0;
        const name = doc.createElement("span");
        name.className = "gfp-tab-name desk-ft-tab-name";
        name.textContent = fileName(relPath);
        const dirty = doc.createElement("span");
        dirty.className = "gfp-tab-dirty desk-ft-tab-dirty";
        dirty.textContent = tab.dirty ? "•" : "";
        const close = doc.createElement("button");
        close.type = "button";
        close.className = "gfp-tab-close desk-ft-tab-close";
        close.innerHTML = ICON.close;
        close.title = "Close";
        close.setAttribute("aria-label", "Close " + fileName(relPath));
        close.addEventListener("click", (event) => {
          event.stopPropagation();
          void closeTab(relPath);
        });
        item.append(name, dirty, close);
        item.addEventListener("click", () => activateTab(relPath));
        tabsEl.appendChild(item);
      }
    }

    function currentTab() {
      return currentState && currentState.activeRelPath
        ? currentState.tabs.get(currentState.activeRelPath) || null
        : null;
    }

    function showTree() {
      treeMode = true;
      rootEl.classList.remove("gfp-viewing");
      if (mount.viewingBodyClass) doc.body.classList.remove(mount.viewingBodyClass);
      tree.hidden = false;
      viewer.hidden = true;
      renderTabs();
      if (currentState && currentState.tree && renderedTreeState !== currentState) {
        renderRootTree(currentState);
      } else if (currentState && !currentState.tree && open) {
        void loadRootTree();
      }
    }

    function showViewerError(relPath, reason) {
      treeMode = false;
      tree.hidden = true;
      viewer.hidden = false;
      viewer.textContent = "";
      const head = viewerHead();
      viewer.append(head);
      appendStatus(viewer, reason, true);
    }

    /**
     * The open file's action row. No back chevron and no filename: both were
     * saying something the panel already says. The tab strip above names the
     * file and marks it dirty, and the project title beside it is the way back
     * to the tree — so the breadcrumb row was a third copy of the same two
     * facts, costing a row of height on a phone.
     */
    function viewerHead() {
      const head = doc.createElement("div");
      head.className = "gfp-viewer-head desk-ft-toolbar files-browse-viewer-head";
      return head;
    }

    function renderViewer() {
      const tab = currentTab();
      if (!tab) return showTree();
      // Where the caret was, so a repaint does not throw it away.
      //
      // This function rebuilds the viewer from scratch, textarea included, and a
      // save repaints — so saving mid-sentence moved the cursor to the start and
      // lost the selection and the scroll position. Captured for THIS tab only;
      // a repaint that swaps files should not move a caret into someone else's
      // text.
      const live = viewer.querySelector(".gfp-editor");
      const carry = live && editingTabKey === tab.key
        ? {
            start: live.selectionStart,
            end: live.selectionEnd,
            scrollTop: live.scrollTop,
            focused: doc.activeElement === live,
          }
        : null;
      editingTabKey = tab.editing ? tab.key : null;
      treeMode = false;
      rootEl.classList.add("gfp-viewing");
      if (mount.viewingBodyClass) doc.body.classList.add(mount.viewingBodyClass);
      tree.hidden = true;
      viewer.hidden = false;
      viewer.textContent = "";
      const head = viewerHead();
      renderViewerActions(head, tab);
      viewer.appendChild(head);
      if (tab.notice) {
        const notice = doc.createElement("div");
        notice.className = "gfp-notice desk-ft-notice files-browse-notice" + (tab.conflict ? " gfp-notice-warning files-browse-notice-warn" : "");
        notice.textContent = tab.notice;
        viewer.appendChild(notice);
      }
      if (tab.conflict) renderConflictActions(tab);
      const body = doc.createElement("div");
      body.className = "gfp-viewer-body desk-ft-viewer-body files-browse-viewer-body";
      if (elementIds.viewerBody) body.id = elementIds.viewerBody;
      if (tab.editing) {
        const editor = doc.createElement("textarea");
        editor.className = "gfp-editor desk-ft-editor files-browse-editor";
        editor.value = tab.draftText;
        editor.spellcheck = false;
        // Held, not hidden, while a Reload is in flight — see reloadTab.
        editor.readOnly = !!tab.reloading;
        editor.setAttribute("aria-label", "Edit " + tab.relPath);
        editor.addEventListener("input", () => {
          applyDraft(tab, editor.value);
          patchDirtyUi(tab);
        });
        body.appendChild(editor);
      } else if (tab.kind === "image" && tab.dataUrl) {
        const image = doc.createElement("img");
        image.src = tab.dataUrl;
        image.alt = tab.relPath;
        body.appendChild(image);
      } else if (tab.kind === "markdown" && tab.mode === "preview") {
        const markdown = doc.createElement("div");
        markdown.className = "gfp-markdown desk-ft-md files-browse-md";
        markdown.innerHTML = renderMarkdown(tab.draftText);
        body.appendChild(markdown);
      } else {
        const pre = doc.createElement("pre");
        pre.textContent = tab.draftText;
        body.appendChild(pre);
      }
      viewer.appendChild(body);
      // Put the caret back where the repaint found it.
      if (carry) {
        const next = viewer.querySelector(".gfp-editor");
        if (next) {
          try {
            next.setSelectionRange(carry.start, carry.end);
            next.scrollTop = carry.scrollTop;
          } catch (_) { /* a non-text control has no selection range */ }
          if (carry.focused) next.focus({ preventScroll: true });
        }
      }
    }

    function renderViewerActions(head, tab) {
      if (EDITABLE_KINDS.has(tab.kind) && access.write && tab.stamp && tab.expectedAbsPath) {
        if (tab.kind === "markdown") {
          // Markdown has two modes and the desktop panel has always shown them
          // as a PAIR of icon buttons with the current one marked active — not
          // as one worded toggle. The worded version was a divergence
          // introduced by the extraction, and it made Markdown read as a
          // different kind of file from every other text file, which shows the
          // pencil below.
          const modeButton = (icon, label, mode) => {
            const button = actionButton("", "", () => {
              tab.mode = mode;
              tab.editing = mode === "code";
              if (mode === "code") {
                tab.notice = "";
                tab.conflict = false;
              }
              renderViewer();
              const editor = viewer.querySelector(".gfp-editor");
              if (editor) editor.focus();
            });
            button.classList.add("gfp-mode", "files-browse-action");
            // "Edit source" IS Markdown's edit control, so it keeps the class
            // every other text file's pencil carries. One selector means
            // "the control that puts this file into edit mode", whatever the
            // file type — which is what callers and tests actually want.
            if (mode === "code") button.classList.add("gfp-edit");
            if (tab.mode === mode) button.classList.add("gfp-active", "desk-ft-active");
            button.innerHTML = icon;
            button.title = label;
            button.setAttribute("aria-label", label);
            button.setAttribute("aria-pressed", String(tab.mode === mode));
            return button;
          };
          head.appendChild(modeButton(ICON.preview, "Preview", "preview"));
          head.appendChild(modeButton(ICON.code, "Edit source", "code"));
        } else if (!tab.editing) {
          const edit = actionButton("", "", () => {
            tab.editing = true;
            tab.notice = "";
            tab.conflict = false;
            renderViewer();
            const editor = viewer.querySelector(".gfp-editor");
            if (editor) editor.focus();
          });
          edit.classList.add("gfp-edit", "files-browse-action");
          edit.innerHTML = ICON.pencil;
          edit.title = "Edit file";
          edit.setAttribute("aria-label", "Edit file");
          head.appendChild(edit);
        }
        if (tab.editing) {
          const cancel = actionButton("Cancel", "", () => void cancelChanges(tab));
          cancel.classList.add("gfp-cancel", "files-browse-action");
          cancel.disabled = tab.saving;
          const save = actionButton(tab.saving ? "Saving…" : "Save", "primary", () => void saveTab(tab));
          save.classList.add("gfp-save", "files-browse-action", "files-browse-action-primary");
          save.disabled = tab.saving || !tab.dirty;
          head.append(cancel, save);
        }
      }
      if (access.openExternal || access.reveal) {
        const more = actionButton("", "", () => openRowMenu(more, { relPath: tab.relPath, kind: "file", name: fileName(tab.relPath) }));
        more.classList.add("gfp-more");
        more.classList.add("desk-ft-open-ext");
        more.innerHTML = ICON.more;
        more.title = "More actions";
        more.setAttribute("aria-label", "More actions");
        head.appendChild(more);
      }
    }

    function patchDirtyUi(tab) {
      const save = viewer.querySelector(".gfp-save");
      if (save) save.disabled = tab.saving || !tab.dirty;
      const item = tabsEl.querySelector('[data-rel="' + cssEscape(tab.relPath) + '"] .gfp-tab-dirty');
      if (item) item.textContent = tab.dirty ? "•" : "";
    }

    async function cancelChanges(tab) {
      if (tab.dirty) {
        const answer = await confirmChoice({
          title: "Cancel changes?",
          body: "This discards your unsaved edits and restores the last loaded version.",
          actions: [{ id: "discard", label: "Discard", danger: true }],
        });
        if (answer !== "discard") return false;
      }
      tab.draftText = tab.baselineText;
      tab.dirty = false;
      tab.editing = false;
      tab.conflict = false;
      tab.notice = "";
      renderTabs();
      renderViewer();
      return true;
    }

    /**
     * Whether `tab` is the one actually painted right now.
     *
     * Async work must not repaint the viewer for a tab nobody is looking at:
     * `renderViewer()` rebuilds the live textarea, and takes the caret, the
     * selection and any in-progress IME composition with it. Save A, switch to
     * B, start typing, and A's answer landing would disturb what you are typing
     * in B. `reloadTab` learned this the hard way; keeping the rule in one
     * place is what stops the next awaiting path from having to.
     */
    function isOnScreen(tab) {
      const state = scopes.get(tab.scopeId);
      return !!state
        && currentState === state
        && state.activeRelPath === tab.relPath
        && state.tabs.get(tab.relPath) === tab;
    }

    /** Repaint only what `tab` actually owns on screen. */
    function repaintFor(tab) {
      if (scopes.get(tab.scopeId) === currentState) renderTabs();
      if (isOnScreen(tab)) renderViewer();
    }

    async function saveTab(tab) {
      if (!access.write || !tab.dirty || tab.saving || !tab.stamp || !tab.expectedAbsPath) return false;
      const sentText = tab.draftText;
      const seq = ++tab.saveSeq;
      tab.saving = true;
      tab.sentText = sentText;
      tab.notice = "";
      renderViewer();
      const result = await access.write(tab.scopeId, {
        relPath: tab.relPath,
        text: sentText,
        stamp: tab.stamp,
        expectedAbsPath: tab.expectedAbsPath,
      });
      if (destroyed || tab.saveSeq !== seq) return false;
      if (result && result.ok) {
        applySaveSuccess(tab, sentText, result);
        repaintFor(tab);
        return true;
      }
      tab.saving = false;
      tab.sentText = null;
      if (result && result.reason === "changed") {
        tab.conflict = true;
        tab.notice = "File changed on disk. Reload the host's version, or keep your edits and overwrite.";
      } else if (result && result.reason === "workspace changed") {
        tab.conflict = false;
        tab.notice = "This file is no longer the one you opened. Re-open it from the tree.";
      } else {
        tab.conflict = false;
        tab.notice = result && result.reason || "Save refused.";
      }
      repaintFor(tab);
      return false;
    }

    function renderConflictActions(tab) {
      const actions = doc.createElement("div");
      actions.className = "gfp-conflict-actions files-browse-conflict-actions";
      const reload = actionButton("Reload", "", () => void reloadTab(tab));
      const overwrite = actionButton("Overwrite", "danger", () => void overwriteTab(tab));
      // Reload and Overwrite resolve the SAME conflict in opposite directions,
      // so running both is not a faster way to decide — it is a way to end up
      // with a panel that misreports the file. Click Reload, then Overwrite
      // while the first read is still out, and the write lands while the reload
      // replaces the tab: the panel then shows the host's version, clean, over a
      // file that actually holds the draft, and closing it warns about nothing.
      // Whichever is chosen first owns the conflict until it finishes.
      reload.disabled = overwrite.disabled = !!(tab.reloading || tab.saving);
      actions.append(reload, overwrite);
      viewer.appendChild(actions);
    }

    async function reloadTab(tab) {
      const state = scopes.get(tab.scopeId);
      if (!state || state.tabs.get(tab.relPath) !== tab || tab.reloading) return false;
      // Reload replaces the whole tab with the host's version, so anything typed
      // while the read is in flight would vanish without a word — and on a phone
      // that flight is long enough to type into. The editor is held read-only
      // for the duration instead: Reload means "take the file's version", and
      // the honest way to say that is to stop accepting edits, not to accept
      // them and then drop them.
      tab.reloading = true;
      tab.notice = "Reloading…";
      repaintFor(tab);
      const result = await access.read(tab.scopeId, tab.relPath);
      tab.reloading = false;
      if (destroyed || state.tabs.get(tab.relPath) !== tab) return false;
      if (!result || !result.ok) {
        tab.conflict = false;
        tab.notice = result && result.reason || "Could not reload the current file version.";
        repaintFor(tab);
        return false;
      }
      const fresh = makeTab(tab.scopeId, result);
      state.tabs.set(tab.relPath, fresh);
      repaintFor(fresh);
      return true;
    }

    async function overwriteTab(tab) {
      if (!access.write || tab.saving) return false;
      const state = scopes.get(tab.scopeId);
      if (!state || state.tabs.get(tab.relPath) !== tab) return false;
      tab.saving = true;
      tab.conflict = false;
      tab.notice = "Refreshing version…";
      renderViewer();
      const fresh = await access.read(tab.scopeId, tab.relPath);
      if (destroyed || state.tabs.get(tab.relPath) !== tab) return false;
      if (!fresh || !fresh.ok || !fresh.stamp || !fresh.absPath) {
        tab.saving = false;
        tab.notice = fresh && fresh.reason || "Could not reload the current file version.";
        return renderViewer();
      }
      // Overwrite means “replace the newer bytes of the file I opened.” It may
      // refresh a stamp; it never adopts a different file identity.
      if (fresh.absPath !== tab.expectedAbsPath) {
        tab.saving = false;
        tab.notice = "This file is no longer the one you opened. Re-open it from the tree.";
        return renderViewer();
      }
      tab.stamp = fresh.stamp;
      tab.saving = false;
      // Dirty against what is ON DISK NOW, not against the version this tab was
      // opened at. Overwrite exists precisely because the file moved underneath
      // us, so the opened baseline is the one value that is certainly stale.
      // Comparing against it meant that typing your way back to the opened text
      // during the refresh made the tab read "clean", `saveTab` then refused to
      // run, and the panel showed the older content as saved while the disk kept
      // the newer bytes — and closing it would not have warned.
      if (typeof fresh.text === "string") tab.baselineText = fresh.text;
      tab.dirty = tab.draftText !== tab.baselineText;
      if (!tab.dirty) {
        // The refresh proved the file already holds exactly this text, so there
        // is nothing to overwrite. `saveTab` refuses a clean tab and returns
        // silently, which left "Refreshing version…" on screen forever — an
        // operation that never finished, for the one case where it was already
        // done.
        tab.notice = "Already matches the file on disk.";
        tab.editing = false;
        repaintFor(tab);
        return true;
      }
      return saveTab(tab);
    }

    function actionButton(label, tone, listener) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "gfp-action" + (tone ? " gfp-action-" + tone : "");
      button.textContent = label;
      button.addEventListener("click", listener);
      return button;
    }

    function openRowMenu(anchor, entry, pointerEvent) {
      closeMenu();
      menu = doc.createElement("div");
      menu.className = "gfp-menu desk-ft-overflow-menu desk-ft-open";
      menu.setAttribute("role", "menu");
      if (entry.kind !== "dir" && access.openExternal) {
        menu.appendChild(menuItem("Open in default app", () => access.openExternal(currentScope.id, entry.relPath)));
      }
      if (access.reveal) {
        menu.appendChild(menuItem(ui.revealLabel || "Reveal in file manager", () => access.reveal(currentScope.id, entry.relPath)));
      }
      if (!menu.childNodes.length) return closeMenu();
      doc.body.appendChild(menu);

      // Zoom-corrected and clamped to the viewport.
      //
      // The chat scales with `--chat-zoom`, and body zoom scales VISUAL rects
      // while `position: fixed` top/left are LAYOUT pixels — so a menu placed at
      // a raw `clientX/clientY` lands further off the further you are from the
      // origin, which is what "appears randomly" looks like. `unzoomClientPx`
      // converts between the two and is a no-op at zoom 1.
      //
      // This is the same maths the released desktop panel used and `openRailMenu`
      // in chat.js still uses; the extraction dropped it, along with the flip-up
      // and the bottom clamp, so the menu could also run off the screen.
      const helpers = (win.GrokWebviewHelpers || root.GrokWebviewHelpers || {});
      const zoomOf = typeof helpers.chatZoomFactor === "function" ? helpers.chatZoomFactor : () => 1;
      const unzoom = typeof helpers.unzoomClientPx === "function" ? helpers.unzoomClientPx : (px) => px;
      const z = zoomOf();
      const size = menu.getBoundingClientRect();
      const menuH = unzoom(size.height, z);
      const menuW = unzoom(size.width, z);
      const vh = unzoom(win.innerHeight, z);
      const vw = unzoom(win.innerWidth, z);
      const gap = 4;
      let top;
      let left;
      if (pointerEvent) {
        top = unzoom(pointerEvent.clientY, z);
        left = unzoom(pointerEvent.clientX, z);
        if (top + menuH > vh - 8) top = Math.max(8, vh - menuH - 8);
        if (left + menuW > vw - 8) left = Math.max(8, vw - menuW - 8);
      } else {
        const box = anchor.getBoundingClientRect();
        top = unzoom(box.bottom, z) + gap;
        // Flip above the button rather than off the bottom of the panel.
        if (top + menuH > vh - 8) top = Math.max(8, unzoom(box.top, z) - menuH - gap);
        left = unzoom(box.right, z) - menuW;
        left = Math.max(8, Math.min(left, vw - menuW - 8));
      }
      menu.style.top = Math.round(top) + "px";
      menu.style.left = Math.round(left) + "px";
      menu.style.right = "auto";
    }

    function menuItem(label, listener) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "gfp-menu-item desk-ft-overflow-item";
      button.textContent = label;
      button.addEventListener("click", async () => {
        closeMenu();
        await listener();
      });
      return button;
    }

    function closeMenu() {
      if (menu) menu.remove();
      menu = null;
    }

    function appendStatus(host, message, error) {
      host.textContent = "";
      const status = doc.createElement("div");
      status.className = "gfp-status desk-ft-empty" + (error ? " gfp-error desk-ft-error" : "");
      status.textContent = message;
      host.appendChild(status);
    }

    function confirmClose() {
      if (!anyDirty(scopes)) return Promise.resolve(true);
      return confirmChoice({
        title: "Discard changes?",
        body: "Your edits have not been saved.",
        actions: [{ id: "discard", label: "Discard", danger: true }],
      }).then((answer) => answer === "discard");
    }

    function clearMemory() {
      abortPending();
      scopes.clear();
      currentState = currentScope ? scopeState(currentScope) : null;
      renderedTreeState = null;
      treeMode = true;
      renderTabs();
      showTree();
      if (open && currentState) void loadRootTree();
    }

    function destroy() {
      destroyed = true;
      abortPending();
      closeMenu();
      if (typeof unsubscribeScope === "function") unsubscribeScope();
      win.removeEventListener("beforeunload", beforeUnload);
      win.removeEventListener("resize", applyPresentation);
      doc.removeEventListener("click", closeMenuFromOutside);
      toggle.remove();
      resizer.remove();
      rootEl.remove();
    }

    function closeMenuFromOutside(event) {
      if (menu && !menu.contains(event.target)) closeMenu();
    }
    doc.addEventListener("click", closeMenuFromOutside);
    win.addEventListener("resize", applyPresentation);
    rootEl.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        const tab = currentTab();
        if (tab && tab.editing) {
          event.preventDefault();
          void saveTab(tab);
        }
      }
    });

    function beforeUnload(event) {
      if (!anyDirty(scopes)) return;
      event.preventDefault();
      event.returnValue = "";
    }
    win.addEventListener("beforeunload", beforeUnload);

    setPanelWidth(options.preferences && options.preferences.getWidth
      ? options.preferences.getWidth() : DEFAULT_WIDTH, true);
    if (typeof access.onScopeChanged === "function") {
      unsubscribeScope = access.onScopeChanged((scope) => void setScope(scope));
    }
    Promise.resolve(access.currentScope()).then((scope) => setScope(scope));

    if (options.initialOpen) setOpen(true);
    else {
      applyPresentation();
      if (typeof options.onOpenChanged === "function") options.onOpenChanged(false);
    }

    return {
      element: rootEl,
      resizer,
      toggleElement: toggle,
      setOpen,
      isOpen: () => open,
      setScope,
      setWidth: setPanelWidth,
      openPath: openFile,
      hasDirty: () => anyDirty(scopes),
      confirmClose,
      clearMemory,
      destroy,
      _scopes: scopes,
    };
  }

  function iconIdFromTable(name, table, fallback) {
    const lower = String(name || "").toLowerCase();
    const dot = lower.lastIndexOf(".");
    const ext = dot >= 0 ? lower.slice(dot + 1) : lower;
    return table && (table[lower] || table[ext]) || fallback || "default";
  }

  function joinUrl(base, leaf) {
    return String(base || "").replace(/\/?$/, "/") + leaf;
  }

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === "function") return root.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const api = {
    createFilePanel,
    fileName,
    scopeKey,
    defaultFileIconId,
    makeTab,
    applyDraft,
    applySaveSuccess,
    anyDirty,
    panelIcon,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GrokFilePanel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
