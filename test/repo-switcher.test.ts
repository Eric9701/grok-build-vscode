import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverRepos,
  normalizeRepoPath,
  repoLabels,
  type FsLike,
  type RepoPins,
} from "../src/sessions";

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
    expect(discoverRepos({
      fs,
      grokHome,
      pins,
      tmpDir: tmp,
      trustedCwds: [unknown],
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
