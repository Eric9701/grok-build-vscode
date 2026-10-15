/**
 * The renderer half of "projects are folders the person chose": the inline
 * Add-to-Projects strip, Recent's "Add to Projects", and the empty Projects
 * state. Drives the shipped media/chat.js (desktop and phone/web rail).
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const withRail = (window: any) => {
  const el = window.document.createElement("aside");
  el.id = "projects-rail";
  el.hidden = true;
  window.document.body.appendChild(el);
  const search = window.document.createElement("input");
  search.id = "rail-search";
  window.document.body.appendChild(search);
};

const row = (id: string, cwd: string, name: string, updatedAt = 1, extra: Record<string, unknown> = {}) =>
  ({ id, cwd, displayName: name, rawSummary: "", updatedAt, createdAt: 1, numMessages: 2, ...extra });

describe("Add <folder> to Projects?", () => {
  it.each([false, true])("is a strip above the message box with three answers (remote=%s)", (remote) => {
    const h = bootWebview({ remote });
    dispatch(h.window, { type: "session", sessionId: "c1", provider: "grok", models: [] });
    dispatch(h.window, { type: "projectPrompt", sessionId: "c1", cwd: "/scratch/notes", label: "notes" });
    const strip = h.doc.querySelector("footer.composer .project-prompt") as HTMLElement;
    expect(strip).toBeTruthy();
    // Inline, not a dialog.
    expect(h.doc.querySelector(".modal, [role=dialog].project-prompt")).toBeNull();
    expect(strip.querySelector(".project-prompt-text")!.textContent).toBe("Add notes to Projects?");
    expect([...strip.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Add", "Not now", "Never for this folder"]);
    click(h.window, [...strip.querySelectorAll("button")][0] as HTMLElement);
    expect(h.posted).toContainEqual({ type: "addToProjects", cwd: "/scratch/notes" });
    expect(h.doc.querySelector(".project-prompt")).toBeNull();
  });

  it("posts the other answers, goes when another view answered, and ignores another conversation", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "session", sessionId: "c1", provider: "grok", models: [] });
    const ask = () => dispatch(h.window, { type: "projectPrompt", sessionId: "c1", cwd: "/scratch/notes", label: "notes" });
    const buttons = () => [...h.doc.querySelectorAll(".project-prompt button")] as HTMLElement[];
    ask();
    click(h.window, buttons()[2]);
    expect(h.posted).toContainEqual({ type: "answerProjectPrompt", cwd: "/scratch/notes", choice: "never" });
    ask();
    click(h.window, buttons()[1]);
    expect(h.posted).toContainEqual({ type: "answerProjectPrompt", cwd: "/scratch/notes", choice: "notNow" });
    // The phone answered: the desk's strip goes too.
    ask();
    dispatch(h.window, { type: "projectPrompt", sessionId: "c1", cwd: "/scratch/notes", label: "notes", done: true });
    expect(h.doc.querySelector(".project-prompt")).toBeNull();
    // About a conversation this view is not showing.
    dispatch(h.window, { type: "projectPrompt", sessionId: "other", cwd: "/scratch/x", label: "x" });
    expect(h.doc.querySelector(".project-prompt")).toBeNull();
    // Leaving the conversation takes its question with it.
    ask();
    dispatch(h.window, { type: "session", sessionId: "c2", provider: "grok", models: [] });
    expect(h.doc.querySelector(".project-prompt")).toBeNull();
  });
});

function railBoot(entries: unknown[]) {
  const h = bootWebview({ remote: true, beforeScripts: withRail });
  dispatch(h.window, { type: "repos", entries, selectedCwd: "", activeCwd: "" });
  return h;
}
const openRecent = (h: ReturnType<typeof bootWebview>) => {
  const btn = [...h.doc.querySelectorAll(".rail-head-btn")].find((b) => (b.textContent || "").includes("Recent")) as HTMLElement;
  click(h.window, btn);
};

describe("Recent's Add to Projects", () => {
  it("is offered on a conversation whose folder the host can add, and posts it", () => {
    const h = railBoot([{ cwd: "/work/alpha", label: "alpha", available: true, pinned: false, updatedAt: 1 }]);
    dispatch(h.window, { type: "recentSessions", dots: {}, entries: [
      row("x1", "/scratch/notes", "outside", 9, { addableCwd: "/scratch/notes" }),
      row("a1", "/work/alpha", "inside", 8),
    ] });
    openRecent(h);
    const menuFor = (id: string) => {
      const target = h.doc.querySelector(`.rail-list.rail-recent .rail-session[data-session-id="${id}"]`) as HTMLElement;
      const btn = target.querySelector(".rail-session-menu, .rail-action-btn, [aria-haspopup]") as HTMLElement;
      click(h.window, btn);
      return [...h.doc.querySelectorAll(".rail-menu-item")] as HTMLElement[];
    };
    const outside = menuFor("x1");
    const add = outside.find((el) => (el.textContent || "").includes("Add to Projects"))!;
    expect(add).toBeTruthy();
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menuFor("a1").some((el) => (el.textContent || "").includes("Add to Projects"))).toBe(false);
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    click(h.window, menuFor("x1").find((el) => (el.textContent || "").includes("Add to Projects"))!);
    expect(h.posted).toContainEqual({ type: "addToProjects", cwd: "/scratch/notes" });
  });
});

describe("no projects yet", () => {
  const LINE = "Your projects appear here. Open a folder, create one, or add one from Recent.";
  it("says where projects come from, also while Recent is showing", () => {
    const empty = bootWebview({
      beforeScripts: (w) => {
        w.document.body.classList.add("desk");
        withRail(w);
      },
    });
    dispatch(empty.window, { type: "initialState", effort: "", cwd: "", useCtrlEnter: false, extVersion: "0", capabilities: { addProjectFolder: true } });
    dispatch(empty.window, { type: "repos", entries: [], selectedCwd: "", activeCwd: "" });
    expect(empty.doc.getElementById("projects-rail")!.textContent).toContain(LINE);
    dispatch(empty.window, { type: "recentSessions", dots: {}, entries: [row("x1", "/scratch/notes", "outside", 9)] });
    const text = empty.doc.getElementById("projects-rail")!.textContent || "";
    expect(text).toContain("Recent");
    expect(text).toContain("Projects");
    expect(text).toContain(LINE);
  });

  it("keeps a phone's rail up for Recent when the host has no projects yet", () => {
    const h = railBoot([]);
    expect(h.doc.getElementById("projects-rail")!.hidden).toBe(true);
    dispatch(h.window, { type: "recentSessions", dots: {}, entries: [row("x1", "/scratch/notes", "outside", 9)] });
    expect(h.doc.getElementById("projects-rail")!.hidden).toBe(false);
    expect(h.doc.getElementById("projects-rail")!.textContent).toContain(LINE);
  });
});
