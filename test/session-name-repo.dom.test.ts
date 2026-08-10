/**
 * The project label beside the conversation name in the VS Code chat header.
 *
 * VS Code history was pinned to the open folder, so the conversation name always
 * implied "in this workspace". The rail made history multi-workspace — a
 * conversation from any discovered project can be resumed without reloading the
 * window — and at that point the header stopped saying where you are.
 *
 * Two rules this file exists to hold: the label follows the CONVERSATION's cwd
 * (not the host's), and it stays out of the way when there is nothing to
 * disambiguate or when the name is being edited.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const REPOS = [
  { cwd: "/work/app", label: "app", available: true, pinned: false, updatedAt: 2 },
  { cwd: "/work/relay", label: "relay", available: true, pinned: false, updatedAt: 1 },
];

/** `workspaceCwd` is the folder the EDITOR has open — the label's whole test. */
function sendRepos(h: Harness, entries = REPOS, workspaceCwd = "/work/app") {
  dispatch(h.window, {
    type: "repos",
    entries,
    selectedCwd: "/work/app",
    activeCwd: "/work/app",
    workspaceCwd,
  } as never);
}

function nameSession(h: Harness, cwd: string, name = "Some conversation") {
  dispatch(h.window, { type: "sessionName", sessionId: "s1", name, cwd } as never);
}

const tag = (h: Harness) => h.doc.getElementById("session-name-repo") as HTMLElement;

describe("session name project label", () => {
  it("names the conversation's own project, not the host's", () => {
    const h = bootWebview();
    sendRepos(h);
    // Host is in /work/app; the open conversation belongs to the other project.
    nameSession(h, "/work/relay");
    expect(tag(h).hidden).toBe(false);
    expect(tag(h).textContent).toBe("relay");
    expect(tag(h).title).toBe("/work/relay");
  });

  it("uses the catalog label, which is the only thing that separates same-named leaves", () => {
    const h = bootWebview();
    sendRepos(h, [
      { cwd: "/a/site", label: "acme/site", available: true, pinned: false, updatedAt: 2 },
      { cwd: "/b/site", label: "beta/site", available: true, pinned: false, updatedAt: 1 },
    ]);
    nameSession(h, "/b/site");
    expect(tag(h).textContent).toBe("beta/site");
  });

  it("stays quiet when the conversation is in the folder VS Code has open", () => {
    // There the window title already says it, and the line is noise. The label
    // exists to say "this conversation is somewhere else".
    const h = bootWebview();
    sendRepos(h, REPOS, "/work/app");
    nameSession(h, "/work/app");
    expect(tag(h).hidden).toBe(true);
  });

  it("appears once the catalog says which folder the editor has open", () => {
    // The catalog usually lands after the name; the header has to catch up.
    const h = bootWebview();
    nameSession(h, "/work/relay");
    sendRepos(h, REPOS, "/work/app");
    expect(tag(h).hidden).toBe(false);
    expect(tag(h).textContent).toBe("relay");
  });

  it("stays put while the name is being edited", () => {
    // It is a second ROW now rather than something competing with the rename
    // input for width, so hiding it would only make the chip jump.
    const h = bootWebview();
    sendRepos(h, REPOS, "/work/app");
    nameSession(h, "/work/relay");
    expect(tag(h).hidden).toBe(false);

    const label = h.doc.getElementById("session-name-label")!;
    label.dispatchEvent(new (h.window as never as { MouseEvent: typeof MouseEvent }).MouseEvent(
      "click",
      { bubbles: true, cancelable: true },
    ));
    expect(h.doc.querySelector(".session-name-input")).toBeTruthy();
    expect(tag(h).hidden).toBe(false);
    expect(tag(h).textContent).toBe("relay");
  });

  it("puts the rename pencil beside the NAME, not under the project line", () => {
    // Grid auto-placement, and the reason the pencil ended up on a third row:
    // the project line spans both columns, so it takes row 2 and moves the
    // placement cursor past row 1 — anything placing itself after it lands on
    // row 3. Both cells have to be placed explicitly.
    const css = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    const chip = css.slice(css.indexOf(".session-name-chip {"));
    const repoRule = chip.slice(chip.indexOf(".session-name-chip > .session-name-repo"));
    expect(repoRule.slice(0, repoRule.indexOf("}"))).toMatch(/grid-row:\s*2/);
    const editRule = chip.slice(chip.indexOf(".session-name-chip > .session-name-edit"));
    expect(editRule.indexOf("{")).toBeGreaterThan(-1);
    const editBody = editRule.slice(0, editRule.indexOf("}"));
    expect(editBody).toMatch(/grid-column:\s*2/);
    expect(editBody).toMatch(/grid-row:\s*1/);
  });

  it("is not mounted on the remote client, which shows the project on its own line", () => {
    const h = bootWebview({ remote: true });
    sendRepos(h);
    nameSession(h, "/work/relay");
    // #session-head-sub is the remote surface for this; the chip is desk-only.
    expect(tag(h).hidden).toBe(true);
  });
});
