/**
 * Preload: expose an `acquireVsCodeApi()`-compatible surface so unmodified
 * `media/chat.js` boots under Electron (contextIsolation, no nodeIntegration).
 *
 * Host → webview messages are re-dispatched as `window` MessageEvents so
 * chat.js's existing `window.addEventListener("message", …)` keeps working.
 *
 * Note: preload runs in a DOM context but our package tsconfig has no "DOM" lib
 * (extension host is Node). Use minimal ambient typing instead of adding DOM
 * globally to every module.
 */
import { contextBridge, ipcRenderer } from "electron";

declare const window: {
  dispatchEvent(event: { type: string; data?: unknown }): boolean;
};

// Minimal stand-in — preload only needs type + data for chat.js.
class PreloadMessageEvent {
  type = "message";
  constructor(public data: unknown) {}
}

let state: unknown;

const api = {
  postMessage(message: unknown): void {
    ipcRenderer.send("webview-to-host", message);
  },
  getState(): unknown {
    return state;
  },
  setState(newState: unknown): unknown {
    state = newState;
    return newState;
  },
};

contextBridge.exposeInMainWorld("acquireVsCodeApi", () => api);

/**
 * Desktop-only file-tree bridge (not used by chat.js). Paths are re-validated
 * in the main process — the renderer is not trusted for containment.
 */
contextBridge.exposeInMainWorld("grokDesktopFileTree", {
  list: (relPath: string) => ipcRenderer.invoke("desk-ft:list", relPath),
  open: (relPath: string) => ipcRenderer.invoke("desk-ft:open", relPath),
  root: () => ipcRenderer.invoke("desk-ft:root"),
  lastOpen: () => ipcRenderer.invoke("desk-ft:lastOpen"),
});

// Forward main→renderer posts into the same channel VS Code webviews use.
ipcRenderer.on("host-to-webview", (_event, message: unknown) => {
  // Prefer a real MessageEvent when the DOM constructor exists (always in Electron preload).
  try {
    // eslint-disable-next-line no-undef
    const Ev = (globalThis as { MessageEvent?: new (type: string, init: { data: unknown }) => Event }).MessageEvent;
    if (Ev) {
      window.dispatchEvent(new Ev("message", { data: message }) as unknown as { type: string; data?: unknown });
      return;
    }
  } catch {
    /* fall through */
  }
  window.dispatchEvent(new PreloadMessageEvent(message));
});
