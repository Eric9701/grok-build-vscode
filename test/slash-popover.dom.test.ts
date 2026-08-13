// DOM tests for the composer's "/" slash-command / skill popover (#110):
// typing filters advertised names by case-insensitive substring, with prefix
// matches ranked above mid-name matches. Mentions use a different host ranker
// and are not covered here.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

type TextArea = HTMLTextAreaElement;

function typeInComposer(h: Harness, text: string): TextArea {
  const input = h.doc.getElementById("input") as TextArea;
  input.value = text;
  // happy-dom doesn't move the caret on programmatic value writes — pin it to
  // the end the way a real keystroke leaves it.
  input.selectionStart = text.length;
  input.selectionEnd = text.length;
  input.dispatchEvent(new (h.window as any).Event("input", { bubbles: true }));
  return input;
}

function loadCommands(h: Harness, commands: Array<{ name: string; description?: string }>): void {
  dispatch(h.window, { type: "commandsUpdate", commands });
}

function slashPopover(h: Harness): HTMLElement {
  return h.doc.getElementById("slash-popover") as HTMLElement;
}

function slashNames(h: Harness): string[] {
  return [...slashPopover(h).querySelectorAll(".slash-name")].map((el) => el.textContent || "");
}

const SKILLS = [
  { name: "ux-ui-promax", description: "UX/UI kit" },
  { name: "ui-kit", description: "prefix UI" },
  { name: "web-design", description: "site design" },
  { name: "design", description: "bare design" },
  { name: "fluid", description: "contains ui" },
  { name: "compact", description: "Compress conversation" },
];

describe("/ slash-command popover matching", () => {
  it("typing 'ui' finds ux-ui-promax", () => {
    const h = bootWebview();
    loadCommands(h, SKILLS);
    typeInComposer(h, "/ui");

    expect(slashPopover(h).hidden).toBe(false);
    expect(slashNames(h)).toContain("/ux-ui-promax");
  });

  it("typing 'design' finds web-design", () => {
    const h = bootWebview();
    loadCommands(h, SKILLS);
    typeInComposer(h, "/design");

    expect(slashPopover(h).hidden).toBe(false);
    expect(slashNames(h)).toContain("/web-design");
  });

  it("ranks prefix matches above substring matches, stably within each tier", () => {
    const h = bootWebview();
    // Substring hits are advertised first so a filter-without-rerank would
    // put them above the prefix hits.
    loadCommands(h, [
      { name: "ux-ui-promax" },
      { name: "ui-kit" },
      { name: "fluid" },
      { name: "uid" },
    ]);
    typeInComposer(h, "/ui");

    expect(slashNames(h)).toEqual(["/ui-kit", "/uid", "/ux-ui-promax", "/fluid"]);
    expect(slashPopover(h).querySelector(".slash-item")?.classList.contains("active")).toBe(true);
  });

  it("keeps non-matches out of the popover", () => {
    const h = bootWebview();
    loadCommands(h, SKILLS);
    typeInComposer(h, "/ui");

    const names = slashNames(h);
    expect(names).not.toContain("/web-design");
    expect(names).not.toContain("/design");
    expect(names).not.toContain("/compact");
    expect(names).toEqual(["/ui-kit", "/ux-ui-promax", "/fluid"]);
  });

  it("is case-insensitive", () => {
    const h = bootWebview();
    loadCommands(h, SKILLS);
    typeInComposer(h, "/UI");

    expect(slashNames(h)).toContain("/ux-ui-promax");
    expect(slashNames(h)).toContain("/ui-kit");
  });

  it("hides the popover when nothing matches", () => {
    const h = bootWebview();
    loadCommands(h, SKILLS);
    typeInComposer(h, "/zzz");

    expect(slashPopover(h).hidden).toBe(true);
    expect(slashNames(h)).toEqual([]);
  });
});
