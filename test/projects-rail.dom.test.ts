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

  it("lists pinned projects first, then by recency", () => {
    const { doc } = boot();
    expect(rail(doc).hidden).toBe(false);
    expect(repoNames(doc)).toEqual(["beta", "alpha", "gamma", "offline"]);
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

    dispatch(window, {
      type: "repoSessions",
      cwd: probes()[0],
      entries: [row("b1", "/work/beta", "beta one", 4)],
      dots: {},
      total: 1,
    });

    // The answer proves the capability; the rest of the catalog is now worth asking.
    expect(probes().length).toBeGreaterThan(1);
    const betaIndex = repoNames(doc).indexOf("beta");
    expect(sessionNames(doc, betaIndex)).toEqual(["beta one"]);
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
    dispatch(h.window, sessionsFrame([row("f1", "/work/Foo", "upper only", 9)]));

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
    dispatch(h.window, sessionsFrame([row("o1", "/srv/Foo\\bar", "upper only", 9)]));

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

  // The pin lives in a hover-revealed action group, so without a persistent
  // marker a pinned project looks exactly like an unpinned one.
  it("marks a pinned project without needing a hover", () => {
    const { doc } = boot();
    const section = (label: string) => doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf(label)];
    expect(section("beta").classList.contains("pinned")).toBe(true);
    expect(section("alpha").classList.contains("pinned")).toBe(false);
    // The CSS keeps `.pin` visible at rest only on a pinned row, so the class
    // has to be on the button too, not just the section.
    expect(section("beta").querySelector(".rail-action-btn.pin")).not.toBe(null);
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
    it("offers no pin control against a host that never mentions pinning", () => {
      const { doc, window } = boot("/work/alpha");
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      expect(doc.querySelector(".rail-session-actions")).toBe(null);
      // The rows themselves still work — only the new affordance is withheld.
      expect(sessionNames(doc, repoNames(doc).indexOf("alpha"))).toEqual(["alpha one"]);
    });

    it("offers the pin once the host has proved it handles pinning", () => {
      const { doc, window } = boot("/work/alpha");
      // An EMPTY frame is proof enough — that is what a capable host with no
      // pins yet sends, and it must not be mistaken for silence.
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      expect(doc.querySelector(".rail-session-actions .rail-action-btn.pin")).not.toBe(null);
    });

    it("pins from an ordinary project row, naming that row's own repo", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha/wt", "alpha one", 9)]));
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      click(window, section.querySelector(".rail-session-actions .rail-action-btn.pin") as HTMLElement);
      expect(posted.filter((p) => p.type === "toggleSessionPin")).toEqual([
        { type: "toggleSessionPin", id: "a1", cwd: "/work/alpha/wt", pinned: true },
      ]);
    });

    it("unpins from the Pinned group", () => {
      const { doc, window, posted } = boot();
      dispatch(window, pinnedFrame([pinned("b1", "/work/beta", "beta thing", 20)]));
      click(window, doc.querySelector(".rail-pinned .rail-action-btn.pin") as HTMLElement);
      expect(posted.filter((p) => p.type === "toggleSessionPin")).toEqual([
        { type: "toggleSessionPin", id: "b1", cwd: "/work/beta", pinned: false },
      ]);
    });

    // The pin is a real <button> inside a row that also answers Enter/Space.
    // Without a target check the key bubbles and does both — pinning AND opening
    // a conversation that may live in another project, moving the whole tab.
    it("pins by keyboard without also opening the conversation", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const pin = doc.querySelector(".rail-session-actions .rail-action-btn.pin") as HTMLElement;

      // A real button fires click on Enter; the keydown bubbles to the row too.
      pin.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      click(window, pin);

      expect(posted.filter((p) => p.type === "toggleSessionPin")).toHaveLength(1);
      expect(posted.filter((p) => p.type === "resumeSession")).toEqual([]);
    });

    // Clicking the pin must not also open the conversation.
    it("does not resume when the pin is clicked", () => {
      const { doc, window, posted } = boot("/work/alpha");
      dispatch(window, pinnedFrame([]));
      dispatch(window, sessionsFrame([row("a1", "/work/alpha", "alpha one", 9)]));
      const section = doc.querySelectorAll(".rail-repo")[repoNames(doc).indexOf("alpha")];
      click(window, section.querySelector(".rail-session-actions .rail-action-btn.pin") as HTMLElement);
      expect(posted.filter((p) => p.type === "resumeSession")).toEqual([]);
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
});
