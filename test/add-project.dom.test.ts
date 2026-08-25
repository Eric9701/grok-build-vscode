/**
 * Add project, in the real webview.
 *
 * Three ways in, three surfaces. What only a DOM run can show is the wiring:
 * that the menu carries what THIS host offers, that the form posts a name or a
 * URL and never a path, that a failure keeps the form open with something the
 * user can act on, and that a host too old to know any of this still gets the
 * folder picker it always had.
 *
 * The VS Code projects rail is a second renderer of the same shared menu and
 * form (media/webview-helpers.js); test/vscode-projects-rail.dom.test.ts covers
 * that one.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

const CAPS = {
  uploadFile: true,
  remoteVoice: true,
  addProjectFolder: true,
  createProject: true,
  cloneProject: true,
};

function boot(opts: { remote?: boolean; caps?: Record<string, unknown>; coding?: boolean } = {}) {
  const h = bootWebview({ remote: opts.remote });
  dispatch(h.window, {
    type: "initialState",
    effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "3.17.2",
    showThinking: false, expandCommandOutputs: false, steerByDefault: false,
    soundNotifications: false, processingSound: false, readRepliesAloud: false,
    appPurpose: opts.coding ? "coding" : "knowledge",
    capabilities: opts.caps ?? CAPS,
  });
  dispatch(h.window, { type: "projectSetup", root: "~/Grok Build" });
  h.posted.length = 0;
  return h;
}

/** The rail's + button is only mounted on a rail-bearing surface, so drive the
 *  same entry point the no-project empty state uses. */
function openMenu(h: Harness) {
  h.window.eval(`document.body.__openAddProject()`);
}

const menuItems = (h: Harness) =>
  [...h.doc.querySelectorAll(".rail-menu-item")].map(
    (el) => (el.querySelector(".rail-menu-label") || el).textContent?.trim() || "",
  );
const form = (h: Harness) => h.doc.querySelector(".add-project-form") as HTMLElement | null;
const input = (h: Harness) => h.doc.querySelector(".add-project-input") as HTMLInputElement;
const dest = (h: Harness) => (h.doc.querySelector(".add-project-dest")?.textContent || "").trim();
const problem = (h: Harness) => h.doc.querySelector(".add-project-error") as HTMLElement | null;
const fix = (h: Harness) => h.doc.querySelector(".add-project-fix") as HTMLButtonElement | null;
const submit = (h: Harness) =>
  h.doc.querySelector(".add-project-primary") as HTMLButtonElement;

/** Expose the menu opener the rail button would call. chat.js keeps it inside
 *  its IIFE, so reach it the way the onboarding card does. */
function installOpener(h: Harness) {
  h.window.eval(`
    document.body.__openAddProject = () => {
      const card = document.getElementById("welcome-onboarding");
      card.innerHTML = '<button class="onb-action" type="button" data-act="addProjectFolder">Add project folder</button>';
      card.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };
  `);
}

