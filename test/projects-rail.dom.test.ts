import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bootWebview, click, dispatch } from "./webview-harness";

// The rail is the relay page's surface: `#projects-rail` lives in web/chat.html,
// never in the extension's getHtml(). So the harness has to add the mount the way
// the browser client does — and the absence of that element is exactly what keeps
// VS Code free of it.
const withRail = (window: any) => {
  const el = window.document.createElement("aside");
  el.id = "projects-rail";
  el.hidden = true;
  window.document.body.appendChild(el);
  // The relay page's search box lives in the same shell, and the rail's filter
  // reads it directly — so the mount is only faithful with it.
  const search = window.document.createElement("input");
  search.id = "rail-search";
  window.document.body.appendChild(search);
};

// Two available repos besides the selected one, so a fan-out is actually
// observable — with a single eligible repo the probe and the fan-out look alike.
const repos = [
  { cwd: "/work/alpha", label: "alpha", available: true, pinned: false, updatedAt: 30 },
  { cwd: "/work/beta", label: "beta", available: true, pinned: true, pinnedAt: 5, updatedAt: 10 },
  { cwd: "/work/gamma", label: "gamma", available: true, pinned: false, updatedAt: 20 },
  { cwd: "/mnt/offline", label: "offline", available: false, pinned: false, updatedAt: 0 },
];

const sessionsFrame = (entries: unknown[], total = entries.length) => ({
  type: "sessions",
  entries,
  activeId: null,
  dots: {},
  offset: 0,
  total,
  hasMore: false,
  nextOffset: entries.length,
  query: "",
});

const row = (id: string, cwd: string, name: string, updatedAt = 1) =>
  ({ id, cwd, displayName: name, rawSummary: "", updatedAt, createdAt: 1, numMessages: 2 });

function boot(selectedCwd = "/work/alpha") {
  const h = bootWebview({ remote: true, beforeScripts: withRail });
  dispatch(h.window, { type: "repos", entries: repos, selectedCwd, activeCwd: selectedCwd });
  return h;
}

const rail = (doc: Document) => doc.getElementById("projects-rail") as HTMLElement;
const repoNames = (doc: Document) =>
  [...doc.querySelectorAll(".rail-repo-label")].map((e) => e.textContent);
const sessionNames = (doc: Document, repoIndex: number) =>
  [...doc.querySelectorAll(".rail-repo")[repoIndex].querySelectorAll(".rail-session-name")]
    .map((e) => e.textContent);

// Row actions live behind a ⋯ menu now, parented to <body> (the rail scrolls, so
// a menu inside it would be clipped) — hence the document-level lookup.
const openMenu = (window: any, host: Element) => {
  click(window, host.querySelector(".rail-menu-btn") as HTMLElement);
  return window.document.querySelector(".rail-menu") as HTMLElement;
};
const menuItem = (menu: Element, label: string) =>
  [...menu.querySelectorAll(".rail-menu-item")]
    .find((b) => (b.textContent || "").includes(label)) as HTMLElement | undefined;

