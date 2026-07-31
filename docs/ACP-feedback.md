# Grok CLI over ACP — current field feedback

Feedback for the xAI team from a thin ACP client (`grok agent stdio`, JSON-RPC over stdio). It
carries open behavior only, plus a short record of what has closed. The 0.2.3–0.2.112 record is
[archived separately](ACP-feedback-through-0.2.112.md); headings below cite the archive section
they continue.

**Current basis (2026-07-31):** grok CLI **0.2.117** (`f1c0609308`), re-probed against an
authenticated account on Windows 11. **Nine of the eleven sections below carry fresh 0.2.117
evidence.** Two do not — §10 (needs a 403) and §11 (needs a subagent run) — and two further
sub-claims keep an older build: the 429 retry delay in §5 and the cross-product settings merge in
§9. Everything unconfirmed on this build is labelled in place and summarized under *Coverage of
this pass*; nothing here is asserted as current on evidence we did not actually take.

## Evidence discipline

- **LIVE-VERIFIED** — observed on the named installed CLI build.
- **SOURCE-VERIFIED** — present in the named dated OSS snapshot.
- **SOURCE-ONLY** — changed upstream but never observed in a shipped binary.

Only LIVE-VERIFIED evidence retires an issue or a compatibility fallback. That distinction is
load-bearing: image-aware `read_file` and truthful created-file rewind reporting both exist in
published source, and both are still broken in the shipped 0.2.117 binary.

---

## 1. Plan mode still permits delegated mutation (archive §2.1)

**LIVE-VERIFIED 0.2.117.** Native exit verdicts now behave correctly: `{outcome:"cancelled"}` stays
in Plan, `"approved"` implements in the same turn, `"abandoned"` exits, and the model is told which
the user chose. That earlier issue is closed — thank you.

The safety boundary is not. In one 0.2.117 plan turn the CLI correctly refused the edit tool but
passed **five `terminal/create` requests** to the client. A normal ACP client executes those, so
Plan can mutate the workspace through the terminal while claiming edits are forbidden. This is the
**fourth consecutive build** we have measured it on. Published source explains the split:
`plan_mode_edit_gate` gates `AccessKind::Edit`, while bash, MCP and web fall through.

**Client cost/workaround:** we maintain a second plan-policy engine at the mandatory
`fs/write_text_file` and `terminal/create` handlers, classify read-only shell commands, constrain
paths, and reject everything else. It is the one safety workaround we cannot remove even though
native verdicts now work.

**Ask:** enforce one server-side Plan tool policy across edit, shell, MCP and web surfaces — allow
demonstrably read-only operations, reject potentially mutating ones before dispatch.

A smaller contract issue remains: after a cancelled verdict, same-turn re-planning is
nondeterministic. Identical prompts produced **1, 2 and 15** repeated `exit_plan_mode` asks within
one turn, so a client cannot treat a re-ask as a lifecycle guarantee.

## 2. Image capability and binary reads disagree with shipped behavior (archive §2.5)

**LIVE-VERIFIED 0.2.117.** `initialize` returns
`promptCapabilities: {"image":false,"audio":false,"embeddedContext":true}` although inline
`{type:"image"}` prompt blocks work. A client that trusts the advertised capability disables working
vision.

The inverse mismatch is more damaging: `read_file` on an image still returns
`FileReadError: "Cannot read binary file"`. This affects pasted assets, generated media, and
subagent-produced images. The image-aware branch is present in published source but remains
**SOURCE-ONLY** — it has not reached the shipped binary.

**Client cost/workaround:** we ignore the capability flag, pin a live drift test, pre-read and send
supported images ourselves, add "do not Read" hints to reduce transcript noise, and parse
generated-media paths out of tool output. There is no client workaround when the model
independently needs to inspect a generated image by path.

**Ask:** advertise `image:true`; ship the source's image-aware `read_file` path; return generated
media as structured `image`/`resource_link` content instead of a path embedded in text or
`rawOutput`; expose dropped-image errors on a documented surface.

