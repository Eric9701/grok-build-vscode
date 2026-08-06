/**
 * HostWebview over Electron IPC + a custom `app-resource://` protocol.
 *
 * The sidebar sets `html` (built by `getHtml`) and never hand-writes a page.
 * Scripts/styles resolve through {@link asWebviewUri} → `app-resource://` path
 * URLs under full-serve roots (canonical containment). Generated media and
 * other host-chosen files go through a {@link ResourceRegistry} opaque handle
 * so the renderer cannot invent paths into `~/.grok`.
 *
 * Renderer → host messages are schema-validated ({@link parseWebviewMsg})
 * before any sidebar listener runs.
 */
import type { BrowserWindow } from "electron";
import * as path from "node:path";
import type { HostDisposable, HostWebview, Uri } from "../host";
import {
  appResourceMayServeStaticPath,
  resolveAppResourceServe,
  rootServePolicy,
} from "./app-resource-policy";
import {
  authorizeDesktopWebviewMsg,
  type DesktopOpenFileContext,
} from "./desktop-policy";
import { FileSelectionRegistry } from "./file-selection-registry";
import {
  RESOURCE_REGISTRY_URL_SEGMENT,
  ResourceRegistry,
} from "./resource-registry";
import { parseWebviewMsg } from "./webview-msg-validate";

const SCHEME = "app-resource";
const AUTHORITY = "vsc-resource";

/** Minimal VS Code-like theme tokens so chat.css paints without a VS Code host. */
const DESKTOP_THEME_CSS = `
:root {
  color-scheme: dark;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-sideBar-background: #252526;
  --vscode-editor-background: #1e1e1e;
  --vscode-editorWidget-border: #454545;
  --vscode-editorWidget-background: #252526;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, "Courier New", monospace;
  --vscode-textLink-foreground: #3794ff;
  --vscode-textLink-activeForeground: #3794ff;
  --vscode-textCodeBlock-background: #1e1e1e;
  --vscode-textPreformat-foreground: #d7ba7d;
  --vscode-input-background: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-focusBorder: #007fd4;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  --vscode-button-secondaryBackground: #3a3d41;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #094771;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-toolbar-hoverBackground: rgba(255,255,255,0.08);
  --vscode-scrollbarSlider-background: rgba(121,121,121,0.4);
  --vscode-scrollbarSlider-hoverBackground: rgba(100,100,100,0.7);
  --vscode-scrollbarSlider-activeBackground: rgba(191,191,191,0.4);
  --vscode-charts-green: #4ec9b0;
  --vscode-charts-blue: #3794ff;
  --vscode-charts-yellow: #dcdcaa;
  --vscode-errorForeground: #f48771;
  --vscode-keybindingLabel-background: rgba(128,128,128,0.17);
  --vscode-keybindingLabel-border: rgba(51,51,51,0.6);
  --vscode-keybindingLabel-foreground: #cccccc;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-widget-shadow: rgba(0,0,0,0.36);
  --vscode-dropdown-background: #3c3c3c;
  --vscode-dropdown-foreground: #f0f0f0;
  --vscode-dropdown-border: #3c3c3c;
  --vscode-menu-background: #252526;
  --vscode-menu-foreground: #cccccc;
  --vscode-menu-selectionBackground: #094771;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-menu-border: #454545;
  --vscode-progressBar-background: #0e70c0;
  --vscode-inputValidation-errorBackground: #5a1d1d;
  --vscode-inputValidation-errorBorder: #be1100;
}
html, body { margin: 0; height: 100%; overflow: hidden; }
body { background: var(--vscode-sideBar-background); color: var(--vscode-foreground); }

/* Reading measure — desktop shell only (mirrors AFK Pilot web/chat.html).
   Shared chat.css is left alone so VS Code's narrow panel is unchanged.
   Top bar fills the chat column (rail edge → panel edge); only messages +
   composer are width-capped. */
body.desk > #messages,
body.desk > .composer,
body.desk > #messages-wrap,
body.desk .desk-ft-chat > #messages,
body.desk .desk-ft-chat > .composer,
body.desk .desk-ft-chat > #messages-wrap {
  max-width: 800px;
  width: 100%;
  margin-left: auto;
  margin-right: auto;
  box-sizing: border-box;
}
/* Without the file-tree shell, a slightly wider reading column is fine. */
body.desk:not(.desk-with-ft) > #messages,
body.desk:not(.desk-with-ft) > .composer,
body.desk:not(.desk-with-ft) > #messages-wrap {
  max-width: 1120px;
}
/* Top bar: full width of the chat column (not the reading measure). */
body.desk > .top-bar,
body.desk .app-main > .top-bar {
  max-width: none;
  width: 100%;
  margin-left: 0;
  margin-right: 0;
  box-sizing: border-box;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
  flex-shrink: 0;
}

/* Spacing rhythm — match AFK Pilot (web/chat.html), not chat.css body.desk's
   4px VS Code-panel pad. Desktop shell only; chat.css is untouched. */
body.desk {
  --pad: 8px;
}
body.desk > #messages,
body.desk > .composer,
body.desk .desk-ft-chat > #messages,
body.desk .desk-ft-chat > .composer {
  padding-left: calc(var(--pad) + 5px);
  padding-right: calc(var(--pad) + 5px);
}
/* Room under typed text before the toolbar (AFK Pilot: 11px). */
body.desk textarea#input,
body.desk .input-highlight {
  padding-bottom: 11px;
}
/* Extra air under the composer card vs the window edge. */
body.desk > .composer,
body.desk .desk-ft-chat > .composer {
  padding-bottom: max(12px, var(--pad));
}

/* Scroll-edge fades — port of AFK Pilot web/chat.html (not shared chat.css). */
#messages-wrap {
  position: relative;
  z-index: 0;
  isolation: isolate;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
}
#messages-wrap > #messages {
  flex: 1 1 auto;
  min-height: 0;
}
.msg-fade {
  position: absolute;
  left: 0;
  right: 8px; /* clear the 8px scrollbar so it stays crisp */
  height: 18px;
  z-index: 4;
  pointer-events: none;
}
.msg-fade-top {
  top: 0;
  background: linear-gradient(to bottom, var(--vscode-sideBar-background), transparent);
  opacity: var(--fade-top-op, 0);
}
.msg-fade-bot {
  bottom: 0;
  background: linear-gradient(to top, var(--vscode-sideBar-background), transparent);
  opacity: var(--fade-bot-op, 0);
}
`;

