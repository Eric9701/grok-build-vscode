/**
 * Routine run store — the claim that makes a run happen exactly once.
 *
 * The claim tests run against a REAL temp directory, deliberately. A fake fs
 * that "implements" the exclusive-create flag proves only that the fake is
 * self-consistent; the guarantee under test belongs to the operating system,
 * so the operating system has to be the one asserting it.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *   1. Two hosts claiming the same window: exactly one wins
 *   2. A second claim by the SAME host also loses — a tick inside one window
 *      re-fires nothing
 *   3. Different windows of the same routine are independently claimable
 *   4. Losing a claim is silent; it must not log per-tick
 *   5. A traversal-shaped window key or routine id is refused, not written
 *   6. A corrupt record is skipped without blanking the rest of the history
 *   7. `list` returns newest-first and caps at 20
 *   8. `prune` deletes only beyond the cap, oldest first
 *   9. A pruned window can be claimed again — the memo does not outlive the file
 *  10. `sweepInterrupted` rewrites only `running`, and the claim file survives
 *      so the window stays consumed
 *  11. `forget` drops a removed routine's whole history
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RoutineRunStore, type RunStoreFs } from "../src/routine-store";
import type { RoutineRun } from "../src/routines";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-runs-"));
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

function store(log?: (line: string) => void): RoutineRunStore {
  return new RoutineRunStore({ dir: dir.replace(/\\/g, "/"), fs: realFs, log });
}

function run(windowKey: string, over: Partial<RoutineRun> = {}): RoutineRun {
  return {
    routineId: "r1",
    windowKey,
    startedAt: 1000,
    outcome: "running",
    ...over,
  };
}

describe("claiming", () => {
  it("lets exactly one of two hosts win the same window (req 1)", () => {
    // Two stores over ONE directory is two hosts over one ~/.grok.
    const vscode = store();
    const desktop = store();

    const a = vscode.claim("r1", "i0", run("i0"));
    const b = desktop.claim("r1", "i0", run("i0"));

    expect([a, b]).toEqual([true, false]);
    expect(fs.readdirSync(path.join(dir, "r1"))).toEqual(["i0.json"]);
  });

  it("refuses a second claim from the same host (req 2)", () => {
    const host = store();
    expect(host.claim("r1", "i0", run("i0"))).toBe(true);
    expect(host.claim("r1", "i0", run("i0"))).toBe(false);
  });

  it("still refuses after a restart, when the memo is empty but the file is not (req 2)", () => {
    expect(store().claim("r1", "i0", run("i0"))).toBe(true);
    // A fresh store has no in-memory memo — the filesystem has to be what says no.
    expect(store().claim("r1", "i0", run("i0"))).toBe(false);
  });

  it("keeps different windows independent (req 3)", () => {
    const host = store();
    expect(host.claim("r1", "i0", run("i0"))).toBe(true);
    expect(host.claim("r1", "i1", run("i1"))).toBe(true);
    expect(host.claim("r2", "i0", run("i0", { routineId: "r2" }))).toBe(true);
  });

  it("loses silently — a busy machine must not log per tick (req 4)", () => {
    const lines: string[] = [];
    const first = store((l) => lines.push(l));
    first.claim("r1", "i0", run("i0"));

    const second = store((l) => lines.push(l));
    second.claim("r1", "i0", run("i0"));

    expect(lines).toEqual([]);
  });

  it("refuses a traversal-shaped key or id without writing (req 5)", () => {
    const lines: string[] = [];
    const host = store((l) => lines.push(l));

    expect(host.claim("r1", "../../escape", run("../../escape"))).toBe(false);
    expect(host.claim("../..", "i0", run("i0"))).toBe(false);
    expect(host.claim("r1", "i0/../../x", run("i0"))).toBe(false);

    expect(fs.readdirSync(dir)).toEqual([]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("unsafe claim");
  });
});

describe("history", () => {
  it("skips a corrupt record without losing the rest (req 6)", () => {
    const host = store();
    host.claim("r1", "i0", run("i0", { startedAt: 1, outcome: "ran" }));
    host.claim("r1", "i1", run("i1", { startedAt: 2, outcome: "ran" }));
    fs.writeFileSync(path.join(dir, "r1", "i2.json"), "{ not json", "utf8");

    const listed = host.list("r1");
    expect(listed.map((r) => r.windowKey)).toEqual(["i1", "i0"]);
  });

  it("returns newest first and caps at 20 (req 7)", () => {
    const host = store();
    for (let i = 0; i < 30; i += 1) {
      host.claim("r1", `i${i}`, run(`i${i}`, { startedAt: i, outcome: "ran" }));
    }
    const listed = host.list("r1");
    expect(listed).toHaveLength(20);
    expect(listed[0].startedAt).toBe(29);
    expect(listed[19].startedAt).toBe(10);
  });

  it("prunes only beyond the cap, oldest first (req 8)", () => {
    const host = store();
    for (let i = 0; i < 25; i += 1) {
      host.claim("r1", `i${i}`, run(`i${i}`, { startedAt: i, outcome: "ran" }));
    }
    host.prune("r1");
    const left = fs.readdirSync(path.join(dir, "r1")).sort();
    expect(left).toHaveLength(20);
    expect(left).not.toContain("i0.json");
    expect(left).toContain("i24.json");
  });

  it("lets a pruned window be claimed again (req 9)", () => {
    const host = store();
    for (let i = 0; i < 25; i += 1) {
      host.claim("r1", `i${i}`, run(`i${i}`, { startedAt: i, outcome: "ran" }));
    }
    host.prune("r1");
    // i0 was pruned. If the in-memory memo outlived the file, this returns
    // false and that window could never be recorded again.
    expect(host.claim("r1", "i0", run("i0"))).toBe(true);
  });

  it("does not prune at exactly the cap", () => {
    const host = store();
    for (let i = 0; i < 20; i += 1) {
      host.claim("r1", `i${i}`, run(`i${i}`, { startedAt: i, outcome: "ran" }));
    }
    host.prune("r1");
    expect(fs.readdirSync(path.join(dir, "r1"))).toHaveLength(20);
  });

  it("is empty for a routine that never ran", () => {
    expect(store().list("nothing")).toEqual([]);
  });
});

describe("finishing and sweeping", () => {
  it("records the outcome over the claim", () => {
    const host = store();
    host.claim("r1", "i0", run("i0"));
    host.finish(run("i0", { outcome: "ran", endedAt: 2000, sessionId: "s-9" }));

    const [only] = host.list("r1");
    expect(only.outcome).toBe("ran");
    expect(only.sessionId).toBe("s-9");
    expect(only.endedAt).toBe(2000);
  });

  it("sweeps running to interrupted and keeps the window consumed (req 10)", () => {
    const host = store();
    host.claim("r1", "i0", run("i0", { outcome: "running" }));
    host.claim("r1", "i1", run("i1", { outcome: "ran", startedAt: 2000 }));

    store().sweepInterrupted("r1", 5000);

    const after = host.list("r1");
    expect(after.find((r) => r.windowKey === "i0")?.outcome).toBe("interrupted");
    expect(after.find((r) => r.windowKey === "i1")?.outcome).toBe("ran");
    // The claim file survives the sweep, so the dead window cannot re-fire.
    expect(store().claim("r1", "i0", run("i0"))).toBe(false);
  });

  it("forgets a removed routine entirely (req 11)", () => {
    const host = store();
    host.claim("r1", "i0", run("i0"));
    host.claim("r1", "i1", run("i1"));
    host.forget("r1");

    expect(host.list("r1")).toEqual([]);
    // And the id is reusable, memo included.
    expect(host.claim("r1", "i0", run("i0"))).toBe(true);
  });
});

describe("a disk that misbehaves", () => {
  const brokenFs = (over: Partial<RunStoreFs>): RunStoreFs => ({ ...realFs, ...over });

  it("reports a real claim failure but keeps running", () => {
    const lines: string[] = [];
    const host = new RoutineRunStore({
      dir: dir.replace(/\\/g, "/"),
      log: (l) => lines.push(l),
      fs: brokenFs({
        writeFileSync: () => {
          const e = new Error("disk full") as NodeJS.ErrnoException;
          e.code = "ENOSPC";
          throw e;
        },
      }),
    });

    expect(host.claim("r1", "i0", run("i0"))).toBe(false);
    expect(lines.join(" ")).toContain("claim failed");
  });

  it("survives an unreadable directory", () => {
    const host = new RoutineRunStore({
      dir: dir.replace(/\\/g, "/"),
      fs: brokenFs({
        readdirSync: () => {
          throw new Error("EPERM");
        },
      }),
    });
    fs.mkdirSync(path.join(dir, "r1"));
    expect(host.list("r1")).toEqual([]);
    expect(() => host.prune("r1")).not.toThrow();
  });
});
