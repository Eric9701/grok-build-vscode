/**
 * Pure project-discovery seeding + archive-field stripping.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *  1. Threshold 10-in-3-months opens / skips correctly
 *  2. Seeding only when !seedCompleted && empty open set
 *  3. Deliberate empty after seed does NOT re-seed
 *  4. withoutArchiveFields removes the wire capability signal
 *  5. ensureWorkspaceRoot seeds only those paths (trust set = opened folders)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PROJECT_DISCOVERY_MIN_SESSIONS,
  PROJECT_DISCOVERY_WINDOW_MS,
  meetsProjectDiscoveryThreshold,
  selectProjectsToSeed,
  shouldSeedProjectDiscovery,
  withoutArchiveFields,
} from "../src/project-discovery";
import { ConfigStore } from "../src/desktop/config-store";
import {
  discoverSeedProjectPaths,
  ensureWorkspaceRoot,
} from "../src/desktop/electron-host";
import { sessionsDirFor } from "../src/sessions";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 7, 1); // fixed clock

function stamps(n: number, ageDays: number): number[] {
  const t = now - ageDays * DAY;
  return Array.from({ length: n }, () => t);
}

describe("meetsProjectDiscoveryThreshold", () => {
  it("requires at least 10 sessions inside the 3-month window", () => {
    expect(meetsProjectDiscoveryThreshold(stamps(10, 0), now)).toBe(true);
    expect(meetsProjectDiscoveryThreshold(stamps(9, 0), now)).toBe(false);
    expect(meetsProjectDiscoveryThreshold(stamps(10, 89), now)).toBe(true);
    // Just outside the window.
    expect(meetsProjectDiscoveryThreshold(stamps(10, 91), now)).toBe(false);
  });

  it("counts only sessions inside the window (mixed ages)", () => {
    const mixed = [...stamps(9, 10), ...stamps(5, 200)];
    expect(meetsProjectDiscoveryThreshold(mixed, now)).toBe(false);
    const enough = [...stamps(10, 10), ...stamps(50, 200)];
    expect(meetsProjectDiscoveryThreshold(enough, now)).toBe(true);
  });

  it("exposes the constants tests and call sites share", () => {
    expect(PROJECT_DISCOVERY_MIN_SESSIONS).toBe(10);
    expect(PROJECT_DISCOVERY_WINDOW_MS).toBe(90 * DAY);
  });
});

describe("shouldSeedProjectDiscovery", () => {
  it("seeds on first run with an empty open set", () => {
    expect(
      shouldSeedProjectDiscovery({ discoverySeedCompleted: false, openFolderCount: 0 }),
    ).toBe(true);
  });

  it("does not seed when folders are already open (restored prefs / --workspace)", () => {
    expect(
      shouldSeedProjectDiscovery({ discoverySeedCompleted: false, openFolderCount: 1 }),
    ).toBe(false);
    expect(
      shouldSeedProjectDiscovery({ discoverySeedCompleted: true, openFolderCount: 3 }),
    ).toBe(false);
  });

  it("does not re-seed after the flag is set — including a deliberate empty list", () => {
    // Owner note: "when empty" and "do not re-seed after closing everything"
    // conflict; the seed-completed flag resolves it. Empty + completed = no seed.
    expect(
      shouldSeedProjectDiscovery({ discoverySeedCompleted: true, openFolderCount: 0 }),
    ).toBe(false);
  });
});

describe("selectProjectsToSeed", () => {
  it("opens only checkouts meeting the threshold", () => {
    const picked = selectProjectsToSeed(
      [
        { cwd: "/work/hot", sessionTimestampsMs: stamps(12, 5) },
        { cwd: "/work/cold", sessionTimestampsMs: stamps(3, 5) },
        { cwd: "/work/stale", sessionTimestampsMs: stamps(20, 120) },
        { cwd: "/work/edge", sessionTimestampsMs: stamps(10, 30) },
      ],
      now,
    );
    expect(picked).toEqual(["/work/hot", "/work/edge"]);
  });
});

describe("withoutArchiveFields", () => {
  it("strips archived/archivedAt so the client capability probe is false", () => {
    const stripped = withoutArchiveFields({
      cwd: "/r",
      label: "r",
      available: true,
      pinned: false,
      updatedAt: 1,
      archived: true,
      archivedAt: 99,
    });
    expect(stripped).toEqual({
      cwd: "/r",
      label: "r",
      available: true,
      pinned: false,
      updatedAt: 1,
    });
    expect("archived" in stripped).toBe(false);
    expect(typeof (stripped as { archived?: boolean }).archived).toBe("undefined");
  });
});

describe("ensureWorkspaceRoot seeding (host-side)", () => {
  let tmp: string;
  let prefsFile: string;
  let grokHome: string;
  let hot: string;
  let cold: string;

  function touchSession(cwd: string, id: string, mtimeMs: number): void {
    const dir = path.join(sessionsDirFor(grokHome, cwd), id);
    fs.mkdirSync(dir, { recursive: true });
    const summary = path.join(dir, "summary.json");
    fs.writeFileSync(summary, JSON.stringify({ info: { id, cwd }, updated_at: new Date(mtimeMs).toISOString() }));
    fs.utimesSync(summary, new Date(mtimeMs), new Date(mtimeMs));
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-seed-"));
    prefsFile = path.join(tmp, "config.json");
    grokHome = path.join(tmp, "grok-home");
    hot = fs.mkdtempSync(path.join(tmp, "hot-"));
    cold = fs.mkdtempSync(path.join(tmp, "cold-"));
    for (let i = 0; i < 12; i++) touchSession(hot, `hot-${i}`, now - i * DAY);
    for (let i = 0; i < 3; i++) touchSession(cold, `cold-${i}`, now - i * DAY);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("seeds only projects meeting the threshold into the open set", () => {
    const store = new ConfigStore(prefsFile);
    const seeded = discoverSeedProjectPaths({
      fs: fs as any,
      grokHome,
      tmpDir: path.join(tmp, "tmp"),
      nowMs: now,
    });
    expect(seeded).toContain(hot);
    expect(seeded).not.toContain(cold);

    const root = ensureWorkspaceRoot(store, () => null, undefined, {
      runDiscoverySeed: () => seeded,
    });
    expect(store.getWorkspaceRoots().map((p) => path.resolve(p))).toEqual(
      seeded.map((p) => path.resolve(p)),
    );
    expect(root).toBeTruthy();
    expect(store.isDiscoverySeedCompleted()).toBe(true);

    // Trust set = only what we opened — cold never entered open roots.
    expect(store.getWorkspaceRoots().some((r) => path.resolve(r) === path.resolve(cold))).toBe(false);
  });

  it("does not seed when a workspace is forced or already open", () => {
    const store = new ConfigStore(prefsFile);
    let discoveryCalls = 0;
    const runDiscoverySeed = () => {
      discoveryCalls++;
      return [hot];
    };

    // Forced path: open that folder, mark completed, never discover.
    const forced = ensureWorkspaceRoot(store, () => null, hot, { runDiscoverySeed });
    expect(forced && path.resolve(forced)).toBe(path.resolve(hot));
    expect(discoveryCalls).toBe(0);
    expect(store.isDiscoverySeedCompleted()).toBe(true);

    // Second launch with empty prefs would not re-run because flag is set —
    // simulate by clearing roots while keeping the flag.
    store.removeWorkspaceRoot(hot);
    expect(store.getWorkspaceRoots()).toEqual([]);
    const again = ensureWorkspaceRoot(store, () => null, undefined, { runDiscoverySeed });
    expect(discoveryCalls).toBe(0);
    expect(again).toBeUndefined();
    expect(store.getWorkspaceRoots()).toEqual([]);
  });

  it("marks seed completed even when discovery finds nothing (no picker)", () => {
    const store = new ConfigStore(prefsFile);
    const root = ensureWorkspaceRoot(store, () => null, undefined, {
      runDiscoverySeed: () => [],
    });
    expect(root).toBeUndefined();
    expect(store.getWorkspaceRoots()).toEqual([]);
    expect(store.isDiscoverySeedCompleted()).toBe(true);
    // Next empty launch: still no seed.
    let calls = 0;
    ensureWorkspaceRoot(store, () => null, undefined, {
      runDiscoverySeed: () => {
        calls++;
        return [hot];
      },
    });
    expect(calls).toBe(0);
  });

  it("allows closing the last folder without re-seeding on next ensure", () => {
    const store = new ConfigStore(prefsFile);
    store.addWorkspaceRoot(hot, true);
    store.markDiscoverySeedCompleted();
    expect(store.removeWorkspaceRoot(hot)).toBe(true);
    expect(store.getWorkspaceRoots()).toEqual([]);
    let calls = 0;
    ensureWorkspaceRoot(store, () => null, undefined, {
      runDiscoverySeed: () => {
        calls++;
        return [cold];
      },
    });
    expect(calls).toBe(0);
    expect(store.getWorkspaceRoots()).toEqual([]);
  });
});
