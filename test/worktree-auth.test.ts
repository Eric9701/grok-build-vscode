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
  CLONE_WORKTREE_SOURCE_MARKER,
  cloneWorktreeSourceMatches,
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
    // From create progress through the cache push it guards. Bounded by the
    // push itself, not by a character count — a fixed window silently stops
    // covering the code it is about the moment a comment grows.
    const createRegion = src.slice(
      createStart,
      src.indexOf("this.worktreeCache.push", createStart) + 40,
    );
    const authIdx = createRegion.indexOf("worktreePathAuthorizedForRepo");
    const cachePush = createRegion.indexOf("this.worktreeCache.push");
    expect(authIdx).toBeGreaterThan(0);
    expect(cachePush).toBeGreaterThan(authIdx);

    // Mutation: if we pushed to cache before validation, order flips.
    expect(cachePush).toBeGreaterThan(authIdx);
  });
});

/**
 * Clone-mode worktrees.
 *
 * Not every "worktree" the CLI produces is a `git worktree add`. For some repos
 * it makes a standalone clone — its `.git` is a real directory with its own
 * object store — and the source repo's `git worktree list` will never mention
 * it. The owner hit exactly that: the checkout was created, refused as "not in
 * git worktree list", and left on disk; the retry that "worked" only passed
 * because the ACP list was trusted on its own, and what it waved through was an
 * empty directory that grok then exited 1 inside.
 *
 * So the provenance marker the CLI writes is the second form of proof — read
 * from local disk by us, never taken from the agent.
 */
describe("cloneWorktreeSourceMatches", () => {
  // The owner's real paths — note the lowercase drive letter in the marker the
  // CLI wrote against the uppercase one in the worktree path. Windows treats
  // them as the same place and so must this.
  const SOURCE = String.raw`c:\GitHub\accredia`;
  const WT = String.raw`C:\Users\Dell\.grok\worktrees\github-accredia\worktree-test`;
  const winJoin = (a: string, b: string) => `${a}\\${b.split("/").join("\\")}`;
  const reader = (contents: Record<string, string>) => (p: string) => {
    const hit = contents[p];
    if (hit === undefined) throw new Error("ENOENT: no such file");
    return hit;
  };
  const marker = (dir: string) => winJoin(dir, CLONE_WORKTREE_SOURCE_MARKER);
  const call = (opts: { source?: string; gitRoot?: string; contents?: Record<string, string> }) =>
    cloneWorktreeSourceMatches({
      worktreePath: WT,
      sourceRepo: opts.source ?? SOURCE,
      sourceGitRoot: opts.gitRoot,
      readMarker: reader(opts.contents ?? {}),
      joinPath: winJoin,
    });

  it("accepts a marker naming the source repo", () => {
    expect(call({ contents: { [marker(WT)]: `${SOURCE}\n` } })).toBe(true);
  });

  it("accepts a marker naming the git root when the project is a subfolder", () => {
    expect(
      call({
        source: String.raw`c:\GitHub\accredia\packages\app`,
        gitRoot: SOURCE,
        contents: { [marker(WT)]: SOURCE },
      }),
    ).toBe(true);
  });

  it("refuses a marker naming a DIFFERENT repo", () => {
    // The whole point: a path the agent claims is a worktree of this repo, but
    // whose own on-disk record says it came from somewhere else.
    expect(call({ contents: { [marker(WT)]: String.raw`c:\GitHub\some-other-repo` } })).toBe(false);
  });

  it("refuses when there is no marker at all", () => {
    // An empty directory the CLI left behind reads exactly like this.
    expect(call({})).toBe(false);
  });

  it("refuses an empty or self-referential marker", () => {
    expect(call({ contents: { [marker(WT)]: "   \n" } })).toBe(false);
    expect(call({ contents: { [marker(WT)]: WT } })).toBe(false);
  });
});

describe("worktree validation reads git first", () => {
  it("never returns an ACP path git has not confirmed, without proof of its own", () => {
    // The regression that shipped: `listAuthoritativeWorktreePaths` returned the
    // agent's list verbatim whenever it had any attributed row, and consulted
    // git only when that list was EMPTY. The guard's whole job is to confirm the
    // agent's claim, and it was satisfied by the claim.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private async listAuthoritativeWorktreePaths");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  private ", start + 40));
    // git runs unconditionally, before any use of the ACP answer.
    const gitAt = body.indexOf("listGitWorktreePaths");
    const acpAt = body.indexOf("client.listWorktrees");
    expect(gitAt).toBeGreaterThan(-1);
    expect(acpAt).toBeGreaterThan(gitAt);
    // Every ACP row that gets added has to clear the provenance check.
    expect(body).toMatch(/cloneWorktreeBelongsTo\([^)]*\)\)\s*add\(/);
  });

  it("a directory with no .git is never 'ready'", () => {
    // waitForWorktreeReady used to fall back to `existsSync(worktreePath)` on
    // timeout, so an empty folder counted as a checkout and grok was spawned in
    // it. That is the `grok exited with code 1` in the owner's log.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private async waitForWorktreeReady");
    const body = src.slice(start, src.indexOf("\n  }", start) + 4);
    expect(body).toContain('path.join(worktreePath, ".git")');
    expect(body).not.toMatch(/return fs\.existsSync\(worktreePath\)/);
  });

  it("self-removal is fenced by location AND one positive answer", () => {
    // The fallback for "Remove worktree failed: Internal error" is a recursive
    // delete, so the fence is worth pinning: grok's own root, never an open
    // folder or the source repo, and then either nothing-to-lose (gone or
    // empty) or a marker naming this repo.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private canSelfRemoveWorktree");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  /**", start));
    expect(body).toContain('path.join(resolveGrokHome(), "worktrees")');
    expect(body).toContain("relativePathWithin");
    expect(body).toContain("openWorkspaceFolders");
    expect(body).toContain("cloneWorktreeBelongsTo");
    // An empty directory has nothing to lose, and it is the case that kept the
    // owner stuck: the CLI deletes the contents and THEN fails on the
    // bookkeeping, so by the time it reports the error there is no marker left
    // to prove anything with. Refusing there refuses to delete an empty folder
    // the user explicitly asked to delete.
    expect(body).toContain("readdirSync");
    expect(body).toContain("if (!contents.length) return undefined");
  });

  it("refusals carry a reason, and the reason reaches the user", () => {
    // "Remove worktree failed: Internal error" with nothing after it is what
    // this round cost. A refusal has to say what it refused on.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private canSelfRemoveWorktree");
    const body = src.slice(start, src.indexOf("\n  /**", start));
    expect(body).toContain(": string | undefined {");
    expect(body).toContain("return `it is outside");
    const remove = src.slice(src.indexOf("async removeFocusedWorktree"));
    expect(remove.slice(0, remove.indexOf("this.worktreeCache = "))).toContain(
      "was left alone because",
    );
  });

  it("does not demand a clone marker from a worktree git already listed", () => {
    // Linked worktrees have no marker BY DESIGN. Running the check on them
    // logged "no clone provenance" for perfectly valid checkouts — which is
    // exactly the alarming line the owner reported for a worktree that worked.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private async listAuthoritativeWorktreePaths");
    const body = src.slice(start, src.indexOf("\n  private ", start + 40));
    expect(body).toContain("if (authorized.some((p) => pathsEqual(p, row.path))) continue;");
  });
});
