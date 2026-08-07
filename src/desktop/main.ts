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
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  shell,
  type Menu as ElectronMenu,
  type MenuItemConstructorOptions,
  type ProtocolRequest,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { GrokSidebar } from "../sidebar";
import { Uri } from "../host";
import type { HostContext, HostDisposable } from "../host";
import { ConfigStore, SensitiveConfigStore } from "./config-store";
import type { DesktopOpenFileContext } from "./desktop-policy";
import { createElectronHost, ensureWorkspaceRoot, type ElectronRemoteActions } from "./electron-host";
import {
  APP_RESOURCE_SCHEME,
  desktopChromeBootSource,
  ElectronWebview,
  isAppDocumentUrl,
} from "./electron-webview";
import {
  DESKTOP_APP_FULL_NAME,
  DESKTOP_APP_DISPLAY_NAME,
  DESKTOP_APP_SHORT_NAME,
  DESKTOP_PUBLIC_REPO_URL,
} from "./host-dialogs";
import { createFileMemento } from "./memento";
import {
  resolveDesktopProfileDir,
  resolveExtensionRoot,
  resolveUserDataDir,
} from "./paths";
import { createSafeStorageSecrets } from "./safe-secrets";
import {
  injectFileTreePanelLogged,
  registerFileTreeIpc,
} from "./file-tree-ipc";
import {
  installWindowSecurityLocks,
  isTrustedMainFrameIpc,
} from "./window-security";
import {
  DESKTOP_RELEASES_API_URL,
  DESKTOP_UPDATE_CHECK_INTERVAL_MS,
  desktopUpdatePageUrl,
  noticeIfUpdateAvailable,
  type GithubReleaseLike,
} from "./app-update";

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

