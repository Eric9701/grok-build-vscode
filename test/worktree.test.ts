import { describe, it, expect } from "vitest";
import {
  unwrapExtResult,
  parseWorktreeList,
  parseWorktreeRecord,
  parseWorktreeCreate,
  parseWorktreeApply,
  parseWorktreeRemove,
  parseWorktreeStatus,
  worktreesForRepo,
  worktreeCwdsForRepo,
  worktreeDisplayName,
  WORKTREE_NAME_TAG,
  matchWorktreeForCwd,
  mergeWorktreeRefresh,
  mergeSessionIndexes,
  sanitizeWorktreeLabel,
  WorktreeCreateSlots,
  pathsEqual,
  pathIsInside,
  isGitRepo,
  gitRootForPath,
  normalizeFsPath,
} from "../src/worktree";

describe("worktreeCwdsForRepo", () => {
  const worktrees = [
    { path: "/worktrees/a", sourceGitRoot: "/repos/a" },
    { path: "/worktrees/b", sourceGitRoot: "/repos/b" },
    { path: "/worktrees/legacy" },
  ];

  it("does not grant the primary workspace another repository's worktrees", () => {
    expect(worktreeCwdsForRepo({
      repoCwd: "/repos/a",
      repoGitRoot: "/repos/a",
      worktrees,
    })).toEqual(["/worktrees/a"]);
  });

  it("does not let a nested checkout inherit its parent's worktrees", () => {
    expect(worktreeCwdsForRepo({
      repoCwd: "/repos/a/nested-b",
      repoGitRoot: "/repos/a/nested-b",
      worktrees: [{ path: "/worktrees/a", sourceGitRoot: "/repos/a" }],
    })).toEqual([]);
  });

  it("keeps a selected repo's own registered worktrees in scope", () => {
    expect(worktreeCwdsForRepo({
      repoCwd: "/repos/b",
      repoGitRoot: "/repos/b",
      worktrees,
    })).toEqual(["/worktrees/b"]);
  });

  it("matches a worktree git root when VS Code opened a repo subdirectory", () => {
    expect(worktreeCwdsForRepo({
      repoCwd: "/repos/a/packages/editor",
      repoGitRoot: "/repos/a",
      worktrees,
    })).toEqual(["/worktrees/a"]);
  });

  it("does not assign worktrees when the selected checkout identity is unknown", () => {
    expect(worktreeCwdsForRepo({
      repoCwd: "/repos/a",
      worktrees,
    })).toEqual([]);
  });
});

describe("unwrapExtResult", () => {
  it("unwraps a single {result} envelope", () => {
    expect(unwrapExtResult({ result: { a: 1 } })).toEqual({ a: 1 });
  });
  it("returns the payload when there is no envelope", () => {
    expect(unwrapExtResult({ a: 1 })).toEqual({ a: 1 });
    expect(unwrapExtResult([1, 2])).toEqual([1, 2]);
  });
});

describe("parseWorktreeList / parseWorktreeRecord", () => {
  const row = {
    id: "my-feature-abc",
    path: "C:\\Users\\x\\.grok\\worktrees\\repo\\my-feature",
    source_repo: "C:\\Projects\\repo",
    repo_name: "repo",
    kind: "session",
    creation_mode: "linked",
    git_ref: "HEAD",
    head_commit: "deadbeef",
    session_id: "019f-sid",
    status: "alive",
    metadata: { label: "my-feature", user_provided: true },
  };

  it("parses a double-wrapped list payload", () => {
    const list = parseWorktreeList({ result: [row] });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("my-feature-abc");
    expect(list[0].label).toBe("my-feature");
    expect(list[0].userProvidedLabel).toBe(true);
    expect(list[0].sourceRepo).toBe("C:\\Projects\\repo");
    expect(list[0].sessionId).toBe("019f-sid");
  });

  it("parses a bare array", () => {
    expect(parseWorktreeList([row])).toHaveLength(1);
  });

  it("returns [] for empty / garbage", () => {
    expect(parseWorktreeList({ result: [] })).toEqual([]);
    expect(parseWorktreeList(null)).toEqual([]);
    expect(parseWorktreeList({})).toEqual([]);
  });

  it("falls back to basename when no label metadata", () => {
    const r = parseWorktreeRecord({ path: "/tmp/wt/foo-bar", status: "alive" });
    expect(r?.label).toBe("foo-bar");
  });
});

