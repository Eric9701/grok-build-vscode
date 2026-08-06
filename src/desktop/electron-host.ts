/**
 * Electron implementation of the portable {@link Host} interface.
 *
 * File open: hands the real path to the OS default handler (`shell.openPath`).
 * Diff / untitled text: read-only internal BrowserWindows (not full editors).
 * AFK Pilot link/unlink: delegates to sidebar handlers wired after construction.
 * Device credentials: never stored by this module (see main.ts + safe-secrets).
 */
import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type {
  Host,
  HostCancellationToken,
  HostDisposable,
  HostFileSystem,
  HostFileSystemWatcher,
  HostInputBoxOptions,
  HostMessageOptions,
  HostOpenDialogOptions,
  HostProgressOptions,
  HostQuickPickItem,
  HostQuickPickOptions,
  HostSaveDialogOptions,
  HostTerminal,
  HostTerminalOptions,
  HostTextDocumentContentProvider,
  HostTextEditor,
  HostTextShowOptions,
  Uri,
} from "../host";
import { isFsPathInWorkspace } from "../host";
import type { ConfigStore } from "./config-store";
import { authorizeOpenUrl } from "./desktop-policy";
import {
  buildDiffViewerHtml,
  buildTextViewerHtml,
  interpretOpenPathResult,
  resolveDocumentText,
} from "./document-view";
import { nearestExistingAncestor } from "./file-tree";
import {
  planOpenCliInTerminal,
  planRunCommandInTerminal,
  type ExternalTerminalPlan,
} from "./external-terminal";
import { findFilesUnder } from "./find-files";
import {
  buildInputBoxHtml,
  buildQuickPickHtml,
  DESKTOP_APP_SHORT_NAME,
  parseDialogSubmit,
  selectQuickPickIndex,
} from "./host-dialogs";
import { installWindowSecurityLocks } from "./window-security";

function splitMessageArgs(
  items: Array<string | HostMessageOptions>,
): { options?: HostMessageOptions; buttons: string[] } {
  if (items.length > 0 && typeof items[0] === "object" && items[0] !== null) {
    return { options: items[0] as HostMessageOptions, buttons: items.slice(1) as string[] };
  }
  return { buttons: items as string[] };
}

function parentWindow(getWindow: () => BrowserWindow | null): BrowserWindow | undefined {
  const w = getWindow();
  return w && !w.isDestroyed() ? w : undefined;
}

async function messageBox(
  getWindow: () => BrowserWindow | null,
  kind: "info" | "warning" | "error",
  message: string,
  buttons: string[],
  modal?: boolean,
): Promise<string | undefined> {
  void modal;
  const opts = {
    type: kind === "info" ? ("info" as const) : kind === "warning" ? ("warning" as const) : ("error" as const),
    message,
    buttons: buttons.length ? buttons : ["OK"],
    defaultId: 0,
    cancelId: buttons.length ? buttons.length - 1 : 0,
    noLink: true,
  };
  const win = parentWindow(getWindow);
  const result = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  if (!buttons.length) return undefined;
  return buttons[result.response];
}

const hostFs: HostFileSystem = {
  async readFile(uri) {
    return fs.promises.readFile(uri.fsPath);
  },
  async writeFile(uri, content) {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  },
  async createDirectory(uri) {
    await fs.promises.mkdir(uri.fsPath, { recursive: true });
  },
  async delete(uri, options) {
    await fs.promises.rm(uri.fsPath, {
      recursive: options?.recursive ?? false,
      force: true,
    });
  },
  async stat(uri) {
    const s = await fs.promises.stat(uri.fsPath);
    // VS Code FileType: File=1, Directory=2, SymbolicLink=64
    let type = s.isFile() ? 1 : s.isDirectory() ? 2 : 0;
    if (s.isSymbolicLink()) type |= 64;
    return {
      type,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    };
  },
};

export interface ElectronRemoteActions {
  link: () => Promise<void>;
  unlink: () => Promise<void>;
}