## 3. Rewind reports files it did not revert (archive §2.15)

**LIVE-VERIFIED 0.2.117.** `_x.ai/rewind/execute` with `mode:"all"` can return a newly created path
in `reverted_files` while leaving that file on disk, so the response tells a client that more was
restored than actually was.

Published source deletes a file whose before-snapshot is missing and only then appends it to
`reverted_files`. That fix is **SOURCE-ONLY**; the shipped result is still wrong.

**Client cost/workaround:** our UI uses deliberately vague wording and cannot truthfully enumerate
restored paths from the response. We also had to probe two undocumented semantics: the target prompt
is discarded inclusively, and the current tip is a legal target.

**Ask:** ship truthful created-file handling (or split `restored` from `createdLeftInPlace`),
document the discard-inclusive boundary, and advertise the rewind capability and its schema.

## 4. A large shipped surface is undiscoverable (archive §2.16, §2.2)

**LIVE-VERIFIED 0.2.117** (method existence by error code: `-32601` absent, `-32602`/success
present, run with known-present, known-absent and bare-prefix controls).

Routed and useful, advertised nowhere: `_x.ai/session/list`, `_x.ai/session/info`,
`_x.ai/session/fork`, `_x.ai/session/usage`, `_x.ai/session/state`, `_x.ai/session/import`,
`_x.ai/session/updates`, `_x.ai/rewind/points`, `_x.ai/hooks/list`, and
`_x.ai/compact_conversation` (returns `{}` — the position-independent compact clients otherwise have
to guess exists).

Push rails nothing announces: `_x.ai/settings/update`, `_x.ai/announcements/update`,
`_x.ai/models/update`, `_x.ai/sessions/changed`, `_x.ai/queue/changed`,
`_x.ai/mcp/servers_updated`, `_x.ai/mcp_initialized`, `_x.ai/session/prompt_complete`, plus the two
lifecycle rails — `_x.ai/session_notification` live and `_x.ai/session/update` on replay — whose
0.2.117 kinds include `tool_call_delta_chunk`, `response_completed`, `hook_execution`,
`pending_interaction`, `interaction_resolved`, `session_summary_generated` and `turn_completed`.

`initialize` does advertise more than it used to (`x.ai/hooks`, `x.ai/fs_notify`,
`x.ai/capabilities.toolOverrides`, `modelState`, `defaultAuthMethodId`, `sessionCapabilities.list`,
and the flags `grokShell` / `voiceMode` / `cancelRewind` / `sessionRecap` / `x.ai/mcp/sdk` /
`x.ai/pluginDirs`) — but none of it names a method or a rail, so none of it makes the list above
discoverable.

Two slash commands that a generic client should not dispatch are still advertised on 0.2.117.
`/context` dispatches and emits **zero** output bytes — no inference, no content (LIVE-VERIFIED);
`/always-approve` flips the process-wide permission state (still advertised on 0.2.117;
SOURCE-VERIFIED 2026-07-16 for the mechanism). There is still no TUI-only or unsafe flag on an
advertised command, so every client ships its own denylist. Dispatch also still requires position 0:
sending `"Some editor-injected context.\n/session-info"` did not dispatch — the text went to the
model instead, taking the session from 5 472 to 16 047 context tokens.

**Client cost/workaround:** private method-name knowledge, `-32601` feature gates, payload probes,
send-reordering so commands land at position 0, and denylists for advertised commands. A rename or
prefix change silently breaks features.

**Ask:** publish an `initialize` capability set naming supported methods, push rails, versions and
schemas; mark commands that are TUI-only or unsafe for generic dispatch; document that xAI extension
methods are `_x.ai/...` on the wire; and accept a slash command anywhere in the first text block (or
provide a structured command field).

## 5. Context and usage numbers have misleading scopes (archive §2.3, §2.13)

**LIVE-VERIFIED 0.2.117.** The prompt **result**'s `_meta.totalTokens` is still a placeholder: a
`/session-info` turn returned `{"totalTokens":0,"modelId":"grok-4.5",…}` while its own reply prose
reported the true 5 474. The `session/update` **envelope** `_meta.totalTokens` is the trustworthy
one — in a second 0.2.117 capture it carried 5 473, matching that run's prose exactly, and it
climbs truthfully during a turn. The result value never does.

