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

  it("directory rows use a disclosure chevron and no folder Seti glyph", () => {
    const boot = fileTreePanelBootSource(iconsDir);
    // Chevrons (Codex / VS Code SVG > / v), not filled triangle glyphs.
    expect(boot).toMatch(/twistGlyph/);
    expect(boot).toContain("ICON_CHEVRON_RIGHT");
    expect(boot).toContain("ICON_CHEVRON_DOWN");
    expect(boot).toMatch(/m9 18 6-6-6-6/); // chevron-right path
    expect(boot).toMatch(/m6 9 6 6 6-6/); // chevron-down path
    expect(boot).not.toMatch(/["']▶["']|["']▼["']|["']▸["']|["']▾["']|["']›["']|["']⌄["']/);
    // Dirs skip Seti: iconFor returns empty for kind===dir.
    expect(boot).toMatch(/if\s*\(\s*kind\s*===\s*["']dir["']\s*\)\s*return\s*\{\s*id:\s*["']["']/);
    expect(boot).toMatch(/data-kind/);
    // Single lead column: chevron OR icon, shared 16px box (no file spacer column).
    expect(FILE_TREE_PANEL_CSS).toContain("desk-ft-lead");
    expect(FILE_TREE_PANEL_CSS).toMatch(/--desk-ft-lead-size:\s*16px/);
    // No empty disclosure spacer kept for alignment on dir rows.
    expect(FILE_TREE_PANEL_CSS).not.toMatch(
      /\.desk-ft-row\[data-kind=["']dir["']\]\s*\.desk-ft-icon\s*\{[^}]*visibility:\s*hidden/s,
    );
    // Row height unchanged from the rail density pass.
    expect(FILE_TREE_PANEL_CSS).toMatch(
      /\.desk-ft-row\s*\{[^}]*min-height:\s*var\(--rail-row-min-height/s,
    );
    // Tight lead→label gap (not the rail's 6px).
    expect(FILE_TREE_PANEL_CSS).toMatch(/\.desk-ft-row\s*\{[^}]*gap:\s*2px/s);
    // Chevron fills the lead box (optical parity with 16px Seti icons).
    expect(FILE_TREE_PANEL_CSS).toMatch(
      /\.desk-ft-twist svg\s*\{[^}]*width:\s*var\(--desk-ft-lead-size/s,
    );
    // makeNode: one lead child — twist for dirs, icon for files (never both).
    expect(boot).toMatch(/desk-ft-lead/);
    expect(boot).toMatch(/classList\.add\(["']desk-ft-twist["']\)/);
    expect(boot).toMatch(/classList\.add\(["']desk-ft-icon["']\)/);
    // Only one append of the lead before name — no second glyph column.
    expect(boot).toMatch(/row\.appendChild\(lead\);\s*row\.appendChild\(name\)/);
    // File branch attaches data-icon on the lead; dir branch uses twistGlyph.
    expect(boot).toMatch(
      /entry\.kind\s*===\s*["']dir["']\s*\)\s*\{[\s\S]*?desk-ft-twist[\s\S]*?twistGlyph/,
    );
    expect(boot).toMatch(
      /else\s*\{[\s\S]*?desk-ft-icon[\s\S]*?data-icon/,
    );
    // twistGlyph must return the SVG constants (not a triangle/unicode glyph).
    expect(boot).toMatch(
      /function twistGlyph\s*\(\s*open\s*\)\s*\{\s*return open \? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT/,
    );
  });

  it("file and folder leads share the same column model and per-level indent", () => {
    const boot = fileTreePanelBootSource(iconsDir);
    // Same depth → same paddingLeft formula (per-level indent preserved).
    expect(boot).toMatch(/const indent = 8 \+ depth \* 12/);
    expect(boot).toMatch(/row\.style\.paddingLeft = indent \+ ["']px["']/);
    // Leading glyph is exactly one of twist|icon under .desk-ft-lead — not
    // twist+icon (which would push files right by a chevron width).
    expect(boot).toMatch(/lead\.className = ["']desk-ft-lead["']/);
    expect(boot).not.toMatch(/appendChild\(twist\);\s*row\.appendChild\(icon\)/);
    // Shared lead box width for both glyphs.
    expect(FILE_TREE_PANEL_CSS).toMatch(
      /\.desk-ft-lead\s*\{[^}]*--desk-ft-lead-size:\s*16px/s,
    );
    // Row min-height still the rail density token (must not grow).
    expect(FILE_TREE_PANEL_CSS).toMatch(
      /\.desk-ft-row\s*\{[^}]*min-height:\s*var\(--rail-row-min-height,\s*30px\)/s,
    );
  });
});
