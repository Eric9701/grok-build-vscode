/**
 * Minimal preload for in-app HTML dialogs (quick pick / input box).
 * Exposes only submit/cancel — no host message bus, no file tree.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("deskDialog", {
  submit(value: unknown): void {
    ipcRenderer.send("desk-dialog-result", value);
  },
  cancel(): void {
    ipcRenderer.send("desk-dialog-result", null);
  },
});
