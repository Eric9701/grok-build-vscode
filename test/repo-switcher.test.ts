import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverRepos,
  normalizeRepoPath,
  repoLabels,
  type FsLike,
  type RepoPins,
} from "../src/sessions";
import { worktreeCwdsForRepo } from "../src/worktree";

function fakeFs(entries: Record<string, { dir: boolean; mtime?: number }>): FsLike {
  return {
    existsSync: (p) => !!entries[p],
    readdirSync: (p) => {
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      const names = new Set<string>();
      for (const key of Object.keys(entries)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const first = rest.split(/[\\/]/)[0];
        if (first) names.add(first);
      }
      return [...names];
    },
    readFileSync: () => "",
    statSync: (p) => {
      const hit = entries[p];
      if (!hit) throw new Error("ENOENT");
      return { isDirectory: () => hit.dir, mtimeMs: hit.mtime ?? 0 };
    },
    rmdirSync: () => {},
  };
}

describe("repo switcher discovery", () => {
  const grokHome = path.join(path.sep, "home", "p", ".grok");
  const root = path.join(grokHome, "sessions");
  const tmp = path.join(path.sep, "tmp");
  const cwdA = path.join(path.sep, "work", "one", "app");
  const cwdB = path.join(path.sep, "work", "two", "app");
  const tempCwd = path.join(tmp, "grok-live-123");

  it("decodes cwd catalogs, filters temp noise before rendering, and disambiguates duplicate leaves", () => {
    const aCatalog = path.join(root, encodeURIComponent(cwdA));
    const bCatalog = path.join(root, encodeURIComponent(cwdB));
    const tempCatalog = path.join(root, encodeURIComponent(tempCwd));
    const fs = fakeFs({
      [root]: { dir: true },
      [aCatalog]: { dir: true, mtime: 10 },
      [bCatalog]: { dir: true, mtime: 20 },
      [tempCatalog]: { dir: true, mtime: 999 },
      [cwdA]: { dir: true },
      [cwdB]: { dir: true },
      [tempCwd]: { dir: true },
    });
    const repos = discoverRepos({ fs, grokHome, pins: {}, tmpDir: tmp, platform: process.platform });
    expect(repos.map((r) => r.cwd)).toEqual([cwdB, cwdA]);
    expect(repos.map((r) => r.label)).toEqual(["two/app", "one/app"]);
  });

  it("never promotes Grok-managed worktrees to top-level repos, labelled or not", () => {
    const worktreesRoot = path.join(grokHome, "worktrees");
    const labelled = path.join(worktreesRoot, "repo", "known");
    const unknown = path.join(worktreesRoot, "repo", "forgotten");
    const pinned = path.join(worktreesRoot, "repo", "old-pin");
    const labelledCatalog = path.join(root, encodeURIComponent(labelled));
    const unknownCatalog = path.join(root, encodeURIComponent(unknown));
    const pins: RepoPins = {
      [normalizeRepoPath(pinned)]: { cwd: pinned, pinnedAt: 1 },
    };
    const fs = fakeFs({
      [root]: { dir: true },
      [labelledCatalog]: { dir: true, mtime: 20 },
      [unknownCatalog]: { dir: true, mtime: 10 },
      [labelled]: { dir: true },
      [unknown]: { dir: true },
      [pinned]: { dir: true },
    });
    const labels = new Map([[normalizeRepoPath(labelled), "known"]]);
    // Session catalogs and pins never promote a worktree to a row — that is the
    // rule being pinned: a worktree belongs to a parent checkout, it isn't a
    // repo you choose between. `trustedCwds` is the single carve-out, covered
    // separately below; the folder the user actually opened is not clutter, and
    // excluding it leaves the selection naming a row that doesn't exist.
    expect(discoverRepos({
      fs,
      grokHome,
      pins,
      tmpDir: tmp,
      worktreeLabels: labels,
    })).toEqual([]);
  });

  it("keeps a pinned missing checkout visible and sorts pins above recency", () => {
    const live = path.join(path.sep, "work", "live");
    const missing = path.join(path.sep, "mnt", "offline");
    const liveCatalog = path.join(root, encodeURIComponent(live));
    const key = normalizeRepoPath(missing);
    const pins: RepoPins = { [key]: { cwd: missing, pinnedAt: 50 } };
    const fs = fakeFs({
      [root]: { dir: true },
      [liveCatalog]: { dir: true, mtime: 100 },
      [live]: { dir: true },
    });
    const repos = discoverRepos({ fs, grokHome, pins, tmpDir: tmp });
    expect(repos[0]).toMatchObject({ cwd: missing, pinned: true, available: false });
    expect(repos[1]).toMatchObject({ cwd: live, pinned: false, available: true });
  });

  it("keeps open workspace roots selectable before their first Grok session", () => {
    const fresh = path.join(path.sep, "work", "fresh");
    const fs = fakeFs({
      [root]: { dir: true },
      [fresh]: { dir: true },
    });
    const repos = discoverRepos({
      fs,
      grokHome,
      pins: {},
      tmpDir: tmp,
      trustedCwds: [fresh],
    });
    expect(repos).toEqual([
      expect.objectContaining({ cwd: fresh, label: "fresh", available: true, updatedAt: 0 }),
    ]);
  });

  it("uses only leaf labels when they are unique", () => {
    const labels = repoLabels(["/work/alpha", "/other/beta"]);
    expect(labels.get("/work/alpha")).toBe("alpha");
    expect(labels.get("/other/beta")).toBe("beta");
  });

  it("preserves filesystem roots while normalizing repo identity", () => {
    expect(normalizeRepoPath(path.parse(path.resolve(path.sep)).root)).toBe(path.parse(path.resolve(path.sep)).root.toLowerCase());
  });
});

