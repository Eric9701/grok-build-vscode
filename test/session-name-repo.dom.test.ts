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
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const REPOS = [
  { cwd: "/work/app", label: "app", available: true, pinned: false, updatedAt: 2 },
  { cwd: "/work/relay", label: "relay", available: true, pinned: false, updatedAt: 1 },
];

function sendRepos(h: Harness, entries = REPOS) {
  dispatch(h.window, {
    type: "repos",
    entries,
    selectedCwd: "/work/app",
    activeCwd: "/work/app",
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

  it("stays hidden with a single project — nothing to disambiguate", () => {
    const h = bootWebview();
    sendRepos(h, [REPOS[0]]);
    nameSession(h, "/work/app");
    expect(tag(h).hidden).toBe(true);
  });

  it("appears when a second project shows up, without a new sessionName frame", () => {
    const h = bootWebview();
    sendRepos(h, [REPOS[0]]);
    nameSession(h, "/work/app");
    expect(tag(h).hidden).toBe(true);
    // The catalog usually lands after the name; the header has to catch up.
    sendRepos(h);
    expect(tag(h).hidden).toBe(false);
    expect(tag(h).textContent).toBe("app");
  });

  it("gets out of the way while the name is being edited", () => {
    const h = bootWebview();
    sendRepos(h);
    nameSession(h, "/work/relay");
    expect(tag(h).hidden).toBe(false);

    const label = h.doc.getElementById("session-name-label")!;
    label.dispatchEvent(new (h.window as never as { MouseEvent: typeof MouseEvent }).MouseEvent(
      "click",
      { bubbles: true, cancelable: true },
    ));
    // The rename input takes the chip's full width; a label wedged beside it is
    // what pushed the field narrower than the name it replaced (see chat.css).
    expect(h.doc.querySelector(".session-name-input")).toBeTruthy();
    expect(tag(h).hidden).toBe(true);
  });

  it("is not mounted on the remote client, which shows the project on its own line", () => {
    const h = bootWebview({ remote: true });
    sendRepos(h);
    nameSession(h, "/work/relay");
    // #session-head-sub is the remote surface for this; the chip is desk-only.
    expect(tag(h).hidden).toBe(true);
  });
});