describe("projects rail", () => {
  it("does not mount without a #projects-rail element, even when repos arrives", () => {
    // Regression guard for VS Code: getHtml never includes the mount, so a
    // `repos` frame (sent for clear-all naming) must not light a rail column.
    const { doc, window, posted } = bootWebview({});
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(doc.body.classList.contains("has-rail")).toBe(false);
    expect(doc.querySelectorAll(".rail-repo")).toHaveLength(0);
    expect(posted.filter((p) => p.type === "listRepoSessions")).toEqual([]);
  });

  it("mounts for a non-remote host when the rail element exists and repos arrives", () => {
    // Desktop multi-folder: no IS_REMOTE, but host shipped the mount + catalog.
    // Capability gate is mount + reposKnown — not the remote flag.
    const { doc, window } = bootWebview({ beforeScripts: withRail });
    expect(rail(doc).hidden).toBe(true);
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(rail(doc).hidden).toBe(false);
    expect(doc.body.classList.contains("has-rail")).toBe(true);
    expect(repoNames(doc)).toContain("alpha");
  });

  it("stays hidden until the host proves it speaks `repos`", () => {
    const { doc, posted } = bootWebview({ remote: true, beforeScripts: withRail });
    expect(rail(doc).hidden).toBe(true);
    // No catalog means no probe: an older host must not be sent a dead frame
    // before it has even shown that it knows about repos.
    expect(posted.filter((p) => p.type === "listRepoSessions")).toEqual([]);
  });

  // Recency and nothing else. `beta` carries pinned:true in the fixture on
  // purpose: the rail deliberately IGNORES repo pins (the VS Code picker still
  // offers them), because for projects the one you touched last is the one you
  // want, and a second ordering rule only costs the eye.
  it("lists projects by last activity, ignoring repo pins", () => {
    const { doc } = boot();
    expect(rail(doc).hidden).toBe(false);
    expect(repoNames(doc)).toEqual(["alpha", "gamma", "beta", "offline"]);
  });

  // "Last activity" means the newest CONVERSATION, not the catalog's own stamp —
  // which is the mtime of the project's session directory, and clearing a
  // project's history writes to that directory. So the one project that
  // demonstrably had nothing recent was presented as the most recent thing you
  // had done. Once its rows are known to be gone, it has no activity at all.
  it("does not promote a project whose history was just cleared", () => {
    const catalog = [
      // gamma's directory was touched by the clear itself, so its catalog stamp
      // is the freshest number in the rail.
      { cwd: "/work/gamma", label: "gamma", available: true, pinned: false, updatedAt: 900 },
      { cwd: "/work/alpha", label: "alpha", available: true, pinned: false, updatedAt: 100 },
      { cwd: "/work/beta", label: "beta", available: true, pinned: false, updatedAt: 90 },
    ];
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(repoNames(h.doc)).toEqual(["gamma", "alpha", "beta"]);

    dispatch(h.window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 500)]));
    dispatch(h.window, {
      type: "repoSessions", cwd: "/work/beta", entries: [row("b1", "/work/beta", "beta one", 400)], dots: {}, total: 1,
    });
    // The host's answer for the emptied project: no rows.
    dispatch(h.window, { type: "repoSessions", cwd: "/work/gamma", entries: [], dots: {}, total: 0 });

    expect(repoNames(h.doc)).toEqual(["alpha", "beta", "gamma"]);
  });

  // The project you are working in must not sink while its list is in flight:
  // an empty holder is the state before the first `sessions` frame, not proof of
  // an empty project.
  it("keeps the selected project in place until its own list arrives", () => {
    const { doc } = boot("/work/alpha");
    expect(repoNames(doc)[0]).toBe("alpha");
  });

  // Cold start used to leave the selected project on "No sessions yet" while
  // sibling `repoSessions` previews filled in — because `railSelectedRows`
  // starts empty and was treated as a known-empty list. Empty + unknown must
  // read as loading; empty only after an unfiltered `sessions` frame is real.
  it("shows Loading for the selected project until sessions arrives, not No sessions yet", () => {
    const { doc, window } = boot("/work/alpha");
    const notes = () => {
      const alpha = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      return [...alpha.querySelectorAll(".rail-note")].map((e) => e.textContent);
    };
    expect(notes()).toContain("Loading…");
    expect(notes()).not.toContain("No sessions yet");

    dispatch(window, sessionsFrame([]));
    expect(notes()).toContain("No sessions yet");

    dispatch(window, sessionsFrame([row("a1", "/work/alpha", "real history", 9)]));
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["real history"]);
  });

  // Two empty projects tie on activity, and the tie used to break on the
  // catalog's own stamp — the session directory's mtime, which CLEARING a
  // project touches. So the just-emptied one still climbed above its equally
  // empty neighbours: the same bug, one rank smaller.
  it("does not let the cleared project win the tie between empty ones", () => {
    const catalog = [
      { cwd: "/work/zed", label: "zed", available: true, pinned: false, updatedAt: 10 },
      // Freshly cleared: nothing in it, and the newest directory stamp in the rail.
      { cwd: "/work/acme", label: "acme", available: true, pinned: false, updatedAt: 999 },
    ];
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/zed", activeCwd: "/work/zed" });
    dispatch(h.window, sessionsFrame([]));
    dispatch(h.window, { type: "repoSessions", cwd: "/work/acme", entries: [], dots: {}, total: 0 });

    expect(repoNames(h.doc)).toEqual(["acme", "zed"]); // by name, not by mtime
  });

  // A project we have looked at and found empty has nothing to clear, so the
  // menu says so on its face rather than taking the click and answering with a
  // notice in whatever conversation happens to be open elsewhere.
  it("disables Clear all history for a project known to be empty", () => {
    const { doc, window, posted } = boot();
    dispatch(window, { type: "repoSessions", cwd: "/work/beta", entries: [], dots: {}, total: 0 });

    const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    const clear = menuItem(openMenu(window, beta), "Clear all history");
    expect((clear as HTMLButtonElement).disabled).toBe(true);
    click(window, clear as HTMLElement);
    expect(posted.filter((p) => p.type === "clearAllSessions")).toEqual([]);

    // …and stays available where rows are merely unknown: "not loaded" is not
    // "empty", and disabling there would strand a project behind a dead control.
    const gamma = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("gamma")];
    const gammaClear = menuItem(openMenu(window, gamma), "Clear all history");
    expect((gammaClear as HTMLButtonElement).disabled).toBe(false);
  });

  // Clearing a project the host has not SELECTED is a repo-addressed act, and an
  // extension that predates that drops the message without a word — no error, no
  // deletion. The rail appears against those hosts (they send `repos`), so the
  // control has to wait for proof that the cwd on these messages is read at all.
  // Where you already are is never gated: that always worked.
  it("withholds cross-project Clear all until the host proves it reads the cwd", () => {
    const { doc, window, posted } = boot();

    const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    const dead = menuItem(openMenu(window, beta), "Clear all history") as HTMLButtonElement;
    expect(dead.disabled).toBe(true);
    // Host-neutral: this page drives the VS Code extension OR the desktop app,
    // and cannot tell which, so it must not name one of them.
    expect(dead.title).toContain("Update Grok Build");
    expect(dead.title).not.toContain("the Grok extension");
    click(window, dead);
    expect(posted.filter((p) => p.type === "clearAllSessions")).toEqual([]);

    // The project you are in is offered regardless — no probe is even sent for
    // it, so gating it on one would disable it forever on a single-project box.
    // It is also offered before its own list has arrived: an empty row-holder is
    // the state before the first frame, not proof of an empty project.
    const alpha = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    expect((menuItem(openMenu(window, alpha), "Clear all history") as HTMLButtonElement).disabled)
      .toBe(false);

    // One answered probe is the proof.
    dispatch(window, {
      type: "repoSessions", cwd: "/work/beta", entries: [row("b1", "/work/beta", "beta one", 4)], dots: {}, total: 1,
    });
    const live = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    expect((menuItem(openMenu(window, live), "Clear all history") as HTMLButtonElement).disabled)
      .toBe(false);
  });

  // The degrade path — the whole reason the rail reads the selected repo from
  // `sessions` instead of demanding its own frame. A host that never answers
  // `listRepoSessions` must still produce a usable rail.
  it("works against a host that never answers listRepoSessions", () => {
    const { doc, window, posted } = boot();
    dispatch(window, sessionsFrame([
      row("a1", "/work/alpha", "alpha newest", 9),
      row("a2", "/work/alpha", "alpha older", 8),
    ]));

    // The selected repo has rows without any preview frame ever arriving.
    const alphaIndex = repoNames(doc).indexOf("alpha");
    expect(sessionNames(doc, alphaIndex)).toEqual(["alpha newest", "alpha older"]);

    // And the client probed ONCE, not once per repo — an unanswered probe is one
    // dead frame, not a fan-out repeated on every catalog push.
    expect(posted.filter((p) => p.type === "listRepoSessions")).toHaveLength(1);

    // A second catalog must not re-probe repos already asked about.
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(posted.filter((p) => p.type === "listRepoSessions")).toHaveLength(1);
    expect(rail(doc).hidden).toBe(false);
  });

  // A host too old to answer `listRepoSessions` replies with silence, and the
  // probe only ever names ONE repo — so every other repo would spin forever with
  // nothing coming. After the deadline the rail says what to do about it.
  it("tells you to update the host when the probe goes unanswered", async () => {
    const h = bootWebview({
      remote: true,
      beforeScripts: (w: any) => { withRail(w); w.__grokRailProbeTimeoutMs = 5; },
    });
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    dispatch(h.window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));

    await new Promise((r) => setTimeout(r, 40));

    const notes = [...h.doc.querySelectorAll(".rail-note")].map((e) => e.textContent);
    // Every repo we are not in — including the ones never probed, which is the
    // half that used to hang.
    expect(notes.filter((t) => t === "Update Grok Build to preview")).toHaveLength(2);
    expect(notes).not.toContain("Loading…");
    // The repo we ARE in still shows its sessions: that list needs no new frame.
    expect(sessionNames(h.doc, repoNames(h.doc).indexOf("alpha"))).toEqual(["alpha one"]);
  });

  it("never shows that hint to a host that does answer", async () => {
    const h = bootWebview({
      remote: true,
      beforeScripts: (w: any) => { withRail(w); w.__grokRailProbeTimeoutMs = 5; },
    });
    dispatch(h.window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    dispatch(h.window, {
      type: "repoSessions", cwd: "/work/beta", entries: [row("b1", "/work/beta", "beta one", 4)], dots: {}, total: 1,
    });

    await new Promise((r) => setTimeout(r, 40));

    const notes = [...h.doc.querySelectorAll(".rail-note")].map((e) => e.textContent);
    expect(notes).not.toContain("Update Grok Build to preview");
  });

  it("fans out to the remaining repos only once a preview comes back", () => {
    const { doc, window, posted } = boot();
    const probes = () => posted.filter((p) => p.type === "listRepoSessions").map((p) => p.cwd);
    expect(probes()).toHaveLength(1);

    // Whichever repo the probe picked — asserting on the probe rather than on a
    // hardcoded name keeps this independent of the rail's ordering rule.
    const probed = probes()[0];
    dispatch(window, {
      type: "repoSessions",
      cwd: probed,
      entries: [row("p1", probed, "first preview", 4)],
      dots: {},
      total: 1,
    });

    // The answer proves the capability; the rest of the catalog is now worth asking.
    expect(probes().length).toBeGreaterThan(1);
    const probedLabel = repos.find((r) => r.cwd === probed)!.label;
    expect(sessionNames(doc, repoNames(doc).indexOf(probedLabel))).toEqual(["first preview"]);
  });

  it("previews three sessions per repo and expands in place", () => {
    const { doc, window } = boot();
    dispatch(window, sessionsFrame([
      row("a1", "/work/alpha", "one", 9),
      row("a2", "/work/alpha", "two", 8),
      row("a3", "/work/alpha", "three", 7),
      row("a4", "/work/alpha", "four", 6),
    ]));
    const alphaIndex = repoNames(doc).indexOf("alpha");
    expect(sessionNames(doc, alphaIndex)).toEqual(["one", "two", "three"]);

    const more = doc.querySelectorAll(".rail-repo")[alphaIndex].querySelector(".rail-more") as HTMLElement;
    // One step, no counters — never "Show N more" (three disagreeing totals).
    expect(more.textContent).toBe("Show more");
    expect(more.textContent).not.toMatch(/\d/);
    click(window, more);
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["one", "two", "three", "four"]);
    const less = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")]
      .querySelector(".rail-more") as HTMLElement;
    expect(less.textContent).toBe("Show less");
    expect(less.textContent).not.toMatch(/\d/);
  });

  it("reopens a session in its own repo, carrying that session's cwd", () => {
    const { doc, window, posted } = boot();
    dispatch(window, {
      type: "repoSessions",
      cwd: "/work/beta",
      entries: [row("b1", "/work/beta/sub", "beta one", 4)],
      dots: {},
      total: 1,
    });
    const betaIndex = repoNames(doc).indexOf("beta");
    const session = doc.querySelectorAll(".rail-repo")[betaIndex].querySelector(".rail-session") as HTMLElement;
    click(window, session);
    expect(posted.filter((p) => p.type === "resumeSession")).toEqual([
      // The session's OWN cwd, not the repo row's — a worktree session lives in a
      // deeper checkout and the host resolves sessions by cwd.
      { type: "resumeSession", id: "b1", cwd: "/work/beta/sub" },
    ]);
  });

  // The catalog naming the new repo arrives before that repo's session list, so
  // without a guard the rail paints the previous project's conversations under
  // the new project's name.
  it("never shows the previous repo's sessions under the repo just switched to", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha secret", 9)]));
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["alpha secret"]);

    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/beta", activeCwd: "/work/beta" });
    // Beta has no preview of its own here, so it shows nothing — and crucially
    // NOT alpha's conversation, which is the bleed this guards.
    expect(sessionNames(doc, repoNames(doc).indexOf("beta"))).toEqual([]);
    // Alpha keeps its own rows as a sibling rather than dropping to a spinner:
    // we already hold them, and walking away is not a reason to forget them.
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["alpha secret"]);

    // ...and the real list restores rows.
    dispatch(window, sessionsFrame([row("b1", "/work/beta", "beta one", 4)]));
    expect(sessionNames(doc, repoNames(doc).indexOf("beta"))).toEqual(["beta one"]);
  });

  // With the history popover searching, the host's unfiltered first page is
  // rejected by the popover (it wants its filtered view back). That page is the
  // only unfiltered one the rail will see, so dropping it wholesale left the rail
  // pinned on "Loading…" until the search was cleared or the page refreshed.
  it("still fills after a repo switch made with a history search open", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));

    // Open history and type a query.
    click(window, doc.getElementById("history-btn") as HTMLElement);
    const search = doc.querySelector(".history-search") as HTMLInputElement;
    search.value = "beta";
    search.dispatchEvent(new (window as any).Event("input", { bubbles: true }));

    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/beta", activeCwd: "/work/beta" });
    // The host's unfiltered list for the new repo — what the popover rejects.
    dispatch(window, sessionsFrame([row("b1", "/work/beta", "beta one", 4)]));

    expect(sessionNames(doc, repoNames(doc).indexOf("beta"))).toEqual(["beta one"]);
  });

  // Switching INTO a repo we already previewed must show what we know at once —
  // the rows are in hand, so a spinner there would be theatre.
  it("keeps the repo you switch into showing the sessions already known", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
    dispatch(window, {
      type: "repoSessions", cwd: "/work/beta", entries: [row("b1", "/work/beta", "beta one", 4)], dots: {}, total: 1,
    });

    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/beta", activeCwd: "/work/beta" });
    const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    expect([...beta.querySelectorAll(".rail-session-name")].map((e) => e.textContent)).toEqual(["beta one"]);
    // No spinner in the section we switched INTO. (Repos we have never previewed
    // still show one — they really have nothing yet.)
    expect(beta.querySelector(".rail-note")).toBe(null);
  });

  // Two caps deep: the host's `total` counts hidden subagent rows, and expansion
  // itself stops at RAIL_EXPANDED. The control never prints a count (scar: a
  // "Show 25 more" once revealed 17 and stranded 8).
  it("reveals up to the expand cap with an unnumbered Show more", () => {
    const { doc, window } = boot();
    dispatch(window, sessionsFrame(
      Array.from({ length: 28 }, (_, i) => row(`a${i}`, "/work/alpha", `s${i}`, 100 - i)),
    ));
    const more = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")]
      .querySelector(".rail-more") as HTMLElement;
    expect(more.textContent).toBe("Show more");
    expect(more.textContent).not.toMatch(/\d/);
    click(window, more);
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toHaveLength(20);
  });

  // `total` counts index slots including subagent sessions the host hides, so a
  // count-derived button can promise rows that do not exist.
  it("never offers a Show-more that reveals nothing", () => {
    const { doc, window } = boot();
    dispatch(window, {
      type: "repoSessions",
      cwd: "/work/beta",
      // The host counted 7 index slots but only 2 are user sessions — the rest
      // are hidden subagent rows. Expanding could never produce a third.
      entries: [row("b1", "/work/beta", "one", 4), row("b2", "/work/beta", "two", 3)],
      dots: {},
      total: 7,
    });
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    expect([...section.querySelectorAll(".rail-session-name")].map((e) => e.textContent))
      .toEqual(["one", "two"]);
    expect(section.querySelector(".rail-more")).toBe(null);
  });

  // The host folds path case only on Windows, because only there is it
  // insignificant. A client that folded everywhere merged two real Linux
  // checkouts into one identity — so one project rendered the other's
  // conversations, and clicking a row acted on the wrong checkout.
  it("keeps POSIX repos that differ only by case apart", () => {
    const cased = [
      { cwd: "/work/Foo", label: "Foo", available: true, pinned: false, updatedAt: 30 },
      { cwd: "/work/foo", label: "foo", available: true, pinned: false, updatedAt: 20 },
    ];
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    dispatch(h.window, { type: "repos", entries: cased, selectedCwd: "/work/Foo", activeCwd: "/work/Foo" });
    // Newer than the sibling's stamp: the rail orders projects by their newest
    // CONVERSATION, and a fixture whose session predates the sibling's catalog
    // entry would be asserting an order the sort no longer promises.
    dispatch(h.window, sessionsFrame([row("f1", "/work/Foo", "upper only", 30)]));

    expect(repoNames(h.doc)).toEqual(["Foo", "foo"]);
    expect(sessionNames(h.doc, 0)).toEqual(["upper only"]);
    // The lower-case sibling is a different repo and must not borrow those rows.
    expect(sessionNames(h.doc, 1)).toEqual([]);
  });

  // A backslash is an ordinary filename character on POSIX, so it must not be
  // read as Windows syntax and normalised away.
  it("keeps POSIX repos apart when their names contain a backslash", () => {
    const odd = [
      { cwd: "/srv/Foo\\bar", label: "Foo-bar", available: true, pinned: false, updatedAt: 30 },
      { cwd: "/srv/foo\\bar", label: "foo-bar", available: true, pinned: false, updatedAt: 20 },
    ];
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    dispatch(h.window, { type: "repos", entries: odd, selectedCwd: "/srv/Foo\\bar", activeCwd: "/srv/Foo\\bar" });
    dispatch(h.window, sessionsFrame([row("o1", "/srv/Foo\\bar", "upper only", 30)]));

    expect(sessionNames(h.doc, 0)).toEqual(["upper only"]);
    expect(sessionNames(h.doc, 1)).toEqual([]);
  });

  it("still treats Windows repos spelled differently as one", () => {
    const cased = [
      { cwd: "C:\\Work\\Alpha\\", label: "Alpha", available: true, pinned: false, updatedAt: 30 },
    ];
    const h = bootWebview({ remote: true, beforeScripts: withRail });
    // The host's own frames vary drive-letter case and slash direction freely.
    dispatch(h.window, { type: "repos", entries: cased, selectedCwd: "c:/work/alpha", activeCwd: "c:/work/alpha" });
    dispatch(h.window, sessionsFrame([row("w1", "C:\\Work\\Alpha", "windows row", 9)]));
    expect(sessionNames(h.doc, 0)).toEqual(["windows row"]);
  });

  // Projects are not pinnable here at all: no marker, no menu item. The menu
  // carries only the destructive act, which is the one thing worth hiding behind
  // an extra click.
  it("offers no way to pin a project, and no marker for one", () => {
    const { doc, window } = boot();
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
    expect(section.querySelector(".rail-pin-mark")).toBe(null);
    const menu = openMenu(window, section.querySelector(".rail-repo-head") as HTMLElement);
    expect(menuItem(menu, "Pin project")).toBe(undefined);
    expect(menuItem(menu, "Clear all history")).not.toBe(undefined);
  });

  // Nothing marks the live or the selected project — the highlighted
  // conversation locates it, and the header names it.
  it("marks neither the live nor the selected project", () => {
    const { doc } = boot();
    expect(doc.querySelector(".rail-repo-live")).toBe(null);
    expect(doc.querySelector(".rail-repo.selected")).toBe(null);
  });

  describe("pinned conversations", () => {
    const pinnedFrame = (entries: unknown[]) => ({ type: "pinnedSessions", entries, dots: {} });
    const pinned = (id: string, cwd: string, name: string, at: number) =>
      ({ ...row(id, cwd, name), pinnedAt: at });

    it("shows no Pinned group until something is pinned", () => {
      const { doc } = boot();
      expect([...doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent)).toEqual(["Projects"]);
    });

    it("lifts pinned conversations above Projects, newest pin first", () => {
      const { doc, window } = boot();
      dispatch(window, pinnedFrame([
        pinned("b1", "/work/beta", "beta thing", 20),
        pinned("a1", "/work/alpha", "alpha thing", 10),
      ]));
      const heads = [...doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent);
      // RECENT also lists pinned rows (duplication intentional).
      expect(heads[0]).toBe("Pinned");
      expect(heads).toContain("Projects");
      expect(heads).toContain("Recent");
      expect([...doc.querySelectorAll(".rail-pinned .rail-session-name")].map((e) => e.textContent))
        .toEqual(["beta thing", "alpha thing"]);
    });

    // Out of its project, a row has to say where it came from — two "Untitled"
    // conversations are otherwise identical, and opening the wrong one moves the tab.
    it("names each pinned row's repo", () => {
      const { doc, window } = boot();
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta thing", 20)]));
      expect(doc.querySelector(".rail-pinned .rail-session-repo")?.textContent).toBe("beta");
    });

    // Two checkouts can share a leaf name; the host already disambiguates them
    // in the catalog, so the pinned row must use that label rather than
    // recomputing a leaf and showing "project" twice.
    it("uses the catalog's disambiguated repo label", () => {
      const { doc, window } = boot();
      const dupes = [
        { cwd: "/work/client/proj", label: "client/proj", available: true, pinned: false, updatedAt: 30 },
        { cwd: "/work/archive/proj", label: "archive/proj", available: true, pinned: false, updatedAt: 20 },
      ];
      dispatch(window, { type: "repos", entries: dupes, selectedCwd: "/work/client/proj", activeCwd: "/work/client/proj" });
      dispatch(window, pinnedFrame([
        pinned("p1", "/work/client/proj", "one", 20),
        pinned("p2", "/work/archive/proj", "two", 10),
      ]));
      expect([...doc.querySelectorAll(".rail-pinned .rail-session-repo")].map((e) => e.textContent))
        .toEqual(["client/proj", "archive/proj"]);
    });

    it("reopens a pinned conversation in its own repo", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta/sub", "beta thing", 20)]));
      click(window, doc.querySelector(".rail-pinned .rail-session") as HTMLElement);
      expect(posted.filter((p) => p.type === "resumeSession")).toEqual([
        { type: "resumeSession", id: "b1", cwd: "/work/beta/sub" },
      ]);
    });

    // A host that never sends `pinnedSessions` drops `toggleSessionPin`, so a
    // pin offered there is a control that does nothing. Capability, not version.
    // The menu itself still exists — rename and delete do not depend on pinning.
    it("offers no pin control against a host that never mentions pinning", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const menu = openMenu(window, doc.querySelector(".rail-session") as HTMLElement);
      expect(menuItem(menu, "Pin conversation")).toBe(undefined);
      expect(menuItem(menu, "Rename")).not.toBe(undefined);
      // The rows themselves still work — only the one affordance is withheld.
      expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["alpha one"]);
    });

    it("offers the pin once the host has proved it handles pinning", () => {
      const { doc, window } = boot("/work/alpha");
      // An EMPTY frame is proof enough — that is what a capable host with no
      // pins yet sends, and it must not be mistaken for silence.
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const menu = openMenu(window, doc.querySelector(".rail-session") as HTMLElement);
      expect(menuItem(menu, "Pin conversation")).not.toBe(undefined);
    });

    it("pins from an ordinary project row, naming that row's own repo", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha/wt", "alpha one", 9)]));
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const menu = openMenu(window, section.querySelector(".rail-session") as HTMLElement);
      click(window, menuItem(menu, "Pin conversation")!);
      expect(posted.filter((p) => p.type === "toggleSessionPin")).toEqual([
        { type: "toggleSessionPin", id: "a1", cwd: "/work/alpha/wt", pinned: true },
      ]);
    });

    // The Pinned group is where a pinned conversation is unpinned — there is no
    // pin glyph on the row any more, so the group IS the statement that it is
    // pinned, and its menu is where that is undone.
    it("unpins from the Pinned group", () => {
      const { doc, window, posted } = boot();
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta thing", 20)]));
      const menu = openMenu(window, doc.querySelector(".rail-pinned .rail-session") as HTMLElement);
      click(window, menuItem(menu, "Unpin conversation")!);
      expect(posted.filter((p) => p.type === "toggleSessionPin")).toEqual([
        { type: "toggleSessionPin", id: "b1", cwd: "/work/beta", pinned: false },
      ]);
    });

    it("shows a filled pin on pinned rows and outline on others (hover control)", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta thing", 20)]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const pinnedBtn = doc.querySelector(".rail-pinned .rail-pin-btn") as HTMLElement;
      expect(pinnedBtn).toBeTruthy();
      expect(pinnedBtn.classList.contains("active")).toBe(true);
      // Filled variant uses fill="currentColor" on the pin head path.
      expect(pinnedBtn.innerHTML).toMatch(/fill="currentColor"/);
      const projectRow = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")]
        .querySelector(".rail-pin-btn") as HTMLElement;
      expect(projectRow).toBeTruthy();
      expect(projectRow.classList.contains("active")).toBe(false);
      expect(projectRow.innerHTML).not.toMatch(/fill="currentColor"/);
    });

    it("pins from the session-row hover control in one click", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha/wt", "alpha one", 9)]));
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const pinBtn = section.querySelector(".rail-pin-btn") as HTMLElement;
      click(window, pinBtn);
      expect(posted.filter((p) => p.type === "toggleSessionPin")).toEqual([
        { type: "toggleSessionPin", id: "a1", cwd: "/work/alpha/wt", pinned: true },
      ]);
      // Row click is not fired by the pin control.
      expect(posted.filter((p) => p.type === "resumeSession")).toEqual([]);
    });

    // The menu button is a real <button> inside a row that also answers
    // Enter/Space. Without a target check the key bubbles and does both — opening
    // the menu AND opening a conversation that may live in another project,
    // moving the whole tab.
    it("opens the menu by keyboard without also opening the conversation", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const btn = doc.querySelector(".rail-session-actions .rail-menu-btn") as HTMLElement;

      // A real button fires click on Enter; the keydown bubbles to the row too.
      btn.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      click(window, btn);

      expect(doc.querySelector(".rail-menu")).not.toBe(null);
      expect(posted.filter((p) => p.type === "resumeSession")).toEqual([]);
    });

    // Opening the menu must not also open the conversation.
    it("does not resume when the menu is opened", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      openMenu(window, section.querySelector(".rail-session") as HTMLElement);
      expect(posted.filter((p) => p.type === "resumeSession")).toEqual([]);
    });

    // Rename and delete are authorized by the host against a REPO, and the host
    // only knows which one from this field — without it every row the rail draws
    // from a project it has not selected is refused.
    it("names the row's own repo when deleting", async () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const menu = openMenu(window, doc.querySelector(".rail-session") as HTMLElement);
      click(window, menuItem(menu, "Delete")!);
      click(window, doc.querySelector(".confirm-btn.confirm-danger") as HTMLElement);
      // uiConfirm resolves a promise, so the post lands a microtask later.
      await Promise.resolve();
      expect(posted.filter((p) => p.type === "deleteSession")).toEqual([
        { type: "deleteSession", id: "a1", name: "alpha one", cwd: "/work/alpha" },
      ]);
    });
  });

  // The conversations are the point of the rail, and they were the one thing a
  // keyboard could not reach — repo names and pin buttons are real <button>s,
  // the rows were bare divs with an onclick.
  it("lets a keyboard reach and open a conversation", () => {
    const { doc, window, posted } = boot("/work/alpha");
    dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
    const first = doc.querySelector(".rail-session") as HTMLElement;
    expect(first.getAttribute("role")).toBe("button");
    expect(first.tabIndex).toBe(0);

    first.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted.filter((p) => p.type === "resumeSession")).toEqual([
      { type: "resumeSession", id: "a1", cwd: "/work/alpha" },
    ]);
  });

  it("offers no session rows for an unavailable checkout", () => {
    const { doc } = boot();
    const offlineIndex = repoNames(doc).indexOf("offline");
    const section = doc.querySelectorAll(".rail-repo")[offlineIndex];
    expect(section.classList.contains("unavailable")).toBe(true);
    expect(section.querySelector(".rail-note")?.textContent).toBe("Unavailable");
  });

  describe("new session", () => {
    const addFor = (doc: Document, label: string) =>
      doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf(label)]
        .querySelector('.rail-action-btn[title="New session here"]');

    it("starts directly in the repo already selected", () => {
      const { doc, window, posted } = boot("/work/alpha");
      click(window, addFor(doc, "alpha") as HTMLElement);
      expect(posted.filter((p) => p.type === "newSession")).toEqual([{ type: "newSession" }]);
      expect(posted.filter((p) => p.type === "selectRepo")).toEqual([]);
    });

    // The browser page arms an "open this repo's newest session" bridge on every
    // outbound selectRepo. A cross-repo New would race that bridge and could land
    // on an existing conversation, so the control is not offered where it cannot
    // keep its promise.
    it("is not offered for a project that is not selected", () => {
      const { doc } = boot("/work/alpha");
      expect(addFor(doc, "alpha")).not.toBe(null);
      expect(addFor(doc, "beta")).toBe(null);
      expect(addFor(doc, "gamma")).toBe(null);
    });
  });

  // Archiving exists so the rail can be a list of what you are working on rather
  // than everything you have ever opened. It is DERIVED, never a stored section:
  // one timestamped choice per project plus an age rule, both measured against
  // that project's newest conversation. Which is what makes "work in it and it
  // comes back" free — activity newer than the choice simply outranks it, and
  // there is no second flag to fall out of step.
  describe("archived projects", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const ago = (days: number) => Date.now() - days * DAY;

    /** A catalog whose stamps are real clock time, so the 30-day rule means
     *  something. `archived`/`archivedAt` present = a host that can record the
     *  choice; the fixtures above deliberately omit them. */
    const repo = (
      label: string,
      updatedAt: number,
      extra: Record<string, unknown> = {},
    ) => ({
      cwd: `/work/${label}`,
      label,
      available: true,
      pinned: false,
      updatedAt,
      archived: false,
      archivedAt: 0,
      ...extra,
    });

    const heads = (doc: Document) =>
      [...doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent);
    const sectionRepos = (doc: Document, which: "projects" | "archived") =>
      [...(doc.querySelector(`.rail-list.rail-${which}`)?.querySelectorAll(".rail-repo-label") ?? [])]
        .map((e) => e.textContent);

    /** Five projects: one selected, three recent (which the floor would protect
     *  anyway), and two long-idle ones past the floor. */
    function bootArchive(overrides: Record<string, Record<string, unknown>> = {}) {
      const catalog = [
        repo("home", ago(0), overrides.home),
        repo("one", ago(1), overrides.one),
        repo("two", ago(2), overrides.two),
        repo("three", ago(3), overrides.three),
        repo("stale", ago(80), overrides.stale),
        repo("ancient", ago(400), overrides.ancient),
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      // Give every project rows, so activity is read from conversations rather
      // than from the catalog's directory mtime.
      dispatch(h.window, sessionsFrame([row("h1", "/work/home", "home one", ago(0))]));
      for (const r of catalog.slice(1)) {
        dispatch(h.window, {
          type: "repoSessions",
          cwd: r.cwd,
          entries: [row(`${r.label}1`, r.cwd, `${r.label} one`, r.updatedAt)],
          dots: {},
          total: 1,
        });
      }
      return h;
    }

    it("drops long-idle projects into a folded Project Archive section", () => {
      const { doc } = bootArchive();
      // RECENT is present once sessions load; Project Archive is folded (no list).
      expect(heads(doc)).toContain("Projects");
      expect(heads(doc)).toContain("Project Archive");
      expect(heads(doc)).toContain("Recent");
      expect(sectionRepos(doc, "projects")).toEqual(["home", "one", "two", "three"]);
      expect(doc.querySelector(".rail-list.rail-archived")).toBe(null);
      // No count badge on the group header (styled like the others).
      expect(doc.querySelector(".rail-head-count")).toBe(null);
    });

    it("opens and remembers the Project Archive section", () => {
      const { doc, window } = bootArchive();
      const archivedBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Project Archive")) as HTMLElement;
      click(window, archivedBtn);
      expect(sectionRepos(doc, "archived")).toEqual(["stale", "ancient"]);
      // Whether it is open is the same kind of answer as a project fold, so it
      // keeps the same company and survives a reload.
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("grok.remote.railShape"));
      const saved = JSON.parse(window.localStorage.getItem(key as string));
      expect(saved.groupCollapsed.archived).toBe(false);
      expect(saved.archiveOpen).toBe(true);
    });

    // Coming back from three weeks away must not archive everything at once and
    // leave a rail that reads as broken.
    it("never lets the age rule empty the Projects section", () => {
      const catalog = [
        repo("home", ago(200)),
        repo("a", ago(210)),
        repo("b", ago(220)),
        repo("c", ago(230)),
        repo("d", ago(240)),
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      // Every project's rows, because the age rule only ever runs on rows it
      // actually has — see the guess test above.
      dispatch(h.window, sessionsFrame([row("h1", "/work/home", "home one", ago(200))]));
      for (const r of catalog.slice(1)) {
        dispatch(h.window, {
          type: "repoSessions",
          cwd: r.cwd,
          entries: [row(`${r.label}1`, r.cwd, `${r.label} one`, r.updatedAt)],
          dots: {},
          total: 1,
        });
      }
      // The three newest besides the one you are in, plus the one you are in.
      expect(sectionRepos(h.doc, "projects")).toEqual(["home", "a", "b", "c"]);
      expect(h.doc.querySelector(".rail-list.rail-archived")).toBe(null);
      // One age-archived project remains folded under Project Archive.
      const archivedBtn = [...h.doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Project Archive"));
      expect(archivedBtn).toBeTruthy();
    });

    // The age rule needs to know when a project was last worked in, and the only
    // honest source for that is the project's own conversations. The catalog's
    // stamp is the session DIRECTORY's mtime, which does not move when you
    // continue an existing conversation — so against an extension too old to
    // list another project's sessions (v2.3.1 has no `listRepoSessions` at all)
    // it would file a project you use every day under Archived, silently.
    it("never archives on a guess when the host cannot list the project's rows", () => {
      const catalog = [
        { cwd: "/work/home", label: "home", available: true, pinned: false, updatedAt: Date.now() },
        // Used daily, in one long-running conversation — so its directory has
        // not been written to in a year, and its catalog stamp says so.
        { cwd: "/work/daily", label: "daily", available: true, pinned: false, updatedAt: ago(400) },
        { cwd: "/work/other", label: "other", available: true, pinned: false, updatedAt: ago(401) },
        { cwd: "/work/third", label: "third", available: true, pinned: false, updatedAt: ago(402) },
        { cwd: "/work/fourth", label: "fourth", available: true, pinned: false, updatedAt: ago(403) },
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });

      // No `repoSessions` ever answers — the whole point. Not even the projects
      // past the floor may be archived.
      expect([...h.doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent))
        .not.toContain("Project Archive");
      expect(sectionRepos(h.doc, "projects")).toHaveLength(5);
    });

    // A rail that files the conversation on screen under "Archived" is
    // describing the screen wrongly, whatever the dates say.
    it("never archives the project you are reading", () => {
      const { doc } = bootArchive({ home: { archived: true, archivedAt: Date.now() } });
      expect(sectionRepos(doc, "projects")).toContain("home");
    });

    it("archives on request, and asks the host to remember it", () => {
      const { doc, window, posted } = bootArchive();
      const one = doc.querySelectorAll(".rail-repo")[1];
      const menu = openMenu(window, one.querySelector(".rail-repo-head") as HTMLElement);
      // First in the menu: putting a project away is the everyday act, and it
      // must be reachable without passing the delete.
      expect((menu.querySelector(".rail-menu-item") as HTMLElement).textContent).toContain("Archive project");
      click(window, menuItem(menu, "Archive project") as HTMLElement);
      expect(posted.filter((p) => p.type === "setRepoArchived")).toEqual([
        { type: "setRepoArchived", cwd: "/work/one", archived: true },
      ]);
    });

    // The floor holds back the AGE rule only. An explicit Archive on a project
    // you use every day has to take effect, or the control silently does nothing
    // exactly where it is most likely to be used.
    it("honours an explicit archive on a project the floor protects", () => {
      const { doc } = bootArchive({ one: { archived: true, archivedAt: Date.now() } });
      expect(sectionRepos(doc, "projects")).toEqual(["home", "two", "three"]);
      expect(doc.querySelector(".rail-list.rail-archived")).toBe(null);
      expect(heads(doc)).toContain("Project Archive");
    });

    // The whole reason the choice is a timestamp rather than a flag.
    it("brings a project back the moment it is worked in again", () => {
      const { doc, window } = bootArchive({ stale: { archived: true, archivedAt: ago(10) } });
      expect(sectionRepos(doc, "projects")).not.toContain("stale");

      dispatch(window, {
        type: "repoSessions",
        cwd: "/work/stale",
        entries: [row("s2", "/work/stale", "back at it", Date.now())],
        dots: {},
        total: 1,
      });
      expect(sectionRepos(doc, "projects")).toContain("stale");
    });

    // "Keep showing me this one" is a real, stored answer — not the absence of
    // one. Without it the age rule would undo the unarchive on the next render.
    it("keeps an unarchived project visible however idle it is", () => {
      const { doc } = bootArchive({ ancient: { archived: false, archivedAt: Date.now() } });
      expect(sectionRepos(doc, "projects")).toContain("ancient");
    });

    it("moves an archived project back from its own menu", () => {
      const { doc, window, posted } = bootArchive();
      const archivedBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Project Archive")) as HTMLElement;
      click(window, archivedBtn);
      const archivedSection = doc.querySelector(".rail-list.rail-archived") as HTMLElement;
      const menu = openMenu(window, archivedSection.querySelector(".rail-repo-head") as HTMLElement);
      // The verb follows the SECTION, not the stored flag: these two were
      // archived by age and carry no flag at all, so reading the flag would
      // offer "Archive" on a row already sitting under Project Archive.
      expect(menuItem(menu, "Archive project")).toBe(undefined);
      click(window, menuItem(menu, "Move to Projects") as HTMLElement);
      expect(posted.filter((p) => p.type === "setRepoArchived")).toEqual([
        { type: "setRepoArchived", cwd: "/work/stale", archived: false },
      ]);
    });

    // A query answered with "No matches." while the project sits collapsed two
    // inches below is simply wrong.
    it("reaches into Project Archive when searching, and opens it", () => {
      const { doc, window } = bootArchive();
      const search = doc.getElementById("rail-search") as HTMLInputElement;
      search.value = "ancient";
      search.dispatchEvent(new (window as any).Event("input", { bubbles: true }));

      expect(heads(doc)).toEqual(["Recent", "Project Archive"]);
      expect(sectionRepos(doc, "archived")).toEqual(["ancient"]);
      // …and says why it cannot be folded while the search is holding it open,
      // rather than offering a button whose click the next render undoes.
      const archivedBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Project Archive")) as HTMLButtonElement;
      expect(archivedBtn.disabled).toBe(true);
    });

    // Capability, never a version: a host that cannot record the choice must not
    // be offered a control that does nothing. The age rule still applies — it
    // needs nothing from the host.
    it("hides the archive control against a host that cannot record it", () => {
      const { doc, window } = boot();
      const beta = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("beta")];
      const menu = openMenu(window, beta.querySelector(".rail-repo-head") as HTMLElement);
      expect(menuItem(menu, "Archive project")).toBe(undefined);
      expect(menuItem(menu, "Clear all history")).not.toBe(undefined);
    });
  });

  // A fold is a preference set at some earlier moment, and the one thing it must
  // never do is hide where you are NOW — corrected when the conversation ARRIVES,
  // rather than by refusing the fold outright.
  describe("the project holding the live conversation", () => {
    it("can still be folded, and stays folded", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, { ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]), activeId: "a1" });

      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const head = alpha().querySelector(".rail-repo-head") as HTMLElement;
      expect(head.getAttribute("aria-expanded")).toBe("true");
      click(window, head);
      expect(alpha().querySelector(".rail-sessions")).toBe(null);

      // Holding the current project open forever made the one section you most
      // often want out of the way the one section you could not fold.
      dispatch(window, { ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]), activeId: "a1" });
      expect(alpha().querySelector(".rail-sessions")).toBe(null);
    });

    // A worktree conversation reports the WORKTREE as its cwd, and a worktree is
    // deliberately not a catalog row — so comparing the project's path with the
    // live session's said "not mine", and the project actually holding the open
    // conversation neither highlighted it nor re-opened for it.
    it("recognises its own conversation when that conversation is in a worktree", () => {
      const { doc, window } = boot("/work/alpha");
      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      click(window, alpha().querySelector(".rail-repo-head") as HTMLElement);
      expect(alpha().querySelector(".rail-sessions")).toBe(null);

      // The host names the worktree, not the checkout — and it lands BEFORE the
      // conversation goes live, so the active cwd is already the worktree at the
      // moment that matters. Sent the other way round, keying the re-open on the
      // active cwd alone still happens to work, and this test proves nothing.
      dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha/.wt" });
      dispatch(window, {
        ...sessionsFrame([{ ...row("w1", "/work/alpha/.wt", "worktree work", 9), worktreeLabel: "feature" }]),
        activeId: "w1",
      });

      expect(alpha().querySelector(".rail-session.active")).not.toBe(null);
      // Keying the re-open on the active cwd alone would miss this entirely: the
      // conversation's cwd is the worktree, the section's is the checkout.
      expect(alpha().querySelector(".rail-sessions")).not.toBe(null);
    });

    it("re-opens a project that was folded before the conversation moved there", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      click(window, alpha().querySelector(".rail-repo-head") as HTMLElement);
      expect(alpha().querySelector(".rail-sessions")).toBe(null);

      // The conversation is opened from somewhere else — a phone, the desk, the
      // Pinned group. The fold that was fine a moment ago now hides the answer.
      dispatch(window, { ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]), activeId: "a1" });
      expect(alpha().querySelector(".rail-sessions")).not.toBe(null);
    });
  });

  // ---- Rail redesign: four groups, chevron-after, folder icons, collapse ----
  describe("rail redesign (four groups)", () => {
    const pinnedFrame = (entries: unknown[]) => ({ type: "pinnedSessions", entries, dots: {} });
    const pinned = (id: string, cwd: string, name: string, at: number, updatedAt = at) =>
      ({ ...row(id, cwd, name, updatedAt), pinnedAt: at });

    it("renders PINNED, RECENT, PROJECTS, PROJECT ARCHIVE in that order when all apply", () => {
      // Explicit archive (not age): the always-visible floor keeps a lone
      // idle project in Projects, so age alone cannot produce archive here.
      const catalog = [
        { cwd: "/work/home", label: "home", available: true, pinned: false, updatedAt: Date.now(), archived: false, archivedAt: 0 },
        { cwd: "/work/old", label: "old", available: true, pinned: false, updatedAt: Date.now(), archived: true, archivedAt: Date.now() - 1000 },
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      dispatch(h.window, sessionsFrame([row("h1", "/work/home", "home one", Date.now())]));
      dispatch(h.window, {
        type: "repoSessions",
        cwd: "/work/old",
        entries: [row("o1", "/work/old", "old one", Date.now() - 5000)],
        dots: {},
        total: 1,
      });
      dispatch(h.window, pinnedFrame([pinned("h1", "/work/home", "home one", 50, Date.now())]));

      const titles = [...h.doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent);
      expect(titles).toEqual(["Pinned", "Recent", "Projects", "Project Archive"]);
    });

    it("all group labels use .rail-head and share bold uppercase CSS treatment", async () => {
      const catalog = [
        { cwd: "/work/home", label: "home", available: true, pinned: false, updatedAt: Date.now(), archived: false, archivedAt: 0 },
        { cwd: "/work/old", label: "old", available: true, pinned: false, updatedAt: Date.now(), archived: true, archivedAt: Date.now() - 1000 },
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      dispatch(h.window, sessionsFrame([row("h1", "/work/home", "home one", Date.now())]));
      dispatch(h.window, {
        type: "repoSessions",
        cwd: "/work/old",
        entries: [row("o1", "/work/old", "old one", Date.now() - 5000)],
        dots: {},
        total: 1,
      });
      dispatch(h.window, pinnedFrame([pinned("h1", "/work/home", "home one", 50, Date.now())]));

      const groupHeads = [...h.doc.querySelectorAll(".rail-head")] as HTMLElement[];
      expect(groupHeads).toHaveLength(4);
      for (const head of groupHeads) {
        // Static PINNED is .rail-head alone; the others are .rail-head.rail-head-fold.
        expect(head.classList.contains("rail-head")).toBe(true);
        const title = head.querySelector(".rail-head-title") as HTMLElement;
        expect(title).toBeTruthy();
        // Applied styles live on the shared class (and .rail-head-title / btn).
        // happy-dom may not load chat.css, so assert the class contract + source.
        expect(title.className).toBe("rail-head-title");
      }
      // Source-level: chat.css forces uppercase + 700 on every group path.
      // (happy-dom may not apply the stylesheet; this still fails if the rule is removed.)
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const css = readFileSync(join(__dirname, "..", "media", "chat.css"), "utf8");
      expect(css).toMatch(/\.rail-head-title\s*\{[^}]*font-weight:\s*700/s);
      expect(css).toMatch(/\.rail-head-title\s*\{[^}]*text-transform:\s*uppercase/s);
      expect(css).toMatch(/\.rail-head-btn\s*\{[^}]*font-weight:\s*700/s);
      expect(css).toMatch(/\.rail-head-btn\s*\{[^}]*text-transform:\s*uppercase/s);
    });

    it("omits Project Archive and archive actions when the host omits archive fields (desktop)", () => {
      // Capability = presence of `archived` on rows. Desktop strips the fields;
      // age rule and Archive menu must not run.
      const day = 24 * 60 * 60 * 1000;
      const t = (days: number) => Date.now() - days * day;
      const catalog = [
        { cwd: "/work/home", label: "home", available: true, pinned: false, updatedAt: t(0) },
        { cwd: "/work/stale", label: "stale", available: true, pinned: false, updatedAt: t(80) },
        { cwd: "/work/ancient", label: "ancient", available: true, pinned: false, updatedAt: t(400) },
      ];
      const h = bootWebview({ remote: true, beforeScripts: withRail });
      dispatch(h.window, { type: "repos", entries: catalog, selectedCwd: "/work/home", activeCwd: "/work/home" });
      dispatch(h.window, sessionsFrame([row("h1", "/work/home", "home one", t(0))]));
      for (const r of catalog.slice(1)) {
        dispatch(h.window, {
          type: "repoSessions",
          cwd: r.cwd,
          entries: [row(`${r.label}1`, r.cwd, `${r.label} one`, r.updatedAt)],
          dots: {},
          total: 1,
        });
      }
      const { doc, window } = h;
      expect(doc.querySelector(".rail-list.rail-archived")).toBe(null);
      expect([...doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent)).not.toContain(
        "Project Archive",
      );
      // All three stay under Projects (age rule disabled).
      const projectLabels = [
        ...(doc.querySelector(".rail-list.rail-projects")?.querySelectorAll(".rail-repo-label") ?? []),
      ].map((e) => e.textContent).sort();
      expect(projectLabels).toEqual(["ancient", "home", "stale"]);
      const menu = openMenu(window, doc.querySelector(".rail-repo-head") as HTMLElement);
      const labels = [...menu.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
      expect(labels.some((l) => /archive/i.test(l))).toBe(false);
    });

    it("omits Project Archive when no project is archived (deliberate, not a bug)", () => {
      // All projects active — no empty archive band.
      const { doc } = boot();
      const titles = [...doc.querySelectorAll(".rail-head-title")].map((e) => e.textContent);
      expect(titles).not.toContain("Project Archive");
      expect(doc.querySelector(".rail-list.rail-archived")).toBe(null);
    });

    it("PINNED is not collapsible — no head button, no chevron", () => {
      const { doc, window } = boot();
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta thing", 20)]));
      const pinnedHead = [...doc.querySelectorAll(".rail-head")]
        .find((h) => h.querySelector(".rail-head-title")?.textContent === "Pinned") as HTMLElement;
      expect(pinnedHead).toBeTruthy();
      expect(pinnedHead.querySelector(".rail-head-btn")).toBe(null);
      expect(pinnedHead.querySelector(".rail-head-twisty")).toBe(null);
      expect(doc.querySelector(".rail-list.rail-pinned")).toBeTruthy();
    });

    it("group headers put the chevron after the label", () => {
      const { doc, window } = boot();
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const recentBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Recent")) as HTMLElement;
      expect(recentBtn).toBeTruthy();
      const kids = [...recentBtn.children].map((c) => c.className);
      const titleIdx = kids.findIndex((c) => c.includes("rail-head-title"));
      const twistyIdx = kids.findIndex((c) => c.includes("rail-head-twisty"));
      expect(titleIdx).toBeGreaterThanOrEqual(0);
      expect(twistyIdx).toBeGreaterThan(titleIdx);
    });

    it("collapses and remembers RECENT / PROJECTS", () => {
      const { doc, window } = boot();
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      expect(doc.querySelector(".rail-list.rail-recent")).toBeTruthy();
      expect(doc.querySelector(".rail-list.rail-projects")).toBeTruthy();

      const recentBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Recent")) as HTMLElement;
      click(window, recentBtn);
      expect(doc.querySelector(".rail-list.rail-recent")).toBe(null);

      const projectsBtn = [...doc.querySelectorAll(".rail-head-btn")]
        .find((b) => (b.textContent || "").includes("Projects")) as HTMLElement;
      click(window, projectsBtn);
      expect(doc.querySelector(".rail-list.rail-projects")).toBe(null);

      const key = Object.keys(window.localStorage).find((k) => k.startsWith("grok.remote.railShape"));
      const saved = JSON.parse(window.localStorage.getItem(key as string));
      expect(saved.groupCollapsed.recent).toBe(true);
      expect(saved.groupCollapsed.projects).toBe(true);
    });

    it("RECENT merges sessions across projects, including pinned, newest first", () => {
      const { doc, window } = boot();
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha recent", 100)]));
      dispatch(window, {
        type: "repoSessions",
        cwd: "/work/beta",
        entries: [row("b1", "/work/beta", "beta older", 50)],
        dots: {},
        total: 1,
      });
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta older", 9, 50)]));

      const recentNames = [...doc.querySelectorAll(".rail-list.rail-recent .rail-session-name")]
        .map((e) => e.textContent);
      expect(recentNames).toEqual(["alpha recent", "beta older"]);
      // Pinned still has its own copy.
      expect([...doc.querySelectorAll(".rail-pinned .rail-session-name")].map((e) => e.textContent))
        .toEqual(["beta older"]);
      // And PROJECTS still lists alpha's row under the project.
      expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toContain("alpha recent");
    });

    it("RECENT Show more / Show less has no digits", () => {
      const { doc, window } = boot();
      const many = Array.from({ length: 5 }, (_, i) =>
        row(`a${i}`, "/work/alpha", `s${i}`, 100 - i),
      );
      dispatch(window, sessionsFrame(many));
      const more = doc.querySelector(".rail-list.rail-recent .rail-more") as HTMLElement;
      expect(more.textContent).toBe("Show more");
      expect(more.textContent).not.toMatch(/\d/);
      expect(doc.querySelectorAll(".rail-list.rail-recent .rail-session-name")).toHaveLength(3);
      click(window, more);
      expect(doc.querySelectorAll(".rail-list.rail-recent .rail-session-name")).toHaveLength(5);
      const less = doc.querySelector(".rail-list.rail-recent .rail-more") as HTMLElement;
      expect(less.textContent).toBe("Show less");
      expect(less.textContent).not.toMatch(/\d/);
    });

    it("project rows use folder-closed when collapsed and folder-open when expanded", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const twisty = () => alpha().querySelector(".rail-twisty") as HTMLElement;
      // Expanded: ONE flag drives icon + session list (data-expanded + folder-open).
      expect(alpha().getAttribute("data-expanded")).toBe("1");
      // Expanded: folder-open path includes m6 14 (open flap).
      expect(twisty().innerHTML).toMatch(/m6 14/);
      expect(twisty().innerHTML).not.toMatch(/M2 10h20/);
      expect(alpha().querySelector(".rail-sessions")).not.toBe(null);
      // Icon and list cannot disagree: sessions present ⇒ open icon path.
      expect(!!alpha().querySelector(".rail-sessions")).toBe(
        /m6 14/.test(twisty().innerHTML),
      );
      // Folder is an indicator (not a button); the whole head toggles.
      expect(twisty().tagName).toBe("SPAN");
      click(window, alpha().querySelector(".rail-repo-head") as HTMLElement);
      // Collapsed: folder-closed has M2 10h20; no sessions; data-expanded=0.
      expect(alpha().getAttribute("data-expanded")).toBe("0");
      expect(twisty().innerHTML).toMatch(/M2 10h20/);
      expect(twisty().innerHTML).not.toMatch(/m6 14/);
      expect(alpha().querySelector(".rail-sessions")).toBe(null);
      expect(!!alpha().querySelector(".rail-sessions")).toBe(
        /m6 14/.test(twisty().innerHTML),
      );
    });

    it("the whole project header toggles expand; hover actions do not", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const head = () => alpha().querySelector(".rail-repo-head") as HTMLElement;
      expect(alpha().getAttribute("data-expanded")).toBe("1");
      // Click the label area (not the folder alone) — whole head is the control.
      click(window, alpha().querySelector(".rail-repo-label") as HTMLElement);
      expect(alpha().getAttribute("data-expanded")).toBe("0");
      expect(alpha().querySelector(".rail-sessions")).toBe(null);
      click(window, head());
      expect(alpha().getAttribute("data-expanded")).toBe("1");
      // Hover action (+ New) must not toggle.
      const before = posted.length;
      const add = alpha().querySelector(".rail-repo-actions .rail-action-btn") as HTMLElement;
      click(window, add);
      expect(alpha().getAttribute("data-expanded")).toBe("1");
      // Selected project's + posts newSession (does not fold).
      expect(posted.slice(before).some((p) => p.type === "newSession")).toBe(true);
    });

    it("hidden hover actions are absolutely positioned so they do not reserve label width", () => {
      // Assert the CSS contract: actions overlay (position:absolute) on hover-capable
      // surfaces. A layout-space reservation would reintroduce early title truncation.
      const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css");
      const css = fs.readFileSync(cssPath, "utf8");
      // Overlay path (default).
      expect(css).toMatch(
        /\.rail-repo-actions,\s*\n\s*\.rail-session-actions\s*\{[^}]*position:\s*absolute/s,
      );
      // Touch / no-hover: back to in-flow reservation.
      expect(css).toMatch(
        /@media\s*\(hover:\s*none\)\s*\{[\s\S]*?\.rail-repo-actions,\s*\n\s*\.rail-session-actions\s*\{[^}]*position:\s*static/,
      );
    });

    it("hover action buttons sit flat on the row hover surface (no darker chip)", () => {
      const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css");
      const css = fs.readFileSync(cssPath, "utf8");
      const hoverRule = css.match(
        /\.rail-action-btn:hover\s*,\s*\.rail-action-btn\.active\s*\{[^}]+\}/,
      );
      expect(hoverRule?.[0]).toMatch(/background:\s*transparent/);
      expect(hoverRule?.[0]).not.toContain("toolbar-hoverBackground");
      // Scrim uses the row hover token so controls are not a second layer.
      expect(css).toMatch(
        /\.rail-repo-actions,\s*\n\s*\.rail-session-actions\s*\{[^}]*--rail-hover-bg/s,
      );
    });

    it("a host that never mounts #projects-rail never renders the rail (VS Code property)", () => {
      // Same guard as the top-level test — kept next to the redesign so a
      // regression that lights the rail without a mount fails this suite hard.
      const { doc, window } = bootWebview({});
      dispatch(window, {
        type: "repos",
        entries: repos,
        selectedCwd: "/work/alpha",
        activeCwd: "/work/alpha",
      });
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      expect(doc.getElementById("projects-rail")).toBe(null);
      expect(doc.body.classList.contains("has-rail")).toBe(false);
      expect(doc.querySelectorAll(".rail-head-title")).toHaveLength(0);
      expect(doc.querySelectorAll(".rail-session")).toHaveLength(0);
    });
  });
});