// Name + userData MUST be set before anything resolves getPath("userData") —
// Electron otherwise parks the profile under the generic "Electron" folder.
// Tests pass --user-data-dir for isolation (skips branding/migration).
const earlyArgs = parseArgs(process.argv.slice(1));
try {
  app.setName(DESKTOP_APP_SHORT_NAME);
  // Windows groups taskbar buttons by AppUserModelID, and an unpackaged run
  // without one inherits electron.exe's identity — so the taskbar showed
  // Electron's atom whatever icon the window set. Installed builds were never
  // affected (their shortcut carries an ID), which is why this only ever looked
  // wrong while developing. Must match electron-builder.yml's appId, or a dev
  // run and the installed app would occupy separate taskbar buttons.
  app.setAppUserModelId("com.productcompass.grok-build-desktop");
} catch {
  /* app module edge cases in tests */
}
try {
  const { userData: ud, migratedFrom } = resolveDesktopProfileDir({
    appData: app.getPath("appData"),
    override: earlyArgs.userDataDir,
  });
  app.setPath("userData", ud);
  if (migratedFrom) {
    process.stdout.write(
      `[desktop] migrated profile from ${migratedFrom} → ${ud}\n`,
    );
  }
} catch {
  /* best-effort; createApp still resolves via resolveUserDataDir */
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

/**
 * Application menu: no stock Electron Help links; public repo only.
 * File → Add/Close Project Folder drive multi-folder (rail + config store).
 */
export function buildDesktopAppMenu(actions?: {
  addProjectFolder?: () => void;
  removeProjectFolder?: () => void;
}): ElectronMenu {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: DESKTOP_APP_FULL_NAME,
            submenu: [
              { role: "about" as const, label: `About ${DESKTOP_APP_FULL_NAME}` },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Add Project Folder…",
          click: () => {
            try {
              actions?.addProjectFolder?.();
            } catch {
              /* best-effort */
            }
          },
        },
        {
          label: "Close Project Folder",
          click: () => {
            try {
              actions?.removeProjectFolder?.();
            } catch {
              /* best-effort */
            }
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit", label: "Quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "GitHub Repository",
          click: () => {
            void shell.openExternal(DESKTOP_PUBLIC_REPO_URL);
          },
        },
        {
          label: `About ${DESKTOP_APP_FULL_NAME}`,
          click: () => {
            void shell.openExternal(DESKTOP_PUBLIC_REPO_URL);
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

let mainWindow: BrowserWindow | null = null;
let sidebar: GrokSidebar | null = null;
let webview: ElectronWebview | null = null;

// One process per profile: a second launch must focus the existing window, not
// spawn another sidebar / ACP pool / remote uplink on the same device token.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log("another instance already holds this profile; quitting");
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });
}

async function createApp(): Promise<void> {
  const args = earlyArgs;
  // Profile root = Electron userData (branded early above, or test override).
  const userData = resolveUserDataDir(args.userDataDir);
  fs.mkdirSync(userData, { recursive: true });

  const extensionRoot = resolveExtensionRoot();
  const pkg = readPackageMeta(extensionRoot);
  const configPath = path.join(userData, "config.json");
  // Construct first, then attach encryption — same production sequence tests pin.
  // Never delete a legacy plaintext credential when encrypt is unavailable.
  const config = new ConfigStore(configPath);
  try {
    config.setSensitiveStore(
      new SensitiveConfigStore(path.join(userData, "sensitive.enc.json"), safeStorage),
    );
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    log(`sensitive config store init FAILED: ${msg}`);
    // Leave the credential in config.json for a later run; surface loudly so a
    // swallowed catch cannot silently destroy it (round 12).
    dialog.showErrorBox(
      "Secure storage unavailable",
      "Could not encrypt stored credentials (for example the voice API key). " +
        "They remain in config.json until OS secure storage is available, and " +
        "will migrate automatically on the next successful start.\n\n" +
        msg,
    );
  }

  if (args.configJson && fs.existsSync(args.configJson)) {
    try {
      // Strip a UTF-8 BOM — PowerShell Set-Content -Encoding utf8 writes one on
      // Windows, and JSON.parse rejects it as an unexpected token.
      const raw = fs.readFileSync(args.configJson, "utf8").replace(/^\uFEFF/, "");
      const overrides = JSON.parse(raw) as Record<string, unknown>;
      // THIS RUN ONLY — deliberately not persisted. A throwaway grok.cliPath
      // used to survive into every later launch, leaving the app starting a
      // stub agent with nothing on screen to explain it.
      config.applySessionOverrides(overrides);
      log(`applied config overrides from ${args.configJson} (this run only)`);
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
  webview.getWorkspaceRoot = () => config.getWorkspaceRoot();
  webview.onDroppedMessage = (reason, raw) => {
    const t =
      raw && typeof raw === "object" && "type" in raw
        ? String((raw as { type: unknown }).type)
        : typeof raw;
    log(`dropped renderer message (${reason}): ${t}`);
  };

  // Registry + canonical static roots — never free-form ~/.grok path serve.
  // Narrow extra lane: exact APP_DOCUMENT_URL → in-memory HTML (real origin for
  // localStorage). Not a path serve; does not widen static/registry policy.
  protocol.handle(APP_RESOURCE_SCHEME, async (request: Request | ProtocolRequest) => {
    const url = typeof request === "object" && "url" in request ? request.url : String(request);
    if (!webview) {
      return new Response("Forbidden", { status: 403 });
    }
    if (isAppDocumentUrl(url)) {
      const html = webview.getDocumentHtml();
      if (!html) {
        return new Response("Document not ready", { status: 404 });
      }
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    const fsPath = webview.resolveResourceUrl(url);
    if (!fsPath) {
      log(`blocked resource: ${url}`);
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
  // Same auth context for message-gate (webview) and use-time openFsPath (host).
  const authContext: { get?: () => DesktopOpenFileContext } = {};
  const host = createElectronHost({
    config,
    getWindow: () => mainWindow,
    log,
    remoteActions,
    getAuthContext: () => authContext.get?.(),
    onWorkspaceRootChanged: (root) => {
      // File-tree panel boots once against api.root(); rebind so the visible
      // tree matches the active project (otherwise reads resolve against B
      // while rows still show A's layout).
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send("desk-ft:root-changed", { root });
      }
    },
  });

  sidebar = new GrokSidebar(hostContext, host);
  // Session-aware roots for openFile/openDiff (worktree cwd, not only the
  // selected project folder). Wired after sidebar exists.
  authContext.get = () => ({
    workspaceRoot: config.getWorkspaceRoot(),
    allowedRoots: sidebar!.desktopAuthRoots(),
  });
  webview.getAuthContext = () => authContext.get!();
  remoteActions.current = {
    link: () => sidebar!.linkRemoteDevice(),
    unlink: () => sidebar!.unlinkRemoteDevice(),
  };

  // Host-minted file-selection handles for genuine OS drops (preload only —
  // never exposed as a free-form path API to page script).
  ipcMain.handle("desk-file-sel:register", (event, rawPaths: unknown) => {
    if (!isTrustedMainFrameIpc(event, () => mainWindow)) {
      log("refused desk-file-sel:register from non-main sender/frame");
      return [] as string[];
    }
    if (!webview || !Array.isArray(rawPaths)) return [] as string[];
    const handles: string[] = [];
    for (const p of rawPaths) {
      if (typeof p !== "string" || !p.trim()) continue;
      try {
        handles.push(webview.fileSelection.register(p));
      } catch (e) {
        log(`file selection register failed: ${(e as Error).message}`);
      }
    }
    return handles;
  });

  // Full product name for About / OS app identity (short name was set early so
  // userData resolved under a branded folder). Window title uses short name.
  app.setName(DESKTOP_APP_FULL_NAME);
  Menu.setApplicationMenu(
    buildDesktopAppMenu({
      addProjectFolder: () => {
        void sidebar?.addProjectFolder();
      },
      removeProjectFolder: () => {
        void sidebar?.removeProjectFolder();
      },
    }),
  );

  // Round icon first — same one the installers use, so a dev run and an
  // installed build look identical in the taskbar and dock. Falls back to the
  // square marketplace icon if it is somehow missing.
  const roundIcon = path.join(extensionRoot, "resources", "grok-icon-round-512.png");
  const iconPath = fs.existsSync(roundIcon)
    ? roundIcon
    : path.join(extensionRoot, "resources", "grok-icon.png");
  const iconOpt = fs.existsSync(iconPath) ? iconPath : undefined;

  mainWindow = new BrowserWindow({
    // Wider default so chat + file tree both have room; collapse shrinks the panel.
    width: 720,
    height: 800,
    minWidth: 400,
    minHeight: 480,
    title: DESKTOP_APP_DISPLAY_NAME,
    // Match AFK Pilot dark page chrome; theme toggle may lighten the document.
    backgroundColor: "#1a1a1a",
    // Windows draws a light system menu strip over a dark app otherwise. Hide
    // it by default; Alt reveals the File/Edit/View/Help menus when needed.
    autoHideMenuBar: true,
    icon: iconOpt,
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

  installWindowSecurityLocks(mainWindow, {
    log,
    openExternal: (url) => shell.openExternal(url),
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  ipcMain.on("webview-to-host", (event, message: unknown) => {
    // Ambient authority: only the main BrowserWindow main frame may post.
    if (!isTrustedMainFrameIpc(event, () => mainWindow)) {
      log("refused webview-to-host from non-main sender/frame");
      return;
    }
    webview?.dispatchMessage(message);
  });

  // Open-folder set: restore prefs or one-shot discovery seed — never a folder
  // picker. Empty is valid (user adds via File → Add Project Folder).
  const workspace = ensureWorkspaceRoot(config, () => mainWindow, args.workspace);
  if (workspace) log(`workspace: ${workspace}`);
  else log("workspace: (none — empty project rail; use Add Project Folder)");
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
  // remounts without touching getHtml() / chat.js. Chrome fades run after the
  // panel so #messages is in its final parent.
  mainWindow.webContents.on("did-finish-load", () => {
    void (async () => {
      await injectFileTreePanelLogged(mainWindow, log);
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
      try {
        await mainWindow.webContents.executeJavaScript(desktopChromeBootSource(), true);
      } catch (e) {
        log(`[desk-chrome] inject failed: ${(e as Error).message}`);
      }
    })();
  });

  sidebar.resolveWebviewView({
    webview,
    show() {
      mainWindow?.show();
    },
  });

  // Update *notice* only — no auto-download. Failure is silence (offline,
  // rate-limit, malformed). Re-check every 12h while the app stays open.
  // In-memory only — no disk; re-post on reload so the rail button survives
  // a document refresh without another network round-trip.
  const appVersion = app.getVersion() || pkg.version;
  let pendingUpdate: { version: string; url: string } | null = null;
  const postUpdateNotice = (version: string, url: string): void => {
    pendingUpdate = { version, url };
    if (!webview) return;
    void webview.postMessage({ type: "updateAvailable", version, url });
  };
  const checkForDesktopUpdate = async (): Promise<void> => {
    try {
      const res = await net.fetch(DESKTOP_RELEASES_API_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Grok-Build-Desktop/${appVersion}`,
        },
      });
      if (!res.ok) return;
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return;
      const notice = noticeIfUpdateAvailable(
        appVersion,
        body as GithubReleaseLike[],
      );
      // The notice's own url is the GitHub release page. Send people to the
      // update page instead — same release, one button, no .blockmap files.
      if (notice) postUpdateNotice(notice.version, desktopUpdatePageUrl(appVersion));
    } catch {
      /* offline / parse / network — stay silent */
    }
  };
  // After first paint so a slow API never races the webview boot.
  setTimeout(() => {
    void checkForDesktopUpdate();
  }, 4_000);
  setInterval(() => {
    void checkForDesktopUpdate();
  }, DESKTOP_UPDATE_CHECK_INTERVAL_MS);
  // Re-deliver an already-known notice after inject (reload wipes the button).
  mainWindow.webContents.on("did-finish-load", () => {
    if (!pendingUpdate) return;
    const n = pendingUpdate;
    setTimeout(() => {
      if (pendingUpdate) postUpdateNotice(n.version, n.url);
    }, 500);
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

if (gotSingleInstanceLock) {
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
}
