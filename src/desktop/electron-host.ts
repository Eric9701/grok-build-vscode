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
  shell,
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
import {
  buildDiffViewerHtml,
  buildTextViewerHtml,
  interpretOpenPathResult,
  resolveDocumentText,
} from "./document-view";
import {
  planOpenCliInTerminal,
  planRunCommandInTerminal,
  type ExternalTerminalPlan,
} from "./external-terminal";
import { findFilesUnder } from "./find-files";

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
  /** Called when workspace root is chosen for the first time (or changed). */
  onWorkspaceRootChanged?: (root: string) => void;
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
  // base64 data URL avoids encodeURIComponent length blow-ups for mid-size diffs.
  const dataUrl = "data:text/html;base64," + Buffer.from(html, "utf8").toString("base64");
  void win.loadURL(dataUrl);
  return win;
}

export function createElectronHost(opts: ElectronHostOptions): Host {
  const { config, getWindow, log, remoteActions } = opts;
  const configListeners = config; // store owns change events
  let activeEditor: HostTextEditor | undefined;
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
      // Electron has no native quick-pick; use a simple numbered dialog for ≤6 items.
      if (!items.length) return undefined;
      if (items.length > 8) {
        await notYet("Large quick-pick lists");
        return undefined;
      }
      const labels = items.map((it, i) => `${i + 1}. ${it.label}${it.description ? ` — ${it.description}` : ""}`);
      const buttons = items.map((it) => it.label.slice(0, 40));
      buttons.push("Cancel");
      const boxOpts = {
        type: "question" as const,
        title: options?.title ?? "Choose",
        message: options?.placeHolder ?? "Select an item",
        detail: labels.join("\n"),
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true,
      };
      const win = parentWindow(getWindow);
      const result = win
        ? await dialog.showMessageBox(win, boxOpts)
        : await dialog.showMessageBox(boxOpts);
      if (result.response >= items.length) return undefined;
      return items[result.response];
    },

    async showInputBox(options?: HostInputBoxOptions): Promise<string | undefined> {
      // No native text input dialog in Electron — stub visibly for step 3.
      log(`[desktop] showInputBox("${options?.prompt ?? ""}"): not available yet`);
      await messageBox(
        getWindow,
        "info",
        options?.prompt
          ? `Input prompt is not available yet:\n\n${options.prompt}`
          : "Text input dialog is not available in the desktop app yet.",
        ["OK"],
      );
      return undefined;
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
    asRelativePath(uri: Uri) {
      const root = config.getWorkspaceRoot();
      if (!root || uri.scheme !== "file") return uri.fsPath;
      const rel = path.relative(root, uri.fsPath);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return uri.fsPath;
      return rel;
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
      const root = config.getWorkspaceRoot();
      if (!root) return false;
      return isFsPathInWorkspace(fsPath, [root]);
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
      const watchPath = path.join(base, pattern.includes("*") ? "" : pattern);
      const target = pattern.includes("*") ? base : watchPath;
      const createListeners = new Set<() => void>();
      const changeListeners = new Set<() => void>();
      const deleteListeners = new Set<() => void>();
      let watcher: fs.FSWatcher | undefined;
      try {
        // Watch the directory that should contain the file (auth.json lives under
        // ~/.grok — the dir may exist before the file).
        const watchTarget = fs.existsSync(base)
          ? base
          : fs.existsSync(target)
            ? path.dirname(target)
            : undefined;
        if (watchTarget) {
          const matches = (filename: string | null): boolean => {
            if (!pattern || pattern.includes("*")) return true;
            // Exact basename patterns (auth.json).
            if (!filename) return true;
            return filename === pattern || filename === path.basename(pattern);
          };
          watcher = fs.watch(watchTarget, (event, filename) => {
            if (filename && !matches(filename.toString())) return;
            const full = filename
              ? path.join(watchTarget, filename.toString())
              : target;
            // Node reports creates/deletes as "rename" on most platforms.
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
              return;
            }
            for (const l of changeListeners) l();
          });
        }
      } catch (e) {
        log(`[desktop] fs.watch failed: ${(e as Error).message}`);
      }
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
          watcher?.close();
        },
      };
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
      return "Grok Build Desktop";
    },
    get language() {
      return "en";
    },
    get isTelemetryEnabled() {
      return config.getValue("grok.telemetry.enabled") !== false;
    },

    webviewReloadsUnderLiveSession: true,
    remoteInstallIdSuffix: ":desktop",
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
