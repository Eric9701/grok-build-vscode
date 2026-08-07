/**
 * chat.js publishes its markdown renderer on `window.__grokRenderMarkdown` so
 * the desktop file panel — injected into the SAME document after load — can
 * preview `.md` files with the conversation's renderer instead of the ~35-line
 * private subset it used to carry (headings, fences and bold only: no bullets,
 * no tables, no links, no italics).
 *
 * The export is a contract between two surfaces in different files, so it needs
 * its own coverage: deleting it would leave the panel silently degraded to its
 * fallback rather than failing anything.
 */
import { describe, expect, it } from "vitest";
import { bootWebview } from "./webview-harness";

function render(md: string): string {
  const h = bootWebview({ ready: true });
  const fn = (h.window as any).__grokRenderMarkdown;
  expect(typeof fn).toBe("function");
  return String(fn(md));
}

describe("shared markdown renderer (window.__grokRenderMarkdown)", () => {
  it("renders bullets — the panel's own parser never did", () => {
    const html = render("- alpha\n- beta\n");
    expect(html).toContain("<li>");
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
  });

  it("renders GFM tables", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain("md-table-wrap");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
  });

  it("still renders what the old subset did", () => {
    const html = render("# Title\n\n**bold** and `code`\n\n```\nfenced\n```\n");
    expect(html).toContain("Title");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>");
    expect(html).toContain("fenced");
  });

  it("escapes raw HTML in the source — repo files are not trusted markup", () => {
    // The panel previews files from whatever repository is open. If a README
    // could inject live markup it would run inside the Electron renderer, which
    // holds the preload bridge. `inline()` escapes &, < and > first, so this
    // must come back inert.
    const html = render('<img src=x onerror="alert(1)">\n');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("survives a null or undefined body without throwing", () => {
    const h = bootWebview({ ready: true });
    const fn = (h.window as any).__grokRenderMarkdown;
    expect(() => fn(null)).not.toThrow();
    expect(() => fn(undefined)).not.toThrow();
  });
});
