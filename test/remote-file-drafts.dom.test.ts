/**
 * Unsaved edits in the phone's file editor survive leaving the file.
 *
 * Three paths tore the viewer down and dropped the draft on the floor without
 * asking: "Back to files", any directory navigation, and a repo switch. The
 * editor has an explicit **Cancel**; that is the discard, and it should be the
 * only one — navigating away is not a decision about text you just typed.
 *
 * The keying matters as much as the parking: a draft is held against the repo it
 * was read from, so switching projects can never surface project A's text in a
 * same-named file under project B.
 *
 * Memory only, deliberately — see the comment above stashRemoteFileDraft in
 * chat.js. Unsaved text survives navigating away and is defended by a
 * confirmation on reload/close; it does not survive the OS killing the tab.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bootWebview, dispatch, click, type Harness } from "./webview-harness";

const CWD_A = "/work/app";
const CWD_B = "/work/relay";

function remoteHost(): Harness {
  const h = bootWebview({ remote: true });
  // Cancel asks before discarding. Tests that are not about the question answer
  // it yes by default; the ones that are override this.
  (h.window as never as { confirm: () => boolean }).confirm = () => true;
  dispatch(h.window, {
    type: "initialState",
    cwd: CWD_A,
    capabilities: { browseProjectFiles: true, editProjectFiles: true },
  } as never);
  dispatch(h.window, {
    type: "repos",
    entries: [
      { cwd: CWD_A, label: "app", available: true, pinned: false, updatedAt: 2 },
      { cwd: CWD_B, label: "relay", available: true, pinned: false, updatedAt: 1 },
    ],
    selectedCwd: CWD_A,
    activeCwd: CWD_A,
  } as never);
  return h;
}

function openPanel(h: Harness) {
  click(h.window, h.doc.getElementById("files-browse-btn")!);
}

/**
 * Ask for a file the way the panel does — click its row in the listing.
 *
 * The client only accepts a `projectFileContent` for a read it actually issued
 * (one request, one answer), so a test that dispatches the answer out of the
 * blue is testing nothing. This drives the real request first.
 */
function openFile(h: Harness, relPath: string, cwd = CWD_A) {
  dispatch(h.window, {
    type: "projectDirListing",
    ok: true,
    cwd,
    relPath: "",
    entries: [{ name: relPath, kind: "file", relPath }],
    truncated: false,
  } as never);
  const row = [...h.doc.querySelectorAll(".files-browse-row")].find(
    (r) => (r.textContent || "").includes(relPath),
  );
  expect(row, `no row for ${relPath}`).toBeTruthy();
  click(h.window, row!);
}

/**
 * The host's answer alone — for cases where the code under test already issued
 * the read (Reload), or where the point IS that no read was issued.
 */
function answerFile(
  h: Harness,
  relPath: string,
  text: string,
  cwd = CWD_A,
  stamp: { mtimeMs: number; size: number } = { mtimeMs: 1, size: text.length },
) {
  dispatch(h.window, {
    type: "projectFileContent",
    ok: true,
    cwd,
    kind: "text",
    relPath,
    text,
    stamp,
    absPath: `/abs/${relPath}`,
  } as never);
}

/** Open a file the way a user does, and let the host answer. */
function sendFile(h: Harness, relPath: string, text: string, cwd = CWD_A) {
  openFile(h, relPath, cwd);
  dispatch(h.window, {
    type: "projectFileContent",
    ok: true,
    cwd,
    kind: "text",
    relPath,
    text,
    stamp: { mtimeMs: 1, size: text.length },
    absPath: `/abs/${relPath}`,
  } as never);
}

function editor(h: Harness) {
  return h.doc.querySelector(".files-browse-editor") as HTMLTextAreaElement | null;
}

function type(h: Harness, value: string) {
  const ta = editor(h)!;
  ta.value = value;
  ta.dispatchEvent(new (h.window as never as { Event: typeof Event }).Event("input", { bubbles: true }));
}

function beginEdit(h: Harness, relPath: string, text: string, typed: string, cwd = CWD_A) {
  sendFile(h, relPath, text, cwd);
  click(h.window, h.doc.querySelector(".files-browse-viewer-head .files-browse-action")!);
  type(h, typed);
}