export function asAppResourceUrl(uri: Uri): string {
  if (uri.scheme === "file") {
    // Portable Uri.path is POSIX-style, with a leading / before Windows drive.
    const encPath = uri.path
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return `${SCHEME}://${AUTHORITY}${encPath.startsWith("/") ? encPath : `/${encPath}`}`;
  }
  // Non-file: still route through the scheme so CSP accepts it; path may be empty.
  const encPath = uri.path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${SCHEME}://${AUTHORITY}${encPath.startsWith("/") ? encPath : `/${encPath || "/"}`}`;
}

/** Build a registry-handle app-resource URL for an opaque media id. */
export function asAppResourceRegistryUrl(id: string): string {
  return `${SCHEME}://${AUTHORITY}/${RESOURCE_REGISTRY_URL_SEGMENT}/${id}`;
}

/** Decode an app-resource URL back to an absolute filesystem path (path-shaped only). */
export function appResourceUrlToFsPath(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${SCHEME}:` || parsed.hostname !== AUTHORITY) return undefined;
  let p = decodeURIComponent(parsed.pathname);
  // Registry handles are not filesystem paths.
  if (p.includes(`/${RESOURCE_REGISTRY_URL_SEGMENT}/`) || p.startsWith(`/${RESOURCE_REGISTRY_URL_SEGMENT}/`)) {
    return undefined;
  }
  // Windows: /C:/Users/... → C:\Users\...
  if (/^\/[A-Za-z]:/.test(p)) {
    p = p.slice(1).replace(/\//g, path.sep);
  } else if (process.platform === "win32") {
    p = p.replace(/\//g, path.sep);
  }
  return p;
}

export const APP_RESOURCE_SCHEME = SCHEME;
export const APP_RESOURCE_CSP_SOURCE = `${SCHEME}:`;

export class ElectronWebview implements HostWebview {
  private _html = "";
  private _options: HostWebview["options"] = {};
  private listeners = new Set<(message: unknown) => unknown>();
  private allowedRoots: string[] = [];
  /** Host-issued media handles — only these resolve under media-only roots. */
  readonly registry = new ResourceRegistry();
  /**
   * Host-issued handles for OS picker / genuine file drops. `dropFile` carries
   * only these ids — never a renderer-invented path.
   */
  readonly fileSelection = new FileSelectionRegistry();
  /** Optional log for dropped IPC (wired from main). */
  onDroppedMessage?: (reason: string, raw: unknown) => void;
  /**
   * Workspace root for desktop openFile policy. Wired from main after the
   * folder is chosen; when unset, openFile is refused.
   * Prefer {@link getAuthContext} when session roots (worktrees) matter.
   */
  getWorkspaceRoot?: () => string | undefined;
  /**
   * Full desktop auth context (session roots + drop-handle resolver). Wired
   * from main after the sidebar exists so worktree sessions authorize correctly.
   */
  getAuthContext?: () => DesktopOpenFileContext;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  get html(): string {
    return this._html;
  }

  set html(value: string) {
    this._html = value;
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const injected = injectTheme(value);
    // data: URL keeps us free of a second HTML file; scripts still load via app-resource.
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(injected)}`);
  }

  get options(): HostWebview["options"] {
    return this._options;
  }

  set options(value: HostWebview["options"]) {
    this._options = value ?? {};
    this.allowedRoots = (value?.localResourceRoots ?? [])
      .filter((u) => u.scheme === "file")
      .map((u) => path.normalize(u.fsPath));
  }

  get cspSource(): string {
    return APP_RESOURCE_CSP_SOURCE;
  }

  /**
   * Resolve an app-resource request URL to a serveable absolute path, or null.
   * Registry handles and static full-serve paths only — never free-form Grok home.
   */
  resolveResourceUrl(url: string): string | null {
    const fsPath = appResourceUrlToFsPath(url);
    const result = resolveAppResourceServe({
      urlOrPath: url,
      fsPath,
      allowedRoots: this.allowedRoots,
      registry: this.registry,
    });
    return result.ok ? result.fsPath : null;
  }

  /**
   * Whether a path-shaped URL may be served (static full-serve only).
   * @deprecated Prefer {@link resolveResourceUrl}; kept for diagnostics.
   */
  isPathAllowed(fsPath: string): boolean {
    if (!this.allowedRoots.length) return false;
    return appResourceMayServeStaticPath(fsPath, this.allowedRoots);
  }

  /** Absolute roots currently registered (tests / diagnostics). */
  getAllowedRoots(): readonly string[] {
    return this.allowedRoots;
  }

  postMessage(message: unknown): Thenable<boolean> {
    const win = this.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return Promise.resolve(false);
    }
    win.webContents.send("host-to-webview", message);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(listener: (message: unknown) => unknown): HostDisposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Called from main when the renderer posts a webview message.
   * Schema-invalid / unknown types are dropped (never cast through).
   * Path-bearing ops pass through {@link authorizeDesktopWebviewMsg} with the
   * active session's roots (not merely the selected project folder).
   */
  dispatchMessage(message: unknown): void {
    const parsed = parseWebviewMsg(message);
    if (!parsed) {
      this.onDroppedMessage?.("invalid WebviewMsg", message);
      return;
    }
    const base = this.getAuthContext?.() ?? {
      workspaceRoot: this.getWorkspaceRoot?.(),
    };
    const auth = authorizeDesktopWebviewMsg(parsed, {
      ...base,
      requireDropFileHandle: true,
      resolveDropFileHandle: (id) => this.fileSelection.take(id),
    });
    if ("refused" in auth) {
      this.onDroppedMessage?.(
        `desktop policy refused ${auth.type}: ${auth.reason}`,
        message,
      );
      return;
    }
    for (const listener of this.listeners) {
      try {
        void listener(auth.msg);
      } catch {
        /* best-effort — sidebar wraps handlers itself */
      }
    }
  }

  asWebviewUri(uri: Uri): string {
    if (uri.scheme !== "file") {
      return asAppResourceUrl(uri);
    }
    const fsPath = path.normalize(uri.fsPath);
    // Static full-serve roots (extension media/resources, staging): path URL
    // with canonical containment at serve time.
    for (const root of this.allowedRoots) {
      if (rootServePolicy(root) !== "full") continue;
      if (appResourceMayServeStaticPath(fsPath, [root])) {
        return asAppResourceUrl(uri);
      }
    }
    // Everything else (Grok home media, unlisted paths the host still wants
    // to stream): opaque registry handle only — and only when provenance
    // allows (canonical target under an approved root).
    try {
      const id = this.registry.register(fsPath, {
        allowedRoots: this.allowedRoots,
      });
      return asAppResourceRegistryUrl(id);
    } catch {
      // File not yet on disk, unreadable, or outside approved roots — path
      // URL still refuses at serve time unless it lands under a full-serve root.
      return asAppResourceUrl(uri);
    }
  }
}

