const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mediaHarness", {
  send(record) { ipcRenderer.send("media-harness-renderer", record); },
  complete() { ipcRenderer.send("media-harness-complete"); },
  onBegin(callback) { ipcRenderer.on("media-harness-begin", callback); },
});
