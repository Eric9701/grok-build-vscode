/**
 * Pure helpers for per-turn thumbs feedback (`x.ai/feedback`, #114).
 *
 * Logical ACP method is `x.ai/feedback`. On the JSON-RPC wire it MUST be
 * `_x.ai/feedback`: the ACP decoder only routes `_`-prefixed extension
 * methods to `ext_method`, and a bare `x.ai/feedback` is -32601 before the
 * CLI router runs. Same convention as `_x.ai/interject`. See
 * research/turn-feedback.md.
 */

import { errorDetail } from "./acp-dispatch";
import type { AcpProvider } from "./acp-backend";
import { isPrimerText } from "./grok-primer";
import { countsAsUserBubble, isInterjectionText } from "./plan-restore";
import type { HostMsg } from "./protocol";

/** JSON-RPC method name this host sends (ACP `_` extension prefix). */
export const FEEDBACK_RPC_METHOD = "_x.ai/feedback" as const;

export type ThumbsRating = -1 | 0 | 1;
export type FeedbackClientType = "extension" | "desktop";
export type FeedbackUserKind = "hidden" | "steer" | "prompt";

export function isThumbsRating(value: unknown): value is ThumbsRating {
  return value === -1 || value === 0 || value === 1;
}

export function feedbackClientType(isDesktop: boolean): FeedbackClientType {
  return isDesktop ? "desktop" : "extension";
}

/**
 * `session/new` `_meta.feedbackEnabled` (absent on `session/load` and older
 * CLIs). Undefined means "not stated" — do not treat that as enabled.
 */
export function parseFeedbackEnabledMeta(sessionResult: unknown): boolean | undefined {
  const rec = asRecord(sessionResult);
  if (!rec) return undefined;
  const meta = asRecord(rec._meta) ?? asRecord(rec.meta);
  if (!meta) return undefined;
  if (typeof meta.feedbackEnabled === "boolean") return meta.feedbackEnabled;
  if (typeof meta.feedback_enabled === "boolean") return meta.feedback_enabled;
  return undefined;
}

/** True when an `available_commands_update` list includes the `/feedback` builtin. */
export function commandsAdvertiseFeedback(commands: readonly unknown[]): boolean {
  return commands.some((command) => {
    if (!command || typeof command !== "object") return false;
    return (command as { name?: unknown }).name === "feedback";
  });
}

/**
 * Whether this host should offer thumbs. Codex/Claude have no equivalent.
 * A latched RPC failure (`-32601` or "Feedback is disabled.") wins. An
 * explicit `session/new` false wins over a later commands list. Unknown
 * (no meta, no commands yet) stays off — an affordance that cannot work
 * must not be shown.
 */
export function decideFeedbackAvailability(input: {
  provider: AcpProvider;
  metaEnabled?: boolean;
  commandsAdvertise?: boolean;
  latchedUnsupported: boolean;
}): boolean {
  if (input.provider !== "grok" || input.latchedUnsupported) return false;
  if (input.metaEnabled === false) return false;
  return input.metaEnabled === true || input.commandsAdvertise === true;
}

/** Internal-error whose detail begins "Feedback is disabled." */
export function isFeedbackDisabledError(err: unknown): boolean {
  return /^\s*Feedback is disabled/i.test(errorDetail(err));
}

export function buildClientFeedbackParams(opts: {
  sessionId: string;
  clientType: FeedbackClientType;
  ratingValue: ThumbsRating;
  turnNumber: number;
  clientVersion?: string;
}): Record<string, unknown> {
  return {
    session_id: opts.sessionId,
    client_type: opts.clientType,
    rating_type: "thumbs",
    rating_value: opts.ratingValue,
    turn_number: opts.turnNumber,
    ...(opts.clientVersion ? { client_version: opts.clientVersion } : {}),
  };
}

/**
 * How a user-side conversation item counts for `turn_texts_for_feedback`.
 * Steers and hidden plumbing are User items on the agent; visible bubbles
 * are not.
 */
export function classifyFeedbackUserText(text: string, steer?: boolean): FeedbackUserKind {
  if (steer || isInterjectionText(text)) return "steer";
  if (isPrimerText(text)) return "hidden";
  if (!countsAsUserBubble(text)) return "hidden";
  return "prompt";
}

/**
 * Conversation User items the host has seen, in order — including hidden
 * primers and mid-turn steers. This is what `turn_texts_for_feedback` indexes
 * with `nth(turn_number)`. It is NOT rewind's `prompt_index`.
 */
export function feedbackUserItemsFromBuffer(buffer: readonly HostMsg[]): FeedbackUserKind[] {
  const items: FeedbackUserKind[] = [];
  let chunkText: string | null = null;
  const finishChunks = () => {
    if (chunkText === null) return;
    items.push(classifyFeedbackUserText(chunkText));
    chunkText = null;
  };
  for (const msg of buffer) {
    if (msg.type === "userMessageChunk") {
      chunkText = (chunkText ?? "") + msg.text;
      continue;
    }
    finishChunks();
    if (msg.type === "userMessage") {
      items.push(classifyFeedbackUserText(msg.text, msg.steer));
    }
  }
  finishChunks();
  return items;
}

export function visibleFeedbackPromptCount(items: readonly FeedbackUserKind[]): number {
  return items.reduce((n, kind) => n + (kind === "prompt" ? 1 : 0), 0);
}

export function feedbackMapIsConsistent(
  items: readonly FeedbackUserKind[],
  totalUserBubbles: number | undefined,
): boolean {
  if (typeof totalUserBubbles !== "number") return true;
  return visibleFeedbackPromptCount(items) === totalUserBubbles;
}

/**
 * `turn_number` for the agent footer of visible user bubble N: the index of
 * that prompt among ALL User items (primers + steers + prompts). Null when
 * the bubble is not in the list — never omit `turn_number` on the wire; the
 * agent would attribute the rating to its current telemetry turn.
 */
export function feedbackTurnNumberForVisibleBubble(
  items: readonly FeedbackUserKind[],
  visibleBubbleIndex: number,
): number | null {
  if (!Number.isInteger(visibleBubbleIndex) || visibleBubbleIndex < 0) return null;
  let visible = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i] !== "prompt") continue;
    visible += 1;
    if (visible === visibleBubbleIndex) return i;
  }
  return null;
}

export function truncateTurnRatings<T>(
  ratings: ReadonlyMap<number, T>,
  surviving: number,
): Map<number, T> {
  const next = new Map<number, T>();
  for (const [index, rating] of ratings) {
    if (index < surviving) next.set(index, rating);
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
