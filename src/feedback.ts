/**
 * Pure helpers for per-turn thumbs feedback (`x.ai/feedback`, #114).
 * Host opt-in: `grok.thumbsFeedback` (Settings → General, default off).
 *
 * Logical ACP method is `x.ai/feedback`. On the JSON-RPC wire it MUST be
 * `_x.ai/feedback`: the ACP decoder only routes `_`-prefixed extension
 * methods to `ext_method`, and a bare `x.ai/feedback` is -32601 before the
 * CLI router runs. Same convention as `_x.ai/interject`. See
 * research/turn-feedback.md.
 *
 * The host does not send `turn_number`. Reconstructing the CLI's User-item
 * index from the visible buffer is not possible: six `SyntheticReason`
 * variants all produce `ConversationItem::User`, and most never reach this
 * host. Thumbs therefore rate only the turn that just finished in this
 * process; the agent attributes the rating from its own session tracking.
 */

import { errorDetail } from "./acp-dispatch";
import type { AcpProvider } from "./acp-backend";

/** JSON-RPC method name this host sends (ACP `_` extension prefix). */
export const FEEDBACK_RPC_METHOD = "_x.ai/feedback" as const;

export type ThumbsRating = -1 | 0 | 1;
export type FeedbackClientType = "extension" | "desktop";

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
 * `userEnabled` is the Settings → General opt-in (`grok.thumbsFeedback`,
 * default off): off means never; on means when the provider supports it.
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
  userEnabled: boolean;
}): boolean {
  if (!input.userEnabled) return false;
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
  clientVersion?: string;
}): Record<string, unknown> {
  return {
    session_id: opts.sessionId,
    client_type: opts.clientType,
    rating_type: "thumbs",
    rating_value: opts.ratingValue,
    ...(opts.clientVersion ? { client_version: opts.clientVersion } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
