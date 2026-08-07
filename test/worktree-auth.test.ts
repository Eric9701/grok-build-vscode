/**
 * ACP worktree path validation before cache / auth roots.
 *
 * Mutation-checked: an unlisted worktree path is refused.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterWorktreesForSourceRepo,
  mergeWorktreeRefresh,
  parseGitWorktreeListPorcelain,
  worktreePathAuthorizedForRepo,
  type WorktreeRecord,
} from "../src/worktree";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rec(partial: Partial<WorktreeRecord> & { path: string; sourceRepo?: string }): WorktreeRecord {
  return {
    id: partial.id ?? partial.path,
    path: partial.path,
    sourceRepo: partial.sourceRepo ?? "",
    repoName: partial.repoName ?? "r",
    kind: partial.kind ?? "session",
    creationMode: partial.creationMode ?? "linked",
    gitRef: partial.gitRef ?? "HEAD",
    headCommit: partial.headCommit ?? "",
    status: partial.status ?? "alive",
    label: partial.label ?? "l",
    userProvidedLabel: partial.userProvidedLabel ?? false,
  };
}

describe("worktreePathAuthorizedForRepo", () => {
  const source = "/repos/app";
  const listed = ["/repos/app", "/home/u/.grok/worktrees/app/feat"];

  it("accepts a path that appears in the authoritative list for the repo", () => {
    expect(
      worktreePathAuthorizedForRepo({
        worktreePath: "/home/u/.grok/worktrees/app/feat",
        sourceRepo: source,
        listedWorktreePaths: listed,
        claimedSourceGitRoot: source,
        sourceGitRoot: source,
      }),
    ).toBe(true);
  });

  it("refuses a path not in the worktree list (compromised ACP create)", () => {
    expect(
      worktreePathAuthorizedForRepo({
        worktreePath: "/evil/outside",
        sourceRepo: source,
        listedWorktreePaths: listed,
        claimedSourceGitRoot: source,
      }),
    ).toBe(false);
  });

  it("refuses when claimed sourceGitRoot does not match the requested repo", () => {
    expect(
      worktreePathAuthorizedForRepo({
        worktreePath: "/home/u/.grok/worktrees/app/feat",
        sourceRepo: source,
        listedWorktreePaths: listed,
        claimedSourceGitRoot: "/evil/other-repo",
        sourceGitRoot: source,
      }),
    ).toBe(false);
  });

  it("refuses the main checkout path as a 'created' worktree", () => {
    expect(
      worktreePathAuthorizedForRepo({
        worktreePath: source,
        sourceRepo: source,
        listedWorktreePaths: listed,
      }),
    ).toBe(false);
  });
});

describe("filterWorktreesForSourceRepo / mergeWorktreeRefresh", () => {
  it("drops records without sourceRepo or with the wrong source", () => {
    const refreshed = [
      rec({ path: "/wt/good", sourceRepo: "/repos/app" }),
      rec({ path: "/wt/evil", sourceRepo: "/repos/other" }),
      rec({ path: "/wt/orphan" }), // no sourceRepo
    ];
    const kept = filterWorktreesForSourceRepo(refreshed, "/repos/app");
    expect(kept.map((r) => r.path)).toEqual(["/wt/good"]);
  });

  it("mergeWorktreeRefresh does not inject unattributed rows into the cache", () => {
    const current: WorktreeRecord[] = [
      rec({ path: "/wt/old", sourceRepo: "/repos/app" }),
    ];
    const merged = mergeWorktreeRefresh(current, "/repos/app", [
      rec({ path: "/wt/new", sourceRepo: "/repos/app" }),
      rec({ path: "/evil", sourceRepo: "" }),
      rec({ path: "/other", sourceRepo: "/repos/other" }),
    ]);
    expect(merged.map((r) => r.path).sort()).toEqual(["/wt/new"].sort());
  });
});

describe("parseGitWorktreeListPorcelain", () => {
  it("extracts worktree paths from porcelain output", () => {
    const stdout = [
      "worktree /repos/app",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /home/u/.grok/worktrees/app/feat",
      "HEAD def",
      "detached",
      "",
    ].join("\n");
    expect(parseGitWorktreeListPorcelain(stdout)).toEqual([
      "/repos/app",
      "/home/u/.grok/worktrees/app/feat",
    ]);
  });
});

describe("sidebar create path validates before cache (source)", () => {
  it("create worktree calls worktreePathAuthorizedForRepo before cache push", () => {
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(src).toContain("worktreePathAuthorizedForRepo");
    expect(src).toContain("listAuthoritativeWorktreePaths");
    expect(src).toContain("listGitWorktreePaths");
    // git spawn lives outside sidebar (cli-process gate: no execFile in sidebar).
    expect(src).toMatch(/from\s+["']\.\/git-worktree-list["']/);

    const createStart = src.indexOf("Creating git worktree");
    // From create progress through cache push.
    const createRegion = src.slice(createStart, createStart + 4500);
    const authIdx = createRegion.indexOf("worktreePathAuthorizedForRepo");
    const cachePush = createRegion.indexOf("this.worktreeCache.push");
    expect(authIdx).toBeGreaterThan(0);
    expect(cachePush).toBeGreaterThan(authIdx);

    // Mutation: if we pushed to cache before validation, order flips.
    expect(cachePush).toBeGreaterThan(authIdx);
  });
});
