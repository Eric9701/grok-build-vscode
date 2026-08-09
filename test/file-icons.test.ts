import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFileIconDataUrlMap,
  defaultFileIconsDir,
  fileIconId,
  isMonochromeIconSvg,
  monochromeIconIds,
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

describe("fill-less Seti glyphs are theme-tinted, not black", () => {
  it("classifies by the SVG's own fill, not a hand-kept list", () => {
    // A coloured glyph carries an explicit fill; a plain one carries none, and
    // SVG then defaults it to BLACK — invisible on a dark theme.
    expect(isMonochromeIconSvg('<svg><path fill="#cbcb41" d="M0 0"/></svg>')).toBe(false);
    expect(isMonochromeIconSvg('<svg><path d="M0 0"/></svg>')).toBe(true);
    // `fill="none"` is a stroke-drawn glyph, which is still uncoloured.
    expect(isMonochromeIconSvg('<svg><path fill="none" stroke="#abc" d="M0 0"/></svg>')).toBe(true);
  });

  it("catches the generic text icon the user reported, and its whole class", () => {
    const mono = new Set(monochromeIconIds(iconsDir));
    // `.dockerignore` and every other unmapped file falls back to `default`.
    expect(mono.has("default")).toBe(true);
    // Not an isolated glyph — a third of the vendored set had the same defect.
    expect(mono.size).toBeGreaterThan(20);
    // Coloured glyphs must NOT be repainted, or Seti stops being Seti.
    expect(mono.has("javascript")).toBe(false);
    expect(mono.has("css")).toBe(false);
  });

  it("renders those as a currentColor-independent theme token, never opacity", () => {
    const boot = fileTreePanelBootSource(iconsDir);
    expect(boot).toContain("SETI_MONO");
    expect(boot).toContain("desk-ft-icon-mono");
    // The tint must resolve per theme — the desktop defines
    // --vscode-descriptionForeground for BOTH light and dark.
    expect(FILE_TREE_PANEL_CSS).toMatch(
      /\.desk-ft-icon-mono\s*\{[^}]*--vscode-descriptionForeground/s,
    );
    expect(FILE_TREE_PANEL_CSS).toMatch(/\.desk-ft-icon-mono\s*\{[^}]*mask-image/s);
  });
});

describe("markdown preview uses the conversation's renderer", () => {
  it("delegates to chat.js and keeps a fallback", () => {
    const boot = fileTreePanelBootSource(iconsDir);
    // One renderer for both surfaces — the private subset dropped bullets and
    // tables entirely, which is exactly what this replaces.
    expect(boot).toContain("window.__grokRenderMarkdown");
    expect(boot).toContain("renderMarkdownFallback");
  });

  it("defers markdown typography to chat.css; keeps only panel layout bounds", () => {
    // Shared with .msg.agent .body — do not restate list/table colours here.
    const chatCss = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    expect(chatCss).toMatch(/\.desk-ft-md\s+ul|\.desk-ft-md ul/);
    // Shared with remote files-browse-md as well as the desktop panel class.
    expect(chatCss).toMatch(
      /\.desk-ft-md ul(?:, \.files-browse-md ul)? \{ list-style-type: disc|\.msg\.agent \.body ul,\s*\n\.desk-ft-md ul/,
    );
    expect(chatCss).toContain(".desk-ft-md th");
    expect(chatCss).toMatch(
      /\.desk-ft-md th[\s\S]*textBlockQuote-background|textBlockQuote-background[\s\S]*\.desk-ft-md th/,
    );
    // Panel only constrains table width so a wide table does not grow the column.
    expect(FILE_TREE_PANEL_CSS).toContain(".desk-ft-md .md-table-wrap");
    expect(FILE_TREE_PANEL_CSS).toMatch(
      /\.desk-ft-md \.md-table-wrap\s*\{[^}]*max-width:\s*100%/s,
    );
    expect(FILE_TREE_PANEL_CSS).not.toMatch(/textCodeBlock-background/);
  });
});