describe("parseWorktreeCreate / Apply / Remove / Status", () => {
  it("parses create (double-wrapped)", () => {
    const c = parseWorktreeCreate({
      result: {
        status: "creating",
        sessionId: "s1",
        worktreePath: "/wt/path",
        sourceGitRoot: "/repo/",
      },
    });
    expect(c).toEqual({
      status: "creating",
      sessionId: "s1",
      worktreePath: "/wt/path",
      sourceGitRoot: "/repo/",
    });
  });

  it("returns null without worktreePath", () => {
    expect(parseWorktreeCreate({ result: { status: "creating" } })).toBeNull();
  });

  it("parses apply with files", () => {
    const a = parseWorktreeApply({
      result: {
        status: "success",
        files: [{ path: "a.ts", type: "edit", additions: 2, deletions: 1 }],
        gitRoot: "/repo",
      },
    });
    expect(a?.files).toEqual([{ path: "a.ts", type: "edit", additions: 2, deletions: 1 }]);
    expect(a?.gitRoot).toBe("/repo");
  });

  it("parses remove", () => {
    expect(parseWorktreeRemove({ result: { removed: true, resolvedPath: "/wt" } })).toEqual({
      removed: true,
      resolvedPath: "/wt",
    });
  });

  it("parses status notifications", () => {
    expect(parseWorktreeStatus({ status: "progress", message: "Creating…" })?.status).toBe("progress");
    expect(parseWorktreeStatus({ status: "created", worktreePath: "/wt" })?.worktreePath).toBe("/wt");
    expect(parseWorktreeStatus({})).toBeNull();
  });
});

describe("worktreesForRepo", () => {
  const records = [
    parseWorktreeRecord({
      id: "1",
      path: "/home/u/.grok/worktrees/app/feat",
      source_repo: "/home/u/app",
      status: "alive",
      metadata: { label: "feat" },
    })!,
    parseWorktreeRecord({
      id: "2",
      path: "/home/u/.grok/worktrees/other/x",
      source_repo: "/home/u/other",
      status: "alive",
      metadata: { label: "x" },
    })!,
    parseWorktreeRecord({
      id: "3",
      path: "/home/u/.grok/worktrees/app/old",
      source_repo: "/home/u/app",
      status: "dead",
      metadata: { label: "old" },
    })!,
  ];

  it("filters by source_repo and alive by default", () => {
    const hit = worktreesForRepo(records, "/home/u/app");
    expect(hit.map((r) => r.id)).toEqual(["1"]);
  });

  it("can include dead", () => {
    expect(worktreesForRepo(records, "/home/u/app", { includeDead: true }).map((r) => r.id)).toEqual(["1", "3"]);
  });
});

describe("worktreeDisplayName", () => {
  it("prefixes with (WT)", () => {
    expect(worktreeDisplayName("my-feature")).toBe("(WT) my-feature");
  });
  it("is idempotent", () => {
    expect(worktreeDisplayName(worktreeDisplayName("feat"))).toBe("(WT) feat");
    expect(worktreeDisplayName("(WT) feat")).toBe("(WT) feat");
  });
  it("handles blank", () => {
    expect(worktreeDisplayName("")).toBe(WORKTREE_NAME_TAG);
    expect(worktreeDisplayName(undefined)).toBe(WORKTREE_NAME_TAG);
  });
});

