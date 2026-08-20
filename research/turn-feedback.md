# Per-turn thumbs (#114)

Grok-only. Codex and Claude have no equivalent. Buttons live on the single
agent-turn footer (Copy + timestamp), revealed at turn end — and only on the
turn that just finished **in this process**.

## Wire

Logical ACP method `x.ai/feedback` (snake_case `ClientFeedbackInput`). On the
JSON-RPC wire the host sends **`_x.ai/feedback`**: the ACP decoder only routes
`_`-prefixed extension methods to `ext_method`; a bare `x.ai/feedback` is
`-32601` at decode, before the CLI router. Same convention as
`_x.ai/interject`. The CLI match arm is the un-prefixed logical name.

`rating_type: "thumbs"`, `rating_value` -1 / 0 / 1. No `request_id` (spontaneous).
`client_type` is the **host** (`extension` or `desktop`), even when a phone
clicked. **`turn_number` is omitted.** The agent attributes the rating from its
own session tracking — the same numbering it uses for solicited `/feedback`.

Degrade and hide the affordance on `-32601` and on an internal error whose
detail begins `Feedback is disabled.` Availability is advertised first from
`session/new` `_meta.feedbackEnabled`, else from an `available_commands_update`
that includes the `feedback` builtin. Off until one of those is true.

**Host opt-in.** `grok.thumbsFeedback` (Settings → General → *Thumbs feedback
to SpaceXAI*, default **off**) is an additional gate on
`decideFeedbackAvailability` (`userEnabled`). Off means never; on means when
the provider supports it. Codex and Claude stay off. The TUI samples
feedback; this host does not — the setting is the substitute. The desk owns
the toggle; remotes show a read-only On/Off status (`thumbsFeedbackRemote`)
because inbound `setThumbsFeedback` is `host-local`. Ratings stay
ephemeral (`Session.turnRating` only). Solicited
`FeedbackRequestNotification` / `x.ai/feedback/dismiss` stay unimplemented.

## Why the host does not send `turn_number`

An earlier revision mapped visible user bubble N → the Nth **prompt** among
host-seen User items and sent that index. That mapping cannot be made correct.

`turn_texts_for_feedback` filters `matches!(item, ConversationItem::User(_))`
— a bare match. It does not skip synthetic items. `SyntheticReason`
(`xai-grok-sampling-types/src/conversation.rs`) has six variants that all
produce `ConversationItem::User`:

| Variant | What injects it |
|---|---|
| `CompactionMeta` | compaction pipeline |
| `SystemReminder` | runtime `<system-reminder>` |
| `ProjectInstructions` | AGENTS.md / CLAUDE.md, at session spawn |
| `AutoContinue` | after compaction, so the agent keeps going |
| `AutoRecovery` | after a transient tool failure, to retry |
| `Interjection` | steers (the only one this host models) |

We model exactly one of six. `ProjectInstructions` means any repo with an
AGENTS.md or CLAUDE.md is already offset before the user types anything.
`AutoRecovery` fires on transient tool failures and is invisible to the host.
Compaction rewrites the CLI's User-item sequence while `session.buffer` keeps
the original visible turns — so the consistency check (visible prompt count)
still passes while the thumb silently rates a hidden `compaction_meta`.

There is no signal we receive that reconstructs this sequence. Patching in a
compaction tracker would fix one of six sources and leave the feature still
silently wrong.

Omitting `turn_number` is therefore the honest wire: the agent fills in its
current turn. The UI is narrowed to match — thumbs only on that turn.

## UI

Thumbs only, no comment box. Only the most recent completed turn's footer
offers them; older turns lose the affordance. A turn completed in a previous
process (`session/load`) gets none — the agent's counter restarts, so there
is nothing honest to attribute to. Click paints after the host acks. Clicking
the active thumb sends `rating_value: 0` (clear). Local `Session.turnRating`
only — nothing is read back from the agent.

Rewind drops eligibility: the discarded tail includes the turn that just
finished, and a surviving older turn is not "the current one."

Remote inbound is `propose` (same class as `steerSend`).