export interface ElectronHostOptions {
  config: ConfigStore;
  getWindow: () => BrowserWindow | null;
  log: (line: string) => void;
  /**
   * AFK Pilot link/unlink — filled after GrokSidebar is constructed so the host
   * reuses the extension's uplink flow (no protocol reimplementation).
   */
  remoteActions?: { current?: ElectronRemoteActions };
  /** Called when the active workspace folder changes (switch / add-as-active). */
  onWorkspaceRootChanged?: (root: string) => void;
  /** Called when the open-folder list changes (add / remove / first open). */
  onWorkspaceFoldersChanged?: (roots: string[], active: string | undefined) => void;
}

function openHtmlDocumentWindow(
  getWindow: () => BrowserWindow | null,
  title: string,
  html: string,
): BrowserWindow {
  const parent = parentWindow(getWindow);
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 400,
    minHeight: 300,
    title,
    parent: parent ?? undefined,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installWindowSecurityLocks(win, {
    log: () => {},
    openExternal: (url) => {
      void shell.openExternal(url);
    },
  });
  // base64 data URL avoids encodeURIComponent length blow-ups for mid-size diffs.
  const dataUrl = "data:text/html;base64," + Buffer.from(html, "utf8").toString("base64");
  void win.loadURL(dataUrl);
  return win;
}

/**
 * Modal HTML dialog window that returns a single IPC payload (or null on cancel).
 * Used for quick pick (any size) and text input — not native message-box caps.
 */
function showHtmlDialog(
  getWindow: () => BrowserWindow | null,
  title: string,
  html: string,
  size: { width: number; height: number },
): Promise<unknown> {
  return new Promise((resolve) => {
    const parent = parentWindow(getWindow);
    const dialogPreload = path.join(__dirname, "dialog-preload.js");
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      minWidth: 320,
      minHeight: 200,
      title,
      parent: parent ?? undefined,
      modal: !!parent,
      show: true,
      backgroundColor: "#252526",
      autoHideMenuBar: true,
      webPreferences: {
        preload: dialogPreload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    installWindowSecurityLocks(win, {
      log: () => {},
      openExternal: (url) => {
        void shell.openExternal(url);
      },
    });
    win.setMenuBarVisibility(false);

    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("desk-dialog-result", onResult);
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        /* best-effort */
      }
      resolve(value);
    };

    const onResult = (event: IpcMainEvent, payload: unknown) => {
      if (event.sender.id !== win.webContents.id) return;
      finish(payload);
    };
    ipcMain.on("desk-dialog-result", onResult);
    win.on("closed", () => finish(null));

    const dataUrl = "data:text/html;base64," + Buffer.from(html, "utf8").toString("base64");
    void win.loadURL(dataUrl);
  });
}

/**
 * Watch `base/pattern` for create/change/delete.
 *
 * Supervises the directory chain rather than binding once: when `base` is
 * missing, walks to the nearest existing ancestor and rebinds as segments
 * appear; when `base` is deleted and recreated, re-attaches without restart.
 */
