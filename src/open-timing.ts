/**
 * Phase clock for opening a conversation.
 *
 * Exists because "sometimes it takes ages" is not something you can fix. Five
 * things happen when a conversation opens, they have very different costs, and
 * four of them are invisible from outside:
 *
 *   1. the previous `grok` process has to exit;
 *   2. the CLI version is probed (`grok --version`);
 *   3. a new process spawns and completes the ACP handshake;
 *   4. the CLI loads the session — rereading the transcript and rebuilding its
 *      prompt context, which indexes the repository;
 *   5. the transcript replays into the webview.
 *
 * Measured on a real 1786-session store, our own file work is not the slow
 * part: ordering the whole history is ~190ms and a project's index pass is
 * ~10–30ms. So the seconds live in 4 and 5, and this says which — per open,
 * in one line the owner can paste back.
 *
 * Pure and injectable: `now` is a parameter so tests never sleep.
 */

export interface OpenPhase {
  name: string;
  ms: number;
}

/** Render a duration the way a person reads one: ms below a second, else seconds. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One line per open: what it did, how long in total, and where the time went.
 *
 * Phases that cost nothing are dropped rather than printed as `0ms` — on a warm
 * open most of them are zero, and a line of zeroes hides the one number that
 * matters. `rest` is whatever the named phases did not account for; it is
 * printed only when it is worth explaining.
 */
export function formatOpenTimings(opts: {
  kind: "resume" | "new";
  totalMs: number;
  phases: readonly OpenPhase[];
  cwd?: string;
}): string {
  const named = opts.phases.filter((p) => Math.round(p.ms) > 0);
  const accounted = opts.phases.reduce((sum, p) => sum + p.ms, 0);
  const rest = opts.totalMs - accounted;
  const parts = named.map((p) => `${p.name} ${formatMs(p.ms)}`);
  // With no phases at all there is nothing for `rest` to be the remainder OF —
  // it would just restate the total in smaller print.
  if (opts.phases.length && Math.round(rest) > 0) parts.push(`rest ${formatMs(rest)}`);
  const breakdown = parts.length ? ` — ${parts.join(", ")}` : "";
  const where = opts.cwd ? ` · ${opts.cwd}` : "";
  return `[open] ${opts.kind} took ${formatMs(opts.totalMs)}${breakdown}${where}`;
}

/**
 * Accumulates phases as an open proceeds. `mark` closes the phase that ended
 * at the call, so the call sites read as a timeline rather than as pairs of
 * start/stop bookkeeping that can be got out of step.
 */
export class OpenClock {
  private readonly phases: OpenPhase[] = [];
  private readonly startedAt: number;
  private last: number;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.startedAt = this.now();
    this.last = this.startedAt;
  }

  /** Close the phase ending here and name it. */
  mark(name: string): void {
    const at = this.now();
    this.phases.push({ name, ms: at - this.last });
    this.last = at;
  }

  totalMs(): number {
    return this.now() - this.startedAt;
  }

  summary(kind: "resume" | "new", cwd?: string): string {
    return formatOpenTimings({ kind, totalMs: this.totalMs(), phases: this.phases, cwd });
  }
}