Not re-checked on 0.2.117 and **last LIVE-VERIFIED 0.2.112 / SOURCE-VERIFIED 2026-07-29**: the same
placeholder zero on `/compact` (where the sibling `_meta` usage fields are a stale echo of the
*previous* inference turn), a native `/compact` streaming no content at all, and the absence of any
standard ACP `usage_update` notification.

`_x.ai/session/usage` is scoped to the agent **process**, not the session. Measured on 0.2.117:
`totalTokens 31828, numTurns 2, costUsdTicks 180384000` (now with a welcome per-model `modelUsage`
breakdown), then **all zeros** on the next call after `session/load` in a fresh process, and
`numTurns: 1` after one further turn in a session that had had three. A cumulative-looking counter
that silently resets under-reports while still looking authoritative.

**Client cost/workaround:** we discard the placeholder zeros, read context size from notification
envelopes, and maintain our own persisted per-turn ledger because the cumulative-looking RPC is
process-scoped. Rewind must subtract from that client ledger too.

**Ask:** return the true post-operation context size on the prompt result, including after
`session/load`; emit a standard `usage_update`; and either persist `_x.ai/session/usage` across load
or rename it `process/usage`.

Related quota gap, **last LIVE-VERIFIED 0.2.103, SOURCE-VERIFIED 2026-07-29, not re-checked on
0.2.117** (we cannot force a rate-limit without abusing the account): HTTP 429 maps to `-32003`
without the available retry delay. There is also still no queryable quota surface — eight plausible
method names (`_x.ai/usage`, `_x.ai/quota`, `_x.ai/limits`, `_x.ai/rate_limits`,
`_x.ai/account/usage`, `_x.ai/user/usage`, `_x.ai/billing/usage`, `_x.ai/usage/get`) all returned
`-32601` on 0.2.117. A client can only say "try again later". Please preserve `retry_after_secs` in
error data and expose account quota independently of per-process token accounting.

## 6. Edit diff delivery is inconsistent, and `old_line` is a post-edit coordinate (archive §2.10)

**LIVE-VERIFIED 0.2.117** across five edit shapes (single replace, multi-line region replace,
whole-file overwrite, new file, and a replace-all whose replacement grows each site).

- **The three delivery paths carry different metadata, never the same.** The pre-write echo carries
  block-level `_meta:{old_line,new_line}` and no `details[]`; the completed update carries
  `_meta:{details:[…]}` and **no** block-level `old_line`; `session/load` replay carries only
  `details[]`. A client seeding from the echo's shape gets nothing on replay, and vice versa.
- **The first diff is wrong for whole-file writes.** On an overwrite the echo's diff block has
  `oldText: ""` while the completed update carries the real 58-byte prior content — and the echo's
  `_meta` is `{}`, with no line numbers at all. A client painting the earliest diff paints a false
  "new file".
- **`details[].old_line` is located in post-edit text.** For a replace-all where each replacement
  adds two lines, the ground-truth pre-edit occurrences are lines 2, 4, 6, but `details[]` reports
  `old_line` 2, 6, 10 — identical to `new_line`. The pre-edit line number is therefore not
  recoverable from the payload at all.
- `details[]` does now enumerate every replaced site (12 of 12, at real 1-based lines 3, 5, … 25),
  which is right and worth keeping. It carries `line_prefix` plus `context_before`/`context_after`,
  but no `line_suffix` and no full changed line.

**Client cost/workaround:** we key idempotency on diff content, treat a missing `status` as
provisional, merge three incompatible metadata shapes, and reconstruct whole-file context from disk
when it still matches.

**Ask:** send one authoritative diff or mark the echo explicitly provisional; use identical metadata
on echo, completion and replay; include the full old/new changed line (or `line_suffix`); and define
the coordinate space — if `old_line` is post-edit, say so, or add a genuine pre-edit line.

