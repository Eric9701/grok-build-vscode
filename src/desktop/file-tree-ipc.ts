/**
 * Main-process IPC for the desktop file-tree panel.
 * Renderer is less trusted: every path is re-resolved and containment-checked
 * (canonical / realpath — see file-tree.ts), and only the main BrowserWindow
 * may invoke these channels.
 */
import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent, type Event as ElectronEvent } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { isExecutableOpenTarget } from "./desktop-policy";
import { interpretOpenPathResult } from "./document-view";
import {
  listTreeDir,
  readTreeFile,
  resolveTreePath,
  writeTreeFile,
  type TreeFileStamp,
} from "./file-tree";
import { fileTreePanelBootSource } from "./file-tree-panel";
import { isTrustedMainFrameIpc } from "./window-security";

const CH_LIST = "desk-ft:list";
const CH_OPEN = "desk-ft:open";
const CH_READ = "desk-ft:read";
const CH_SAVE = "desk-ft:save";
const CH_ROOT = "desk-ft:root";

export interface FileTreeIpcOptions {
  getWorkspaceRoot: () => string | undefined;
  log: (line: string) => void;
  /** Main window — handlers refuse invokes from any other webContents. */
  getMainWindow: () => BrowserWindow | null;
  /**
   * When set (tests), open writes the absolute path as a line instead of
   * calling the OS handler — so e2e can assert the open path without a GUI app.
   * Prefer this over any production diagnostic: a process-global last-open
   * path would leak across project switches.
   */
  openSinkPath?: string;
}

let handlersRegistered = false;
let closeBoundWindow: BrowserWindow | null = null;
let closeBoundHandler: ((event: ElectronEvent) => void) | null = null;

/** True when the IPC event came from the desktop app's main window main frame. */
export function isIpcFromMainWindow(
  event: Pick<IpcMainInvokeEvent, "sender"> & {
    senderFrame?: { url?: string } | null;
  },
  getMainWindow: () => BrowserWindow | null,
): boolean {
  return isTrustedMainFrameIpc(event, getMainWindow);
}

/** Register invoke handlers once per process. */
export function registerFileTreeIpc(opts: FileTreeIpcOptions): void {
  if (handlersRegistered) {
    // Allow re-binding workspace getter when createApp restarts in the same process.
    unregisterFileTreeIpc();
  }
  handlersRegistered = true;

  const deny = (channel: string) => {
    opts.log(`[desk-ft] refused ${channel}: sender is not the main window`);
    return { ok: false as const, reason: "forbidden", error: "forbidden" };
  };

  ipcMain.handle(CH_ROOT, (e) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_ROOT);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, reason: "no workspace root" };
    return {
      ok: true as const,
      root,
      name: path.basename(root) || root,
    };
  });

  ipcMain.handle(CH_LIST, (e, relPath: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_LIST);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, reason: "no workspace root" };
    const rel = typeof relPath === "string" ? relPath : "";
    return listTreeDir(root, rel);
  });

  ipcMain.handle(CH_OPEN, async (e, relPath: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_OPEN);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, error: "no workspace root" };
    if (typeof relPath !== "string") {
      return { ok: false as const, error: "invalid path" };
    }
    // Validate, then re-resolve immediately before use (cheap TOCTOU close:
    // a same-user process could swap a link between the two checks).
    const first = resolveTreePath(root, relPath);
    if (!first.ok) {
      opts.log(`[desk-ft] open rejected: ${first.reason} (${relPath})`);
      return { ok: false as const, error: first.reason };
    }
    const resolved = resolveTreePath(root, relPath);
    if (!resolved.ok) {
      opts.log(`[desk-ft] open rejected on re-check: ${resolved.reason} (${relPath})`);
      return { ok: false as const, error: resolved.reason };
    }
    // Open files only — directories stay expand-only in the panel.
    // resolveTreePath already refused outbound symlinks/junctions; open the
    // path the user sees (link path when it is an in-tree link).
    try {
      const st = fs.statSync(resolved.absPath);
      if (!st.isFile()) {
        return { ok: false as const, error: "not a file" };
      }
    } catch {
      return { ok: false as const, error: "not found" };
    }
    // Same executable refusal as chat openFile (desktop-policy): extension,
    // symlink target, launcher format, and POSIX +x on the canonical file.
    if (isExecutableOpenTarget(resolved.absPath)) {
      opts.log(`[desk-ft] open rejected: executable path refused (${relPath})`);
      return { ok: false as const, error: "executable path refused" };
    }

    const sink = opts.openSinkPath || process.env.GROK_DESKTOP_OPEN_SINK;
    if (sink) {
      try {
        fs.appendFileSync(sink, resolved.absPath + "\n", "utf8");
      } catch (err) {
        opts.log(`[desk-ft] open sink write failed: ${(err as Error).message}`);
        return { ok: false as const, error: "sink write failed" };
      }
      return { ok: true as const, path: resolved.absPath, sink: true as const };
    }

    // Final containment + executable re-check immediately before the OS open.
    const finalCheck = resolveTreePath(root, relPath);
    if (!finalCheck.ok || finalCheck.absPath !== resolved.absPath) {
      opts.log(`[desk-ft] open rejected at use-time re-resolve (${relPath})`);
      return { ok: false as const, error: "path escaped workspace" };
    }
    if (isExecutableOpenTarget(finalCheck.absPath)) {
      opts.log(`[desk-ft] open rejected at use-time: executable (${relPath})`);
      return { ok: false as const, error: "executable path refused" };
    }

    const err = await shell.openPath(finalCheck.absPath);
    const result = interpretOpenPathResult(err);
    if (!result.ok) {
      opts.log(`[desk-ft] openPath failed: ${result.error}`);
      return { ok: false as const, error: result.error };
    }
    return { ok: true as const, path: finalCheck.absPath };
  });

  /** In-panel read for markdown/json/image/text preview (containment-checked). */
  ipcMain.handle(CH_READ, (e, relPath: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_READ);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, reason: "no workspace root" };
    if (typeof relPath !== "string") {
      return { ok: false as const, reason: "invalid path" };
    }
    return readTreeFile(root, relPath);
  });

  ipcMain.handle(CH_SAVE, (e, payload: unknown) => {
    if (!isIpcFromMainWindow(e, opts.getMainWindow)) return deny(CH_SAVE);
    const root = opts.getWorkspaceRoot();
    if (!root) return { ok: false as const, reason: "no workspace root" };
    if (!payload || typeof payload !== "object") {
      return { ok: false as const, reason: "invalid save request" };
    }
    const request = payload as {
      relPath?: unknown;
      text?: unknown;
      stamp?: unknown;
    };
    if (typeof request.relPath !== "string" || typeof request.text !== "string") {
      return { ok: false as const, reason: "invalid save request" };
    }
    const stamp = request.stamp as Partial<TreeFileStamp> | undefined;
    if (
      !stamp ||
      typeof stamp.mtimeMs !== "number" ||
      typeof stamp.size !== "number"
    ) {
      return { ok: false as const, reason: "invalid version stamp" };
    }
    const result = writeTreeFile(root, request.relPath, request.text, stamp as TreeFileStamp, {
      isExecutableOpenTarget: (absPath) => isExecutableOpenTarget(absPath),
    });
    if (!result.ok) {
      opts.log(`[desk-ft] save rejected: ${result.reason} (${request.relPath})`);
    }
    return result;
  });

  const win = opts.getMainWindow();
  if (win && !win.isDestroyed()) {
    let closePending = false;
    const onClose = (event: ElectronEvent) => {
      if (closePending) {
        event.preventDefault();
        return;
      }
      closePending = true;
      event.preventDefault();
      void win.webContents
        .executeJavaScript(
          `(function(){try{var f=window.__grokDeskFtBeforeClose;if(typeof f!=="function")return Promise.resolve(true);return Promise.resolve(f()).then(Boolean);}catch(_){return false;}})()`,
          true,
        )
        .then((ok) => {
          closePending = false;
          if (!ok || win.isDestroyed()) return;
          if (closeBoundWindow === win && closeBoundHandler) {
            win.removeListener("close", closeBoundHandler);
            closeBoundWindow = null;
            closeBoundHandler = null;
          }
          win.close();
        })
        .catch(() => {
          closePending = false;
        });
    };
    closeBoundWindow = win;
    closeBoundHandler = onClose;
    win.on("close", onClose);
  }
}

