/**
 * Pure helpers for Grok's rewind surface (`_x.ai/rewind/*`).
 *
 * Wire format (probe-confirmed on CLI 0.2.111 — see research/rewind.md):
 *   points  { sessionId } → { rewind_points: RewindPoint[] }  (snake_case fields)
 *   execute { sessionId, targetPromptIndex, mode?, force? }
 *           → { success, target_prompt_index, mode, reverted_files, clean_files,
 *               conflicts, prompt_text, error }
 *
 * Methods are `_`-prefixed on the wire; bare `x.ai/...` is -32601.
 * `force: true` is required for the execute to actually truncate (without it
 * the CLI returns success:false with empty arrays — the TUI confirmation gate).
 *
 * User-bubble mapping: the extension's hidden primer (and other non-bubbled
 * turns) still create rewind points. `userFacingRewindPoints` strips those so
 * the Nth visible user bubble aligns with the Nth user-facing point.
 */

import { isPrimerText } from "./grok-primer";
import { unwrapExtResult } from "./worktree";

/** Modes the execute RPC accepts (serde enum on the wire). */
export type RewindMode = "all" | "conversation_only" | "code_only" | "files_only";

export const REWIND_MODES: readonly RewindMode[] = [
  "all",
  "conversation_only",
  "code_only",
  "files_only",
];

export interface RewindPoint {
  promptIndex: number;
  createdAt: string;
  numFileSnapshots: number;
  hasFileChanges: boolean;
  promptPreview: string;
}

