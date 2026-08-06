/**
 * HostWebview over Electron IPC + a custom `app-resource://` protocol.
 *
 * The sidebar sets `html` (built by `getHtml`) and never hand-writes a page.
 * Scripts/styles/media resolve through {@link asWebviewUri} → `app-resource://`.
 */
import type { BrowserWindow } from "electron";
import * as path from "node:path";
import type { HostDisposable, HostWebview, Uri } from "../host";
import { appResourceMayServe } from "./app-resource-policy";

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

/** Decode an app-resource URL back to an absolute filesystem path. */
export function appResourceUrlToFsPath(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${SCHEME}:` || parsed.hostname !== AUTHORITY) return undefined;
  let p = decodeURIComponent(parsed.pathname);
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
   * Whether the app-resource protocol may serve this absolute path.
   * Uses the webview's localResourceRoots, then narrows media-only roots
   * (Grok home) to generated session media — never auth.json / history.
   * @see appResourceMayServe
   */
  isPathAllowed(fsPath: string): boolean {
    if (!this.allowedRoots.length) return false;
    return appResourceMayServe(fsPath, this.allowedRoots);
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

  /** Called from main when the renderer posts a webview message. */
  dispatchMessage(message: unknown): void {
    for (const listener of this.listeners) {
      try {
        void listener(message);
      } catch {
        /* best-effort — sidebar wraps handlers itself */
      }
    }
  }

  asWebviewUri(uri: Uri): string {
    return asAppResourceUrl(uri);
  }
}

function injectTheme(html: string): string {
  const tag = `<style id="grok-desktop-theme">${DESKTOP_THEME_CSS}</style>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${tag}</head>`);
  }
  return tag + html;
}
