import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("command and inline-diff surfaces do not trap page scrolling (#71)", () => {
  for (const selector of [".tool-cmd", ".tool-cmd-output", ".tool-diff-region"]) {
    it(`${selector} has no inner-scroll cap`, () => {
      const rule = ruleBody(selector);
      expect(rule).not.toBe("");
      expect(rule).not.toMatch(/\bmax-height\s*:/);
      expect(rule).not.toMatch(/\boverflow(?:-y)?\s*:/);
    });
  }
});

describe("the 12-line diff collapse can actually hide overflow rows (#71)", () => {
  // buildInlineDiffRegion collapses a long diff by setting `hidden` on every
  // row past DIFF_PREVIEW_LINES. `.tdl` carries an explicit `display: grid`,
  // which beats the UA's [hidden]{display:none} (equal specificity → source
  // order wins), so without an author override the hidden rows stay visible
  // and the diff renders fully expanded. This asserts the override exists —
  // the DOM tests can't catch it because happy-dom doesn't run the CSS cascade.
  it(".tdl sets display: grid, so it needs a [hidden] override", () => {
    expect(ruleBody(".tdl")).toMatch(/display\s*:\s*grid/);
  });
  it(".tdl[hidden] forces display: none", () => {
    expect(ruleBody(".tdl[hidden]")).toMatch(/display\s*:\s*none/);
  });
});

describe("command input clipping (#92)", () => {
  it("keeps command lines single-line and clips inside the detail surface", () => {
    const rule = ruleBody(".tool-cmd");
    expect(rule).toMatch(/white-space\s*:\s*pre\b/);
    expect(rule).toMatch(/overflow-x\s*:\s*hidden/);
    expect(rule).toMatch(/overflow-wrap\s*:\s*normal/);
  });

  it("does not apply the no-wrap rule to command output", () => {
    expect(ruleBody(".tool-cmd-output")).not.toMatch(/white-space\s*:\s*pre\b/);
  });
});