export function createBoundFileSystemWatcher(
  base: string,
  pattern: string,
  log: (line: string) => void,
): HostFileSystemWatcher {
  const watchPath = path.join(base, pattern.includes("*") ? "" : pattern);
  const target = pattern.includes("*") ? base : watchPath;
  const createListeners = new Set<() => void>();
  const changeListeners = new Set<() => void>();
  const deleteListeners = new Set<() => void>();
  let disposed = false;
  let baseWatcher: fs.FSWatcher | undefined;
  /** Watches the nearest existing ancestor while base (or mid-path) is missing. */
  let chainWatcher: fs.FSWatcher | undefined;
  let chainWatchPath: string | undefined;
  let rebindTimer: ReturnType<typeof setTimeout> | undefined;

  const matches = (filename: string | null): boolean => {
    if (!pattern || pattern.includes("*")) return true;
    if (!filename) return true;
    return filename === pattern || filename === path.basename(pattern);
  };

  const clearWatchers = () => {
    try {
      baseWatcher?.close();
    } catch {
      /* */
    }
    try {
      chainWatcher?.close();
    } catch {
      /* */
    }
    baseWatcher = undefined;
    chainWatcher = undefined;
    chainWatchPath = undefined;
  };

  const scheduleRebind = () => {
    if (disposed) return;
    if (rebindTimer) clearTimeout(rebindTimer);
    // Coalesce bursty rename events while a tree is being recreated.
    rebindTimer = setTimeout(() => {
      rebindTimer = undefined;
      tryStart();
    }, 50);
  };

  const emitForEvent = (event: string, filename: string | null, watchTarget: string) => {
    const full = filename ? path.join(watchTarget, filename.toString()) : target;
    if (event === "rename") {
      try {
        if (fs.existsSync(full)) {
          for (const l of createListeners) l();
          for (const l of changeListeners) l();
        } else {
          for (const l of deleteListeners) l();
        }
      } catch {
        for (const l of changeListeners) l();
      }
      // Base itself may have been deleted — re-supervise the chain.
      if (!fs.existsSync(base)) {
        scheduleRebind();
      }
      return;
    }
    for (const l of changeListeners) l();
  };

  const bindBaseWatcher = () => {
    if (disposed) return;
    try {
      baseWatcher?.close();
    } catch {
      /* */
    }
    baseWatcher = undefined;
    try {
      baseWatcher = fs.watch(base, (event, filename) => {
        if (disposed) return;
        // If base vanished, fall back to chain supervision.
        if (!fs.existsSync(base)) {
          scheduleRebind();
          return;
        }
        if (filename && !matches(filename.toString())) return;
        emitForEvent(event, filename ? filename.toString() : null, base);
      });
      baseWatcher.on?.("error", () => {
        scheduleRebind();
      });
    } catch (e) {
      log(`[desktop] fs.watch failed: ${(e as Error).message}`);
      scheduleRebind();
    }
  };

  const bindChainWatcher = (watchDir: string) => {
    if (disposed) return;
    if (chainWatchPath === watchDir && chainWatcher) return;
    try {
      chainWatcher?.close();
    } catch {
      /* */
    }
    chainWatcher = undefined;
    chainWatchPath = watchDir;
    try {
      chainWatcher = fs.watch(watchDir, () => {
        if (disposed) return;
        scheduleRebind();
      });
      chainWatcher.on?.("error", () => {
        scheduleRebind();
      });
    } catch (e) {
      log(`[desktop] fs.watch chain failed on ${watchDir}: ${(e as Error).message}`);
    }
  };

  const tryStart = () => {
    if (disposed) return;
    if (fs.existsSync(base)) {
      // Base is live — drop chain watcher, bind the directory itself.
      try {
        chainWatcher?.close();
      } catch {
        /* */
      }
      chainWatcher = undefined;
      chainWatchPath = undefined;
      bindBaseWatcher();
      // If auth.json already exists when we first bind, fire create so voice
      // config refreshes without waiting for a later change event.
      if (!pattern.includes("*") && fs.existsSync(target)) {
        for (const l of createListeners) l();
      }
      return;
    }
    // Base missing: watch nearest existing ancestor so recreation is visible
    // even when intermediate parents were also removed (custom GROK_HOME, wipe).
    try {
      baseWatcher?.close();
    } catch {
      /* */
    }
    baseWatcher = undefined;
    const ancestor = nearestExistingAncestor(path.dirname(base));
    if (!ancestor) {
      log(`[desktop] fs.watch: no existing ancestor for ${base}`);
      return;
    }
    bindChainWatcher(ancestor);
  };

  tryStart();

  return {
    onDidCreate(listener) {
      createListeners.add(listener);
      return { dispose: () => createListeners.delete(listener) };
    },
    onDidChange(listener) {
      changeListeners.add(listener);
      return { dispose: () => changeListeners.delete(listener) };
    },
    onDidDelete(listener) {
      deleteListeners.add(listener);
      return { dispose: () => deleteListeners.delete(listener) };
    },
    dispose() {
      disposed = true;
      if (rebindTimer) {
        clearTimeout(rebindTimer);
        rebindTimer = undefined;
      }
      clearWatchers();
    },
  };
}