// Leaving the file parks the text — no discard, so no question.
const back = (h: Harness) =>
  click(h.window, h.doc.querySelector(".files-browse-viewer-head .icon-btn")!);

/** Cancel — the one action that throws the edit away, so the one that asks. */
const cancel = (h: Harness) => {
  const actions = [...h.doc.querySelectorAll(".files-browse-viewer-head .files-browse-action")];
  click(h.window, actions.find((b) => b.textContent === "Cancel")!);
};

describe("remote file drafts", () => {
  it("brings the draft back after Back to files", () => {
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    back(h);
    expect(h.doc.querySelector(".files-browse-editor")).toBeNull();

    sendFile(h, "notes.md", "one");
    expect(editor(h)?.value).toBe("one two");
  });

  it("saves against the version the draft was written on, not the fresh read", () => {
    // The baseline travels WITH the draft. Adopting whatever stamp the reopen
    // returns hands the mtime+size fence a valid ticket for an edit based on
    // content that no longer exists, so a desk-side change made while the draft
    // was parked would be overwritten without a word. A stale stamp is not a
    // false alarm: when nothing changed it still matches exactly.
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two"); // read at mtime 1
    back(h);

    // Reopened — and someone edited the file at the desk in the meantime.
    openFile(h, "notes.md");
    answerFile(h, "notes.md", "changed at the desk", CWD_A, { mtimeMs: 999, size: 19 });
    expect(h.doc.querySelector(".files-browse-notice")?.textContent || "").toContain(
      "changed since",
    );

    click(h.window, h.doc.querySelector(".files-browse-action-primary")!);
    const write = h.posted.find((m) => m.type === "writeProjectFile") as
      | { stamp: { mtimeMs: number } }
      | undefined;
    // The stamp the draft was based on, so the host refuses and offers
    // Reload / Overwrite instead of clobbering the desk's change.
    expect(write?.stamp.mtimeMs).toBe(1);
  });

  it("saves normally when the file did not move while the draft was parked", () => {
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    back(h);
    sendFile(h, "notes.md", "one"); // same content, same stamp

    const notice = h.doc.querySelector(".files-browse-notice")?.textContent || "";
    expect(notice).toContain("Unsaved changes");
    expect(notice).not.toContain("changed since");
    click(h.window, h.doc.querySelector(".files-browse-action-primary")!);
    const write = h.posted.find((m) => m.type === "writeProjectFile") as
      | { stamp: { mtimeMs: number }; text: string }
      | undefined;
    expect(write?.text).toBe("one two");
    expect(write?.stamp.mtimeMs).toBe(1);
  });

  it("does not leak a draft into another project's same-named file", () => {
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "SECRET FROM A");

    // Switching repos tears the viewer down; the draft belongs to A.
    dispatch(h.window, {
      type: "repos",
      entries: [
        { cwd: CWD_A, label: "app", available: true, pinned: false, updatedAt: 2 },
        { cwd: CWD_B, label: "relay", available: true, pinned: false, updatedAt: 1 },
      ],
      selectedCwd: CWD_B,
      activeCwd: CWD_B,
    } as never);

    sendFile(h, "notes.md", "relay's own notes", CWD_B);
    expect(editor(h)).toBeNull();
    const body = h.doc.querySelector(".files-browse-viewer-body")?.textContent || "";
    expect(body).not.toContain("SECRET FROM A");
    expect(body).toContain("relay's own notes");
  });

  it("Cancel still discards, and the discard is not undone by reopening", () => {
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    cancel(h);
    back(h);

    sendFile(h, "notes.md", "one");
    expect(editor(h)).toBeNull();
    expect(h.doc.querySelector(".files-browse-viewer-body")?.textContent).toContain("one");
  });

  it("drops the parked copy once the save lands", () => {
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    click(h.window, h.doc.querySelector(".files-browse-action-primary")!);
    dispatch(h.window, {
      type: "projectFileWriteResult",
      ok: true,
      cwd: CWD_A,
      relPath: "notes.md",
      stamp: { mtimeMs: 2, size: 7 },
    } as never);
    back(h);

    // Reopening shows what is on disk, with no phantom edit waiting.
    sendFile(h, "notes.md", "one two");
    expect(editor(h)).toBeNull();
  });
});

