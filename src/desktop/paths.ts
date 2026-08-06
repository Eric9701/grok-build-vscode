/**
 * Path helpers for the desktop Electron app. Resolves the extension/repo root
 * (where `media/` and `resources/` live) relative to the compiled main process.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { app } from "electron";

/** Repo / install root: parent of `out/` when running from a compile tree. */
export function resolveExtensionRoot(): string {
  // out/desktop/main.js → ../../
  const fromOut = path.resolve(__dirname, "..", "..");
  if (fs.existsSync(path.join(fromOut, "media", "chat.js"))) return fromOut;
  // Packaged app fallback (resources next to asar).
  try {
    const appPath = app.getAppPath();
    if (fs.existsSync(path.join(appPath, "media", "chat.js"))) return appPath;
  } catch {
    /* app not ready */
  }
  return fromOut;
}

export function resolveUserDataDir(override?: string): string {
  if (override) return path.resolve(override);
  return path.join(app.getPath("userData"), "grok-desktop");
}
