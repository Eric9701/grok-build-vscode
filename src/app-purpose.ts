/**
 * Global "Use this app for" preference — progressive disclosure.
 *
 * Stored in ~/.grok/client-state/ via PersistedState (same home as pins /
 * archives). Absent or unrecognised values mean Knowledge work: the smaller
 * surface, matching the codebase's capability-detection default.
 *
 * Pure helpers only — no host I/O.
 */

export const APP_PURPOSE_KEY = "grok.appPurpose";

/** Values written to disk / wire. */
export type AppPurpose = "knowledge" | "coding";

/** Safe default when the preference is missing (older hosts, corrupt disk). */
export const DEFAULT_APP_PURPOSE: AppPurpose = "knowledge";

export function parseAppPurpose(value: unknown): AppPurpose {
  return value === "coding" ? "coding" : DEFAULT_APP_PURPOSE;
}

export function isCodingPurpose(purpose: AppPurpose): boolean {
  return purpose === "coding";
}

/** Worktree destinations only surface in Coding. */
export function shouldOfferWorktrees(purpose: AppPurpose): boolean {
  return isCodingPurpose(purpose);
}

/** Thinking-trace switch + live traces only surface in Coding (still default off). */
export function shouldOfferThinkingControls(purpose: AppPurpose): boolean {
  return isCodingPurpose(purpose);
}

/** Expand-tool-details switch only surfaces in Coding (still default off). */
export function shouldOfferToolDetailControls(purpose: AppPurpose): boolean {
  return isCodingPurpose(purpose);
}

/**
 * Effective showThinking for the webview: Coding may honour the user toggle;
 * Knowledge work always hides traces (disclosure system, not a sticky off).
 */
export function effectiveShowThinking(
  purpose: AppPurpose,
  userShowThinking: boolean,
): boolean {
  return isCodingPurpose(purpose) && userShowThinking;
}

/**
 * Effective expandCommandOutputs: same rule as thinking.
 */
export function effectiveExpandCommandOutputs(
  purpose: AppPurpose,
  userExpand: boolean,
): boolean {
  return isCodingPurpose(purpose) && userExpand;
}

export type ContinueChatDestinationId = "workspace" | "worktree";

export interface ContinueChatDestination {
  id: ContinueChatDestinationId;
  /** Primary label shown in the destination picker. */
  label: string;
  /** Short description under the label. */
  description: string;
}

export interface ContinueChatOptions {
  purpose: AppPurpose;
  /** Already inside a worktree — no worktree-from-worktree. */
  isWorktree: boolean;
  /**
   * CLI advertised worktree RPCs. When false the worktree destination is
   * dropped (same collapse as Knowledge work — single destination, no popup).
   */
  worktreeSupported: boolean;
}

/**
 * Destinations under "Continue in a new chat".
 * Knowledge work / unsupported worktrees → workspace only (no popup).
 * Coding + supported + not already in a worktree → workspace + worktree.
 */
export function continueChatDestinations(
  opts: ContinueChatOptions,
): ContinueChatDestination[] {
  const dests: ContinueChatDestination[] = [
    {
      id: "workspace",
      label: "Use this workspace",
      description: "Continue from here in the current checkout",
    },
  ];
  if (
    shouldOfferWorktrees(opts.purpose) &&
    opts.worktreeSupported &&
    !opts.isWorktree
  ) {
    dests.push({
      id: "worktree",
      label: "Use a new worktree",
      description: "Continue from here in an isolated checkout",
    });
  }
  return dests;
}

/** True when the Session entry needs a destination popup (more than one choice). */
export function continueChatNeedsPopup(
  dests: readonly ContinueChatDestination[],
): boolean {
  return dests.length > 1;
}