describe("add project", () => {
  it("offers naming and importing in Knowledge work", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    expect(menuItems(h)).toEqual(["New project", "Import a folder"]);
  });

  it("adds cloning in Coding, at the top, and takes nothing away", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    expect(menuItems(h)).toEqual(["Clone from GitHub", "New project", "Import a folder"]);
  });

  it("explains each entry, because they differ by a verb", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    const descriptions = [...h.doc.querySelectorAll(".rail-menu-desc")].map((el) => el.textContent);
    expect(descriptions).toEqual(["Name it. We make the folder.", "Choose one you already have."]);
  });

  it("stays a plain picker on a host that offers nothing else", () => {
    // An older host advertises `addProjectFolder` alone. One way in is a click,
    // not a menu that asks permission to be a click.
    const h = boot({ caps: { uploadFile: true, remoteVoice: true, addProjectFolder: true } });
    installOpener(h);
    openMenu(h);
    expect(h.doc.querySelector(".rail-menu")).toBeNull();
    expect(h.posted).toContainEqual({ type: "addProjectFolder" });
  });

  it("still opens the picker when capabilities have not arrived yet", () => {
    // The no-project card can be on screen before `initialState` lands, and its
    // button has to do something.
    const h = bootWebview();
    installOpener(h);
    openMenu(h);
    expect(h.posted).toContainEqual({ type: "addProjectFolder" });
  });

  it("hides importing from a phone but keeps the other two", () => {
    // Opening a native picker is host-local — there is no dialog for a remote to
    // see. Naming and cloning send a name and a URL, so the host decides where.
    const h = boot({ remote: true, coding: true });
    installOpener(h);
    openMenu(h);
    expect(menuItems(h)).toEqual(["Clone from GitHub", "New project"]);
  });

  it("shows the destination as you type, and posts a NAME", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    expect(form(h)).toBeTruthy();
    expect(dest(h)).toBe("~/Grok Build/…");
    input(h).value = "Q3 Positioning";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(dest(h)).toBe("~/Grok Build/Q3 Positioning");
    click(h.window, submit(h));
    expect(h.posted).toContainEqual({ type: "createProject", name: "Q3 Positioning" });
    // A name, never a path. That is what lets this reach the host from a phone.
    expect(JSON.stringify(h.posted)).not.toContain("/Grok Build/");
  });

  it("previews the folder a clone URL implies, and posts the URL", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    input(h).value = "https://github.com/phuryn/grok-remote.git";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(dest(h)).toBe("~/Grok Build/grok-remote");
    click(h.window, submit(h));
    expect(h.posted).toContainEqual({
      type: "cloneProject",
      url: "https://github.com/phuryn/grok-remote.git",
    });
  });

  it("refuses to submit an empty field", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    expect(submit(h).disabled).toBe(true);
    click(h.window, submit(h));
    expect(h.posted.some((m) => m.type === "createProject")).toBe(false);
  });

  it("says what it is doing while the host works", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", busy: "clone" });
    expect(submit(h).textContent).toBe("Cloning…");
    expect(submit(h).disabled).toBe(true);
    expect(input(h).disabled).toBe(true);
  });

  it("keeps the form open on failure, with the error to read", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup", root: "~/Grok Build", error: '"Q3" is already in ~/Grok Build.',
    });
    expect(form(h)).toBeTruthy();
    expect(problem(h)?.hidden).toBe(false);
    expect(problem(h)?.textContent).toContain("already in");
    // No fix offered for a failure nothing can fix for them.
    expect(fix(h)?.hidden).toBe(true);
  });

  it("offers to sign in to GitHub when that is what would fix it", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "auth-gh",
    });
    expect(fix(h)?.hidden).toBe(false);
    expect(fix(h)?.textContent).toBe("Sign in to GitHub");
    click(h.window, fix(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "auth" });
    // The form stays up: signing in happens in a terminal, and the user comes
    // back here to try again.
    expect(form(h)).toBeTruthy();
  });

  it("names the install command when the CLI is missing", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "install-gh",
      fixCommand: "winget install --id GitHub.cli -e",
    });
    // Nobody should be asked to approve a command they cannot read.
    expect(fix(h)?.textContent).toContain("winget install --id GitHub.cli -e");
    click(h.window, fix(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "install" });
  });

  it("clears a stale fix when the next failure does not earn one", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", error: "auth", fix: "auth-gh" });
    expect(fix(h)?.hidden).toBe(false);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", error: "Could not resolve host." });
    expect(fix(h)?.hidden).toBe(true);
  });

  it("closes only on done — not on a failure that also stopped being busy", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", error: "nope" });
    expect(form(h)).toBeTruthy();
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", done: true });
    expect(form(h)).toBeNull();
  });

  it("closes on Escape and on Cancel", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    const cancel = h.doc.querySelector(".add-project-btn:not(.add-project-primary)") as HTMLElement;
    click(h.window, cancel);
    expect(form(h)).toBeNull();

    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    expect(form(h)).toBeTruthy();
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(form(h)).toBeNull();
  });

  it("stops listening for Escape once the form is gone", () => {
    // Capture-phase listener: leaving it attached would swallow Escape
    // everywhere else in the app for the rest of the session.
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    let reached = false;
    h.doc.addEventListener("keydown", () => { reached = true; });
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(reached).toBe(true);
  });
});
