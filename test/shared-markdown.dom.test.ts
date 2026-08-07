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

describe("CRLF files render like LF ones", () => {
  // Most files on Windows are CRLF, and the desktop panel renders whole files
  // off disk, so this was the normal case rather than an edge one.
  //
  // The renderer splits on a newline and then tests each line with $-anchored
  // patterns. A carriage return is a line terminator in JS regex, so `.` cannot
  // match one, and every $-anchored rule failed at the final character:
  // headings kept their hashes, bullets kept their dashes, and both fell
  // through to the paragraph path. Tables, links and bold are not $-anchored,
  // so they kept working — which is why it looked like the renderer was mostly
  // fine, and why this survived review.
  const CRLF = "# Title\r\n\r\n## Section\r\n\r\n- one\r\n- two\r\n\r\n1. first\r\n";

  it("renders headings from a CRLF document", () => {
    const out = render(CRLF);
    expect(out).toContain("<h1");
    expect(out).toContain("<h2");
    expect(out).not.toContain("# Title");
    expect(out).not.toContain("## Section");
  });

  it("renders bullets and numbered lists from a CRLF document", () => {
    const out = render(CRLF);
    expect(out).toContain("<ul");
    expect(out).toContain("<ol");
    expect(out).toContain("<li");
  });

  it("produces exactly the same html as the LF form", () => {
    // The strongest statement of the rule: line endings must not be able to
    // change the output at all.
    expect(render(CRLF)).toBe(render(CRLF.replace(/\r\n/g, "\n")));
  });

  it("survives a lone-CR document", () => {
    expect(render("# Old Mac\r\r- item\r")).toContain("<h1");
  });
});
