import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFileIconDataUrlMap,
  defaultFileIconsDir,
  fileIconId,
  resolveFileIconSrc,
} from "../src/desktop/file-icons";
import { FILE_TREE_PANEL_CSS, fileTreePanelBootSource } from "../src/desktop/file-tree-panel";

const iconsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "file-icons");

describe("fileIconId (Seti mapping)", () => {
  it("maps known extensions and directories", () => {
    expect(fileIconId("dir", "src")).toBe("folder");
    expect(fileIconId("file", "app.js")).toBe("javascript");
    expect(fileIconId("file", "app.ts")).toBe("typescript");
    expect(fileIconId("file", "App.tsx")).toBe("react");
    expect(fileIconId("file", "photo.png")).toBe("image");
    expect(fileIconId("file", "photo.PNG")).toBe("image");
    expect(fileIconId("file", "readme.md")).toBe("markdown");
    expect(fileIconId("file", "package.json")).toBe("npm");
    expect(fileIconId("file", "styles.css")).toBe("css");
    expect(fileIconId("file", "unknown.xyz")).toBe("default");
  });
});

describe("Seti icon assets", () => {
  it("ships the icons used for common extensions", () => {
    const map = buildFileIconDataUrlMap(iconsDir);
    for (const id of [
      "javascript",
      "typescript",
      "image",
      "markdown",
      "json",
      "css",
      "folder",
      "default",
    ]) {
      expect(map[id], id).toBeTruthy();
      expect(map[id].startsWith("data:image/svg+xml")).toBe(true);
    }
    // Resolve end-to-end like the tree panel does.
    expect(resolveFileIconSrc("file", "x.js", map).id).toBe("javascript");
    expect(resolveFileIconSrc("file", "x.png", map).src).toContain("data:image/svg+xml");
    expect(resolveFileIconSrc("dir", "lib", map).id).toBe("folder");
  });

  it("embeds Seti icons in the file-tree boot source for known extensions", () => {
    const boot = fileTreePanelBootSource(iconsDir);
    expect(boot).toContain("SETI_ICONS");
    expect(boot).toContain("fileIconId");
    expect(boot).toContain("data-icon");
    // No emoji fallbacks for the extensions the owner called out.
    expect(boot).not.toContain("🟨");
    expect(boot).not.toContain("🖼");
    // Icons actually present in the embedded map.
    expect(boot).toContain("javascript");
    expect(boot).toContain("image");
    // CSS reuses rail row tokens.
    expect(FILE_TREE_PANEL_CSS).toContain("--rail-row-font-size");
    expect(FILE_TREE_PANEL_CSS).toContain("--rail-hover-bg");
    expect(FILE_TREE_PANEL_CSS).toContain("--rail-row-min-height");
    expect(defaultFileIconsDir()).toMatch(/file-icons/);
  });
});
