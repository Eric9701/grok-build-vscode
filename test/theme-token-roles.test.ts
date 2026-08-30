import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * A VS Code colour token carries a ROLE, and the roles are not interchangeable.
 * `button.background` is a surface: the theme only promises it is legible with
 * `button.foreground` painted on top of it. Dark High Contrast sets it to pure
 * BLACK — correct for a bordered button, invisible for a bare check mark or a
 * filled dot, which is what #139 reported.
 *
 * These checks are on the source text rather than on rendered pixels because
 * that is where the mistake is made and where it reads as obviously wrong.
 */
const dir = new URL("../media/", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ name: f, css: readFileSync(new URL(f, dir), "utf8") }));

/** Declarations, as `property: value`, with comments stripped. */
function declarations(css: string): { prop: string; value: string; block: string }[] {
  const out: { prop: string; value: string; block: string }[] = [];
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of bare.split("}")) {
    const body = block.slice(block.indexOf("{") + 1);
    if (!block.includes("{")) continue;
    for (const decl of body.split(";")) {
      const i = decl.indexOf(":");
      if (i === -1) continue;
      out.push({ prop: decl.slice(0, i).trim(), value: decl.slice(i + 1).trim(), block });
    }
  }
  return out;
}

const FOREGROUND_PROPS = new Set(["color", "border-color", "fill", "stroke", "caret-color"]);

describe("VS Code colour tokens are used in the role they were defined for (#139)", () => {
  for (const { name, css } of files) {
    it(`${name}: no *Background token is painted as a foreground`, () => {
      const offenders = declarations(css)
        .filter((d) => FOREGROUND_PROPS.has(d.prop))
        .filter((d) => /var\(\s*--vscode-[A-Za-z.-]*[Bb]ackground/.test(d.value))
        // A deliberate INVERSION is the one legitimate use: the block paints a
        // foreground token as the surface, so the background token is what has
        // to read on it (`.msg-expand-btn:hover`). Both halves swap together.
        .filter((d) => !/background(-color)?: *var\(\s*--vscode-[A-Za-z.-]*[Ff]oreground/.test(d.block))
        .map((d) => `${d.prop}: ${d.value}`);
      expect(offenders).toEqual([]);
    });

    it(`${name}: button.background is only ever a button surface`, () => {
      // A theme may set it to black (hcDark) or white; only `button.foreground`
      // is guaranteed to read on it. A hover/active/disabled variant inherits
      // the colour its base rule set, so it needs no foreground of its own.
      const offenders = declarations(css)
        .filter((d) => d.prop === "background" || d.prop === "background-color")
        .filter((d) => /var\(\s*--vscode-button-(background|hoverBackground)/.test(d.value))
        .filter((d) => !/--vscode-button-[a-zA-Z]*[Ff]oreground/.test(d.block))
        .filter((d) => !/:(hover|active|focus|focus-visible|disabled)\b[^{]*\{/.test(d.block))
        .map((d) => d.block.slice(0, d.block.indexOf("{")).trim());
      expect(offenders).toEqual([]);
    });
  }
});
