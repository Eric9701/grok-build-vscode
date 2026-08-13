/**
 * Phase clock for opening a conversation. One in-memory summary line per open
 * on the Grok output channel — no store, no telemetry.
 *
 * The five costs, in order: previous process exit, `grok --version`, ACP
 * spawn+initialize, CLI `session/load`, host replay posts. Replay is labelled
 * `replay(post)` because there is no webview-complete signal; the clock stops
 * at the last replayed event posted. `now` is injectable so tests never sleep.
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
 * Fixed five-phase line so a paste always has the same names to grep.
 * Zero-cost phases stay on the line (a missing name is not a 0ms name).
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
  return `session open: ${parts.join(" · ")} · total ${formatMs(opts.totalMs)} (events: ${opts.events})`;
}

export class OpenClock {
  private readonly phases: OpenPhase[] = [];
  private readonly startedAt: number;

  constructor(private readonly nowFn: () => number = () => Date.now()) {
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

  totalMs(): number {
    return this.nowFn() - this.startedAt;
  }

  summary(events: number): string {
    return formatOpenTimings({ totalMs: this.totalMs(), phases: this.phases, events });
  }
}
