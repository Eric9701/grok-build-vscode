/**
 * Routine runs on disk — and the claim that makes a run happen exactly once.
 *
 * Every host on this machine (VS Code, Cursor, the desktop app) reads the same
 * `~/.grok/client-state/`, ticks its own timer, and would fire every routine.
 * There is no leader here to prevent that. Instead the run record IS the claim:
 *
 *     routine-runs/<routineId>/<windowKey>.json
 *
 * created with the exclusive-create flag (`wx`). The OS guarantees exactly one
 * creator; every other host gets `EEXIST` and stands down. That is the whole
 * mutual-exclusion story — no lease, no TTL, no renewal loop, and no window
 * where a crashed holder blocks everyone else.
 *
 * One file per run rather than one array in one file, for the same reason: two
 * hosts appending to a shared JSON array race, whereas a host only ever writes
 * the file it exclusively created.
 *
 * **This layer is deliberately not `PersistedState`.** That class caches, keeps
 * a `globalState` shadow, and rebases writes on the current snapshot — all
 * correct for user-edited settings, all wrong for a claim, whose entire value
 * is that it is a single uncached atomic create. Routine *definitions* do live
 * in `PersistedState`; their runs live here.
 */

import {
  ROUTINE_RUN_HISTORY_LIMIT,
  capRoutineRuns,
  interruptStaleRuns,
  type RoutineRun,
} from "./routines";

/** The `fs` surface this needs, injected so tests never touch a real disk. */
export interface RunStoreFs {
  mkdirSync(p: string, opts: { recursive: true }): void;
  /** MUST use the exclusive-create flag and MUST throw when the path exists —
   *  this is the mutual exclusion, not a convenience. */
  writeFileSync(p: string, data: string, opts: { encoding: "utf8"; flag?: string }): void;
  readFileSync(p: string, encoding: "utf8"): string;
  readdirSync(p: string): string[];
  existsSync(p: string): boolean;
  unlinkSync(p: string): void;
}

export interface RunStoreOpts {
  /** `<grokHome>/client-state/routine-runs` — built by the caller. */
  dir: string;
  fs: RunStoreFs;
  log?: (line: string) => void;
}

/** Window keys reach the filesystem, so they are checked rather than trusted:
 *  a key is claimed as a FILE NAME, and `../` in one would escape the store. */
const SAFE_KEY = /^[A-Za-z0-9._-]{1,64}$/;

