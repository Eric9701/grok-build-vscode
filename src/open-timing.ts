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
  // Rounded ALONG THE TIMELINE, not one phase at a time. `performance.now()` is
  // fractional, and rounding each phase independently does not preserve the
  // sum: ten phases of 0.51ms print as ten `1ms` against a `5ms` total, and
  // nine of 0.49ms print as nine `0ms` against `4ms`. Either way the line stops
  // adding up, which is the one guarantee it makes. Rounding the running total
  // and taking differences makes the printed phases sum to the printed elapsed
  // time exactly, whatever the fractions.
  let cumulative = 0;
  let shown = 0;
  const parts = opts.phases.map((p) => {
    const note = p.note ? ` (${p.note})` : "";
    if (!Number.isFinite(p.ms) || p.ms < 0) return `${p.name} ${formatMs(p.ms)}${note}`;
    cumulative += p.ms;
    const display = Math.round(cumulative) - shown;
    shown += display;
    return `${p.name} ${formatMs(display)}${note}`;
  });
  const total = Math.round(opts.totalMs);
  const other = total - shown;
  // Sub-millisecond slack is rounding, not a phase worth naming.
  if (other >= 1) parts.push(`other ${formatMs(other)}`);
  return `session open: ${parts.join(" · ")} · total ${formatMs(total)} (events: ${opts.events})`;
}

/** Wall time the named phases do not account for, in the same whole
 *  milliseconds the line prints. 0 when they tile the total. */
export function unclaimedMs(totalMs: number, phases: readonly OpenPhase[]): number {
  if (!Number.isFinite(totalMs)) return 0;
  const claimed = phases.reduce((sum, p) => sum + (Number.isFinite(p.ms) && p.ms > 0 ? p.ms : 0), 0);
  return Math.round(totalMs) - Math.round(claimed);
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

  record(name: string, ms: number, note?: string): void {
    this.phases.push(note ? { name, ms, note } : { name, ms });
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

  /** RAW. The formatter is the only place that rounds — rounding here too made
   *  `collapse()` store a pre-rounded phase that the timeline then rounded a
   *  second time, and two roundings do not compose into an accurate one. */
  totalMs(): number {
    return this.nowFn() - this.startedAt;
  }

  summary(events: number): string {
    return formatOpenTimings({ totalMs: this.totalMs(), phases: this.phases, events });
  }
}
