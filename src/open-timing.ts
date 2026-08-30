/**
 * Phase clock for opening a conversation. One in-memory summary line per open
 * on the Grok output channel — no store, no telemetry.
 *
 * The costs, in order: `resolve` (everything the CALLER spent before
 * `startSession` — reservation, workspace queue, cwd resolution, the
 * `session-meta.json` read), `approve-gate` (deciding whether a
 * repo's forced auto-approve needs consent, including the config reads that
 * decide it and any modal that results), previous process exit, `prep`, `grok --version`,
 * building the ACP client, spawn+initialize, `session/new` on a create, CLI
 * `session/load` on a resume, host replay posts. Whichever of `new`/`load` did
 * not apply prints 0ms rather than vanishing — a missing name is not a 0ms name. Replay is labelled `replay(post)` because there is no
 * webview-complete signal; the clock stops at the last replayed event posted.
 * `now` is injectable so tests never sleep.
 */

export interface OpenPhase {
  name: string;
  ms: number;
  note?: string;
}

/** Whole milliseconds. Invalid inputs stay unprintable rather than look like 0. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  return `${Math.round(ms)}ms`;
}

/**
 * Fixed-shape line so a paste always has the same names to grep.
 * Zero-cost phases stay on the line (a missing name is not a 0ms name).
 *
 * The line ALWAYS ACCOUNTS FOR ITS OWN TOTAL: whatever the named phases do not
 * claim is printed as `other`. Without it a slow open hides in plain sight —
 * every named phase reads as fast while the total does not, and a reader
 * naturally trusts the names. In one user's log (#133) opens took 2.6-21s with
 * 82-93% of the time in no phase at all, e.g. `total 5201ms` against 379ms of
 * named work, and nothing on the line said so.
 */
export function formatOpenTimings(opts: {
  totalMs: number;
  phases: readonly OpenPhase[];
  events: number;
}): string {
  const parts = opts.phases.map((p) => {
    const note = p.note ? ` (${p.note})` : "";
    return `${p.name} ${formatMs(p.ms)}${note}`;
  });
  const other = unclaimedMs(opts.totalMs, opts.phases);
  // Sub-millisecond slack is rounding, not a phase worth naming.
  if (other >= 1) parts.push(`other ${formatMs(other)}`);
  return `session open: ${parts.join(" · ")} · total ${formatMs(opts.totalMs)} (events: ${opts.events})`;
}

/** Wall time the named phases do not account for. 0 when they tile the total. */
export function unclaimedMs(totalMs: number, phases: readonly OpenPhase[]): number {
  if (!Number.isFinite(totalMs)) return 0;
  const claimed = phases.reduce((sum, p) => sum + (Number.isFinite(p.ms) ? p.ms : 0), 0);
  return totalMs - claimed;
}

export class OpenClock {
  private readonly phases: OpenPhase[] = [];
  private readonly startedAt: number;

  // MONOTONIC by default. `Date.now()` steps when NTP or a person corrects the
  // clock, and a step during an open prints negative phases (`?`) or an
  // invented delay — defeating the diagnostic on exactly the run that had one.
  constructor(private readonly nowFn: () => number = () => performance.now()) {
    this.startedAt = this.nowFn();
  }

  now(): number {
    return this.nowFn();
  }

  elapsed(started: number): number {
    return this.nowFn() - started;
  }

  /**
   * Rounded ON THE WAY IN, and `totalMs` rounds too, so every number the line
   * prints is the number the arithmetic used.
   *
   * `performance.now()` is fractional. Rounding each phase and the total
   * independently at print time means nine phases of 0.49ms print as nine
   * `0ms` while their 4.41ms total prints as `4ms` — the line stops adding up,
   * which is the one guarantee it exists to make. Rounding here instead lets
   * that sub-millisecond dust land in `other`, where unclaimed time belongs.
   */
  record(name: string, ms: number, note?: string): void {
    const whole = Number.isFinite(ms) ? Math.round(ms) : ms;
    this.phases.push(note ? { name, ms: whole, note } : { name, ms: whole });
  }

  /**
   * Replace everything recorded so far with ONE phase of that name, and return
   * how long it covers. A no-op (returning 0) on a clock with no phases yet.
   *
   * For the one caller that RE-ENTERS `startSessionBody` on the same clock (the
   * Windows reactive downgrade). Without it the second pass appends its own
   * `resolve`, `approve-gate`, `dispose`… beside the first pass's, and the
   * fixed-shape line comes out with every name twice and phases that overlap.
   *
   * Naming it rather than dropping it is the point: simply forgetting the
   * phases left the next `resolve` — measured from the clock's start —
   * swallowing a 120s initialize timeout and reporting it as session
   * resolution, which points a reader at the wrong subsystem entirely.
   */
  collapse(name: string): number {
    if (this.phases.length === 0) return 0;
    const ms = this.totalMs();
    this.phases.length = 0;
    this.phases.push({ name, ms });
    return ms;
  }

  totalMs(): number {
    return Math.round(this.nowFn() - this.startedAt);
  }

  summary(events: number): string {
    return formatOpenTimings({ totalMs: this.totalMs(), phases: this.phases, events });
  }
}