// "Continue in a new chat" used to sit in the composer's settings popover
// beside model and effort. Those two say how the agent ANSWERS; forking makes a
// different conversation — which is what the ⋯ menu is already for (Rename,
// Pin, Delete). Moving it leaves the composer popover holding model and effort
// alone. Owner, 2026-08-07.
describe("continue-in-a-new-chat lives in the session ⋯ menu", () => {
  const pinnedFrame = (entries: unknown[]) => ({ type: "pinnedSessions", entries, dots: {} });
  it("offers it on the conversation you are actually in", () => {
    const { doc, window, posted } = boot("/work/alpha");
    dispatch(window, pinnedFrame([]));
    dispatch(window, {
      ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]),
      activeId: "a1",
    });
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    const menu = openMenu(window, section.querySelector(".rail-session") as HTMLElement);
    const item = menuItem(menu, "Continue in a new chat");
    expect(item).toBeTruthy();
    click(window, item!);
    // Knowledge work is the default, so there is one destination and no popup.
    expect(posted.find((p) => p.type === "forkSession")).toBeTruthy();
  });

  it("withholds it from other rows — a fork continues from the LIVE transcript", () => {
    const { doc, window } = boot("/work/alpha");
    dispatch(window, pinnedFrame([]));
    dispatch(window, {
      ...sessionsFrame([
        row("a1", "/work/alpha", "alpha one", 9),
        row("a2", "/work/alpha", "alpha two", 8),
      ]),
      activeId: "a1",
    });
    const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
    const rows = section.querySelectorAll(".rail-session");
    // Second row is not the live conversation — offering a fork there would
    // promise to continue from a transcript this client does not have.
    const menu = openMenu(window, rows[1] as HTMLElement);
    expect(menuItem(menu, "Continue in a new chat")).toBeUndefined();
    expect(menuItem(menu, "Delete")).toBeTruthy();
  });
});