export interface RewindExecuteResult {
  success: boolean;
  targetPromptIndex: number;
  mode: RewindMode | string;
  revertedFiles: string[];
  cleanFiles: string[];
  conflicts: unknown[];
  promptText: string | null;
  error: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Parse one rewind point row (snake_case wire → camelCase). */
export function parseRewindPoint(raw: unknown): RewindPoint | null {
  const r = asRecord(raw);
  if (!r) return null;
  const promptIndex =
    typeof r.prompt_index === "number"
      ? r.prompt_index
      : typeof r.promptIndex === "number"
        ? r.promptIndex
        : null;
  if (promptIndex == null || !Number.isFinite(promptIndex) || promptIndex < 0) return null;
  return {
    promptIndex,
    createdAt: str(r.created_at || r.createdAt),
    numFileSnapshots: num(r.num_file_snapshots ?? r.numFileSnapshots, 0),
    hasFileChanges: r.has_file_changes === true || r.hasFileChanges === true,
    promptPreview: str(r.prompt_preview || r.promptPreview),
  };
}

/**
 * Parse `_x.ai/rewind/points` result. Accepts bare `{rewind_points:[…]}`, a
 * double-wrapped `{result:{…}}`, or a bare array of points.
 */
export function parseRewindPoints(payload: unknown): RewindPoint[] {
  const unwrapped = unwrapExtResult(payload);
  if (Array.isArray(unwrapped)) {
    return unwrapped.map(parseRewindPoint).filter((p): p is RewindPoint => !!p);
  }
  const r = asRecord(unwrapped);
  if (!r) return [];
  const list = r.rewind_points ?? r.rewindPoints ?? r.points;
  if (!Array.isArray(list)) return [];
  return list.map(parseRewindPoint).filter((p): p is RewindPoint => !!p);
}

/** Parse `_x.ai/rewind/execute` result. */
export function parseRewindExecute(payload: unknown): RewindExecuteResult | null {
  const r = asRecord(unwrapExtResult(payload));
  if (!r) return null;
  // success is required for a real execute response; if absent, treat as unparseable.
  if (typeof r.success !== "boolean") return null;
  const modeRaw = str(r.mode, "all");
  return {
    success: r.success,
    targetPromptIndex: num(r.target_prompt_index ?? r.targetPromptIndex, 0),
    mode: modeRaw,
    revertedFiles: strArr(r.reverted_files ?? r.revertedFiles),
    cleanFiles: strArr(r.clean_files ?? r.cleanFiles),
    conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
    promptText:
      typeof r.prompt_text === "string"
        ? r.prompt_text
        : typeof r.promptText === "string"
          ? r.promptText
          : null,
    error:
      typeof r.error === "string"
        ? r.error
        : r.error == null
          ? null
          : String(r.error),
  };
}

/**
 * Format a rewind point for a QuickPick label.
 * Newest-first callers reverse the list themselves; this only formats one row.
 */
export function formatRewindPointLabel(p: RewindPoint): string {
  const preview = (p.promptPreview || "(empty prompt)").replace(/\s+/g, " ").trim();
  const clipped = preview.length > 72 ? preview.slice(0, 69) + "…" : preview;
  const files = p.hasFileChanges
    ? ` · ${p.numFileSnapshots || "?"} file${p.numFileSnapshots === 1 ? "" : "s"}`
    : "";
  return `#${p.promptIndex}  ${clipped}${files}`;
}

/** QuickPick detail line (timestamp). */
export function formatRewindPointDetail(p: RewindPoint): string | undefined {
  if (!p.createdAt) return undefined;
  try {
    const d = new Date(p.createdAt);
    if (Number.isNaN(d.getTime())) return p.createdAt;
    return d.toLocaleString();
  } catch {
    return p.createdAt;
  }
}

/**
 * Points that are valid rewind *targets* — every point except the latest one
 * (rewinding to the current tip is a no-op / errors "current prompt index is N").
 * When only one point exists, returns [] (nothing to rewind to).
 *
 * Pass *all* points (including primer) so the tip is the true conversation tip;
 * filter with `userFacingRewindPoints` first when picking among user bubbles.
 */
export function selectableRewindPoints(points: RewindPoint[]): RewindPoint[] {
  if (points.length <= 1) return [];
  // Keep chronological order; UI may reverse for newest-first display.
  const maxIdx = Math.max(...points.map((p) => p.promptIndex));
  return points.filter((p) => p.promptIndex < maxIdx);
}

/**
 * True when a rewind point is extension/CLI plumbing that never renders a
 * user bubble — so it must not occupy a slot in the bubble→point map.
 * Mirrors chat.js / `countsAsUserBubble` for previews (truncated OK for primer).
 */
export function isHiddenRewindPoint(p: RewindPoint): boolean {
  const t = p.promptPreview ?? "";
  if (isPrimerText(t)) return true;
  if (/^\s*<system-reminder>/.test(t)) return true;
  // Marker-only plan verdict (no user comment) — no bubble.
  if (/^\s*\[Plan (approved|rejected|cancelled)\]\s*$/i.test(t.trim())) return true;
  return false;
}

/**
 * Rewind points that correspond 1:1 with visible user bubbles (order preserved).
 * The Nth user bubble → `userFacingRewindPoints(all)[N]`.
 */
export function userFacingRewindPoints(points: RewindPoint[]): RewindPoint[] {
  return points.filter((p) => !isHiddenRewindPoint(p));
}

/**
 * Map a 0-based visible user-bubble index to a rewind target.
 * Returns null when the index is out of range or the point is the conversation
 * tip (nothing after it to discard).
 *
 * `allPoints` is the full list from `/points` (primer included) so tip detection
 * uses the real max `prompt_index`.
 */
export function resolveUserBubbleRewind(
  allPoints: RewindPoint[],
  userBubbleIndex: number,
): RewindPoint | null {
  if (!Number.isInteger(userBubbleIndex) || userBubbleIndex < 0) return null;
  const facing = userFacingRewindPoints(allPoints);
  const point = facing[userBubbleIndex];
  if (!point) return null;
  if (allPoints.length === 0) return null;
  const maxIdx = Math.max(...allPoints.map((p) => p.promptIndex));
  // Tip of the whole conversation — execute would fail with "current is N".
  if (point.promptIndex >= maxIdx) return null;
  return point;
}

/** Confirm dialog body for a chosen target. */
export function rewindConfirmMessage(p: RewindPoint, mode: RewindMode = "all"): string {
  const preview = (p.promptPreview || "(empty)").replace(/\s+/g, " ").trim();
  const clipped = preview.length > 120 ? preview.slice(0, 117) + "…" : preview;
  const scope =
    mode === "conversation_only"
      ? "Conversation history after this turn will be discarded."
      : mode === "files_only" || mode === "code_only"
        ? "Files will be restored to their snapshot at this turn; conversation stays."
        : "Conversation after this turn will be discarded, and files restored to their snapshot then.";
  return (
    `Rewind to this message?\n\n` +
    `"${clipped}"\n\n` +
    `${scope}\n` +
    `This cannot be undone (unless you have the changes in git).`
  );
}
