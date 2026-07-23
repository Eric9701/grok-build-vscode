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
  worktreeDisplayName,
  WORKTREE_NAME_TAG,
  matchWorktreeForCwd,
  mergeSessionIndexes,
  sanitizeWorktreeLabel,
  pathsEqual,
  pathIsInside,
  isGitRepo,
  normalizeFsPath,
} from "../src/worktree";

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