describe("late answers from the project you left", () => {
  const switchTo = (h: Harness, cwd: string) =>
    dispatch(h.window, {
      type: "repos",
      entries: [
        { cwd: CWD_A, label: "app", available: true, pinned: false, updatedAt: 2 },
        { cwd: CWD_B, label: "relay", available: true, pinned: false, updatedAt: 1 },
      ],
      selectedCwd: cwd,
      activeCwd: cwd,
    } as never);

  it("does not render project A's file under project B", () => {
    // The per-request correlation matched an answer against the repo the REQUEST
    // was made in, which is exactly the repo we just left.
    const h = remoteHost();
    openPanel(h);
    switchTo(h, CWD_B);
    answerFile(h, "notes.md", "PROJECT A CONTENTS", CWD_A);
    const shown = h.doc.querySelector(".files-browse-viewer-body")?.textContent || "";
    expect(shown).not.toContain("PROJECT A CONTENTS");
  });

  it("does not let A's save result mark B's unsaved draft clean", () => {
    // The work-loss half: a stale "Saved." cleared the dirty flag on a draft
    // that had never been written anywhere, so navigating away discarded it as
    // if it were on disk.
    const h = remoteHost();
    openPanel(h);
    switchTo(h, CWD_B);
    beginEdit(h, "notes.md", "b text", "b text edited", CWD_B);

    dispatch(h.window, {
      type: "projectFileWriteResult",
      ok: true,
      cwd: CWD_A,
      relPath: "notes.md",
      stamp: { mtimeMs: 5, size: 6 },
    } as never);

    // Still dirty, still in the editor, nothing claiming it was saved.
    expect(editor(h)?.value).toBe("b text edited");
    expect(h.doc.querySelector(".files-browse-viewer-name")?.textContent).toContain("•");
    expect(h.doc.querySelector(".files-browse-notice")?.textContent || "").not.toContain("Saved");
  });
});

