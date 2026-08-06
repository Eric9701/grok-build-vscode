/**
 * Electron main process — constructs GrokSidebar with an Electron Host so the
 * same agent runs with no VS Code present.
 *
 * Launch: `npm run desktop` → `electron out/desktop/main.js`
 *
 * Test harness flags (also accepted as env):
 *   --workspace=<path>     skip folder picker
 *   --user-data-dir=<path>  isolated prefs / memento
 *   --config-json=<path>    merge dotted config overrides from a JSON file
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  safeStorage,
  type ProtocolRequest,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { GrokSidebar } from "../sidebar";
import { Uri } from "../host";
import type { HostContext, HostDisposable } from "../host";
import { ConfigStore } from "./config-store";
import { createElectronHost, ensureWorkspaceRoot, type ElectronRemoteActions } from "./electron-host";
import {
  APP_RESOURCE_SCHEME,
  appResourceUrlToFsPath,
  ElectronWebview,
} from "./electron-webview";
import { createFileMemento } from "./memento";
import { resolveExtensionRoot, resolveUserDataDir } from "./paths";
import { createSafeStorageSecrets } from "./safe-secrets";
import {
  injectFileTreePanelLogged,
  registerFileTreeIpc,
} from "./file-tree-ipc";

// Electron dies with launch-failed if sandbox is left at the platform default
// in some setups; we set it explicitly on the BrowserWindow. Also strip the
// env that makes `electron` run as plain Node (breaks BrowserWindow entirely).
delete process.env.ELECTRON_RUN_AS_NODE;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_RESOURCE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

function parseArgs(argv: string[]): {
  workspace?: string;
  userDataDir?: string;
  configJson?: string;
} {
  const out: { workspace?: string; userDataDir?: string; configJson?: string } = {};
  for (const a of argv) {
    if (a.startsWith("--workspace=")) out.workspace = a.slice("--workspace=".length);
    else if (a.startsWith("--user-data-dir=")) out.userDataDir = a.slice("--user-data-dir=".length);
    else if (a.startsWith("--config-json=")) out.configJson = a.slice("--config-json=".length);
  }
  if (!out.workspace && process.env.GROK_DESKTOP_WORKSPACE) {
    out.workspace = process.env.GROK_DESKTOP_WORKSPACE;
  }
  if (!out.userDataDir && process.env.GROK_DESKTOP_USER_DATA) {
    out.userDataDir = process.env.GROK_DESKTOP_USER_DATA;
  }
  if (!out.configJson && process.env.GROK_DESKTOP_CONFIG_JSON) {
    out.configJson = process.env.GROK_DESKTOP_CONFIG_JSON;
  }
  return out;
}

// userData must be set before ready — tests pass --user-data-dir for isolation.
const earlyArgs = parseArgs(process.argv.slice(1));
if (earlyArgs.userDataDir) {
  try {
    const ud = path.resolve(earlyArgs.userDataDir);
    fs.mkdirSync(ud, { recursive: true });
    app.setPath("userData", ud);
  } catch {
    /* best-effort; createApp will still use the path for our JSON stores */
  }
}

function readPackageMeta(extensionRoot: string): { version: string; id: string } {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"),
    ) as { version?: string; publisher?: string; name?: string };
    return {
      version: pkg.version ?? "0.0.0",
      id: `${pkg.publisher ?? "PawelHuryn"}.${pkg.name ?? "grok-vscode-phuryn"}`,
    };
  } catch {
    return { version: "0.0.0", id: "PawelHuryn.grok-vscode-phuryn" };
  }
}

function log(line: string): void {
  const stamp = new Date().toISOString();
  process.stdout.write(`[desktop ${stamp}] ${line}\n`);
}

let mainWindow: BrowserWindow | null = null;
let sidebar: GrokSidebar | null = null;
let webview: ElectronWebview | null = null;

