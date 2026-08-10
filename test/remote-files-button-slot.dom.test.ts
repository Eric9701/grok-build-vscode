/**
 * Where the "Project files" button mounts.
 *
 * It used to be appended unconditionally to `.top-bar`. On the browser client
 * that bar is hidden outright once a rail exists (`body.has-rail .top-bar {
 * display: none }` in the relay's chat.html) — the conversation's controls move
 * into `#session-head` there. So the button was built into a hidden element: it
 * showed for the frame before the repo catalog arrived, then vanished, and the
 * remote file browser was unreachable on every browser wide enough for a rail.
 *
 * The ordering is the trap and the reason this is a test rather than a comment:
 * capabilities arrive on `initialState`, `repos` arrives later, and the button
 * is therefore always built while `.top-bar` is still the correct answer.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const withRail = (window: any) => {
  const doc = window.document;
  const rail = doc.createElement("aside");
  rail.id = "projects-rail";
  rail.hidden = true;
  const scroll = doc.createElement("div");
  scroll.id = "rail-scroll";
  rail.appendChild(scroll);
  doc.body.appendChild(rail);
  // The relay's own conversation header. Only that page has it, which is why
  // chat.js selects on presence rather than on a host name or a version.
  const head = doc.createElement("header");
  head.id = "session-head";
  const title = doc.createElement("span");
  title.id = "session-head-title";
  head.appendChild(title);
  const sub = doc.createElement("span");
  sub.id = "session-head-sub";
  head.appendChild(sub);
  const history = doc.createElement("button");
  history.id = "session-history";
  head.appendChild(history);
  doc.body.appendChild(head);
};

/** A remote host that advertises the file browser, exactly as the relay does. */
function remoteWithFiles(before?: (w: any) => void): Harness {
  const h = bootWebview({ remote: true, beforeScripts: before });
  dispatch(h.window, {
    type: "initialState",
    cwd: "/proj",
    capabilities: { browseProjectFiles: true, editProjectFiles: true },
  } as never);
  return h;
}

function sendRepos(h: Harness) {
  dispatch(h.window, {
    type: "repos",
    entries: [{ cwd: "/proj", label: "proj", available: true, pinned: false, updatedAt: 1 }],
    selectedCwd: "/proj",
    activeCwd: "/proj",
  } as never);
}

describe("remote files button placement", () => {
  it("sits last in the top bar, behind a separator, when the page has no rail", () => {
    // A panel toggle, placed like the desktop panel's: at the end, after a
    // separator. It used to sit between History and the overflow, where it read
    // as one more conversation action.
    const h = remoteWithFiles();
    const btn = h.doc.getElementById("files-browse-btn");
    expect(btn).toBeTruthy();
    const bar = btn!.closest(".top-bar");
    expect(bar).toBeTruthy();
    expect(bar!.lastElementChild).toBe(btn);
    expect(btn!.previousElementSibling?.id).toBe("files-browse-sep");
  });

  it("moves out of the hidden top bar into the session head when the rail arrives", () => {
    const h = remoteWithFiles(withRail);
    // Built before `repos` — the top bar is still the right home at this point.
    const btn = h.doc.getElementById("files-browse-btn")!;
    expect(btn.closest(".top-bar")).toBeTruthy();

    sendRepos(h);

    expect(h.doc.body.classList.contains("has-rail")).toBe(true);
    // The regression: still parented to the now-`display:none` bar.
    expect(btn.closest(".top-bar")).toBeNull();
    expect(btn.parentElement?.id).toBe("session-head");
    expect(btn.parentElement!.lastElementChild).toBe(btn);
    expect(btn.previousElementSibling?.id).toBe("files-browse-sep");
    expect((btn as HTMLButtonElement).hidden).toBe(false);
  });

  it("does not stack duplicates when the rail re-renders", () => {
    const h = remoteWithFiles(withRail);
    sendRepos(h);
    sendRepos(h);
    sendRepos(h);
    expect(h.doc.querySelectorAll("#files-browse-btn").length).toBe(1);
    expect(h.doc.querySelectorAll("#files-browse-sep").length).toBe(1);
    expect(h.doc.getElementById("session-head")!.lastElementChild).toBe(
      h.doc.getElementById("files-browse-btn"),
    );
  });

  it("mounts nothing when the host does not advertise the capability", () => {
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    dispatch(h.window, { type: "initialState", cwd: "/proj", capabilities: {} } as never);
    sendRepos(h);
    const btn = h.doc.getElementById("files-browse-btn") as HTMLButtonElement | null;
    // Either never built, or built and hidden — both are correct; a visible
    // control the host cannot answer is not.
    expect(btn === null || btn.hidden).toBe(true);
  });
});