export function unregisterFileTreeIpc(): void {
  if (!handlersRegistered) return;
  for (const ch of [CH_LIST, CH_OPEN, CH_READ, CH_SAVE, CH_ROOT]) {
    ipcMain.removeHandler(ch);
  }
  if (closeBoundWindow && closeBoundHandler) {
    closeBoundWindow.removeListener("close", closeBoundHandler);
    closeBoundWindow = null;
    closeBoundHandler = null;
  }
  handlersRegistered = false;
}

/**
 * Inject (or re-inject) the file-tree panel into the chat document.
 * Safe to call on every did-finish-load.
 */
export async function injectFileTreePanel(win: BrowserWindow | null): Promise<void> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const src = fileTreePanelBootSource();
  try {
    await win.webContents.executeJavaScript(src, true);
  } catch (e) {
    // Log-only: chat still works without the panel.
    // Callers pass log separately; swallow here if injection races dispose.
    void e;
  }
}

/**
 * Open a workspace-relative path in the in-panel file viewer (chat openFile
 * for renderable types). Returns true when the renderer accepted the path.
 * Containment is re-checked by the panel's read IPC — this only delivers the
 * relative path string.
 */
export async function openPathInFilePanel(
  win: BrowserWindow | null,
  relPath: string,
): Promise<boolean> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  if (typeof relPath !== "string" || !relPath || relPath.includes("\0")) return false;
  // Escape for a single-quoted JS string literal.
  const lit = relPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r|\n/g, "");
  try {
    const result = await win.webContents.executeJavaScript(
      `(function(){try{var fn=window.__grokDeskFtOpen;if(typeof fn!=="function")return{ok:false,reason:"no panel"};return Promise.resolve(fn('${lit}')).then(function(r){return r&&r.ok!==false?{ok:true}:r||{ok:true};});}catch(e){return{ok:false,reason:String(e&&e.message||e)};}})()`,
      true,
    );
    if (result && result.ok === false) return false;
    return true;
  } catch {
    return false;
  }
}

export async function injectFileTreePanelLogged(
  win: BrowserWindow | null,
  log: (line: string) => void,
): Promise<void> {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    const result = await win.webContents.executeJavaScript(fileTreePanelBootSource(), true);
    if (result && result.ok === false) {
      log(`[desk-ft] inject: ${result.reason || "failed"}`);
    }
  } catch (e) {
    log(`[desk-ft] inject failed: ${(e as Error).message}`);
  }
}