describe("typing while a save is in flight", () => {
  it("does not claim the later keystrokes were saved", () => {
    // The textarea stays editable during "Saving…", and the host only ever
    // received the text captured when Save was clicked. Taking the live draft
    // as "what is on disk" marked those later keystrokes clean — the UI said
    // Saved, the host had never seen them, and leaving then discarded them.
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    click(h.window, h.doc.querySelector(".files-browse-action-primary")!);
    type(h, "one two three"); // still typing while it saves

    dispatch(h.window, {
      type: "projectFileWriteResult",
      ok: true,
      cwd: CWD_A,
      relPath: "notes.md",
      stamp: { mtimeMs: 9, size: 7 },
    } as never);

    // Still dirty, still editable, Save live again, and the notice says so.
    expect(editor(h)?.value).toBe("one two three");
    expect(
      (h.doc.querySelector(".files-browse-action-primary") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(h.doc.querySelector(".files-browse-notice")?.textContent || "").toContain(
      "typed more since",
    );

    // And the unsent tail survives leaving the file.
    back(h);
    sendFile(h, "notes.md", "one two");
    expect(editor(h)?.value).toBe("one two three");
  });

  it("still settles clean when nothing was typed after Save", () => {
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    click(h.window, h.doc.querySelector(".files-browse-action-primary")!);
    dispatch(h.window, {
      type: "projectFileWriteResult",
      ok: true,
      cwd: CWD_A,
      relPath: "notes.md",
      stamp: { mtimeMs: 9, size: 7 },
    } as never);
    expect(editor(h)).toBeNull();
    expect(h.doc.querySelector(".files-browse-notice")?.textContent).toBe("Saved.");
  });
});

describe("nothing evicts a parked draft", () => {
  it("keeps every abandoned file's text, however many there are", () => {
    // Two bounds were tried and both were worse than none: a count cap dropped
    // the ninth file without a word, and a size cap announced the loss after
    // destroying the text — while exempting the newest draft, so it did not
    // actually bound anything. A resource limit that deletes unsaved work is
    // the bug with a budget.
    const h = remoteHost();
    openPanel(h);
    const names = Array.from({ length: 12 }, (_, i) => `f${i}.md`);
    for (const n of names) {
      beginEdit(h, n, "base", `edited ${n}`);
      back(h);
    }
    for (const n of names) {
      sendFile(h, n, "base");
      expect(editor(h)?.value, n).toBe(`edited ${n}`);
      back(h);
    }
  });

  it("holds a large draft rather than trading it for a smaller one", () => {
    const h = remoteHost();
    openPanel(h);
    const big = "x".repeat(1_200_000);
    beginEdit(h, "big-a.md", "base", big + "A");
    back(h);
    beginEdit(h, "big-b.md", "base", big + "B");
    back(h);

    sendFile(h, "big-a.md", "base");
    expect(editor(h)?.value.endsWith("A")).toBe(true);
  });
});

describe("leaving the page", () => {
  const unload = (h: Harness) => {
    const e = new (h.window as never as { Event: typeof Event }).Event("beforeunload", {
      cancelable: true,
    });
    h.window.dispatchEvent(e as never);
    return e;
  };

  it("asks before a reload takes unsaved file edits with it", () => {
    // Drafts are memory-only, so a refresh really is a discard — the last path
    // where typed work vanished with nobody asked, and the easiest to hit: a
    // phone reloads a backgrounded tab by itself.
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    expect(unload(h).defaultPrevented).toBe(true);
  });

  it("still asks once the draft is parked rather than on screen", () => {
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    back(h);
    expect(unload(h).defaultPrevented).toBe(true);
  });

  it("stays out of the way when nothing is unsaved", () => {
    // A prompt that always fires is a prompt nobody reads.
    const h = remoteHost();
    openPanel(h);
    sendFile(h, "notes.md", "one"); // opened, never edited
    expect(unload(h).defaultPrevented).toBe(false);
  });

  it("does not warn about composer text, which survives a reload anyway", () => {
    const h = remoteHost();
    const input = h.doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "a prompt I was typing";
    expect(unload(h).defaultPrevented).toBe(false);
  });
});

describe("a closed panel is not a frozen one", () => {
  it("drops the previous project's file even while the panel is shut", () => {
    // The switch handler cleared the viewer only when the panel was OPEN, and
    // reopening skips the directory request whenever a viewer exists. Close in
    // A, switch to B, reopen — and A's file was sitting there under B.
    const h = remoteHost();
    openPanel(h);
    sendFile(h, "notes.md", "PROJECT A CONTENTS");
    // Close the panel with its own close button.
    click(h.window, h.doc.querySelector(".files-browse-close")!);

    dispatch(h.window, {
      type: "repos",
      entries: [
        { cwd: CWD_A, label: "app", available: true, pinned: false, updatedAt: 2 },
        { cwd: CWD_B, label: "relay", available: true, pinned: false, updatedAt: 1 },
      ],
      selectedCwd: CWD_B,
      activeCwd: CWD_B,
    } as never);

    openPanel(h);
    const shown = h.doc.querySelector(".files-browse-viewer-body")?.textContent || "";
    expect(shown).not.toContain("PROJECT A CONTENTS");
    // …and it asks the host for the new project's root rather than showing stale rows.
    expect(
      h.posted.filter((m) => m.type === "listProjectDir" && m.cwd === CWD_B).length,
    ).toBeGreaterThan(0);
  });

  it("still parks the unsaved draft when the panel was closed first", () => {
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    click(h.window, h.doc.querySelector(".files-browse-close")!);
    dispatch(h.window, {
      type: "repos",
      entries: [
        { cwd: CWD_A, label: "app", available: true, pinned: false, updatedAt: 2 },
        { cwd: CWD_B, label: "relay", available: true, pinned: false, updatedAt: 1 },
      ],
      selectedCwd: CWD_B,
      activeCwd: CWD_B,
    } as never);
    // Back in A, the text is still there.
    dispatch(h.window, {
      type: "repos",
      entries: [
        { cwd: CWD_A, label: "app", available: true, pinned: false, updatedAt: 2 },
        { cwd: CWD_B, label: "relay", available: true, pinned: false, updatedAt: 1 },
      ],
      selectedCwd: CWD_A,
      activeCwd: CWD_A,
    } as never);
    openPanel(h);
    sendFile(h, "notes.md", "one");
    expect(editor(h)?.value).toBe("one two");
  });
});

describe("a parked draft is not consumed by reading it", () => {
  it("survives a second answer for the same file", () => {
    // Two reads of one file can both be in flight — open it, Back, open it
    // again — and answers are matched on cwd+path with no request id echoed by
    // the host. Consuming the draft on the first answer left nothing for the
    // second, which then replaced the editor with the disk version.
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    back(h);

    sendFile(h, "notes.md", "one");
    expect(editor(h)?.value).toBe("one two");
    // The duplicate answer for the same request.
    sendFile(h, "notes.md", "one");
    expect(editor(h)?.value).toBe("one two");
  });

  it("lets go once the text is typed back to what is on disk", () => {
    // Non-consuming reads mean nothing else would ever clear a draft that has
    // become identical to the file.
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    type(h, "one"); // undone
    back(h);

    sendFile(h, "notes.md", "one");
    expect(editor(h)).toBeNull();
  });

  it("does not resurrect a cancelled edit when the file is reopened", () => {
    // Cancel used to drop the parked draft while the viewer was still marked
    // dirty, and the payload written on the way past includes the live dirty
    // editor — so the call meant to remove the text put it straight back.
    //
    // This assertion is the point of the test: an earlier version of it clicked
    // Cancel and then checked nothing at all, so a regression where Cancel stops
    // discarding would have kept it green.
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    cancel(h);

    back(h);
    sendFile(h, "notes.md", "one");
    expect(editor(h), "a cancelled edit must not come back").toBeNull();
    expect(h.doc.querySelector(".files-browse-viewer-body")?.textContent).toContain("one");
  });
});

describe("a duplicated tab", () => {
  it("does not inherit the original's unsaved file edits", () => {
    // Duplicating a tab clones the whole of sessionStorage. The collision
    // handler already mints a fresh token and drops the copied conversation;
    // drafts are copied state too, and were left behind.
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "SECRET FROM TAB A");
    back(h);

    // The collision path is driven by a BroadcastChannel handshake that this
    // harness does not stand up, so the wiring is asserted at the source: the
    // one function that replaces a cloned tab's identity must also drop the
    // cloned drafts, right beside where it drops the cloned conversation.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.js"),
      "utf8",
    );
    const at = src.indexOf("function replaceRemoteTabIdentity()");
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, at + 900);
    expect(fn).toContain("saveRememberedRemoteSession(null)");
    expect(fn).toContain("clearRemoteFileDrafts()");
  });

  it("keeps no draft anywhere a duplicated tab could read", () => {
    // Held in memory only, a draft cannot be inherited at all: memory is not
    // cloned by tab duplication and there is no storage key left to copy. Worth
    // pinning as a property — if durable storage ever comes back, it has to be
    // cleared on identity replacement again.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.js"),
      "utf8",
    );
    expect(src).not.toContain("REMOTE_DRAFTS_STORAGE_KEY");
    const at = src.indexOf("function clearRemoteFileDrafts()");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toMatch(/state\.filesBrowse\.drafts = \[\]/);
  });
});

