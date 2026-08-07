/**
 * Packaged-layout resolution for the desktop app root (media/ + resources/).
 * Pure — no Electron process. Mirrors electron-builder's asar/dir layout.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isExtensionRoot,
  resolveExtensionRootFrom,
} from "../src/desktop/paths";

describe("resolveExtensionRootFrom", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-paths-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeMedia(root: string): void {
    fs.mkdirSync(path.join(root, "media"), { recursive: true });
    fs.writeFileSync(path.join(root, "media", "chat.js"), "// stub\n");
  }

  it("isExtensionRoot requires media/chat.js", () => {
    expect(isExtensionRoot(tmp)).toBe(false);
    writeMedia(tmp);
    expect(isExtensionRoot(tmp)).toBe(true);
  });

  it("resolves the compile-tree layout (out/desktop → root)", () => {
    writeMedia(tmp);
    const moduleDir = path.join(tmp, "out", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(resolveExtensionRootFrom(moduleDir)).toBe(path.resolve(tmp));
  });

  it("resolves the packaged asar layout (app.asar/out/desktop → app.asar)", () => {
    // electron-builder: resources/app.asar/{out,media,package.json}
    const asarRoot = path.join(tmp, "resources", "app.asar");
    writeMedia(asarRoot);
    const moduleDir = path.join(asarRoot, "out", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(resolveExtensionRootFrom(moduleDir)).toBe(path.resolve(asarRoot));
  });

  it("falls back to appPath when moduleDir is not under the media root", () => {
    const appPath = path.join(tmp, "app-root");
    writeMedia(appPath);
    const moduleDir = path.join(tmp, "elsewhere", "out", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(
      resolveExtensionRootFrom(moduleDir, { appPath }),
    ).toBe(path.resolve(appPath));
  });

  it("falls back to resourcesPath/app when media is next to asar", () => {
    const resourcesPath = path.join(tmp, "resources");
    const appDir = path.join(resourcesPath, "app");
    writeMedia(appDir);
    const moduleDir = path.join(tmp, "orphan", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(
      resolveExtensionRootFrom(moduleDir, { resourcesPath }),
    ).toBe(path.resolve(appDir));
  });

  it("falls back to resourcesPath when media is an extraResource", () => {
    const resourcesPath = path.join(tmp, "resources");
    writeMedia(resourcesPath);
    const moduleDir = path.join(tmp, "orphan", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(
      resolveExtensionRootFrom(moduleDir, { resourcesPath }),
    ).toBe(path.resolve(resourcesPath));
  });

  it("returns fromOut when nothing matches (caller logs a bad root)", () => {
    const moduleDir = path.join(tmp, "out", "desktop");
    fs.mkdirSync(moduleDir, { recursive: true });
    expect(resolveExtensionRootFrom(moduleDir)).toBe(
      path.resolve(moduleDir, "..", ".."),
    );
  });
});