/** Routine ids are ours (uuid-shaped), but they name a directory, so they get
 *  the same treatment. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export class RoutineRunStore {
  private readonly dir: string;
  private readonly fs: RunStoreFs;
  private readonly log: (line: string) => void;
  /** Keys this host has already claimed, so a tick inside an unchanged window
   *  costs nothing. Never authoritative — the filesystem is. */
  private readonly claimed = new Set<string>();

  constructor(opts: RunStoreOpts) {
    this.dir = opts.dir;
    this.fs = opts.fs;
    this.log = opts.log ?? (() => {});
  }

  private routineDir(routineId: string): string {
    return `${this.dir}/${routineId}`;
  }

  private runPath(routineId: string, windowKey: string): string {
    return `${this.routineDir(routineId)}/${windowKey}.json`;
  }

  /**
   * Try to claim `windowKey` for `routineId`.
   *
   * Returns true only for the host that created the file. Every other caller —
   * this host on a later tick, or another host racing at the same instant —
   * gets false and must do nothing.
   */
  claim(routineId: string, windowKey: string, run: RoutineRun): boolean {
    if (!SAFE_ID.test(routineId) || !SAFE_KEY.test(windowKey)) {
      this.log(`[routines] refusing unsafe claim ${routineId}/${windowKey}`);
      return false;
    }
    const memo = `${routineId}/${windowKey}`;
    if (this.claimed.has(memo)) return false;

    try {
      this.fs.mkdirSync(this.routineDir(routineId), { recursive: true });
    } catch (e) {
      this.log(`[routines] cannot create run dir: ${(e as Error).message}`);
      return false;
    }

    try {
      // `wx` is the entire mutual exclusion. Never relax this to `w`.
      this.fs.writeFileSync(this.runPath(routineId, windowKey), JSON.stringify(run, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EEXIST is the normal outcome for everyone who did not win. It is not an
      // error and must never be logged as one, or a quiet machine writes a line
      // per routine per tick, forever.
      if (code !== "EEXIST") {
        this.log(`[routines] claim failed for ${memo}: ${(e as Error).message}`);
      }
      this.claimed.add(memo);
      return false;
    }

    this.claimed.add(memo);
    return true;
  }

  /** Overwrite a run this host claimed — the outcome, the session id, the
   *  reason. Plain `w`: by now we own the file. */
  finish(run: RoutineRun): void {
    if (!SAFE_ID.test(run.routineId) || !SAFE_KEY.test(run.windowKey)) return;
    try {
      this.fs.writeFileSync(this.runPath(run.routineId, run.windowKey), JSON.stringify(run, null, 2), {
        encoding: "utf8",
      });
    } catch (e) {
      this.log(`[routines] cannot record run ${run.routineId}/${run.windowKey}: ${(e as Error).message}`);
    }
  }

  /**
   * Newest-first runs for one routine, capped. Unreadable or malformed files
   * are skipped rather than thrown: one corrupt record must not blank a
   * routine's whole history, and it must never take the tick down.
   */
  list(routineId: string): RoutineRun[] {
    if (!SAFE_ID.test(routineId)) return [];
    const dir = this.routineDir(routineId);
    let names: string[];
    try {
      if (!this.fs.existsSync(dir)) return [];
      names = this.fs.readdirSync(dir);
    } catch {
      return [];
    }

    const runs: RoutineRun[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(this.fs.readFileSync(`${dir}/${name}`, "utf8")) as RoutineRun;
        if (parsed && typeof parsed.startedAt === "number" && typeof parsed.windowKey === "string") {
          runs.push(parsed);
        }
      } catch {
        /* one bad file, not a bad history */
      }
    }
    return capRoutineRuns(runs);
  }

  /**
   * Delete every record beyond the newest {@link ROUTINE_RUN_HISTORY_LIMIT}.
   *
   * Called after a run finishes rather than on a schedule, so a routine that
   * stops firing keeps its last twenty indefinitely — which is what the user
   * needs when they come back to ask why it stopped.
   */
  prune(routineId: string): void {
    if (!SAFE_ID.test(routineId)) return;
    const dir = this.routineDir(routineId);
    let names: string[];
    try {
      if (!this.fs.existsSync(dir)) return;
      names = this.fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    if (names.length <= ROUTINE_RUN_HISTORY_LIMIT) return;

    const dated = names
      .map((name) => {
        try {
          const parsed = JSON.parse(this.fs.readFileSync(`${dir}/${name}`, "utf8")) as RoutineRun;
          return { name, startedAt: typeof parsed?.startedAt === "number" ? parsed.startedAt : 0 };
        } catch {
          // Unparseable records sort oldest, so they are the first to go.
          return { name, startedAt: 0 };
        }
      })
      .sort((a, b) => b.startedAt - a.startedAt);

    for (const stale of dated.slice(ROUTINE_RUN_HISTORY_LIMIT)) {
      try {
        this.fs.unlinkSync(`${dir}/${stale.name}`);
        this.claimed.delete(`${routineId}/${stale.name.replace(/\.json$/, "")}`);
      } catch {
        /* best effort */
      }
    }
  }

  /** Drop a removed routine's whole history. */
  forget(routineId: string): void {
    if (!SAFE_ID.test(routineId)) return;
    const dir = this.routineDir(routineId);
    try {
      if (!this.fs.existsSync(dir)) return;
      for (const name of this.fs.readdirSync(dir)) {
        try {
          this.fs.unlinkSync(`${dir}/${name}`);
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* best effort */
    }
    for (const memo of [...this.claimed]) {
      if (memo.startsWith(`${routineId}/`)) this.claimed.delete(memo);
    }
  }

  /**
   * Mark this routine's `running` records as interrupted.
   *
   * Runs once at start. A record left `running` belonged to a host that died
   * mid-run — the strip must not show it as live forever, and the window must
   * not look available again (the claim file stays, so it is still consumed).
   */
  sweepInterrupted(routineId: string, now: number): void {
    for (const run of this.list(routineId)) {
      if (run.outcome !== "running") continue;
      const [swept] = interruptStaleRuns([run], now);
      this.finish(swept);
    }
  }
}