describe("matchWorktreeForCwd / pathsEqual / pathIsInside", () => {
  it("matches cwd to a worktree path", () => {
    const recs = parseWorktreeList([
      { id: "a", path: "C:\\wt\\a", source_repo: "C:\\repo", status: "alive", metadata: { label: "a" } },
    ]);
    expect(matchWorktreeForCwd("C:\\wt\\a", recs)?.id).toBe("a");
    expect(matchWorktreeForCwd("C:\\other", recs)).toBeUndefined();
  });

  it("pathIsInside handles equality and children", () => {
    expect(pathIsInside("/a/b", "/a")).toBe(true);
    expect(pathIsInside("/a", "/a")).toBe(true);
    expect(pathIsInside("/ab", "/a")).toBe(false);
  });

  it("normalizeFsPath is stable", () => {
    expect(normalizeFsPath(".")).toBeTruthy();
    expect(pathsEqual(".", process.cwd())).toBe(true);
  });
});

describe("mergeSessionIndexes", () => {
  it("merges and de-dupes by id, newest mtime first", () => {
    const merged = mergeSessionIndexes([
      {
        cwd: "/main",
        entries: [
          { id: "a", mtimeMs: 100 },
          { id: "b", mtimeMs: 50 },
        ],
      },
      {
        cwd: "/wt",
        entries: [
          { id: "b", mtimeMs: 999 }, // duplicate — first wins
          { id: "c", mtimeMs: 200 },
        ],
      },
    ]);
    expect(merged.map((e) => e.id)).toEqual(["c", "a", "b"]);
    expect(merged.find((e) => e.id === "b")?.cwd).toBe("/main");
    expect(merged.find((e) => e.id === "c")?.cwd).toBe("/wt");
  });
});

describe("mergeWorktreeRefresh", () => {
  const record = (id: string, sourceRepo: string, path: string): any => ({
    id,
    sourceRepo,
    path,
    repoName: id,
    kind: "session",
    creationMode: "linked",
    gitRef: "HEAD",
    headCommit: "",
    status: "alive",
    label: id,
    userProvidedLabel: true,
  });

  it("replaces only the serving client's repo and preserves another repo's registrations", () => {
    const repoAOld = record("a-old", "C:\\repos\\a", "C:\\worktrees\\a-old");
    const repoB = record("b", "C:\\repos\\a\\nested-b", "C:\\worktrees\\b");
    const repoANew = record("a-new", "C:\\repos\\a", "C:\\worktrees\\a-new");

    expect(mergeWorktreeRefresh([repoAOld, repoB], "C:\\repos\\a", [repoANew])).toEqual([
      repoB,
      repoANew,
    ]);
  });

  it("lets a refreshed row replace the same path even if its source metadata changed", () => {
    const stale = record("stale", "C:\\repos\\old", "C:\\worktrees\\shared");
    const fresh = record("fresh", "C:\\repos\\new", "C:\\worktrees\\shared");

    expect(mergeWorktreeRefresh([stale], "C:\\repos\\new", [fresh])).toEqual([fresh]);
  });
});

describe("sanitizeWorktreeLabel", () => {
  it("strips path separators and whitespace", () => {
    expect(sanitizeWorktreeLabel("  my feature/v2  ")).toBe("my-feature-v2");
    expect(sanitizeWorktreeLabel("foo\\bar")).toBe("foo-bar");
  });
  it("caps length", () => {
    expect(sanitizeWorktreeLabel("x".repeat(100)).length).toBe(64);
  });
});

describe("isGitRepo", () => {
  it("walks up for a .git entry", () => {
    const path = require("node:path") as typeof import("node:path");
    const root = path.resolve("repo-root-for-test");
    const src = path.join(root, "src");
    const git = path.join(root, ".git");
    const existing = new Set([git]);
    const fs = { existsSync: (p: string) => existing.has(p) };
    expect(isGitRepo(src, fs)).toBe(true);
    expect(isGitRepo(path.resolve("nope-not-a-repo"), fs)).toBe(false);
  });
});

describe("gitRootForPath", () => {
  it("uses the nearest git marker so a nested checkout has its own identity", () => {
    const path = require("node:path") as typeof import("node:path");
    const parent = path.resolve("parent-repo");
    const nested = path.join(parent, "nested-repo");
    const existing = new Set([path.join(parent, ".git"), path.join(nested, ".git")]);
    const fs = { existsSync: (p: string) => existing.has(p) };

    expect(gitRootForPath(path.join(parent, "packages", "editor"), fs)).toBe(parent);
    expect(gitRootForPath(path.join(nested, "src"), fs)).toBe(nested);
  });
});

