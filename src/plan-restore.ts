// Pure helpers for the plan-mode persist + restore state machine. Split from
// sidebar.ts so the verdict log and the on-resume decision can be unit-tested
// without mocking vscode, the ACP client, or the filesystem.
//
// Background:
//  - Native `exit_plan_mode` outcomes drive the live CLI. The extension still
//    persists each resolved plan locally so cards and client-side gate state can
//    be reconstructed on resume (including sessions created by older versions).
//  - Plan content + verdict + the lexicographic replay coordinate
//    (`afterUserMessage`, `afterInterjection`) are appended via `appendPlanEntry`.
//  - On resume, `decideRestoreState` returns the plan-gate + CLI-mode the host
//    should restore to, based on the *last* verdict. "rejected" means the user
//    was still planning, so the gate goes back up. Everything else (including
//    no saved plans) leaves the gate down — safer than wrongly restoring plan
//    mode on a session the user already cancelled or approved.

export type PlanVerdict = "approved" | "rejected" | "abandoned";

// Keep behaviorally synchronized with media/webview-helpers.js's
// isInterjectionText. test/plan-restore.test.ts runs the same replay-envelope
// corpus through both implementations because the webview cannot import TS.
const INTERJECTION_RE = /^\s*The user sent a message while you were working:\s*\r?\n/;

/** True for the CLI envelope used to persist and replay a mid-turn interjection. */
export function isInterjectionText(text: string): boolean {
  return INTERJECTION_RE.test(String(text || ""));
}

/**
 * True when a REPLAYED user turn renders a user bubble in the webview. The
 * host's replay counter (`session.userMessageCount`, sidebar.ts's
 * userMessageChunk handler) must count exactly what the webview's
 * appendUserChunk bubbles — persisted plan/permission `afterUserMessage`
 * positions are drained against the webview's own count on the NEXT replay.
 * Any asymmetry inflates the host count, and every verdict persisted after a
 * restore then carries an unreachable position — its card permanently lands
 * at the END of the conversation on later restores.
 *
 * Mirrors chat.js exactly. Legacy `<system-reminder>` and marker-only verdict
 * turns render no bubble; a legacy marker WITH a comment renders that comment.
 * Legacy primer turns are handled separately by isPrimerText on both sides.
 */
export function countsAsUserBubble(text: string): boolean {
  const t = text ?? "";
  if (/^\s*<system-reminder>/.test(t)) return false;
  if (isInterjectionText(t)) return false;
  const m = /^\s*\[Plan (approved|rejected|cancelled)\]\s*/i.exec(t);
  if (m && !t.slice(m[0].length).trim()) return false;
  return true;
}

export interface PlanEntry {
  text: string;
  verdict: PlanVerdict;
  /** Number of user messages sent before this plan was resolved. The resume
   *  view uses this to render the plan card inline with the conversation
   *  rather than at the bottom. Older saved entries may not have it. */
  afterUserMessage?: number;
  /** Number of accepted interjections before this plan was resolved. Together
   *  with `afterUserMessage`, this orders repeated reject/revise cycles that
   *  all happen inside one native prompt. */
  afterInterjection?: number;
  /** Assistant-update boundary at which the card was resolved. */
  afterHistoryEvent?: number;
}

export interface RestoreDecision {
  /** Should the client-side plan gate be raised on restore? */
  planActive: boolean;
  /** Mode to set on the CLI so its view of "am I planning?" matches the gate.
   *  "default" is grok's wire name for act mode (NOT "agent"). */
  cliMode: "plan" | "default";
}

/**
 * Where a restored session's plan cards should come from.
 *
 * - `"saved"` — we have per-plan records; render those.
 * - `"disk"`  — we have NO record at all (a session from before per-plan
 *               persistence): fall back to grok's own `plan.md`.
 * - `"none"`  — we have a record and it says there are no plans.
 *
 * The `[]` vs `undefined` distinction is the whole point. A rewind that removes
 * every plan leaves an EMPTY array, and treating that as "legacy" re-read
 * grok's `plan.md` — which a rewind does not truncate — and resurrected the
 * exact plan the user had just deleted, labelled "Restored from the previous
 * session". Empty means empty; only absent means unknown.
 */
export function planRestoreSource(saved: PlanEntry[] | undefined): "saved" | "disk" | "none" {
  if (saved === undefined) return "disk";
  return saved.length > 0 ? "saved" : "none";
}

/**
 * Drop persisted cards whose turn no longer exists after a rewind.
 *
 * Plan and permission cards are the EXTENSION's own record — grok doesn't
 * replay either on `session/load`, so rewinding the conversation leaves them
 * behind. Their saved `afterUserMessage` then exceeds the (now shorter)
 * conversation, so the replay can't place them inline and dumps them at the
 * bottom: cards for turns the user just deleted, reappearing under the ones
 * that survived.
 *
 * `surviving` is the number of user messages left after the rewind. An entry
 * resolved during the Nth turn carries `afterUserMessage === N`, so entries
 * with a position ABOVE `surviving` belong to discarded turns.
 *
 * Entries with no position (legacy, pre-`afterUserMessage`) are KEPT: we can't
 * tell which turn they belong to, and silently deleting a user's plan record on
 * a guess is worse than leaving one card at the bottom.
 */
export function truncateResolvedAfter<T extends { afterUserMessage?: number; afterHistoryEvent?: number }>(
  entries: T[] | undefined,
  surviving: number,
  survivingHistoryEvents?: number,
): T[] {
  return (entries ?? []).filter(
    (e) => (
      survivingHistoryEvents !== undefined && e.afterHistoryEvent !== undefined
        ? e.afterHistoryEvent <= survivingHistoryEvents
        : e.afterUserMessage === undefined || e.afterUserMessage <= surviving
    ),
  );
}

/** Append a resolved plan to the per-session log. `current` may be undefined
 *  for sessions that haven't persisted any plans yet. */
export function appendPlanEntry(current: PlanEntry[] | undefined, entry: PlanEntry): PlanEntry[] {
  return [...(current ?? []), entry];
}

/** Decide what plan-mode state the host should restore to, given the saved log.
 *  Pure: no I/O, no globals. */
export function decideRestoreState(saved: PlanEntry[] | undefined): RestoreDecision {
  if (!saved || saved.length === 0) return { planActive: false, cliMode: "default" };
  const lastVerdict = saved[saved.length - 1].verdict;
  if (lastVerdict === "rejected") return { planActive: true, cliMode: "plan" };
  return { planActive: false, cliMode: "default" };
}
