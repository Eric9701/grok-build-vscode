// DOM tests for the composer's "/" slash-command / skill popover (#110):
// typing filters advertised names and descriptions by case-insensitive
// substring, with name prefix above mid-name above description-only. Mentions
// use a different host ranker and are not covered here.
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

  it("matches a description-only hit and ranks it below name hits", () => {
    const h = bootWebview();
    loadCommands(h, [
      { name: "web-design", description: "UI components" },
      { name: "ui-kit", description: "buttons" },
      { name: "notes", description: "quick ui tips" },
    ]);
    typeInComposer(h, "/ui");

    expect(slashNames(h)).toEqual(["/ui-kit", "/web-design", "/notes"]);
    expect(slashPopover(h).querySelector(".slash-item")?.classList.contains("active")).toBe(true);
  });

  it("highlights the matched run in the name and the description", () => {
    const h = bootWebview();
    loadCommands(h, [
      { name: "ui-kit", description: "UI components" },
    ]);
    typeInComposer(h, "/ui");

    const nameHits = [...slashPopover(h).querySelectorAll(".slash-name .slash-hl")].map((el) => el.textContent);
    const descHits = [...slashPopover(h).querySelectorAll(".slash-desc .slash-hl")].map((el) => el.textContent);
    expect(nameHits).toEqual(["ui"]);
    expect(descHits).toEqual(["UI"]);
  });

  it("renders a description containing angle brackets as text, not markup", () => {
    const h = bootWebview();
    loadCommands(h, [
      { name: "sketch", description: "<img src=x onerror=alert(1)> design kit" },
    ]);
    typeInComposer(h, "/design");

    expect(slashNames(h)).toEqual(["/sketch"]);
    const desc = slashPopover(h).querySelector(".slash-desc") as HTMLElement;
    expect(desc.querySelector("img")).toBeNull();
    expect(desc.textContent).toBe("<img src=x onerror=alert(1)> design kit");
    expect(desc.querySelector(".slash-hl")?.textContent).toBe("design");
  });

  it("keeps arrow-key navigation and the active row after description matches", () => {
    const h = bootWebview();
    loadCommands(h, [
      { name: "ui-kit", description: "buttons" },
      { name: "web-design", description: "UI components" },
      { name: "notes", description: "quick ui tips" },
    ]);
    const input = typeInComposer(h, "/ui");
    input.dispatchEvent(new (h.window as any).KeyboardEvent("keydown", {
      key: "ArrowDown", bubbles: true, cancelable: true,
    }));

    const items = [...slashPopover(h).querySelectorAll(".slash-item")];
    expect(items.map((el) => el.classList.contains("active"))).toEqual([false, true, false]);
    expect(slashNames(h)).toEqual(["/ui-kit", "/web-design", "/notes"]);
  });
});

function skillCmd(name: string, description?: string) {
  return {
    name,
    description,
    _meta: { scope: "user", path: `/skills/${name}/SKILL.md` },
  };
}

describe("/ slash popover — skills anywhere, commands only at position 0 (#110)", () => {
  const MIXED = [
    { name: "compact", description: "Compress conversation" },
    { name: "effort", description: "Set reasoning effort" },
    skillCmd("frontend-design:frontend-design", "Frontend design skill"),
    skillCmd("commit", "Create a commit"),
  ];

  it("at position 0 offers commands and skills", () => {
    const h = bootWebview();
    loadCommands(h, MIXED);
    typeInComposer(h, "/");
    expect(slashPopover(h).hidden).toBe(false);
    expect(slashNames(h)).toEqual([
      "/compact",
      "/effort",
      "/frontend-design:frontend-design",
      "/commit",
    ]);
  });

  it("mid-prompt offers skills and hides commands that would not dispatch", () => {
    const h = bootWebview();
    loadCommands(h, MIXED);
    typeInComposer(h, "rhre /front");
    expect(slashPopover(h).hidden).toBe(false);
    expect(slashNames(h)).toEqual(["/frontend-design:frontend-design"]);
    expect(slashNames(h)).not.toContain("/compact");
    expect(slashNames(h)).not.toContain("/effort");
  });

  it("hides the popover for a mid-prompt command token", () => {
    const h = bootWebview();
    loadCommands(h, MIXED);
    typeInComposer(h, "rhre /compact");
    expect(slashPopover(h).hidden).toBe(true);
    expect(slashNames(h)).toEqual([]);
  });

  it("completes a mid-prompt skill in place", () => {
    const h = bootWebview();
    loadCommands(h, MIXED);
    const input = typeInComposer(h, "please /front");
    const item = slashPopover(h).querySelector(".slash-item") as HTMLElement;
    item.click();
    expect(input.value).toBe("please /frontend-design:frontend-design ");
  });
});
