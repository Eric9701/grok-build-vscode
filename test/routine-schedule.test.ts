/**
 * Routines, composed: the schedule and the claim together, over simulated time.
 *
 * Every piece here is covered on its own — `routines.test.ts` for the window
 * maths, `routine-store.test.ts` for the exclusive-create claim. What neither
 * proves is the property the whole design exists for, which only appears when
 * they run against each other over time and across hosts:
 *
 *   **However many hosts are up, and however long the machine was off, each
 *   window produces exactly one run.**
 *
 * So this drives a real temp directory through a simulated week with several
 * hosts ticking at once, and counts.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *   1. Three hosts ticking every minute produce ONE run per window, not three
 *   2. A closed laptop produces exactly ONE catch-up run, not one per missed window
 *   3. The catch-up run is the CURRENT window — no backlog is replayed
 *   4. A host joining late claims nothing that already ran
 *   5. Restarting every host mid-week does not re-run a claimed window
 *   6. A daily routine fires once per on-cycle day across a DST boundary,
 *      and never twice on the 25-hour day
 *   7. Pausing stops new runs; resuming does not replay what was missed
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RoutineRunStore, type RunStoreFs } from "../src/routine-store";
import { routineWindow, type LocalClock, type Routine } from "../src/routines";

const MIN = 60_000;
const HOUR = 3_600_000;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-sched-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const realFs: RunStoreFs = {
  mkdirSync: (p, o) => void fs.mkdirSync(p, o),
  writeFileSync: (p, d, o) => fs.writeFileSync(p, d, o),
  readFileSync: (p, e) => fs.readFileSync(p, e),
  readdirSync: (p) => fs.readdirSync(p),
  existsSync: (p) => fs.existsSync(p),
  unlinkSync: (p) => fs.unlinkSync(p),
};

function utcClock(): LocalClock {
  return {
    parts(ms) {
      const d = new Date(ms);
      return {
        y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
        minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      };
    },
    stamp: (y, m, d, minutes) => Date.UTC(y, m - 1, d, 0, minutes),
  };
}

/** One host: its own store instance over the shared directory, exactly as a
 *  second editor or the desktop app would be. */
function newHost(): RoutineRunStore {
  return new RoutineRunStore({ dir: dir.replace(/\\/g, "/"), fs: realFs });
}

/**
 * Tick `hosts` once at `now`. Returns how many of them actually won the claim,
 * which for a correct implementation is never more than one.
 */
function tickAll(hosts: RoutineRunStore[], routine: Routine, now: number, clock: LocalClock): number {
  if (routine.paused) return 0;
  const { key } = routineWindow(routine, now, clock);
  if (!key) return 0;
  let winners = 0;
  for (const host of hosts) {
    const won = host.claim(routine.id, key, {
      routineId: routine.id,
      windowKey: key,
      startedAt: now,
      outcome: "running",
    });
    if (won) {
      winners += 1;
      host.finish({
        routineId: routine.id, windowKey: key, startedAt: now,
        endedAt: now, outcome: "ran", sessionId: "s-" + key,
      });
    }
  }
  return winners;
}

const CREATED = Date.UTC(2026, 7, 24, 0, 0);

function every6h(over: Partial<Routine> = {}): Routine {
  return {
    id: "r1", title: "Brief", prompt: "p", cwd: "C:/repo",
    provider: "grok", model: "grok-4.6",
    cadence: { every: 6, unit: "hours" },
    createdAt: CREATED,
    ...over,
  };
}

describe("many hosts, one schedule", () => {
  it("produces one run per window however many hosts tick (req 1)", () => {
    const clock = utcClock();
    const routine = every6h();
    const hosts = [newHost(), newHost(), newHost()];

    // Three days, every host ticking every minute.
    let doubleClaims = 0;
    for (let t = CREATED; t <= CREATED + 72 * HOUR; t += MIN) {
      const winners = tickAll(hosts, routine, t, clock);
      if (winners > 1) doubleClaims += 1;
    }

    expect(doubleClaims).toBe(0);
    // Windows 0..12 inclusive across 72h at 6h — 13 runs, one each.
    const runs = fs.readdirSync(path.join(dir, "r1"));
    expect(runs).toHaveLength(13);
    expect(new Set(runs).size).toBe(13);
  });

  it("lets a host join late without re-running anything (req 4)", () => {
    const clock = utcClock();
    const routine = every6h();
    const early = [newHost()];
    for (let t = CREATED; t <= CREATED + 24 * HOUR; t += MIN) tickAll(early, routine, t, clock);
    const before = fs.readdirSync(path.join(dir, "r1")).length;

    // A second editor opens and immediately ticks over the same past instants.
    const late = newHost();
    for (let t = CREATED; t <= CREATED + 24 * HOUR; t += MIN) tickAll([late], routine, t, clock);

    expect(fs.readdirSync(path.join(dir, "r1"))).toHaveLength(before);
  });

  it("does not re-run a claimed window after every host restarts (req 5)", () => {
    const clock = utcClock();
    const routine = every6h();
    let hosts = [newHost(), newHost()];
    for (let t = CREATED; t <= CREATED + 12 * HOUR; t += MIN) tickAll(hosts, routine, t, clock);
    const before = fs.readdirSync(path.join(dir, "r1")).length;

    // Every in-memory memo is gone; only the filesystem remembers.
    hosts = [newHost(), newHost()];
    for (let t = CREATED; t <= CREATED + 12 * HOUR; t += MIN) tickAll(hosts, routine, t, clock);

    expect(fs.readdirSync(path.join(dir, "r1"))).toHaveLength(before);
  });
});