describe("WorktreeCreateSlots", () => {
  /** Minimal EventEmitter stand-in: enough to see WHEN listeners are attached,
   *  and to fire `exit` exactly once like AcpClient's does. */
  function fakeClient() {
    const listeners = new Map<string, Array<(...a: any[]) => void>>();
    let exited = false;
    return {
      on(event: string, fn: (...a: any[]) => void) {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
      },
      off(event: string, fn: (...a: any[]) => void) {
        const list = listeners.get(event) ?? [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      },
      count(event: string) {
        return (listeners.get(event) ?? []).length;
      },
      /** One-shot, like the real `exit`: a listener attached after this has
       *  fired will never be called. */
      exit() {
        if (exited) return;
        exited = true;
        for (const fn of [...(listeners.get("exit") ?? [])]) fn();
      },
    };
  }

  it("counts creates so a pathless event is only attributable when one is live", () => {
    const slots = new WorktreeCreateSlots();
    const client = fakeClient();
    expect(slots.sole(client)).toBe(false);

    const releaseA = slots.take(client);
    expect(slots.sole(client)).toBe(true);
    const releaseB = slots.take(client);
    expect(slots.sole(client), "two in flight — nothing pathless is attributable").toBe(false);

    releaseB();
    expect(slots.sole(client)).toBe(true);
    releaseA();
    expect(slots.sole(client)).toBe(false);
  });

  it("releases a held slot when the CLI dies AFTER reporting progress", () => {
    // The bug this exists for. `exit` is one-shot: a CLI that crashes mid-copy
    // emits it long before the idle clock decides the create has stalled. The
    // listener used to be registered at that later moment, so it was attached
    // to an event that had already gone and the slot outlived the process.
    const slots = new WorktreeCreateSlots();
    const client = fakeClient();

    const release = slots.take(client);
    client.exit();               // the CLI dies while the watch is still running
    release({ keep: true });     // ...and only THEN does the watch call it stalled

    expect(slots.sole(client), "a dead client holds no creates").toBe(false);
  });

  it("keeps a stalled create's slot while the client is still alive", () => {
    // The property the retention exists for: a stalled create is one we stopped
    // waiting for, not one that ended, so a retry must not read its pathless
    // progress as its own.
    const slots = new WorktreeCreateSlots();
    const client = fakeClient();

    const stalled = slots.take(client);
    stalled({ keep: true });
    expect(slots.sole(client), "the abandoned create still counts").toBe(true);

    const retry = slots.take(client);
    expect(slots.sole(client), "so the retry cannot claim to be alone").toBe(false);
    retry();

    client.exit();
    expect(slots.sole(client)).toBe(false);
  });

  it("leaves no listener behind on an ordinary create", () => {
    // Why the listener could not simply always be registered before: a reused
    // workspace client would accumulate one per create until it exited.
    const slots = new WorktreeCreateSlots();
    const client = fakeClient();

    for (let i = 0; i < 50; i++) slots.take(client)();
    expect(client.count("exit")).toBe(0);

    // A retained slot is the one case that keeps its listener — that listener
    // IS what eventually frees the slot.
    slots.take(client)({ keep: true });
    expect(client.count("exit")).toBe(1);
  });

  it("ignores a second release rather than under-counting", () => {
    // An under-count reads as "only one create in flight", which is exactly the
    // state that makes a pathless progress event trusted when it should not be.
    const slots = new WorktreeCreateSlots();
    const client = fakeClient();

    const first = slots.take(client);
    slots.take(client);
    first();
    first();
    expect(slots.sole(client)).toBe(true);
  });

  it("survives a client that refuses to subscribe", () => {
    const slots = new WorktreeCreateSlots();
    const client = {
      on() { throw new Error("no listeners here"); },
    };
    const release = slots.take(client);
    expect(slots.sole(client)).toBe(true);
    expect(() => release()).not.toThrow();
    expect(slots.sole(client)).toBe(false);
  });
});
