/**
 * Path helpers for the desktop Electron app. Resolves the extension/repo root
 * (where `media/` and `resources/` live) relative to the compiled main process.
 *
 * Layouts:
 *   Dev compile tree:  <root>/out/desktop/main.js  → root has media/
 *   Packaged (asar):   <…>/resources/app.asar/out/desktop/main.js
 *                      media/ is at app.asar root (electron-builder `files`)
 *   Packaged (dir):    <…>/resources/app/out/desktop/main.js  (same relative layout)
 *   Extra-resources:   media next to asar under process.resourcesPath (fallback)
 *
 * Pure resolvers (`isExtensionRoot`, `resolveExtensionRootFrom`) do not import
 * Electron so unit tests can load them without a BrowserWindow.
 */
import * as path from "node:path";
import * as fs from "node:fs";

/** True when this directory looks like the install/repo root (has chat assets). */
export function isExtensionRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, "media", "chat.js"));
}

/**
 * Pure resolver — unit-testable without a live Electron app.
 * `moduleDir` is the directory of the compiled main script (usually `__dirname`).
 */
export function resolveExtensionRootFrom(
  moduleDir: string,
  opts?: {
    /** `app.getAppPath()` — asar path or resources/app when unpacked. */
    appPath?: string;
    /** `process.resourcesPath` — directory that contains app.asar / app/. */
    resourcesPath?: string;
  },
): string {
  // out/desktop/main.js → ../../  (dev tree and packaged asar/dir layout)
  const fromOut = path.resolve(moduleDir, "..", "..");
  if (isExtensionRoot(fromOut)) return fromOut;

  if (opts?.appPath && isExtensionRoot(opts.appPath)) return opts.appPath;

  // media shipped as extraResource next to asar (not the default layout).
  if (opts?.resourcesPath) {
    const nextToAsar = path.join(opts.resourcesPath, "app");
    if (isExtensionRoot(nextToAsar)) return nextToAsar;
    if (isExtensionRoot(opts.resourcesPath)) return opts.resourcesPath;
  }

  return fromOut;
}

/** Repo / install root: parent of `out/` when running from a compile tree. */
export function resolveExtensionRoot(): string {
  // Lazy require so pure helpers stay loadable outside Electron.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require("electron") as typeof import("electron");
  let appPath: string | undefined;
  try {
    appPath = app.getAppPath();
  } catch {
    /* app not ready */
  }
  return resolveExtensionRootFrom(__dirname, {
    appPath,
    resourcesPath:
      typeof process.resourcesPath === "string" ? process.resourcesPath : undefined,
  });
}

export function resolveUserDataDir(override?: string): string {
  if (override) return path.resolve(override);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require("electron") as typeof import("electron");
  return path.join(app.getPath("userData"), "grok-desktop");
}