## 7. Fork's cut point is undocumented and moved between builds (archive §2.12)

**LIVE-VERIFIED FIXED on 0.2.117 — the headline is a thank-you.** `_x.ai/session/fork` with
`targetPromptIndex` now truncates **both** logs at the same boundary. On a 2-prompt session a full
fork copied 17 chat messages / 24 updates; `targetPromptIndex: 0` copied 10 / 10, and the second
prompt's text is absent from `chat_history.jsonl` **and** `updates.jsonl` on disk. The 0.2.101
failure — the model forgetting turns that `session/load` still replayed to the user — is gone.

Two residual issues stop us from shipping per-message branching:

- **The index base changed with no signal.** On 0.2.101, `targetPromptIndex: 1` against a 2-prompt
  session cut to the first prompt. On 0.2.117 the identical call copies the *whole* session, and `0`
  is the value that cuts there. Same wire call, different cut point, nothing on the wire
  distinguishes them.
- **Out-of-range is silent.** `targetPromptIndex: 99` returns a successful **full** copy rather than
  an error, so a client that miscounts gets a whole-session fork and never learns.

**Client cost/workaround:** we ship whole-session fork only and withhold per-message branching,
because we cannot pin a cut point across builds.

**Ask:** document the index base, return the effective cut point in `ForkSessionResponse` so a
client can validate its own replay, and reject an out-of-range index instead of silently copying
everything.

## 8. The shell dialect comes from the agent's environment, not the client (archive §2.9)

**LIVE-VERIFIED 0.2.117.** In ACP mode grok hands raw commands to the client to execute, but every
model-facing shell signal is derived from the grok host process. Measured: with `GROK_SHELL` unset
the model's first user message carries `Shell: powershell`; with `GROK_SHELL=bash` it carries
`Shell: bash`. Nothing in `clientCapabilities` is consulted, so detection and execution can diverge
and the model can emit POSIX syntax for a PowerShell executor (originally observed on 0.2.101).
`initialize._meta.grokShell` is advertised as `true`, but it is a constant — identical with
`GROK_SHELL` unset and set — so it does not report the resolved dialect either.

**Client cost/workaround:** on Windows we resolve the shell we will actually run and set the
undocumented `GROK_SHELL` variable in the stdio process's environment. Without it each mismatch
costs an extra tool call and model turn; rewriting arbitrary commands client-side is not safe.

**Ask:** document `GROK_SHELL`, and preferably accept and honor a client-declared terminal dialect
during `initialize`.

## 9. Effective permission policy is visible only in fragments (archive §2.11, §2.7)

**LIVE-VERIFIED 0.2.117 for the reporting gap.** `_x.ai/settings/update` carries `permission_mode`
and `auto_permission_mode_enabled`, both `null` on a default config, so a client cannot distinguish
"not set" from "not reported" — and neither field names the winning rule or its source file. There
is no getter: `_x.ai/settings`, `_x.ai/settings/get`, `_x.ai/settings/list`, `_x.ai/permissions/get`,
`_x.ai/permission/mode` and `_x.ai/session/config` all return `-32601`.

**Last LIVE-VERIFIED 0.2.99–0.2.101; SOURCE-VERIFIED 2026-07-16** for the underlying cause, which we
did not re-run on 0.2.117 because reproducing it means mutating another product's config: permission
prompts vary by machine because grok merges several invisible policy sources — Grok project grants,
managed settings, and Claude Code's `~/.claude/settings*.json`. An `Edit`, `Write` or `Bash` allow
granted to a different product can bypass `session/request_permission` before this client is
involved.

**Client cost/workaround:** review is decoupled from approval and rendered from every diff update.
To explain why no approval arrived, a client would have to reimplement the CLI's policy-resolution
stack — and still could not manufacture the missing choice.

**Ask:** report the effective per-session decision policy, the winning rule and its source file, and
make the cross-product Claude settings import explicit rather than silent.

## 10. Entitlement failures are still prose-only (archive §2.14)