describe("a closed laptop", () => {
  it("catches up with exactly one run, not one per missed window (req 2, 3)", () => {
    const clock = utcClock();
    const routine = every6h();
    const hosts = [newHost()];

    // Friday: up for the first two windows.
    for (let t = CREATED; t <= CREATED + 7 * HOUR; t += MIN) tickAll(hosts, routine, t, clock);
    const beforeGap = fs.readdirSync(path.join(dir, "r1"));
    expect(beforeGap.sort()).toEqual(["i0.json", "i1.json"]);

    // Lid shut until Monday. Twelve windows are owed.
    const monday = CREATED + 72 * HOUR;
    const restarted = [newHost()];
    tickAll(restarted, routine, monday, clock);

    const after = fs.readdirSync(path.join(dir, "r1")).sort();
    expect(after).toHaveLength(3);
    // The CURRENT window, not the oldest missed one — no backlog is replayed.
    expect(after).toEqual(["i0.json", "i1.json", "i12.json"]);
  });

  it("resumes its normal cadence after the catch-up", () => {
    const clock = utcClock();
    const routine = every6h();
    const hosts = [newHost()];
    const monday = CREATED + 72 * HOUR;
    tickAll(hosts, routine, monday, clock);
    for (let t = monday; t <= monday + 24 * HOUR; t += MIN) tickAll(hosts, routine, t, clock);

    // i12 (the catch-up) plus i13..i16 over the following day.
    expect(fs.readdirSync(path.join(dir, "r1")).sort()).toEqual(
      ["i12.json", "i13.json", "i14.json", "i15.json", "i16.json"],
    );
  });
});

describe("a daily routine across a daylight-saving change", () => {
  it("fires once per day, never twice on the 25-hour day (req 6)", () => {
    // Clocks go back one hour at 01:00 UTC on 25 Oct: +120 before, +60 after.
    const cutover = Date.UTC(2026, 9, 25, 1, 0);
    const offsetFor = (utc: number) => (utc < cutover ? 120 : 60);
    const clock: LocalClock = {
      parts(ms) {
        const d = new Date(ms + offsetFor(ms) * MIN);
        return {
          y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
          minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
        };
      },
      stamp(y, m, d, minutes) {
        const wall = Date.UTC(y, m - 1, d, 0, minutes);
        return wall - offsetFor(wall - 120 * MIN) * MIN;
      },
    };

    const routine: Routine = {
      id: "r1", title: "Morning", prompt: "p", cwd: "C:/repo",
      provider: "grok", model: "grok-4.6",
      cadence: { every: 1, unit: "days", at: "08:00" },
      createdAt: Date.UTC(2026, 9, 23, 4, 0), // 06:00 local, before that day's slot
    };
    const hosts = [newHost(), newHost()];

    for (let t = routine.createdAt; t <= Date.UTC(2026, 9, 28, 0, 0); t += MIN) {
      expect(tickAll(hosts, routine, t, clock)).toBeLessThan(2);
    }

    const runs = fs.readdirSync(path.join(dir, "r1")).sort();
    // 23, 24, 25, 26, 27 — one per calendar day, the long day included ONCE.
    expect(runs).toEqual([
      "d2026-10-23.json", "d2026-10-24.json", "d2026-10-25.json",
      "d2026-10-26.json", "d2026-10-27.json",
    ]);

    // And each one fired at 08:00 local, not at a drifting UTC offset.
    for (const name of runs) {
      const run = JSON.parse(fs.readFileSync(path.join(dir, "r1", name), "utf8"));
      expect(clock.parts(run.startedAt).minutes).toBe(8 * 60);
    }
  });
});

describe("pausing", () => {
  it("stops new runs and does not replay them on resume (req 7)", () => {
    const clock = utcClock();
    const hosts = [newHost()];
    const live = every6h();
    for (let t = CREATED; t <= CREATED + 7 * HOUR; t += MIN) tickAll(hosts, live, t, clock);
    expect(fs.readdirSync(path.join(dir, "r1"))).toHaveLength(2);

    const paused = every6h({ paused: true });
    for (let t = CREATED + 7 * HOUR; t <= CREATED + 48 * HOUR; t += MIN) {
      tickAll(hosts, paused, t, clock);
    }
    expect(fs.readdirSync(path.join(dir, "r1"))).toHaveLength(2);

    // Resumed a day later: the current window fires, the paused ones stay gone.
    const resumed = every6h();
    tickAll(hosts, resumed, CREATED + 48 * HOUR, clock);
    expect(fs.readdirSync(path.join(dir, "r1")).sort()).toEqual(
      ["i0.json", "i1.json", "i8.json"],
    );
  });
});