export function createElectronHost(opts: ElectronHostOptions): Host {
  const { config, getWindow, log, remoteActions, onWorkspaceRootChanged, onWorkspaceFoldersChanged } =
    opts;
  const configListeners = config; // store owns change events
  let activeEditor: HostTextEditor | undefined;

  const notifyFolders = (prevActive: string | undefined) => {
    const roots = config.getWorkspaceRoots();
    const active = config.getWorkspaceRoot();
    try {
      onWorkspaceFoldersChanged?.(roots, active);
    } catch {
      /* best-effort */
    }
    if (active && prevActive !== active) {
      try {
        onWorkspaceRootChanged?.(active);
      } catch {
        /* best-effort */
      }
    }
  };
  const editorListeners = new Set<() => void>();
  const selectionListeners = new Set<() => void>();
  const contentProviders = new Map<string, HostTextDocumentContentProvider>();

  const notYet = (feature: string) => {
    log(`[desktop] ${feature}: not available yet`);
    return messageBox(getWindow, "info", `${feature} is not available in the desktop app yet.`, ["OK"]);
  };

  async function openFsPath(fsPath: string): Promise<void> {
    const err = await shell.openPath(fsPath);
    const result = interpretOpenPathResult(err);
    if (!result.ok) {
      log(`[desktop] openPath failed: ${result.error}`);
      await messageBox(
        getWindow,
        "error",
        `Could not open file:\n${fsPath}\n\n${result.error}`,
        ["OK"],
      );
    }
  }

  return {
    showInformationMessage(message, ...items) {
      const buttons = items as string[];
      return messageBox(getWindow, "info", message, buttons);
    },
    showWarningMessage(message, ...items) {
      const { options, buttons } = splitMessageArgs(items);
      return messageBox(getWindow, "warning", message, buttons, options?.modal);
    },
    showErrorMessage(message, ...items) {
      const { options, buttons } = splitMessageArgs(items);
      return messageBox(getWindow, "error", message, buttons, options?.modal);
    },

    async showQuickPick<T extends HostQuickPickItem>(
      items: readonly T[],
      options?: HostQuickPickOptions,
    ): Promise<T | undefined> {
      if (!items.length) return undefined;
      // In-app HTML list scales past the native message-box button cap (model
      // selection is routinely 10–20 items).
      const html = buildQuickPickHtml({
        title: options?.title ?? "Choose",
        placeHolder: options?.placeHolder ?? "Select an item",
        items: items.map((it) => ({
          label: it.label,
          description: it.description,
          detail: it.detail,
        })),
      });
      const height = Math.min(640, 160 + items.length * 44);
      const raw = await showHtmlDialog(getWindow, options?.title ?? "Choose", html, {
        width: 480,
        height: Math.max(280, height),
      });
      if (raw === null || raw === undefined) return undefined;
      const parsed = parseDialogSubmit(raw);
      if (!parsed || parsed.kind !== "quickpick") return undefined;
      return selectQuickPickIndex(items, parsed.index);
    },

    async showInputBox(options?: HostInputBoxOptions): Promise<string | undefined> {
      const html = buildInputBoxHtml({
        title: options?.title ?? "Input",
        prompt: options?.prompt,
        placeHolder: options?.placeHolder,
        value: options?.value,
        password: options?.password,
      });
      const raw = await showHtmlDialog(
        getWindow,
        options?.title ?? "Input",
        html,
        { width: 440, height: 220 },
      );
      if (raw === null || raw === undefined) return undefined;
      const parsed = parseDialogSubmit(raw);
      if (!parsed || parsed.kind !== "input") return undefined;
      return parsed.value;
    },

    async showOpenDialog(options?: HostOpenDialogOptions): Promise<string[] | undefined> {
      const props: OpenDialogOptions["properties"] = [];
      const wantFiles = options?.canSelectFiles === true
        || (options?.canSelectFiles !== false && !options?.canSelectFolders);
      const wantFolders = options?.canSelectFolders === true;
      if (wantFiles) props.push("openFile");
      if (wantFolders) props.push("openDirectory");
      if (!props.length) props.push("openFile");
      if (options?.canSelectMany) props.push("multiSelections");

      const filters = options?.filters
        ? Object.entries(options.filters).map(([name, exts]) => ({
            name,
            extensions: exts.map((e) => e.replace(/^\./, "")),
          }))
        : undefined;

      const win = parentWindow(getWindow);
      const result = win
        ? await dialog.showOpenDialog(win, {
            properties: props,
            defaultPath: options?.defaultPath,
            buttonLabel: options?.openLabel,
            filters,
          })
        : await dialog.showOpenDialog({
            properties: props,
            defaultPath: options?.defaultPath,
            buttonLabel: options?.openLabel,
            filters,
          });
      if (result.canceled || !result.filePaths.length) return undefined;
      return result.filePaths;
    },

    async showSaveDialog(options?: HostSaveDialogOptions): Promise<string | undefined> {
      const filters = options?.filters
        ? Object.entries(options.filters).map(([name, exts]) => ({
            name,
            extensions: exts.map((e) => e.replace(/^\./, "")),
          }))
        : undefined;
      const win = parentWindow(getWindow);
      const result = win
        ? await dialog.showSaveDialog(win, {
            defaultPath: options?.defaultPath,
            buttonLabel: options?.saveLabel,
            title: options?.title,
            filters,
          })
        : await dialog.showSaveDialog({
            defaultPath: options?.defaultPath,
            buttonLabel: options?.saveLabel,
            title: options?.title,
            filters,
          });
      if (result.canceled || !result.filePath) return undefined;
      return result.filePath;
    },

    getConfiguration(section?: string, resourcePath?: string) {
      return config.getConfiguration(section, resourcePath);
    },

    async openExternal(url: string) {
      // Defense in depth: chat openUrl is gated in ElectronWebview, but any
      // other Host caller must not launch arbitrary schemes either.
      const auth = authorizeOpenUrl(url);
      if (!auth.ok) {
        log(`[desktop] openExternal refused: ${auth.reason} (${url})`);
        return false;
      }
      await shell.openExternal(url);
      return true;
    },

    async openSettings(section?: string) {
      const msg = section
        ? `Settings UI is not available yet.\n\nEdit config.json in the app data folder (key: ${section}).`
        : "Settings UI is not available yet.\n\nEdit config.json in the app data folder.";
      await messageBox(getWindow, "info", msg, ["OK"]);
    },

    async linkRemote() {
      const actions = remoteActions?.current;
      if (!actions?.link) {
        await notYet("AFK Pilot device linking");
        return;
      }
      await actions.link();
    },
    async unlinkRemote() {
      const actions = remoteActions?.current;
      if (!actions?.unlink) {
        await notYet("AFK Pilot device unlinking");
        return;
      }
      await actions.unlink();
    },

    createTerminal(nameOrOptions: string | HostTerminalOptions): HostTerminal {
      const name = typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions.name;
      const opts = typeof nameOrOptions === "string" ? undefined : nameOrOptions;
      const cwd = opts?.cwd || config.getWorkspaceRoot() || process.cwd();

      const runPlan = (plan: ExternalTerminalPlan): void => {
        if (plan.kind === "unsupported") {
          log(`[desktop] createTerminal("${name}"): ${plan.reason}`);
          void messageBox(
            getWindow,
            "error",
            `Could not open a terminal for "${name}":\n${plan.reason}`,
            ["OK"],
          );
          return;
        }
        try {
          log(`[desktop] terminal: ${plan.label}`);
          const child = spawn(plan.command, plan.args, {
            cwd: plan.cwd,
            detached: true,
            stdio: "ignore",
            shell: plan.shell,
            windowsHide: false,
          });
          // Async spawn failures (ENOENT, etc.) escape try/catch — surface them.
          child.on("error", (e) => {
            const msg = e.message;
            log(`[desktop] createTerminal spawn failed: ${msg}`);
            void messageBox(
              getWindow,
              "error",
              `Could not open a terminal for "${name}":\n${msg}`,
              ["OK"],
            );
          });
          child.unref();
        } catch (e) {
          const msg = (e as Error).message;
          log(`[desktop] createTerminal spawn failed: ${msg}`);
          void messageBox(
            getWindow,
            "error",
            `Could not open a terminal for "${name}":\n${msg}`,
            ["OK"],
          );
        }
      };

      // Login / logout / MCP: open a *visible* OS terminal running the CLI.
      // Windows .cmd shims need shell interpretation — planOpenCliInTerminal
      // routes them through `cmd /c start` (not a silent shell:false spawn).
      if (opts?.shellPath) {
        runPlan(planOpenCliInTerminal(name, opts.shellPath, opts.shellArgs ?? [], cwd));
      }

      return {
        show() {},
        sendText(text: string) {
          // Install Grok and other typed commands — open a visible terminal.
          runPlan(planRunCommandInTerminal(name, text, cwd));
        },
        dispose() {},
      };
    },

    async withProgress<T>(
      options: HostProgressOptions,
      task: (cancellationToken: HostCancellationToken) => Thenable<T>,
    ): Promise<T> {
      log(`[desktop] progress: ${options.title}`);
      const token: HostCancellationToken = { isCancellationRequested: false };
      return task(token);
    },

    append(text: string) {
      process.stdout.write(text);
    },
    appendLine(line: string) {
      log(line);
    },
    showOutput(_preserveFocus?: boolean) {
      // Desktop logs to stdout; nothing to show.
    },

    fs: hostFs,

    workspaceRoot() {
      return config.getWorkspaceRoot();
    },
    workspaceFolders() {
      return config.getWorkspaceRoots();
    },
    setActiveWorkspaceFolder(cwd: string) {
      const prev = config.getWorkspaceRoot();
      if (!config.setActiveWorkspaceRoot(cwd)) return;
      notifyFolders(prev);
    },
    addWorkspaceFolder(cwd: string) {
      const prev = config.getWorkspaceRoot();
      if (!config.addWorkspaceRoot(cwd, true)) return false;
      notifyFolders(prev);
      return true;
    },
    removeWorkspaceFolder(cwd: string) {
      const prev = config.getWorkspaceRoot();
      if (!config.removeWorkspaceRoot(cwd)) return false;
      notifyFolders(prev);
      return true;
    },
    asRelativePath(uri: Uri) {
      // Prefer the active root; fall through to any open folder so multi-folder
      // paths still relative-ize correctly.
      const roots = config.getWorkspaceRoots();
      if (!roots.length || uri.scheme !== "file") return uri.fsPath;
      const active = config.getWorkspaceRoot();
      const ordered = active
        ? [active, ...roots.filter((r) => path.resolve(r) !== path.resolve(active))]
        : roots;
      for (const root of ordered) {
        const rel = path.relative(root, uri.fsPath);
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
      }
      return uri.fsPath;
    },
    async findFiles(include, exclude?, maxResults?) {
      const root = config.getWorkspaceRoot();
      if (!root) return [];
      if (typeof include === "string") {
        return findFilesUnder(root, exclude, maxResults);
      }
      return findFilesUnder(include.base || root, exclude, maxResults);
    },
    isInWorkspace(fsPath: string) {
      const roots = config.getWorkspaceRoots();
      if (!roots.length) return false;
      return isFsPathInWorkspace(fsPath, roots);
    },

    getActiveTextEditor() {
      return activeEditor;
    },
    async openTextFile(fsPath: string, options?: HostTextShowOptions) {
      // Open the user's real file via the OS. Line selection is not supported
      // (we are not an editor) — still open the path so the user can navigate.
      if (options?.selection) {
        log(
          `[desktop] openTextFile: line selection not supported; opening ${path.basename(fsPath)} in the OS default app`,
        );
      }
      await openFsPath(fsPath);
    },
    async openResource(target: string | Uri, _options?: HostTextShowOptions) {
      const fsPath = typeof target === "string"
        ? target
        : target.scheme === "file"
          ? target.fsPath
          : undefined;
      if (fsPath) {
        await openFsPath(fsPath);
        return;
      }
      // Virtual URI (e.g. content provider): show read-only text window.
      if (typeof target !== "string") {
        try {
          const text = resolveDocumentText(target, contentProviders, (p) =>
            fs.readFileSync(p, "utf8"),
          );
          const title = path.basename(target.path) || target.toString();
          openHtmlDocumentWindow(getWindow, title, buildTextViewerHtml(title, text));
          return;
        } catch (e) {
          await messageBox(
            getWindow,
            "error",
            `Could not open resource:\n${target.toString()}\n\n${(e as Error).message}`,
            ["OK"],
          );
          return;
        }
      }
      await messageBox(getWindow, "error", `Could not open resource:\n${String(target)}`, ["OK"]);
    },
    async openUntitledText(content: string, language?: string) {
      const title = language ? `Untitled (${language})` : "Untitled";
      openHtmlDocumentWindow(
        getWindow,
        title,
        buildTextViewerHtml(title, content, language),
      );
    },
    async openDiff(left: Uri, right: Uri, title: string, options?: HostTextShowOptions) {
      try {
        const read = (p: string) => fs.readFileSync(p, "utf8");
        const leftText = resolveDocumentText(left, contentProviders, read);
        const rightText = resolveDocumentText(right, contentProviders, read);
        const leftLabel = path.basename(left.path) || "before";
        const rightLabel = path.basename(right.path) || "after";
        const scrollTo = options?.selection?.start?.line;
        openHtmlDocumentWindow(
          getWindow,
          title,
          buildDiffViewerHtml(title, leftLabel, leftText, rightLabel, rightText, scrollTo),
        );
      } catch (e) {
        await messageBox(
          getWindow,
          "error",
          `Could not open diff:\n${title}\n\n${(e as Error).message}`,
          ["OK"],
        );
      }
    },
    openWorkspaceTextFiles() {
      // No multi-tab editor in the desktop app.
      return [];
    },
    closeDiffTabs(_original: Uri, _modified: Uri) {
      // no-op — internal diff windows are not tracked as tabs
    },

    async setContext(_key: string, _value: unknown) {
      // VS Code when-clause context — no-op on desktop.
    },
    async relocateView(_viewId: string, _destinationId?: string | null) {
      // Capability `canRelocateView` is false — gear must not offer this. Stub
      // remains for typed Host completeness; never user-reachable from the UI.
      await notYet("Move view");
    },

    onDidChangeConfiguration(listener) {
      return configListeners.onDidChange(listener);
    },
    onDidChangeActiveTextEditor(listener) {
      editorListeners.add(listener);
      return {
        dispose: () => {
          editorListeners.delete(listener);
        },
      };
    },
    onDidChangeActiveTextEditorSelection(listener) {
      selectionListeners.add(listener);
      return {
        dispose: () => {
          selectionListeners.delete(listener);
        },
      };
    },
    createFileSystemWatcher(base: string, pattern: string): HostFileSystemWatcher {
      // When ~/.grok does not exist yet, watch the parent and rebind on create
      // so first login refreshes voiceConfigured (auth.json).
      return createBoundFileSystemWatcher(base, pattern, log);
    },
    registerTextDocumentContentProvider(scheme, provider) {
      contentProviders.set(scheme, provider);
      return {
        dispose: () => {
          contentProviders.delete(scheme);
        },
      };
    },

    get appName() {
      return DESKTOP_APP_SHORT_NAME;
    },
    get language() {
      return "en";
    },
    get isTelemetryEnabled() {
      return config.getValue("grok.telemetry.enabled") !== false;
    },

    webviewReloadsUnderLiveSession: true,
    remoteInstallIdSuffix: ":desktop",
    canRelocateView: false,
    canShowOutput: false,
    canSwitchWorkspaceFolder: true,
  };
}

/** Ensure a workspace folder exists; prompt if missing. Returns absolute path or undefined if cancelled. */
export async function ensureWorkspaceRoot(
  config: ConfigStore,
  getWindow: () => BrowserWindow | null,
  forced?: string,
): Promise<string | undefined> {
  if (forced && fs.existsSync(forced)) {
    config.setWorkspaceRoot(path.resolve(forced));
    return path.resolve(forced);
  }
  const existing = config.getWorkspaceRoot();
  if (existing && fs.existsSync(existing)) return existing;

  const win = parentWindow(getWindow);
  const result = win
    ? await dialog.showOpenDialog(win, {
        title: "Choose workspace folder",
        message: "Select a folder for Grok to work in",
        properties: ["openDirectory", "createDirectory"],
      })
    : await dialog.showOpenDialog({
        title: "Choose workspace folder",
        properties: ["openDirectory", "createDirectory"],
      });
  if (result.canceled || !result.filePaths[0]) return undefined;
  const root = result.filePaths[0];
  config.setWorkspaceRoot(root);
  return root;
}