describe("taking the host's version", () => {
  it("Reload actually discards the parked draft", () => {
    // Drafts stopped being consumed on read, so the re-read found this one and
    // put it straight back — the one control that promises to discard could
    // not discard.
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "my edit");
    back(h);
    // Reopen; the desk has changed the file since, so Save conflicts.
    openFile(h, "notes.md");
    answerFile(h, "notes.md", "changed at the desk", CWD_A, { mtimeMs: 999, size: 19 });
    click(h.window, h.doc.querySelector(".files-browse-action-primary")!);
    dispatch(h.window, {
      type: "projectFileWriteResult",
      ok: false,
      cwd: CWD_A,
      relPath: "notes.md",
      reason: "changed", // the stamp-mismatch reason that raises the conflict UI
    } as never);

    const reload = [...h.doc.querySelectorAll(".files-browse-action")].find(
      (b) => b.textContent === "Reload",
    ) as HTMLButtonElement | undefined;
    expect(reload, "a conflict must offer Reload").toBeTruthy();
    reload!.click(); // issues its own read

    answerFile(h, "notes.md", "changed at the desk", CWD_A, { mtimeMs: 999, size: 19 });
    expect(editor(h)).toBeNull();
    expect(h.doc.querySelector(".files-browse-viewer-body")?.textContent).toContain(
      "changed at the desk",
    );
  });

  it("notices a desk-side change from the stamp, not from a second copy", () => {
    // "Has the file moved?" is the stamp's question — the same mtime+size the
    // save fence uses — so a parked draft never carries a full copy of the file
    // it was based on.
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.js"),
      "utf8",
    );
    expect(src).not.toContain("baseText");

    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    back(h);
    sendFile(h, "notes.md", "one"); // same stamp back → no "changed since" claim
    expect(h.doc.querySelector(".files-browse-notice")?.textContent || "").not.toContain(
      "changed since",
    );
  });
});