function injectTheme(html: string): string {
  const tag = `<style id="grok-desktop-theme">${DESKTOP_THEME_CSS}</style>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${tag}</head>`);
  }
  return tag + html;
}

/**
 * Desktop chrome boot: wrap #messages for scroll-edge fades and wire the
 * opacity ramp (port of AFK Pilot web/chat.html — shell-only, not chat.js).
 * Idempotent; safe after file-tree remounts that reparent #messages.
 */
export function desktopChromeBootSource(): string {
  return `(() => {
  const m = document.getElementById("messages");
  if (!m) return { ok: false, reason: "no messages" };

  let wrap = document.getElementById("messages-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "messages-wrap";
    const parent = m.parentElement;
    if (!parent) return { ok: false, reason: "no parent" };
    parent.insertBefore(wrap, m);
    wrap.appendChild(m);
  }
  if (!wrap.querySelector(".msg-fade-top")) {
    const top = document.createElement("div");
    top.className = "msg-fade msg-fade-top";
    top.setAttribute("aria-hidden", "true");
    const bot = document.createElement("div");
    bot.className = "msg-fade msg-fade-bot";
    bot.setAttribute("aria-hidden", "true");
    wrap.appendChild(top);
    wrap.appendChild(bot);
  }

  const FADE_RAMP = 16;
  function ramp(px) {
    const v = px / FADE_RAMP;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  let raf = 0;
  function apply() {
    raf = 0;
    const msg = document.getElementById("messages");
    const w = document.getElementById("messages-wrap");
    if (!msg || !w) return;
    w.style.setProperty("--fade-top-op", String(ramp(msg.scrollTop)));
    w.style.setProperty(
      "--fade-bot-op",
      String(ramp(msg.scrollHeight - msg.clientHeight - msg.scrollTop)),
    );
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(apply);
  }
  if (!m.dataset.deskFadeWired) {
    m.dataset.deskFadeWired = "1";
    m.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
  }
  apply();
  return { ok: true };
})()`;
}