**Last LIVE-VERIFIED 0.2.101; SOURCE-VERIFIED 2026-07-29; not re-checked on 0.2.117** — we cannot
provoke a 403 on an entitled account. A 403 entitlement failure is returned as generic
`-32603 internal_error`, sharing a bucket with policy blocks and server faults, and the only
discriminator is mutable prose.

Subscription *state* is observable — `initialize._meta.defaultAuthMethodId` settled "which credential
won?" on 0.2.112, and `_x.ai/settings/update` carries `subscription_tier_display`, `allow_access` and
`gate_message`/`gate_url`/`gate_label` (all still present on 0.2.117). None of that classifies the
error that ended a turn.

**Client cost/workaround:** conservative text heuristics, to keep a subscription failure in chat
instead of dropping the user into an unfixable login loop.

**Ask:** put a stable machine-readable code in the error's `data` for the entitlement, policy and
server-fault families.

## 11. Restore and subagent normalization remain client work (archive §2.6, §2.4)

**Last LIVE-VERIFIED 0.2.112 (restore) and 0.2.101 (subagents); not re-checked on 0.2.117** —
reproducing the subagent dialects costs several long delegated turns, so we left these labelled
rather than re-assert them. `session/load` can replay `<system-reminder>` and protocol-marker turns
as user content and cannot replay resolved permission requests. Subagent completion has foreground,
Composer and background-poller dialects; a background start ack is marked completed before the real
result arrives; result text duplicates structured output inside wrappers; child sessions appear as
top-level rows and must be filtered by `sessionKind`.

What we did re-confirm on 0.2.117 is the part that is genuinely fine: lifecycle events do ship, on
both rails — `_x.ai/session_notification` live and `_x.ai/session/update` on replay, observed
together in a single session. The remaining issue is that this two-rail contract and its payload
kinds are undocumented.

**Client cost/workaround:** replay filters, persisted and re-injected interaction state, wrapper
stripping, task-id correlation, and separate live/replay lifecycle routing.

**Ask:** keep internal reminders out of user replay; persist resolved interactions; make a
background "completed" mean completed; stop duplicating structured output in text; document both
lifecycle rails.

---

## Closed since the archive

Recorded so the list above is not read as static. Both are LIVE-VERIFIED on 0.2.117, not merely
fixed in source.

| Was | Now |
|---|---|
| §2.1 — a rejected plan needed a synthetic hidden-prompt protocol, because the CLI read a JSON-RPC error response to `exit_plan_mode` as a disconnect | Success `{outcome:"cancelled"\|"approved"\|"abandoned"}` behaves correctly inside the original turn; we deleted the primer machinery |
| §2.12 — `targetPromptIndex` truncated `chat_history.jsonl` but not `updates.jsonl`, so a forked session replayed turns the model had forgotten | Both logs truncate at the same boundary (verified on disk). Only the undocumented index base and the silent out-of-range remain — §7 |

Also retired earlier. Re-observed on 0.2.117: `_x.ai/sessions/changed` pushes the incremental session
catalog we once asked for; `initialize._meta.defaultAuthMethodId` (`"cached_token"`) answers "which
credential won?"; and lifecycle events do ship on both rails, retiring the old "they never ship"
claim — though the subagent-specific kinds were last seen on 0.2.112. Retired on source evidence and
not re-run here: reasoning effort is session-settable via `set_model` `_meta` (0.2.117 still
advertises `reasoningEfforts` in `initialize._meta.modelState`).

## Coverage of this pass

Re-observed live on 0.2.117: §1, §2, §3, §4, §5 (except the 429), §6, §7, §8, §9 (the reporting
gap). Left at an older named build because the trigger cannot be produced without abusing an
account or spending many delegated turns: the 429 `retry_after_secs` gap in §5 (0.2.103), the
cross-product settings merge in §9 (0.2.99–0.2.101), the 403 classification in §10 (0.2.101), and
restore/subagent normalization in §11 (0.2.112 / 0.2.101). Those four are the only claims here not
confirmed on the current build, and they are labelled in place.
