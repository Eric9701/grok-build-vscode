import { describe, expect, it } from "vitest";
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
  it("never mounts in VS Code, even if the element is present", () => {
    // `IS_REMOTE` is the gate, not the element — so a stray mount cannot switch
    // the rail on in a webview where the window already IS the repo.
    const { doc, window, posted } = bootWebview({ beforeScripts: withRail });
    dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha" });
    expect(rail(doc).hidden).toBe(true);
    expect(doc.querySelectorAll(".rail-repo")).toHaveLength(0);
    expect(posted.filter((p) => p.type === "listRepoSessions")).toEqual([]);
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
    expect(dead.title).toContain("Update the Grok extension");
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
  it("tells you to update the extension when the probe goes unanswered", async () => {
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
    expect(notes.filter((t) => t === "Update the extension to preview")).toHaveLength(2);
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
    expect(notes).not.toContain("Update the extension to preview");
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
    expect(more.textContent).toBe("Show 1 more");
    click(window, more);
    expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["one", "two", "three", "four"]);
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
  // itself stops at RAIL_EXPANDED. Either one alone makes the label a lie.
  it("promises only the rows expanding can actually reveal", () => {
    const { doc, window } = boot();
    dispatch(window, sessionsFrame(
      Array.from({ length: 28 }, (_, i) => row(`a${i}`, "/work/alpha", `s${i}`, 100 - i)),
    ));
    const more = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")]
      .querySelector(".rail-more") as HTMLElement;
    // 20 reachable, 3 shown — not 25.
    expect(more.textContent).toBe("Show 17 more");
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
      expect(heads).toEqual(["Pinned", "Projects"]);
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

    it("shows no pin glyph on any row — the Pinned group carries that", () => {
      const { doc, window } = boot();
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta thing", 20)]));
      expect(doc.querySelectorAll(".rail-pin-mark")).toHaveLength(0);
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
    const sectionRepos = (doc: Document, index: number) =>
      [...doc.querySelectorAll(".rail-list")[index].querySelectorAll(".rail-repo-label")]
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

    it("drops long-idle projects into a folded Archived section", () => {
      const { doc } = bootArchive();
      expect(heads(doc)).toEqual(["Projects", "Archived"]);
      expect(sectionRepos(doc, 0)).toEqual(["home", "one", "two", "three"]);
      // Folded by default — the section exists to be out of the way — so the
      // count is the only thing it can say about itself.
      expect(doc.querySelectorAll(".rail-list")).toHaveLength(1);
      expect(doc.querySelector(".rail-head-count")?.textContent).toBe("2");
    });

    it("opens and remembers the Archived section", () => {
      const { doc, window } = bootArchive();
      click(window, doc.querySelector(".rail-head-btn") as HTMLElement);
      expect(sectionRepos(doc, 1)).toEqual(["stale", "ancient"]);
      // Whether it is open is the same kind of answer as a project fold, so it
      // keeps the same company and survives a reload.
      const key = Object.keys(window.localStorage).find((k) => k.startsWith("grok.remote.railShape"));
      expect(JSON.parse(window.localStorage.getItem(key as string)).archiveOpen).toBe(true);
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
      expect(sectionRepos(h.doc, 0)).toEqual(["home", "a", "b", "c"]);
      expect(h.doc.querySelector(".rail-head-count")?.textContent).toBe("1");
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
      expect(h.doc.querySelector(".rail-head-fold")).toBe(null);
      expect(sectionRepos(h.doc, 0)).toHaveLength(5);
    });

    // A rail that files the conversation on screen under "Archived" is
    // describing the screen wrongly, whatever the dates say.
    it("never archives the project you are reading", () => {
      const { doc } = bootArchive({ home: { archived: true, archivedAt: Date.now() } });
      expect(sectionRepos(doc, 0)).toContain("home");
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
      expect(sectionRepos(doc, 0)).toEqual(["home", "two", "three"]);
      expect(doc.querySelector(".rail-head-count")?.textContent).toBe("3");
    });

    // The whole reason the choice is a timestamp rather than a flag.
    it("brings a project back the moment it is worked in again", () => {
      const { doc, window } = bootArchive({ stale: { archived: true, archivedAt: ago(10) } });
      expect(sectionRepos(doc, 0)).not.toContain("stale");

      dispatch(window, {
        type: "repoSessions",
        cwd: "/work/stale",
        entries: [row("s2", "/work/stale", "back at it", Date.now())],
        dots: {},
        total: 1,
      });
      expect(sectionRepos(doc, 0)).toContain("stale");
    });

    // "Keep showing me this one" is a real, stored answer — not the absence of
    // one. Without it the age rule would undo the unarchive on the next render.
    it("keeps an unarchived project visible however idle it is", () => {
      const { doc } = bootArchive({ ancient: { archived: false, archivedAt: Date.now() } });
      expect(sectionRepos(doc, 0)).toContain("ancient");
    });

    it("moves an archived project back from its own menu", () => {
      const { doc, window, posted } = bootArchive();
      click(window, doc.querySelector(".rail-head-btn") as HTMLElement);
      const archivedSection = doc.querySelectorAll(".rail-list")[1];
      const menu = openMenu(window, archivedSection.querySelector(".rail-repo-head") as HTMLElement);
      // The verb follows the SECTION, not the stored flag: these two were
      // archived by age and carry no flag at all, so reading the flag would
      // offer "Archive" on a row already sitting under Archived.
      expect(menuItem(menu, "Archive project")).toBe(undefined);
      click(window, menuItem(menu, "Move to Projects") as HTMLElement);
      expect(posted.filter((p) => p.type === "setRepoArchived")).toEqual([
        { type: "setRepoArchived", cwd: "/work/stale", archived: false },
      ]);
    });

    // A query answered with "No matches." while the project sits collapsed two
    // inches below is simply wrong.
    it("reaches into Archived when searching, and opens it", () => {
      const { doc, window } = bootArchive();
      const search = doc.getElementById("rail-search") as HTMLInputElement;
      search.value = "ancient";
      search.dispatchEvent(new (window as any).Event("input", { bubbles: true }));

      expect(heads(doc)).toEqual(["Archived"]);
      expect(sectionRepos(doc, 0)).toEqual(["ancient"]);
      // …and says why it cannot be folded while the search is holding it open,
      // rather than offering a button whose click the next render undoes.
      expect((doc.querySelector(".rail-head-btn") as HTMLButtonElement).disabled).toBe(true);
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
  // never do is hide where you are NOW.
  describe("the project holding the live conversation", () => {
    it("cannot be folded away while it holds the open conversation", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, { ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]), activeId: "a1" });

      const alpha = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      const twisty = alpha.querySelector(".rail-twisty") as HTMLButtonElement;
      expect(twisty.disabled).toBe(true);
      click(window, twisty);
      expect(doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")]
        .querySelector(".rail-sessions")).not.toBe(null);
    });

    // A worktree conversation reports the WORKTREE as its cwd, and a worktree is
    // deliberately not a catalog row — so comparing the project's path with the
    // live session's said "not mine", and the project actually holding the open
    // conversation neither highlighted it nor held itself open.
    it("recognises its own conversation when that conversation is in a worktree", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, {
        ...sessionsFrame([{ ...row("w1", "/work/alpha/.wt", "worktree work", 9), worktreeLabel: "feature" }]),
        activeId: "w1",
      });
      // The host names the worktree, not the checkout.
      dispatch(window, { type: "repos", entries: repos, selectedCwd: "/work/alpha", activeCwd: "/work/alpha/.wt" });

      const alpha = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      expect(alpha.querySelector(".rail-session.active")).not.toBe(null);
      expect((alpha.querySelector(".rail-twisty") as HTMLButtonElement).disabled).toBe(true);
    });

    it("re-opens a project that was folded before the conversation moved there", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const alpha = () => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      click(window, alpha().querySelector(".rail-twisty") as HTMLElement);
      expect(alpha().querySelector(".rail-sessions")).toBe(null);

      // The conversation is opened from somewhere else — a phone, the desk, the
      // Pinned group. The fold that was fine a moment ago now hides the answer.
      dispatch(window, { ...sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]), activeId: "a1" });
      expect(alpha().querySelector(".rail-sessions")).not.toBe(null);
    });
  });
});
