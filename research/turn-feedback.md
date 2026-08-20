# Per-turn thumbs (#114)

Grok-only. Codex and Claude have no equivalent. Buttons live on the single
agent-turn footer (Copy + timestamp), revealed at turn end.

## Wire

Logical ACP method `x.ai/feedback` (snake_case `ClientFeedbackInput`). On the
JSON-RPC wire the host sends **`_x.ai/feedback`**: the ACP decoder only routes
`_`-prefixed extension methods to `ext_method`; a bare `x.ai/feedback` is
`-32601` at decode, before the CLI router. Same convention as
`_x.ai/interject`. The CLI match arm is the un-prefixed logical name.

`rating_type: "thumbs"`, `rating_value` -1 / 0 / 1. No `request_id` (spontaneous).
`client_type` is the **host** (`extension` or `desktop`), even when a phone
clicked. `turn_number` is always sent.

Degrade and hide the affordance on `-32601` and on an internal error whose
detail begins `Feedback is disabled.` Availability is advertised first from
`session/new` `_meta.feedbackEnabled`, else from an `available_commands_update`
that includes the `feedback` builtin. Off until one of those is true.

## `turn_number` is not rewind `promptIndex`

`turn_texts_for_feedback` does `.filter(User).nth(turn_number)` on the live
conversation snapshot. That index counts **every** `ConversationItem::User`,
including legacy primers and mid-turn interjections.

Rewind `prompt_index` counts `session/prompt` turns. Steers do not consume one.
After compaction the conversation User-item count collapses and `prompt_index`
does not.

The host maps visible user bubble N → the Nth **prompt** among host-seen User
items, then sends that item's index in the full (primer + steer + prompt) list.
Omitting `turn_number` would file the rating against `allocate_turn_number - 1`
(telemetry, monotonic across rewinds, harness siblings) — the wrong turn.

Known remaining miss: agent-side User items the host never saw (notification
drain, TASK_WAKE). Same class as rewind's `bubbleMapIsConsistent` refusal;
thumbs refuse rather than guess when the visible count diverges.

## UI

Thumbs only, no comment box. Click paints after the host acks. Clicking the
active thumb sends `rating_value: 0` (clear). Local `Session.turnRatings` only
— nothing is read back from the agent; a cold `session/load` shows unrated.

Remote inbound is `propose` (same class as `steerSend`).