describe("a save result that cannot be matched to a request", () => {
  it("is ignored rather than believed about the current text", () => {
    // No request id on the wire, and Back clears the correlation. The handler
    // used to fall through and take the LIVE draft as "what was written": save,
    // Back, reopen, type more, and the late result marked the newer text clean
    // while the disk held only the earlier body.
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "first save");
    click(h.window, h.doc.querySelector(".files-browse-action-primary")!);
    back(h); // clears _pendingWrite

    sendFile(h, "notes.md", "one");
    type(h, "newer text typed after");

    dispatch(h.window, {
      type: "projectFileWriteResult",
      ok: true,
      cwd: CWD_A,
      relPath: "notes.md",
      stamp: { mtimeMs: 5, size: 10 },
    } as never);

    // Still dirty, still unsaved, and nothing claiming otherwise.
    expect(editor(h)?.value).toBe("newer text typed after");
    expect(h.doc.querySelector(".files-browse-notice")?.textContent || "").not.toContain("Saved");
    back(h);
    sendFile(h, "notes.md", "one");
    expect(editor(h)?.value).toBe("newer text typed after");
  });
});

describe("throwing an edit away", () => {
  const withConfirm = (h: Harness, answer: boolean) => {
    const seen: string[] = [];
    (h.window as never as { confirm: (m: string) => boolean }).confirm = (m) => {
      seen.push(m);
      return answer;
    };
    return seen;
  };

  it("Cancel asks first, in the desktop panel's words", () => {
    // The desktop asks here (`cancelChanges`) and this panel did not. An earlier
    // attempt hung the question on a close-the-file button instead, which meant
    // inventing a tab that could never have a sibling.
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    const asked = withConfirm(h, true);

    cancel(h);
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain("Cancel changes?");
    expect(editor(h)).toBeNull();

    // Gone for real — reopening shows the file, not the edit.
    back(h);
    sendFile(h, "notes.md", "one");
    expect(editor(h)).toBeNull();
  });

  it("keeps the edit when the answer is no", () => {
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    withConfirm(h, false);
    cancel(h);
    expect(editor(h)?.value).toBe("one two");
  });

  it("does not ask when there is nothing unsaved", () => {
    const h = remoteHost();
    openPanel(h);
    sendFile(h, "notes.md", "one");
    click(h.window, h.doc.querySelector(".files-browse-viewer-head .files-browse-action")!);
    const asked = withConfirm(h, true);
    cancel(h);
    expect(asked).toEqual([]);
  });

  it("leaving the file asks nothing and keeps the text", () => {
    const h = remoteHost();
    openPanel(h);
    beginEdit(h, "notes.md", "one", "one two");
    const asked = withConfirm(h, false);

    back(h);
    expect(asked).toEqual([]);
    sendFile(h, "notes.md", "one");
    expect(editor(h)?.value).toBe("one two");
  });

  it("shows no tab bar — one file at a time is not a tab", () => {
    const h = remoteHost();
    openPanel(h);
    sendFile(h, "notes.md", "one");
    expect(h.doc.querySelector(".files-browse-tabs")).toBeNull();
    expect(h.doc.querySelector(".files-browse-tab")).toBeNull();
  });
});