async function createApp(): Promise<void> {
  const args = earlyArgs;
  // Our prefs/memento live under userData/grok-desktop (or the override root
  // itself when tests pass --user-data-dir, so everything is self-contained).
  const userData = args.userDataDir
    ? path.resolve(args.userDataDir)
    : resolveUserDataDir();
  fs.mkdirSync(userData, { recursive: true });

  const extensionRoot = resolveExtensionRoot();
  const pkg = readPackageMeta(extensionRoot);
  const configPath = path.join(userData, "config.json");
  const config = new ConfigStore(configPath);

  if (args.configJson && fs.existsSync(args.configJson)) {
    try {
      // Strip a UTF-8 BOM — PowerShell Set-Content -Encoding utf8 writes one on
      // Windows, and JSON.parse rejects it as an unexpected token.
      const raw = fs.readFileSync(args.configJson, "utf8").replace(/^\uFEFF/, "");
      const overrides = JSON.parse(raw) as Record<string, unknown>;
      config.applyOverrides(overrides);
      log(`applied config overrides from ${args.configJson}`);
    } catch (e) {
      log(`failed to read config-json: ${(e as Error).message}`);
    }
  }

  const globalStorageDir = path.join(userData, "globalStorage");
  fs.mkdirSync(globalStorageDir, { recursive: true });

  const subscriptions: HostDisposable[] = [];
  // Device token is a credential: encrypt with OS keychain via safeStorage.
  // Ciphertext file only — never plaintext next to config. Encryption-unavailable
  // fails on store/get (createSafeStorageSecrets), never silent fallback.
  const hostContext: HostContext = {
    secrets: createSafeStorageSecrets(
      path.join(userData, "secrets.enc.json"),
      safeStorage,
    ),
    globalStorageUri: Uri.file(globalStorageDir),
    extensionUri: Uri.file(extensionRoot),
    extensionId: pkg.id,
    extensionVersion: pkg.version,
    isProduction: app.isPackaged,
    globalState: createFileMemento(path.join(userData, "globalState.json")),
    subscriptions: {
      push(...items: HostDisposable[]) {
        subscriptions.push(...items);
      },
    },
  };

  webview = new ElectronWebview(() => mainWindow);

  protocol.handle(APP_RESOURCE_SCHEME, async (request: Request | ProtocolRequest) => {
    const url = typeof request === "object" && "url" in request ? request.url : String(request);
    const fsPath = appResourceUrlToFsPath(url);
    if (!fsPath) {
      return new Response("Bad request", { status: 400 });
    }
    if (webview && !webview.isPathAllowed(fsPath)) {
      log(`blocked resource outside roots: ${fsPath}`);
      return new Response("Forbidden", { status: 403 });
    }
    try {
      return await net.fetch(pathToFileURL(fsPath).href);
    } catch (e) {
      log(`resource fetch failed ${fsPath}: ${(e as Error).message}`);
      return new Response("Not found", { status: 404 });
    }
  });

  // Bound after GrokSidebar exists so link/unlink reuse the extension flow.
  const remoteActions: { current?: ElectronRemoteActions } = {};
  const host = createElectronHost({
    config,
    getWindow: () => mainWindow,
    log,
    remoteActions,
  });

  sidebar = new GrokSidebar(hostContext, host);
  remoteActions.current = {
    link: () => sidebar!.linkRemoteDevice(),
    unlink: () => sidebar!.unlinkRemoteDevice(),
  };

  mainWindow = new BrowserWindow({
    // Wider default so chat + file tree both have room; collapse shrinks the panel.
    width: 720,
    height: 800,
    minWidth: 400,
    minHeight: 480,
    title: "Grok Build",
    backgroundColor: "#252526",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Required: without an explicit false, some Electron builds fail with
      // launch-failed before any page code runs (spike-confirmed).
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  ipcMain.on("webview-to-host", (event, message: unknown) => {
    // Ambient authority: only the main BrowserWindow may post host messages.
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
      log("refused webview-to-host from non-main sender");
      return;
    }
    webview?.dispatchMessage(message);
  });

  // Workspace must be set before the sidebar starts a session (ready → startSession).
  const workspace = await ensureWorkspaceRoot(config, () => mainWindow, args.workspace);
  if (!workspace) {
    log("no workspace selected — quitting");
    app.quit();
    return;
  }
  log(`workspace: ${workspace}`);
  log(`extension root: ${extensionRoot}`);
  log(`cliPath config: ${String(config.getValue("grok.cliPath") || "(auto)")}`);

  // Desktop-only file tree — dedicated IPC, not Host / chat.js.
  registerFileTreeIpc({
    getWorkspaceRoot: () => config.getWorkspaceRoot(),
    getMainWindow: () => mainWindow,
    log,
    openSinkPath: process.env.GROK_DESKTOP_OPEN_SINK,
  });

  // Inject after every document load (initial + renderer reload) so the panel
  // remounts without touching getHtml() / chat.js.
  mainWindow.webContents.on("did-finish-load", () => {
    void injectFileTreePanelLogged(mainWindow, log);
  });

  sidebar.resolveWebviewView({
    webview,
    show() {
      mainWindow?.show();
    },
  });

  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      // 0=debug,1=info,2=warning,3=error
      log(`[renderer${level >= 3 ? " error" : " warn"}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log(`did-fail-load ${code} ${desc} url=${url}`);
  });
}

app.whenReady().then(() => {
  void createApp().catch((e) => {
    log(`startup failed: ${(e as Error).stack ?? e}`);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  sidebar?.dispose();
  app.quit();
});

app.on("before-quit", () => {
  try {
    sidebar?.dispose();
  } catch {
    /* best-effort */
  }
});