describe("worktree cwds that ride along with a repo's history", () => {
  const WS = path.resolve("/repo/packages/app");
  const GIT_ROOT = path.resolve("/repo");
  const WT_A = path.resolve("/home/.grok/worktrees/repo/feature-a");
  const WT_B = path.resolve("/home/.grok/worktrees/repo/feature-b");

  // Worktree sessions live in their recorded parent repo's history rather than
  // becoming rows in the project selector.
  it("lists recorded worktrees when the primary workspace is below the git root", () => {
    // The regression this pins: `sourceGitRoot` is the CLI's GIT root, so
    // opening a SUBDIRECTORY of a repo in VS Code makes it != workspaceRoot.
    // Matching on equality dropped these from the list they had always been in.
    expect(
      worktreeCwdsForRepo({
        repoCwd: WS,
        repoGitRoot: GIT_ROOT,
        worktrees: [
          { path: WT_A, sourceGitRoot: GIT_ROOT },
          { path: WT_B, sourceGitRoot: GIT_ROOT },
        ],
      }),
    ).toEqual([WT_A, WT_B]);
  });

  it("does not authorize a parentless worktree under an arbitrary repo", () => {
    expect(
      worktreeCwdsForRepo({ repoCwd: WS, repoGitRoot: GIT_ROOT, worktrees: [{ path: WT_A }] }),
    ).toEqual([]);
  });

  it("scopes to the matching repo once a NON-primary one is selected", () => {
    const other = path.resolve("/work/other");
    const otherWt = path.resolve("/home/.grok/worktrees/other/wt");
    const picked = worktreeCwdsForRepo({
      repoCwd: other,
      repoGitRoot: other,
      worktrees: [
        { path: WT_A, sourceGitRoot: GIT_ROOT },
        { path: otherWt, sourceGitRoot: other },
      ],
    });
    expect(picked).toEqual([otherWt]);
  });

  it("matches a selected repo that sits under its own git root", () => {
    const sub = path.resolve("/work/other/pkg");
    const wt = path.resolve("/home/.grok/worktrees/other/wt");
    expect(
      worktreeCwdsForRepo({
        repoCwd: sub,
        repoGitRoot: path.resolve("/work/other"),
        worktrees: [{ path: wt, sourceGitRoot: path.resolve("/work/other") }],
      }),
    ).toEqual([wt]);
  });

  it("drops an unparented worktree from a non-primary repo rather than guessing", () => {
    expect(
      worktreeCwdsForRepo({
        repoCwd: path.resolve("/work/other"),
        repoGitRoot: path.resolve("/work/other"),
        worktrees: [{ path: WT_A }],
      }),
    ).toEqual([]);
  });
});

describe("the workspace you opened is always a row", () => {
  const grokHome = path.join(path.sep, "home", "p", ".grok");
  const root = path.join(grokHome, "sessions");
  const wtRoot = path.join(grokHome, "worktrees");
  const tmp = path.join(path.sep, "tmp");
  const mainRepo = path.join(path.sep, "work", "repo");
  const wtA = path.join(wtRoot, "repo", "feature-a");
  const wtB = path.join(wtRoot, "repo", "feature-b");

  // Worktrees are excluded as ROWS so they don't clutter the picker — but that
  // rule must not swallow the folder the user deliberately opened. When it did,
  // the selection named a cwd absent from the catalog, and since both
  // clearAllSessions and selectRepo resolve through the catalog and bail on a
  // miss, a confirmed "Delete All" silently did nothing.
  it("keeps a worktree out of the list when it is merely a session catalog", () => {
    const fs = fakeFs({
      [root]: { dir: true },
      [path.join(root, encodeURIComponent(mainRepo))]: { dir: true, mtime: 10 },
      [path.join(root, encodeURIComponent(wtA))]: { dir: true, mtime: 20 },
      [mainRepo]: { dir: true },
      [wtA]: { dir: true },
    });
    const repos = discoverRepos({
      fs, grokHome, pins: {}, tmpDir: tmp, platform: process.platform,
      trustedCwds: [mainRepo],
    });
    expect(repos.map((r) => r.cwd)).toEqual([mainRepo]);
  });

  it("lists a worktree that IS the open workspace, so the selection can resolve", () => {
    const fs = fakeFs({
      [root]: { dir: true },
      [path.join(root, encodeURIComponent(wtA))]: { dir: true, mtime: 20 },
      [path.join(root, encodeURIComponent(wtB))]: { dir: true, mtime: 30 },
      [wtA]: { dir: true },
      [wtB]: { dir: true },
    });
    const repos = discoverRepos({
      fs, grokHome, pins: {}, tmpDir: tmp, platform: process.platform,
      trustedCwds: [wtA],
    });
    // Exactly the one you opened — not every worktree on disk.
    expect(repos.map((r) => r.cwd)).toEqual([wtA]);
    expect(repos[0].available).toBe(true);
  });
});
