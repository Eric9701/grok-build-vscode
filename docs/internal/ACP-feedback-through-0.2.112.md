# Archived ACP field feedback through grok 0.2.112

This is the verbatim historical feedback accumulated across grok CLI 0.2.3–0.2.112. The live [ACP feedback](ACP-feedback.md) supersedes it; nothing below has been rewritten to match newer builds.

# Grok Build CLI over ACP — field feedback from a thin client

Feedback for the Grok Build CLI team from building **grok-build-vscode**, a VS Code/Cursor
sidebar that is a deliberately thin ACP client for `grok agent stdio`. Everything below is
**evidence-based**: wire captures from real sessions (`test/fixtures/composer-subagent-session.jsonl`),
standalone probes (`research/*.cjs`), and a pre-release live suite (`scripts/live-tests.cjs`)
that re-verifies the load-bearing shapes against the real binary. Deep-dives live in
`research/*.md`; this document is the summary an upstream engineer can act on.

**Current live basis (2026-07-29):** grok CLI **0.2.112**
(`9bbd559437`, native Windows, stable channel). `grok update --check` reports **0.2.114**, but it
was deliberately not installed while other grok processes were using the binary. Claims about
shipped behavior are therefore capped at 0.2.112 unless a section names an older measured build.
The original full Grok 4.5 verification remains in **§5**.

That basis is a full live re-verification, not a spot check: the pre-release suite
(`npm run test:live` — **21 passed · 1 skipped · 0 failed**) plus targeted probes for every claim
the suite can't reach. New this pass: `research/acp-surface-audit-probe.cjs`, which asks the
complementary question to every other probe here — *what is on the wire that we have never looked
at?* It dumps whole payloads for every inbound rail and sweeps method existence by error code
(`-32601` absent vs `-32602`/success present, with known-present and known-absent controls). That
sweep is what produced **§2.16**, and it is the reason this pass found more than it set out to
check.

**Current source basis (2026-07-29):** [xai-org/grok-build](https://github.com/xai-org/grok-build)
now publishes a daily `grokkybara[bot]` sync. This pass compares the first public snapshot
(`c68e39f`, 2026-07-16) with the latest available snapshot
([`5da6962`](https://github.com/xai-org/grok-build/commit/5da6962e4adb9c857f3def762542b52b4ec3e522),
2026-07-28; `Source-Revision: 2a818575…`). The snapshots form a 13-commit chain, so source changes
can now be dated and diffed. They still cannot be mapped silently to a released CLI build.

Evidence labels therefore have three meanings: **Live-verified** means observed on the named
binary; **Source-verified** means the named source snapshot implements or still contains the
behavior; **Source-only** means source has changed but that change has not been observed in a
shipped build. When live and source disagree, both are stated. Paths remain relative to
`crates/codegen/`. Our fuller internal notes: `research/grok-build-oss-findings.md`.

**Revision history** — newest first. Each observation is dated and carries the grok CLI build it
was made against; a section without a date here predates this log and is covered by **Basis**.

| Date | grok CLI | What changed |
|---|---|---|
| **2026-07-29** | **0.2.112** | **§2.16 (new) — the wire has outgrown its documentation, and two long-standing asks are quietly answerable.** A method-existence sweep found **six unadvertised RPCs already routed on the shipped build** (`_x.ai/session/usage`, `/state`, `/import`, `/updates`, `_x.ai/compact_conversation`, `_x.ai/hooks/list`) and **five push rails we had never seen** (`_x.ai/sessions/changed`, `queue/changed`, `settings/update`, `models/update`, `session/prompt_complete`). Three consequences: §2.7/§2.14 — `settings/update` carries `permission_mode`, `auto_permission_mode_enabled` and `subscription_tier_display`, and `initialize._meta.defaultAuthMethodId` is live, so the "effective policy / active auth is invisible" asks are now *partly self-served*. §2.3 — every `session/update` envelope carries a truthful live `_meta.totalTokens`, so the prose-regex workaround is retirable even though the prompt *result*'s zero stands. §2.13 — `_x.ai/session/usage` exists and carries **`costUsdTicks`**, but it is **per-process, not per-session** (measured: 31673 tokens before resume, **0** immediately after `session/load` in a fresh process), so it is not the quota RPC and cannot back a session total. **Also live-confirmed as still broken:** the §2.1 terminal hole (4 `terminal/create` calls passed through during a plan turn), §2.5's binary-`read_file` wall, and §2.15's `reverted_files` over-report — all three despite fixes existing in published source. Probe: `research/acp-surface-audit-probe.cjs`. |
| **2026-07-29** | **0.2.112** | **§2.1 — the native plan-mode verdict contract is live-verified.** Replying to `_x.ai/exit_plan_mode` with a JSON-RPC **success** `{outcome:"cancelled"}` (rather than the error we send today) behaves exactly as the source promised: the plan turn ends `end_turn` (not `cancelled`), `current_mode_update` stays `["plan"]`, and the model's own account is *"You asked me to **revise** the plan (not approve or reject), and **yes — I am still in plan mode.**"* That is precisely what our hidden primer exists to fake, which retires the primer's last remaining job. The client-side gate stays regardless — see the terminal hole above. Probe: `research/oss-surfaces-probe.cjs --scenario=planoutcome`. |
| **2026-07-29** | **0.2.112 live + OSS `5da6962`** | **Full source re-verification with shipped/source states separated.** The OSS repo now has 13 daily commits after its first public snapshot, replacing the obsolete “single squashed sync” basis. Latest source still has §2.1’s non-edit-tool plan hole and §2.3’s hardcoded compact zeros. §2.5 splits: `image:false` remains, while source has an image-aware `read_file` path that conflicts with the 0.2.112 generated-JPEG failure. New unadvertised methods are `_x.ai/session/state`, `/import`, and `/usage`; usage is cumulative session token/cost, **not account quota**. §2.12’s two-log fork truncation and §2.15’s created-file rewind are implemented correctly in source but need shipped-build confirmation. §2.14’s active-auth ask is partly implemented through `initialize._meta.defaultAuthMethodId`; structured 403 codes remain absent. |
| **2026-07-28** | **0.2.112** | **§2.5 — re-confirmed outside the paste-image path, sharpened the ask.** [#79](https://github.com/phuryn/grok-build-vscode/issues/79): a subagent's own generated `.jpg` files sitting in its `grok-goal-.../implementer/` scratch dir hit the identical `Cannot read binary file` wall when the model tries `Read` on them mid-task. We audited this repo for host-specific code and found none — no Antigravity-conditional branching anywhere outside analytics (`telemetry.ts`) — so there is **no client-side workaround for this one**; it's upstream-only. Sharpened the ask accordingly: since inline image blocks already work (§2.5's `image:false` is confirmed false), `read_file` should route a binary/image path through that same working vision pipeline instead of hard-failing — that gets the model what it wanted, not just a quieter failure. |
| **2026-07-26** | **0.2.111** | **§2.15 (new) — `_x.ai/rewind/*` semantics are undocumented and one of them is wrong on the wire.** `execute` **DISCARDS its target** prompt along with everything after it (measured: a 4-prompt session rewound to `#1` drops to 1 point; rewound to the tip `#3` drops to 3) — the opposite of what "rewind **to** N" reads like, and getting it backwards silently eats an extra turn *and* that turn's file changes. The **tip is a legal target**, contradicting an earlier "current prompt index is N" error we saw. `prompt_text` returns the *discarded* prompt (correct and useful — it's what a client puts back in the input box). **Bug:** `reverted_files` lists files that were **created** in the rewound turn even though they are left on disk — restore-previous-content has nothing to write back for a new file, so the array over-reports. Probes: `research/rewind-semantics-probe.cjs`, `research/rewind-newfile-probe.cjs`. |
| **2026-07-24** | **0.2.103** | **Re-verification on the current shipped build, prompted by [#64](https://github.com/phuryn/grok-build-vscode/issues/64).** §2.1's terminal hole is **still open** — re-probed: during a plan turn the model issued `run_terminal_command` and the CLI passed `terminal/create` straight through to the client (edit tool correctly blocked, so only `plan.md` was writable). §2.13's quota gap **still holds and now has a second, independent user asking for it**: the account/plan quota the TUI's `/usage` shows is **not reachable over ACP** — no `usage_update`, no `grok usage` subcommand, and `/usage` is TUI-only (like `/context`, `ok_end_turn(0, None)` — streams nothing over `grok agent stdio`). #64 wants exactly §2.13 item 3 (queryable quota in the GUI). Also confirmed advertised effort is model-specific: grok-4.5's `models[]._meta` advertises only `[high (default), medium, low]` (§2.7). |
| **2026-07-18** | **0.2.101** | **§2.13 (new) — rate-limit errors carry no reset time and no quota telemetry.** A weekly/usage limit surfaces as `-32003` with deliberately vague copy ("try again later"); no reset date exists anywhere on the wire, and there is no used/remaining signal a client could use to warn *before* the wall. User-reported ([#57](https://github.com/phuryn/grok-build-vscode/issues/57)) — the billing-flavored wording also misread as an auth failure in our client (fixed in extension v1.7.2 by classifying `-32003` first). |
| **2026-07-17** | **0.2.101** | **§2.12 (new) — `session/fork`'s `targetPromptIndex` truncates `chat_history.jsonl` but NOT `updates.jsonl`**, so a fork-at-a-point replays a conversation the model has forgotten; we ship whole-session forking only as a result. Also **two unadvertised RPCs probe-confirmed WORKING and now shipped in the extension**: `x.ai/interject` (mid-turn steering — the model obeys mid-stream and the turn still ends `end_turn`, i.e. it is genuinely not a cancel) backs the new Steer button, and `x.ai/session/fork` backs Fork. Both are `_`-prefixed, unadvertised, and therefore feature-gated client-side on -32601. Separately, `_meta.usage` (per-prompt billing, incl. `modelUsage`) exists and we had been dropping it; **no cache-creation field exists anywhere**. |
| **2026-07-16** | **OSS tree** | **Source-verified pass over every section** (the CLI went open source). §2.11's root cause found — grok silently merges `~/.claude/settings.json` permission rules; confirmed on our dev box. §2.4 corrected: the lifecycle events DO transmit live, on `x.ai/session_notification` (we watched the persist rail). §2.1's rejection-outcome ask withdrawn — a success `{outcome:"cancelled"}` response already exists (our client gap). §2.6: session list/search/rename/delete/fork exist as unadvertised `x.ai/*` methods. §2.7 corrected: reasoning effort IS session-settable via `set_model` `_meta`. §2.9: an undocumented `GROK_SHELL` override realigns the model's shell hints. Citations + sketch fixes added throughout. |
| **2026-07-15** | **0.2.101** | **§2.1 — the headline defect is FIXED.** A rejection of `x.ai/exit_plan_mode` is now honored. **One new, still-open hole:** plan mode gates the *edit* tool but **not** `terminal/create`, so a shell command can mutate the workspace during planning. |
| **2026-07-15** | **0.2.101** | **§2.10 (new) — edit diffs.** Three asks: every edit reports its diff **twice** and the first can be wrong (an overwriting Write's echo claims `oldText:""`); the echo, the completed update, and the session/load replay each carry a **different `_meta` shape**; and `details[]` has `line_prefix` but no `line_suffix`, so the changed line can't be reconstructed. *(Raised and **withdrawn** the same day: "a replace-all under-describes the change" — `_meta.details[]` does enumerate every site, 12/12 with exact line numbers. That was our client gap, not a CLI defect.)* |
| **2026-07-15** | **0.2.99–0.2.101** | **§2.11 (new) — permission requests are environment-dependent, not configuration-dependent.** The same build + settings sends **zero** `session/request_permission` for an in-workspace edit on some Windows 11 hosts, while prompting reliably on macOS / a Win 11 Azure VM. User-reported ([#49](https://github.com/phuryn/grok-build-vscode/issues/49)); no client-side fix can restore the missing approval step. |
| **2026-07-13** | *not recorded* | **§2.9 (new) — terminal commands** (issue #46, extension v1.5.13). The agent emits POSIX-subshell idioms against a PowerShell host, and the two agent families use different command-execution models. |
| **2026-07-11** | **0.2.93** | **§5 — Grok 4.5 verification.** Every grok-build-family finding re-verified against Grok 4.5; Composer 2.5 re-verified alongside. |

---

## 1. The two agent families behave differently on the wire

Models belong to *agent types* — `grok-build`/`grok-build-plan` vs the `cursor` agent that owns
the Composer models. A client that only tested one family breaks on the other:

| Surface | grok-build agent (Grok 4.5 / Grok Build, `grok-build-plan`) | cursor agent (Composer 2.5) |
|---|---|---|
| Context window (`_meta.totalContextTokens`) | **Grok 4.5: 500K** · **Grok Build: 512K** | 200K |
| Delegation tool | `spawn_subagent` (`_meta["x.ai/tool"].name`) | `Task` |
| `subagent_type` value style | `general-purpose` (kebab) | `generalPurpose` (camel) |
| Delegation completion | Same-id `tool_call_update`, `status:"completed"`, structured `rawOutput.SubagentCompleted` (output, `tool_calls`, `turns`, `duration_ms`, `resume_from_hint`) | A **third, untitled** update (`title:""`, **no `_meta`**), `rawOutput {type:"Text", text}` — **no duration anywhere on the tool channel** |
| Background delegation | `background:true` → instant "started" ack, real result later via `get_command_or_subagent_output` (`TaskOutput.Result` with `task_id`, `duration_secs`, `output`) | not observed |
| Tool-call ids | `call-<uuid>-<n>` | `call-<uuid>-composer_call_<suffix>` — the short suffix **repeats across calls**; only the full id is unique |
| Tool titles | verb-style ("List \`src/…\`") + tool name on spawn | frequently the raw user content (a Grep is titled with its search pattern) |
| `session/set_model` echo | **Grok Build:** versioned id (`grok-build-0.1`) not in `availableModels` · **Grok 4.5:** clean (`{"model":{"Ok":"grok-4.5"}}`, resolvable) | same class of issue |
| Cross-agent switch | `MODEL_SWITCH_INCOMPATIBLE_AGENT` after the first turn (agent locked at spawn) | same |

**Ask:** treat the wire contract as one product across agents — same tool naming, same
completion shape (structured `rawOutput` with duration), same id style — or document the
differences per agent type.

**Update (2026-07-29, 0.2.112): the Composer half of this table is currently unreachable for us.**
`availableModels` now advertises **only `grok-4.5`** on this account/build — no
`grok-composer-2.5-fast` — and the live suite's `subagent-composer` test consequently SKIPs ("no
Composer model available on this account/build"). The Composer observations above are left in
place because they were measured, and because a client that ever sees the `cursor` agent still
needs them; but we can no longer re-verify them, so treat this table's right-hand column as dated
to 0.2.93–0.2.101 rather than current. If the two-family split is being retired, saying so would
let clients drop a meaningful amount of dual-path code (ours is in `webview-helpers.js`'s subagent
classifier and the `toolCallId`-keyed output attach in `chat.js`).

---

## 2. What doesn't work — and what we had to build around it

Ordered roughly by how much client code each one cost.

### 2.1 Plan mode: rejection now works — but `terminal/create` escapes the plan gate
**Update 2026-07-15 (grok 0.2.101): the defect this section originally reported is FIXED — thank
you.** Through **0.2.3**, any client response to `x.ai/exit_plan_mode` — JSON-RPC **result or
error** — was treated as approval, so there was no wire-level "keep planning." On **0.2.101** the
two are cleanly distinguished. A/B with an identical prompt and build, varying only the response
type (`research/plan-mode-recheck-probe.cjs`):

| | **error** (reject) | **result** (approve) |
|---|---|---|
| `current_mode_update` | `[plan]` — stays in plan | `[plan, default]` — exits plan |
| plan turn `stopReason` | `cancelled` | `end_turn` |
| workspace writes | **0** — seed files byte-identical | 2 (file mutated + file created) |
| the model's own account | *"the user never approved or rejected"* | *"the user **approved** the plan"* |

`current_mode_update: "default"` no longer fires on the reject path, and `planContent` now
usually arrives **populated** with the plan text. Two residual notes:
- A rejection is interpreted as a **tool failure** (*"exit_plan_mode failed twice with a client
  disconnect"*), not a semantic *user rejected*. The outcome is right, but an explicit rejection
  outcome would beat overloading the error channel.
- `planContent: null` **still occurs** — observed when the model called `exit_plan_mode` without
  having drafted a plan — so clients still need the `plan.md` fallback.

**Still open, and the reason the workaround stays: plan mode is enforced for the edit tool but
not for the terminal tool** (grok 0.2.101, 2026-07-15). In plan mode the CLI's own tool layer
correctly refuses an edit:
> `Rejected: file edits are not allowed in plan mode -- the only editable file is the plan file`
> `(...plan.md). User verbal approval to edit is not sufficient, they must exit plan mode via the UI.`

Good — that's CLI-enforced, not model-cooperative. But asked to route around that block, the model
issued a `terminal/create` which the CLI **passed straight through to the client**:
```
node -e "require('fs').appendFileSync('app.js','\nfunction subtract(a,b){return a-b}\n')"
```
Nothing was written only because our probe ACKs terminals without executing them — a client that
actually runs the agent's commands (the whole point of `terminal/*` delegation) would have mutated
the workspace during "planning", contradicting the CLI's own rule above. Our client-side
`terminal/create` allowlist (`src/plan-gate.ts`) is currently the **only** barrier.

The workaround therefore remains in place: the client-side gate at the mandatory
`fs/write_text_file` / `terminal/create` choke points, plus a hidden **primer** message carrying
the `[Plan approved]`/`[Plan rejected]`/`[Plan cancelled]` protocol (the primer's original premise
— "ignore the bogus tool result" — is now obsolete; its remaining job is turn shape). The primer
still causes secondary problems (see 2.6).

**Ask:** apply the plan-mode restriction to `terminal/create` as well as the edit tools — a shell
command is a write. ~~Optionally, add an explicit rejection outcome so a reject isn't reported to
the model as a tool failure.~~ *(Withdrawn 2026-07-16 — the outcome exists; see below.)*

**Source-verified (2026-07-16, OSS tree).** The terminal hole is confirmed at HEAD:
`plan_mode_edit_gate` (`xai-grok-shell/src/session/acp_session_impl/tool_calls.rs:150,166-181`)
rejects only `AccessKind::Edit(..)`; `AccessKind::Bash` falls through to `Allow`, and the function's
own doc-comment says bash/MCP/web are never gated there. The caller (`:893-907`) already maps any
non-`Allow` verdict to a rejection message before dispatch, so the gate is the single choke point to
extend. **But the fix is a policy decision, not a one-line arm** (thanks to peer review for the
nudge): a blanket `AccessKind::Bash(_)` rejection would also block *read-only* shell inspection
(`ls`, `git status`, `cat`) that plan mode arguably should permit — grok already classifies a
read-only-command allowlist elsewhere (§2.11), so the natural design is to allow classified
read-only commands and reject the rest. And `Bash` isn't the whole surface: MCP tools and
`WebFetch`/`WebSearch` can have side effects too, so "a shell command is a write" understates it —
the real question is *which* non-edit tools may run during planning. **Ask:** define and enforce a
plan-mode tool policy (read-only shell + read-only MCP/web permitted; everything mutating blocked at
the same gate), not just an edit-tool block.

**The rejection-outcome ask is withdrawn — it already exists, and the error path we used was our
client gap.** The intended reply to `x.ai/exit_plan_mode` is a JSON-RPC **success** carrying
`{"outcome": "approved" | "cancelled" | "abandoned"}`
(`xai-grok-tools/src/implementations/grok_build/exit_plan_mode/types.rs:18-25`, mapped fail-closed
to `cancelled` at `tool_calls.rs:193-203`): `cancelled` keeps plan mode up and the CLI itself tells
the model the user wants to revise (`tool_calls.rs:1266-1287`); `abandoned` deactivates plan mode.
A JSON-RPC **error** — what we sent — is deliberately read as a client *disconnect*
(`ext_method_no_client`, `tool_calls.rs:215-220`), which is exactly the "tool failure" framing we
observed. Residual nit: this schema is undocumented; a note in the agent-mode guide would have saved
the probe. Also pinned: `planContent` is null exactly when `plan.md` is empty/whitespace, missing,
or unreadable at intercept time (`tool_calls.rs:106-113`, `:1204-1227`) — so the ask to keep it
populated reduces to "the model called `exit_plan_mode` without drafting a plan", a model behavior,
not a wire defect.

**Source re-verification (2026-07-29, `5da6962`): unchanged.** `plan_mode_edit_gate` still
matches only `AccessKind::Edit` and its own contract explicitly says bash, MCP, and web are never
gated (`xai-grok-shell/src/session/acp_session_impl/tool_calls.rs:163-211`). The terminal/MCP/web
policy ask therefore remains open in latest source.

**Live re-verification (2026-07-29, 0.2.112) — the hole is still open, and the native verdict
contract now works.** Two measurements from one probe run
(`research/oss-surfaces-probe.cjs --scenario=planoutcome`):

- **The terminal hole reproduces.** During a single plan turn the CLI passed **4 `terminal/create`
  calls** straight through to the client while correctly refusing the edit tool. Third consecutive
  build (0.2.101 → 0.2.103 → 0.2.112) with the same result. Our client-side gate remains the only
  barrier, so **the ask in this section is the one item here we cannot design around** — everything
  else in this document has a client-side workaround; this one does not.
- **A success-response verdict behaves exactly as the source promised.** Replying to
  `_x.ai/exit_plan_mode` with `{outcome:"cancelled"}` — instead of the JSON-RPC error we ship today
  — left the plan turn at `stopReason: end_turn` (not `cancelled`), kept `current_mode_update` at
  `["plan"]`, and produced this from the model unprompted:
  > *"You asked me to **revise** the plan (not approve or reject), and **yes — I am still in plan
  > mode**."*

  That is the entire job our hidden primer still performs, done natively and without a synthetic
  turn. The primer's original premise died in 0.2.101; this kills its replacement premise too. We
  are migrating off it — which retires most of what §2.6 and §3 complain about, since nearly all of
  it is primer-downstream.

### 2.2 Slash commands: dispatch requires position 0, and TUI-only commands are advertised
- A slash command dispatches **only** when it starts the prompt's text block. Editor-injected
  context in front silently degrades `/compact` into a plain LLM turn — in our probe the
  "compact" **grew** the context 6× (`research/compact.md`). Trailing content is fine, so we
  re-order every send; but nothing over the wire tells a client this rule exists.
- `/always-approve` is advertised over ACP but mutates the **global** `config.toml` — a sticky
  cross-session side effect a sidebar can neither show nor undo per-session. We hide it.
- `/context` is advertised but renders only in the CLI's own TUI — over stdio it streams
  nothing. We hide it too (`/session-info` is the working equivalent).

**Ask:** dispatch commands regardless of position (or accept a structured command field), and
don't advertise commands that are TUI-only or config-mutating on a per-session protocol.

**Source-verified (2026-07-16, OSS tree).** Position-0 is by design: `parse_slash_prefix` takes the
*first text block* and requires the `/` as its first non-whitespace character
(`xai-grok-shell/src/session/slash_commands.rs:1052-1074`, pinned by tests at `:1192-1200`); no
structured invocation exists (`prompt._meta` is read only for `mode`; `x.ai/commands/list` lists,
never invokes). `/context` over stdio is literally `ok_end_turn(0, None)` — no output path at all
(`slash_exec.rs:82`) — and the advertised-command list has no TUI-only/hidden flag to set
(`slash_commands.rs:8-18`), so both halves of the ask stand. One **correction**: over ACP,
`/always-approve` does **not** write `config.toml` — it flips an in-memory per-process yolo flag
(`slash_exec.rs:18-52` → `xai-grok-workspace/src/permission/manager.rs:456-477`); the config write
we blamed on it is the TUI's own prompt effect (`permission/prompter.rs:40-44`). Worth noting:
`x.ai/compact_conversation` exists in the ext-method router (`agent/mvp_agent/acp_agent.rs:3438`)
and may already be the position-independent compact this section asks for — undocumented, so we
will probe it.

**Probed 2026-07-29 (0.2.112): it ships.** `_x.ai/compact_conversation` returns `{}` rather than
`-32601`, so the position-independent compact this section asks for **already exists** — we just
had to guess its name. That retires our send-reordering workaround for the one command where
re-ordering was most fragile. The two halves of the ask that remain are unchanged and still worth
doing: `/context` and `/always-approve` are both **still advertised** over ACP on this build
(re-confirmed in `availableCommands`), and there is still no hidden/TUI-only flag for a client to
respect, so every client must maintain its own denylist of commands that misbehave over stdio.

### 2.3 Context accounting: the client can't know the truth when it matters
- The prompt result's `_meta.totalTokens` is **0** for both `/session-info` (context untouched)
  and `/compact` (context shrunk, not emptied) — a placeholder, never a measurement. The other
  fields on a compact turn are a stale echo of the *previous* turn.
- A native `/compact` streams **no content at all** — the turn ends blank with no worked-signal.
- The persisted `signals.json` (`contextTokensUsed`) is recomputed only when the **next
  inference turn ends** — never at the compact turn's own end (probe:
  `research/signals-refresh-probe.cjs`). Right after "compact finished" the true size exists
  nowhere a client can read…
- …except in `/session-info`'s **reply prose**. Our fix is a hidden CLI-local `/session-info`
  turn whose text we scrape with a regex (`**Context:** N / M tokens`). That is as fragile as
  it sounds.
- The ACP `usage_update` notification (the RFD's standard channel for exactly this) is never
  emitted.

**Ask:** emit `usage_update` (or at minimum a truthful `totalTokens`) at the end of `/compact`
and in the `session/load` response. Never report placeholder zeros.

**Source-verified (2026-07-16, OSS tree).** The zeros are hardcoded: `/compact` and `/session-info`
return `ok_end_turn(0, None)` (`xai-grok-shell/src/session/acp_session_impl/slash_exec.rs:16`,
`:371` → `session/commands.rs:63-72`), and the sibling `_meta` fields are captured from the
*previous* inference turn before the match (`agent/mvp_agent/acp_agent.rs:2326-2329`) — placeholder
plus stale echo, exactly as observed. `usage_update` appears nowhere in the tree. The signals.json
timing is also confirmed: `contextTokensUsed` is updated only by the *next* turn's pre-sampling
auto-compact check (`session/compaction.rs:1779-1781` is the sole caller). The kicker: at compact
end the true size is already in scope — `run_compact` reads `get_total_tokens()` and ships it in
the proprietary `AutoCompactCompleted { tokens_before, tokens_after }` notification
(`compaction.rs:629-639`, on the `x.ai/session_notification` rail — see §2.4) — it just never
reaches `_meta.totalTokens`. The minimal fix is ~2 lines: pass that value to `ok_end_turn` instead
of `0`.

**Source re-verification (2026-07-29, `5da6962`): unchanged.** `/compact` still calls
`ok_end_turn(0, None)` immediately after `run_compact`, and `/context` still returns the same zero
shape (`xai-grok-shell/src/session/acp_session_impl/slash_exec.rs:16-20,76`). No standard
`usage_update` path has appeared. `_x.ai/session/usage` is billing/session accounting, not current
context size; it does not close this section.

**Live re-verification (2026-07-29, 0.2.112): the defect stands, but our worst workaround is
retirable.** The prompt **result**'s `_meta.totalTokens` is still `0` on `/session-info` — unchanged.
However every `session/update` **notification envelope** carries a truthful, live-updating
`_meta.totalTokens` (observed 5487 → 15781 → 16015 within a single turn, and exactly matching the
`Context: N / M tokens` prose we scrape). So the fourth bullet's regex — "as fragile as it sounds" —
has a structured replacement that has apparently been there all along on a different envelope than
the one we read. That is a client-side fix, and we are taking it; the ask (don't report placeholder
zeros on the surface that documents itself as the token count) is unaffected. See §2.16.

### 2.4 Subagents: three completion dialects, lifecycle events that never ship, titles that lie
- The `subagent_spawned`/`subagent_finished` lifecycle events (method `_x.ai/session/update`)
  are **written to `updates.jsonl` but never transmitted to the ACP client** (live-verified:
  zero arrive while the log fills). They carry exactly what the UI wants — duration_ms,
  tokens_used, the child's output. We route them anyway, hoping.
- Completion shape differs by agent (see §1) and by mode: a `background:true` spawn reports
  `status:"completed"` **immediately** with a "Subagent started in background." ack — the
  real result arrives minutes later on the poller. "Completed" that isn't.
- The child's clean output is triple-wrapped in envelope text (`<subagent_meta>`,
  `<subagent_result>`, "This is the output of the subagent:", a trailing
  "Agent ID: … (resume …)" hint) even though the same output exists structured in
  `rawOutput`.
- Tool titles embed user content: a Grep **for** `spawn_subagent` is titled exactly
  `spawn_subagent`. Only `_meta["x.ai/tool"].name` tells the truth (that field is excellent —
  see §4). The poller's own name (`get_command_or_subagent_output`) contains "subagent" while
  not being a delegation.
- Each child persists as a **top-level sibling session** in the store; clients must filter
  `session_kind:"subagent"` or every delegation adds a junk row to session history.

**Ask:** transmit the lifecycle events; make "completed" mean completed; keep the envelope out
of the text block (the structured `rawOutput` is enough); put `x.ai/tool` meta on every call.

**Source-verified (2026-07-16, OSS tree; probe-confirmed on 0.2.101) — major correction to the
first bullet.** The lifecycle events **are pushed live; they ride a different METHOD than the one
our UI watches.** There are two rails, and — to be precise — **both are `_`-prefixed on the wire**
(every x.ai extension method is; the `agent-client-protocol` decoder only routes a `_`-prefixed
method to `ext_method`, and the bare `x.ai/...` name is just the internal logical name the Rust
router matches after the decoder strips the `_`). The rails differ by method, not by prefix:
- **`_x.ai/session_notification`** — the **live** lifecycle envelope, emitted unconditionally by
  `send_xai_notification` (`session/acp_session_impl/updates.rs:701-744`) and
  `emit_subagent_notification` (`agent/subagent/mod.rs:2216-2242`). Carries `SubagentFinished`
  (`duration_ms`, `tokens_used`, `output`, `will_wake`; `extensions/notification.rs:629-657`),
  `auto_compact_completed`, `turn_completed`, `image_dropped`. **Probe-observed live on 0.2.101.**
- **`_x.ai/session/update`** — the **persist/replay** records in `updates.jsonl`
  (`storage/mod.rs:92`), re-forwarded on `session/load` (`agent/mvp_agent/mod.rs:1307-1351`).

Our "never transmitted" measurement (0.2.93) watched the persist rail's method; the lifecycle
actually rides `session_notification`, which our client receives but our subagent UI ignores. The
reframed ask: **advertise/document the two rails** — nothing in `initialize` hints they exist.

The other bullets, now cited: the instant background "completed" is structural — the
`run_in_background` branch returns `Ok(ToolOutput::Text("Subagent started in background…"))`
synchronously (`xai-grok-tools/src/implementations/grok_build/task/mod.rs:328-368`); the completed
envelope (`<subagent_meta>` / `<subagent_result>`) is built in the tool-output layer — the
per-poll form at `task_output/mod.rs:581` (the older "This is the output of the subagent:" /
"Agent ID:" wrap survives only as a legacy *parser*, `reminders/task_completion.rs:522-544`);
`x.ai/tool` stamping happens in `stamp_tool_meta` (`tool_calls.rs:260-274`) and skips unresolved
wire names — uninitialized MCP and backend-hosted tools (`normalization.rs:27-41`); and
`session_kind` **is** exposed over ACP as a **top-level `sessionKind`** field on each
`_x.ai/session/list` row (`session/unified_list/row.rs:123`, flattened — NOT in `_meta`, where
`_meta["x.ai/session"].kind` is only the coarse `build`/`chat` class) — see §2.6.

### 2.5 Capabilities and media: the flags don't match reality
- `initialize` advertises `promptCapabilities.image: false`, but inline `{type:"image"}`
  blocks **work** — the model sees the pixels (verified since 0.2.87). A client that trusts
  the flag disables a working feature; we ship with no gate and a live test that fails the day
  the flag flips, in either direction.
- Generated media (`/imagine`, `/imagine-video`) is not returned as an ACP `image`/
  `resource_link` block — the file path is embedded in a `text` block, as JSON on
  Linux/macOS and as human **prose** on native Windows (with `\\?\` extended-length
  prefixes). We parse prose to find pictures.
- A pasted image is copied into `~/.grok/sessions/<…>/assets/` and that internal path is
  surfaced to the model — which then tries to `Read` the binary and fails, polluting the
  transcript. We bake a "do not Read" hint into every image tag.
- **Re-confirmed outside the paste-image path, and it points at the real fix** ([#79](https://github.com/phuryn/grok-build-vscode/issues/79),
  grok 0.2.112, Antigravity IDE): a subagent's own generated `.jpg` files in its
  `grok-goal-.../implementer/` scratch dir hit the same `Cannot read binary file` wall the
  moment the model tries `Read` on them mid-task — same gap as the pasted-image case, just
  reached without our client surfacing anything. No host-conditional code exists anywhere in
  this repo, so an Antigravity-vs-VS Code split (if it's even real) can't be produced by a
  client fix; there is no client-side workaround for this one. The two fixes are not
  equivalent: teaching the model to never *call* `read_file` on a binary path only quiets the
  noise, but this repo already proved (above) that inline image blocks work despite the
  advertised `image:false` — so `read_file` hitting a `.jpg`/`.png`/etc. should satisfy the
  request through that same working vision path instead of hard-failing. That gets the model
  what it was actually trying to do; suppressing the call just makes the failure quieter.
- An image the CLI judges too small is silently dropped, leaving the model hunting the
  workspace for an attachment it never received. No error reaches the client.

**Ask:** truthful capability flags; media as structured content blocks; don't surface internal
asset paths to the model; error on dropped attachments; **and make `read_file` image-aware —
route a binary/image path through the same vision pipeline that already works, rather than a
hardcoded decode failure** (closes both the pasted-image case above and #79's task-generated
case in one fix).

**Source-verified (2026-07-16, OSS tree).** `image: false` is a hardcoded omission — `initialize`
builds `PromptCapabilities::new().embedded_context(true)` and never calls `.image(...)`
(`xai-grok-shell/src/agent/mvp_agent/acp_agent.rs:394-413`), while `prompt_parser.rs:119` accepts
and uses incoming image blocks. The fix is one builder call. Two corrections from the source:

- **Dropped images are not fully silent.** The floors are 8×8 px and 512 total px
  (`session/image_normalize.rs:51-55`, `:429-439`); a drop emits `ImageDropped { notes }` on
  `x.ai/session_notification` (`acp_session_impl/turn.rs:189-196`) plus an
  `<image_dropped_notice>` to the model. The remaining gap is that nothing rides a *standard* ACP
  surface (same discoverability problem as §2.4).
- **Generated media is JSON-in-text on every platform, plus a typed `rawOutput`** — the emitter is
  platform-agnostic (`session/acp_conversion.rs:536-548`, comment: *"Dual channel: prose for
  non-pager clients, typed `raw_output` for the pager"*; payload
  `{path, filename, session_folder, message}` at `xai-grok-tools/src/types/output.rs:108-123`).
  What made native Windows read as prose is the un-normalized path: the media writer never strips
  the `\\?\` verbatim prefix (`grok_build/storage.rs:101`), unlike `read_file`
  (`read_file/mod.rs:315`). A one-line normalization fixes the Windows payload; a
  `resource_link`/`image` content block would still be the right long-term shape (none exists at
  HEAD).

The internal-asset-path surfacing is `render_image_files_block`
(`session/image_describe.rs:329-341`) — the `<image_files>` block hands the model the absolute
`~/.grok/sessions/<…>/assets/…` path, which is what provokes its failing `Read`.

**Source/live split (2026-07-29).** Latest source still advertises image support as false:
`PromptCapabilities::new().embedded_context(true)` has no `.image(true)` call
(`xai-grok-shell/src/agent/mvp_agent/acp_agent.rs:507-509`). But `read_file` source already checks
decoded metadata and routes images to `image_read_output` *before* the generic binary rejection
(`xai-grok-tools/src/implementations/grok_build/read_file/mod.rs:416-427,450-461`). That image
branch is present as far back as the first public source snapshot, while the generated JPEG still
failed live on 0.2.112. Therefore the capability-flag ask remains open, and the image-aware
`read_file` ask is **implemented in published source but not verified in stable** — not withdrawn.

**Live re-verification (2026-07-29, 0.2.112) — it is not just generated JPEGs.** Reduced to the
smallest possible case: a 109-byte 32×32 PNG written to the session cwd, with the model asked to
`Read` it and report verbatim what the tool returned. Result — `status:"failed"`, and:
```json
{"type":"ReadFile","FileReadError":"Cannot read binary file: …\\square.png"}
```
So the wall is the plain `read_file`-on-an-image path, reproducible in one turn with no subagent,
no `/imagine`, and no host specifics — which removes the last doubt that #79 was somehow
Antigravity- or workflow-specific. `promptCapabilities.image:false` was re-confirmed in the same
pass while the vision test again proved inline image blocks work. **Both halves of this section
therefore stand on the shipped build**, and the ask is unchanged: route a binary/image path
through the vision pipeline that already works.

### 2.6 Session catalog and restore: private storage becomes a client API
- Grok's ACP surface exposes `session/new` and `session/load`, but no list, search, rename,
  or delete operations. We enumerate private session directories, parse `summary.json`, infer
  recency from file mtimes, synthesize live sessions before the CLI flushes them, and maintain
  our own pagination, cache, and rename metadata. A client should not need to treat the CLI's
  on-disk implementation as a public API just to render session history.
- `session/set_model` echoes a **versioned id** (`grok-build-0.1`) that isn't in
  `availableModels` and carries no name or context window — still the case on **Grok Build**.
  **Grok 4.5** echoes the clean requested id (`grok-4.5`, resolvable), so the defect is
  per-model within the same agent family; the `resolveModelId` fallback stays for Grok Build,
  older sessions, and the composer agent (see §5).
- The agent type locks after the first turn; switching model families requires a full session
  restart choreographed by the client (`MODEL_SWITCH_INCOMPATIBLE_AGENT`).
- `session/load` does not replay resolved `request_permission`s (we persist and re-inject
  them) and replays `<system-reminder>` turns and protocol markers as user messages a UI must
  know not to render.
- grok titles the session from message #1 — which for us is the hidden primer — so every
  session was named "…Primer v4 Plan Mode…" until we forced display names client-side. Empty
  primer-only sessions accumulate on disk (we sweep them). `num_messages` in `summary.json`
  can be wildly inflated by one agentic turn. `chat_history.jsonl` wraps prompts in
  `<user_query>` — except when it doesn't (slash commands arrive unwrapped).
- Live prompts echo back as `user_message_chunk` since 0.2.33 (they didn't before) —
  undocumented behavior changes like this are how duplicate-bubble bugs are born.

Most of this section is downstream of the primer, which is downstream of 2.1.
**Ask:** expose a paginated `session/list` plus rename/delete operations, returning stable
metadata such as title, updated time, workspace, model, agent type, and session kind. Keep
restore replay free of internal protocol messages and include resolved interaction state.

**Source-verified (2026-07-16, OSS tree; probe-confirmed on 0.2.101) — the catalog operations
already exist, unadvertised, AND ship.** The ext-method router
(`xai-grok-shell/src/agent/mvp_agent/acp_agent.rs:3164-3508`) dispatches `_x.ai/session/list` +
`_x.ai/sessions/list` (`:3168`), `_x.ai/session/search` (`:3181` — the SQLite FTS index behind
`grok sessions search`), `_x.ai/session/rename`, `_x.ai/session/delete`, `_x.ai/session/fork`
(`:3189`, `extensions/session_admin.rs`), plus `_x.ai/session/info`, `_x.ai/session/close`,
`_x.ai/session/load_history` — unconditionally, no feature gate. **Wire form is `_`-prefixed**
(`_x.ai/session/list`); a bare `x.ai/...` is rejected `-32601` at the decoder before the router
runs, so it advertises nothing about whether the RPC exists. A live probe against 0.2.101 confirms
they work: `_x.ai/session/rename` → `{success:true}`, `_x.ai/session/delete` removed the session
dir. `list` returns **`{ sessions, nextCursor, _meta }`** (`unified_list/mod.rs:298`), and
`sessionKind` is a **top-level flattened row field** (`row.rs:123`), *not* in `_meta` (there,
`_meta["x.ai/session"].kind` is only the coarse `build`/`chat` class). The headline ask therefore
reduces to: **advertise/document these methods** (`initialize` hints at none of them), and we are
adopting them directly. Related root causes, now pinned:

- **Versioned `set_model` echo:** the echo returns the catalog *entry's* `.model` while
  `availableModels` ids are the catalog *keys* (`handlers/model_switch.rs:231-235`;
  `agent/config.rs:4788-4795`; `resolve_catalog_key` accepts either, `agent/models.rs:1616-1629`).
  For `grok-build` the remote catalog's key ≠ `.model` (`grok-build-0.1`); for `grok-4.5` they
  coincide — matching §5. Echoing the key would fix it.
- **Agent lock:** `MODEL_SWITCH_INCOMPATIBLE_AGENT` fires only when `turn_count > 0`
  (`handlers/model_switch.rs:65-88`); at zero turns the harness is rebuilt in place (`:89-113`) —
  which is why a pre-first-turn `set_model` works.
- **Replay:** `prepare_replay_lines` filters only blank/rewind/`availableCommands` lines
  (`session/storage/mod.rs:1106-1196`) — `<system-reminder>` and protocol-marker replay is
  structural; and resolved `request_permission`s are request/response RPCs, never persisted as
  session updates, hence never replayable. (`session/load` also honors an undocumented
  `_meta.noReplay`, `agent/mvp_agent/mod.rs:355`.)
- **Titles:** the generator locks onto the first non-empty text with no synthetic-turn skip
  (`session/summary.rs:58-97`). The structural fix for clients exists though: **`session/new`
  accepts `_meta.rules`** — appended to the system prompt as `<human_rules>`
  (`agent/mvp_agent/mod.rs:1036-1058`; also `systemPromptOverride`, `agentProfile` — documented in
  the agent-mode guide). That is the sanctioned home for what our hidden primer does today; moving
  to it dissolves most of this section's primer-downstream complaints, and we are migrating.

**Source additions since the first public snapshot.** The 2026-07-19 sync added
`_x.ai/session/state` and `_x.ai/session/import`: state returns the transcript-adjacent `plan`,
`planMode`, `signals`, `goal`, `announcement`, and `summary` columns; import recreates those plus
`updates.jsonl` on another host (`xai-grok-shell/src/extensions/session_state.rs`). The 2026-07-21
sync added `_x.ai/session/usage` (`extensions/usage.rs`; routed at
`agent/mvp_agent/acp_agent.rs:3440`). All remain unadvertised. These additions sharpen the ask:
advertise a discoverable session-management capability set, including which methods are safe for
cross-host portability.

**Live re-verification (2026-07-29, 0.2.112): all three are routed on the shipped build, and the
headline ask is already implemented as a push rail.** `_x.ai/session/state`, `/import` and
`/updates` all answer `-32602` (routed, parameter shape wrong) rather than `-32601` — so they are
shipping, not source-only. More importantly, **`_x.ai/sessions/changed`** pushes exactly the
catalog this section asks for, incrementally, with `title`, `cwd`, `modelId`, `reasoningEffort`,
`yolo`, `isWorktree` and a live `activity` field. That is better than what we asked for; we simply
had no way to discover it. The private-directory scraping described in the first bullet is
therefore our own remaining problem, not yours — **the ask that survives is purely discoverability**
(§2.16). The rest of this section — versioned `set_model` echo, agent lock, `<system-reminder>`
replay, primer-derived titles — is unchanged on 0.2.112, though the primer half is going away on
our side (§2.1).

### 2.7 Session configuration is partly out of band
- Effective permission mode is invisible over ACP. A global or project
  `permission_mode = "always-approve"` silently changes every session's behavior, so we read
  `config.toml` ourselves to avoid displaying a false "Agent" state. The client cannot disable
  that setting for one session.
- Reasoning effort is only a process-start flag (`--reasoning-effort`). Changing it requires
  killing the agent process and restoring or replacing the session; `session/new` and
  `session/load` do not report the effective value.

**Ask:** return effective permission mode and reasoning effort from `session/new` and
`session/load`, and provide session-scoped setters where supported.

**Source-verified (2026-07-16, OSS tree) — the effort half is withdrawn; the permission half
stands, sharpened.** Reasoning effort **is** session-scoped-settable over ACP: `session/set_model`
reads `_meta.reasoningEffort` (`xai-grok-sampling-types/src/types.rs:852`, `:865-874`), applies and
persists it per-session (`handlers/model_switch.rs:24`, `:117-134`), and it is reported back in the
`session/new`/`session/load` `models[]._meta` (`agent_ops.rs:2258-2274`) and
`x.ai/sessionConfig.options`. Undocumented, but present — we are adopting it and retiring the
process-restart choreography. Permission mode, by contrast, is confirmed absent from every session
response (it appears only in telemetry events, `acp_agent.rs:1089-1097`), has no setter, and the
client's `support_permission` feature is read and then explicitly discarded
(`spawn.rs:217` — `let _ = support_permission;`). See §2.11 for what actually governs prompting —
which makes surfacing the *effective* policy (and its source file) more important, not less.

### 2.8 Transport/platform (historical but instructive)
- Windows builds 0.2.61–0.2.70 didn't read stdin until **EOF** — a persistent ACP client hung
  forever on `initialize` (later builds: on `session/new`). We still carry a version pin +
  downgrade machinery. Regression tests for "read as lines arrive" would prevent a recurrence.
- `grok update` fails while any grok process (including backgrounded subagent children) holds
  the binary — clients must kill process *trees* and retry.
- `x.ai/ask_user_question` (and `exit_plan_mode`) also appear under a `_x.ai/` prefix; the
  response schema (`outcome:"accepted"` required, empty ACK rejected) had to be recovered from
  strings in the binary. Documentation would have saved a probe.

**2026-07-16:** with the source public, the documentation asks here are largely satisfied by
reading it. The `_x.ai/` prefix convention is now clear: **every** x.ai extension method is
`_`-prefixed on the wire, and the ACP decoder rejects a bare `x.ai/...` with `-32601` before the
router runs (`xai-grok-shell/src/agent/app.rs`) — so a client MUST send `_x.ai/session/list`, not
`x.ai/session/list` (a lesson we learned the hard way: a first probe used bare methods and
mis-concluded the session RPCs were unshipped). The two session rails are distinguished by method
(`session_notification` vs `session/update`), not by prefix (§2.4). The `ask_user_question` /
`exit_plan_mode` response schemas live in
`xai-grok-tools/src/implementations/grok_build/*/types.rs`. The stdin-regression and
process-tree-lock items remain as-is (historical).

### 2.9 Terminal commands: the shell is the client's, but the agent writes for another one
In ACP mode grok never runs shell commands itself — it hands each to the client over
`terminal/create`, so the host shell is the **client's** choice. Two problems follow on Windows
(observed 2026-07-13; issue #46, extension v1.5.13; `research/powershell-terminal.md`):

- **The agent writes bash-flavored commands even against a PowerShell host.** We run the agent's
  commands under PowerShell on Windows to match the standalone CLI — users expect their PowerShell
  profile functions and pipelines (`… | Format-List`) to work, which they can't under cmd.exe. But
  grok, in ACP mode, still emits POSIX-subshell idioms like `(cd dir ; cmd)` — invalid in
  PowerShell (`( )` is a grouping *expression*, not a statement list; it errors *"Missing closing
  ')'"*), even while using PowerShell cmdlets (`Get-ChildItem`, `$env:`) in the same batch.
  Standalone grok "just works" under PowerShell, so ACP-mode generation is *worse* than standalone.
  The agent self-recovers by retrying with `Set-Location dir; cmd`, but each miss is a wasted tool
  call + model turn — the exact retry cost #46 set out to remove. A client can't safely rewrite the
  agent's commands. **Ask:** tell the agent the client's shell (or let the client advertise it in
  `initialize`), or generate PowerShell-native syntax on a Windows host as the standalone CLI does.
- **The two agents use different command-execution models, and the client output surface differs.**
  grok-build **delegates** every shell command over `terminal/create` (the client runs it and
  captures stdout). The cursor agent (Composer 2.5) instead runs commands in its **own CLI-side
  persistent shell** — it never sends `terminal/create`; the result rides the completed
  `tool_call_update` (`rawOutput` = `{output, exit_code, command, truncated, current_dir, …}`,
  "Shell state persists for subsequent calls"). So a client that renders command output from the
  `terminal/*` capture gets nothing for Composer rows and must *also* read the completed update's
  `rawOutput`, matched by `toolCallId`. Two consequences worth flagging: (a) **Composer completes a
  batch OUT of issue order** (verified: 10 parallel read-only commands finished 1,2,7,6,10,8,5,3,9,4
  by call#), so any order-based correlation (FIFO) misattributes — `toolCallId` is the only safe key;
  (b) `#46`'s client-shell choice doesn't reach Composer at all, since its shell is CLI-side.
  **Ask:** converge the execution model (or document it), and surface command output the same way on
  both agents — ideally on the completed update's structured `rawOutput` for both, keyed by
  `toolCallId`.

**Source-verified (2026-07-16, OSS tree) — root cause, plus an existing escape hatch.** Every shell
signal the model sees derives from the **grok host process**, never the client:
`detect_windows_shell()` (`xai-grok-config/src/shell.rs:30-106`) feeds the `Shell:` line of the
first user message (`session/user_message.rs:33-81`), the bash tool description, the chain
separator, and the unix-utilities hints (`types/template_renderer.rs:53-163`). Execution, though,
hands the **raw** command to the client — `terminal/acp_terminal.rs:15-26` even comments *"On
Windows the ACP client spawns with its own shell; sending the raw command…"* — so detection and
execution can silently diverge, which is precisely this section's failure mode. Standalone never
diverges because it wraps commands in the same detected shell (`local_terminal.rs:57-63`). The two
execution models are one code path keyed on the client `terminal` capability
(`agent_ops.rs:2830-2847`, `:2943-2958` — `AcpTerminalRunner` vs the CLI-side `TerminalRunner`),
confirming the §1/§2.9 split. An undocumented override exists: **`GROK_SHELL`**
(`pwsh|powershell|cmd|bash`) is read first in the detection cascade (`shell.rs:10-11`, `:25-69`)
and realigns *all* the model-facing signals at once — a client can set it in the agent's spawn env
to match the shell it actually runs (we will). Reframed ask: document `GROK_SHELL`, and better,
consume a client-declared shell from `initialize` (nothing in `clientCapabilities` is read for this
today).

### 2.10 Edit diffs: the first diff can be wrong, and the `_meta` shape differs by delivery path
(observed 2026-07-15, grok **0.2.101**, native Windows; `research/edit-diff.md`,
`research/edit-diff-timing-probe.cjs`)

An edit's diff rides the `tool_call_update` as a `{type:"diff", path, oldText, newText}` content
block, independent of permission mode — an excellent design that lets a client build a review
surface with no permission coupling (see §4). Two fidelity problems sit on top of it:

- **Every edit reports its diff twice, and the two can disagree.** An optimistic **pre-write echo**
  (`kind:"edit"`, titled, no `status`) fires *before* `fs/write_text_file`, then the
  **authoritative completed update** (`status:"completed"`, no `title`/`kind`) fires *after* it.
  For a `search_replace` both carry byte-identical `oldText`/`newText`. For a whole-file **Write
  that overwrites an existing file** they differ: the echo sends `oldText: ""` (it hasn't read the
  old content yet) while the completed update sends the **real prior content**. The echo lands
  first, so a client that renders the first diff it sees shows an overwrite as **pure adds** and
  never corrects it. We shipped exactly that bug for three releases before this probe found it;
  the fix is to key idempotency on the diff *content* rather than on "already rendered".
- **A replace-all's diff block is token-sized — but that is not a defect; the full data is on the
  wire.** *(Open question from the first draft of this section, now SETTLED and WITHDRAWN as an
  ask — verified 2026-07-15, grok 0.2.101, `research/edit-diff-lines-probe.cjs`.)* A
  `search_replace` that changed **148 occurrences** emitted a `diff` block describing only the
  single replaced token, so a client rendering the block alone shows `+1 −1`. We suspected a CLI
  defect. It isn't: a `replace_all` over **12** `PLACEHOLDER` occurrences at known, non-consecutive
  lines produced `_meta.details.length === 12`, `old_line` `[3,5,7,9,11,13,15,17,19,21,23,25]` —
  an exact ground-truth match. The block-level `oldText`/`newText` is the *pattern*; `details[]` is
  the per-site truth. **This was our client-side gap, not your bug — no ask.**

- **`details[]` has `line_prefix` but no `line_suffix`, so a client can't reconstruct the changed
  line.** An entry carries exactly `{old_string, old_line, new_string, new_line, context_before,
  context_after, line_prefix}`. For a site whose real line is `item 1: the token is PLACEHOLDER here`,
  `line_prefix` gives `item 1: the token is ` — everything *before* the match — but the trailing
  ` here` is nowhere on the wire. `context_before`/`context_after` are post-edit windows over the
  *neighbouring* lines, so they never contain the site's own line (a neighbour's window sometimes
  does, but never for the last site). The result: a client can render the change and its leading
  context faithfully, but the rendered line is silently truncated at the match.
  **Ask:** add `line_suffix` (or send the site's full old/new line) — it's one field, and it's the
  difference between rendering a real line and a truncated one.

Related: the initial `tool_call` carries the edit args (`rawInput: {file_path, old_string,
new_string}`) but no diff, and lands only ~30ms before the echo — so there is no useful
"paint earlier from rawInput" shortcut, and taking it would reconstruct the same wrong
`oldText:""` for a Write.

**Credit where due — the line numbers *are* on the wire** (we missed this until 2026-07-15 and
rendered region-relative numbers starting at 1 as a result; our bug, not yours). The pre-write echo
carries them on the diff block:
```json
{"type":"diff","path":"…/alpha.txt","oldText":"WIDGET1","newText":"GADGET1",
 "_meta":{"old_line":2,"new_line":2}}
```
and the completed update carries them per-site on `_meta.details[]`, with surrounding context:
```json
{"old_string":"WIDGET2","old_line":2,"new_string":"GADGET2","new_line":2,
 "context_before":"line one of bravo.txt\n","context_after":"last line stays\n",
 "line_prefix":"the magic word is "}
```
`old_line`/`new_line` are real 1-based file lines, and for a multi-line region they're the region's
**first** line (verified: a 3-line block at lines 40–42 of a 60-line file reports `old_line: 40`).
This is everything a client needs to render a real gutter. Three notes:

- **The three delivery shapes carry different `_meta`, which is the actual friction.** The echo has
  block-level `old_line`/`new_line` but **no** `details[]`; the completed update and the
  **session/load replay** have `details[]` but **no** block-level `old_line`/`new_line`. So a
  client that reads the block `_meta` gets a number on the echo and loses it on both the completed
  repaint and every restored session. **Ask:** put the *same* `_meta` on all three — ideally
  block-level `old_line`/`new_line` **and** `details[]` everywhere — or document which shape owns
  what.
- **A whole-file Write's echo carries `_meta: {}`** — no line data at all — while its completed
  update carries `details[]` with `old_line:1`/`new_line:1`. Same inconsistency, sharper edge.
- **`old_line` is a post-edit coordinate, not a pre-edit one.** `details[]` is computed against the
  *final* file: in a replace-all whose replacement grows the line count (3 sites at pre-edit lines
  2/4/6, each token → 3 lines), every entry reported `old_line === new_line === [2,6,10]` — the
  post-edit lines, not the originals. `context_before`/`context_after` confirm it (site 1's
  `context_after` already shows site 2 replaced). It's self-consistent and fine for rendering, but
  the name `old_line` implies the pre-edit file. **Ask:** either make `old_line` the pre-edit line
  or document that both are post-edit.

**Ask:** send one authoritative diff, or mark the echo as provisional so a client can tell the two
apart.

**Source-verified (2026-07-16, OSS tree).** All three delivery shapes confirmed in code: the echo
computes block-level `{old_line,new_line}` from the *pre-edit* file (`tool_calls.rs:1558-1587`; the
whole-file Write arm emits `oldText:""` + `_meta:{}`, `:1774-1785`); the completed update builds
`_meta.details[]` (`acp_conversion.rs:218-233`); the replay re-emits the persisted completed shape
verbatim. The only signal distinguishing echo from authoritative is the echo's missing `status` —
no provisional marker exists. `old_line` is post-edit because sites are located in the rebuilt
`new_text` (`search_replace/helpers.rs:108-121` — `old_line == new_line` by construction; the
*echo's* block-level `old_line` is genuinely pre-edit, which is the `_meta` inconsistency in one
sentence). And the `line_suffix` ask turns out to be genuinely tiny: `build_edit_details`
(`helpers.rs:97-128`) computes `line_prefix` from `new_text`, and its call site
(`search_replace/mod.rs:717`) already has the full original content in scope — one threaded
parameter yields both full old/new lines.

### 2.11 Permission requests are environment-dependent, not configuration-dependent
(observed 2026-07-15 on grok 0.2.99–0.2.101; user report:
[grok-build-vscode#49](https://github.com/phuryn/grok-build-vscode/issues/49);
`research/edit-diff.md` § "The permission-card red herring")

**Whether `grok agent stdio` sends `session/request_permission` for an in-workspace edit varies by
machine, not by configuration.** On some Windows 11 hosts — including our primary dev box — it sends
**zero** permission requests for an in-workspace edit with `permission_mode = "ask"`, `yolo = false`,
`support_permission` either value, **and even a pristine default config** (probe reproduced with the
extension's exact `initialize` handshake). The *same extension build with the same settings* prompts
reliably on macOS and on a Windows 11 Azure VM for the same edit. It is unaffected by the client's
own Auto-accept state, and by every Grok setting we can find.

This reaches users as a trust problem, not a papercut. Verbatim from #49:

> *"Grok simply edits all my files without any confirmation. There is also no option for me to
> review what changed."*

A client cannot build an approval UX on a signal that may silently never arrive, and cannot explain
to the user why their machine disagrees with the documentation.

Our workaround **decouples review from permission entirely**: the `type:"diff"` block rides
`tool_call_update` regardless of permission mode (§2.10), so we render every edit's diff inline from
the wire and never depend on a card appearing. That solves *review* — it cannot restore *approval*.
If no request arrives, there is nothing for the user to approve, and no client-side code can
manufacture the choice.

**Ask:** make permission requests deterministic and configuration-driven across platforms, or
document exactly what governs them — and surface the effective state over ACP (§2.7). If some
host/build legitimately suppresses them, say so in `initialize` so a client can tell the user
instead of looking broken.

**Source-verified (2026-07-16, OSS tree) — ROOT CAUSE FOUND, and confirmed on our dev box.** The
by-machine variance is grok silently merging **Claude Code's settings** into its effective
permission policy. `resolve_permission_config_with_fallback`
(`xai-grok-workspace/src/permission/resolution.rs:493-498`) reads `~/.claude/settings.local.json`,
`~/.claude/settings.json`, and every project `.claude/settings*.json` up to the repo root
(`claude_settings.rs:374-430`). `permissions.defaultMode: "acceptEdits"` becomes a synthetic
**Allow Edit** rule (`resolution.rs:60-67`), `"bypassPermissions"` a catch-all Allow (`:52-59`),
and an edit-covering `permissions.allow` entry translates directly (`claude_settings.rs:50-72`; a
pattern-less rule matches every path, `policy.rs:227`). Any of these short-circuits the decision at
`manager.rs:1320-1336` **before the prompter**, so `session/request_permission` is never sent.

We then checked the dev box from this section's A/B — the machine that never prompts — and its
`~/.claude/settings.json` contains bare `"Edit"`, `"Write"`, and `"Bash"` entries in
`permissions.allow`, granted to *Claude Code* months earlier: allow rules a user gave one product
silently auto-approve another product's writes, with no indication anywhere. The macOS box and Azure
VM had no such file. **This is not the whole of #49, though — the symptom has multiple invisible
sources.** The `.claude` merge explains *our dev box*; the #49 reporter's own case was different —
they had auto-approval persisted for one workspace in grok's per-project
`~/.grok/sessions/<cwd>/permission.toml` (`manager.rs:935`), and a fresh folder prompted normally.
The honest framing: **several invisible policy sources produce the same "no approval card" symptom**
— the `.claude` fallback, per-project `permission.toml` grants, the `[claude_compat].imported`
cutoff that disables the whole `.claude` fallback (`claude_settings.rs:512-554`), and managed
`requirements.toml`/`managed-settings.json` layers — none surfaced over ACP. (`defaultMode:
"dontAsk"` produces the opposite failure — auto-deny, `manager.rs:1476-1484`.)

This resolves the mystery but sharpens the ask: **the merge is invisible.** Nothing over ACP — or
in grok's own output — tells a client or a user that a `.claude` file from another product is
auto-approving edits. Reframed ask: report the effective permission policy *and its source file*
over ACP (§2.7), and surface the `.claude` import visibly (the TUI's explicit Ctrl+I import is the
right consent model; the silent always-on fallback is not). A client can re-read the same files to
display an honest state — ours will — but a sidebar should not need to re-implement the CLI's
config resolution to explain the CLI's behavior.

---

### 2.12 `session/fork`'s `targetPromptIndex` truncates the model's history but not the replay

**Build:** 0.2.101. **Method:** `_x.ai/session/fork` (unadvertised).

**Source-only correction (2026-07-29): implemented upstream; shipped status pending.** Published
source truncates `updates_to_copy` with `updates_truncate_for_prompt` at the same target used for
`chat_to_copy` (`xai-grok-shell/src/session/storage/jsonl/mod.rs:1063-1074`). That implementation
is present in the first public snapshot; the 2026-07-24 sync additionally filters dead rewind
branches before applying the cut, matching its commit note “Fix session fork truncating at the
wrong prompt in rewound sessions.” The 0.2.101 observation remains valid history, but the ask
should be marked **fixed in source, awaiting a live stable-build recheck**, rather than open
without qualification.

Forking at a point is exactly the primitive a "branch from this message" UI needs, and the field is
there: `ForkSessionRequest.target_prompt_index` (`session/fork.rs:30`) reaches
`CopySessionOptions` (`:99`). It **works** — forking a 14-message session at index 1 returns
`chatMessagesCopied: 7`. But it only truncates one of the two logs:

| | full fork | `targetPromptIndex: 1` |
|---|---|---|
| `chatMessagesCopied` | 14 | **7** |
| `updatesCopied` | 20 | **20** |

A disk diff confirms the split: in the truncated fork the 2nd prompt is **absent from
`chat_history.jsonl`** (what the model reads) but **still present in `updates.jsonl`** — which the
user guide calls "the authoritative conversation log that drives `/resume` and session restore".

**Consequence:** any client that forks at a point and then `session/load`s it renders the FULL
conversation while the model has silently forgotten everything after the cut. The user sees their
own messages on screen and the agent denies knowledge of them. There is no client-side signal that
the two logs disagree.

**Our workaround:** we ship whole-session forking only (gear → *Fork conversation*) and never send
`targetPromptIndex`, which is a real feature loss — per-message branching is the more useful shape.

**Ask:** truncate `updates.jsonl` at the same boundary (or return the effective cut point so a
client can trim its own replay). Note the TUI's `/fork` documents `--at <turn>` as "not supported in
this version" — so this may simply be an unfinished path that the ACP surface exposes early, rather
than a regression.

---

### 2.13 Rate-limit errors carry no reset time and no quota telemetry

**Build:** 0.2.101 (re-confirmed 0.2.103). **Source:** `xai-grok-shell/src/sampling/error.rs`,
`xai-grok-pager/src/app/dispatch/billing.rs`. **User reports:** [#57](https://github.com/phuryn/grok-build-vscode/issues/57) (limit misread as auth), [#64](https://github.com/phuryn/grok-build-vscode/issues/64) (asks for the TUI's `/usage` quota in the GUI — item 3 below).

An HTTP 429 maps to ACP error **`-32003` "Rate limited"** with the backend detail in `data` (a
bare string, or the `{message, promptUsage?}` object `attach_prompt_usage` produces —
`sampling/error.rs:18,82`). The documented contract is that clients suppress the detail and show
friendly copy — and that copy is deliberately vague: the free-usage message "promises no reset
duration — the quota window is backend-config-driven" (`billing.rs:113-115`), and the OAuth/plan
copy is "Upgrade your account or try again later."

**Consequence (the #57 report):** a user who hits the weekly limit gets no answer to the two
questions that actually matter — *when does it reset?* and *how close was I?* Worse, the wording
is billing-flavored ("subscription", "upgrade"), which reads as an account/auth problem; our own
broad expired-token classifier caught it and the recovery ended on the **login screen** (fixed in
extension v1.7.2 by classifying `-32003` before the auth heuristics). Even fixed, the best any
client can honestly render is "usage limit reached, try again later."

**What a client needs, in order of value:**

1. **A machine-readable reset timestamp** in the `-32003` `data`. A 429 normally carries
   `Retry-After` / rate-limit-reset headers at the HTTP layer, so the information likely exists
   upstream and is dropped when the response is flattened to a message string.
2. **Ongoing quota state — used/limit or a percentage — as a per-turn signal**, e.g. on the
   existing `_meta.usage` / `turn_completed.usage` rails or a `session_notification`. Today the
   first sign of the limit is the hard stop; with a usage figure a client can show "82% of your
   weekly limit" and warn *before* the wall, which is when the information is actually useful.
3. **The same quota state on request** — an RPC (a natural neighbor of the unadvertised
   `_x.ai/session/info` family) so a client can render it whenever it wants: a status bar, the
   context popover, or at session start before any turn has run. A push-only signal leaves the
   figure unknowable until a turn happens to complete.

**Ask:** announce dates and limits — a reset timestamp in the rate-limit error, and quota
used/limit (or %) both as a turn-level signal and queryable on demand, rather than a post-mortem.

**Source re-verification (2026-07-29, `5da6962`): the quota ask still stands.** The new
`_x.ai/session/usage` RPC returns a cumulative `PromptUsage` ledger for the current process,
including folded subagent spend and model-level token/cost totals
(`xai-grok-shell/src/extensions/usage.rs`). It explicitly resets when a session is resumed in a
new agent process, and it contains no account used/limit or reset window. Separately,
`SamplingError::Api` can carry `retry_after_secs`, but the 429 arm destructures it away and emits
only `-32003` plus the message (`sampling/error.rs:119-142`; the source test at `:510-519` proves
the value existed before mapping). So this is useful session accounting, not the quota RPC in
item 3, and the reset-time loss is now source-pinned rather than hypothetical.

**Live re-verification (2026-07-29, 0.2.112): `_x.ai/session/usage` ships, and the per-process reset
is real.** Measured, not inferred — `totalTokens: 31673 / numTurns: 2 / costUsdTicks: 178580000`
after two turns, then **all zeros** on the very next call following a `session/load` in a fresh
agent process (`research/acp-surface-audit-probe.cjs --scenario=usageresume`). It is a genuinely
useful per-run ledger and the only source of `costUsdTicks`, but it is not the queryable quota of
item 3 and cannot be shown as a session total. Full detail and the naming ask in **§2.16**. Items
1–3 of this section all remain open.

### 2.14 Entitlement errors are prose-only, and a cached OAuth session silently shadows `XAI_API_KEY`

**Build:** 0.2.101. **Source:** `xai-grok-shell/src/sampling/error.rs:54-85`,
`xai-grok-shell/src/session/acp_session_impl/session_setup.rs:13-33`. **User report:**
[#58](https://github.com/phuryn/grok-build-vscode/issues/58).

The CLI's error mapping is deliberate and mostly right: 401 → `-32000` auth_required (rewritten
to one of two fixed "run `grok login`" strings), 429 → `-32003`, and 403 → **plain
`internal_error` (-32603)** — correctly *not* auth, because the credential was accepted. But that
last bucket mixes entitlement ("The model 'grok-build' requires a Grok subscription."),
content-policy blocks, and genuine server faults, distinguishable only by prose. A client that
wants "missing subscription" to render as something other than a generic failure has to regex the
message — which is how our extension originally mis-routed it to the **sign-in screen** (#58: an
unfixable loop, since the user's sign-in was fine). Fixed in v1.7.3 by trusting `-32000` as the
only overlay-worthy signal and text-classifying the 403 family into an in-chat notice — but the
text contract is unversioned and could change under us silently.

Compounding it: when both a cached OAuth session and `XAI_API_KEY` exist, **auth prefers the
cached session** (`sampling/error.rs:29-34`), so a user whose OAuth account lacks the entitlement
cannot escape by supplying a valid key — their key is silently ignored. The only wire-visible
trace is a hint string appended to one 403 variant ("Your cached OAuth session is being used
instead… run `grok logout`"). The active auth method is otherwise unknowable to an ACP client.

**Ask:** a structured discriminator on 403-family errors (e.g. `data.code:
"subscription:entitlement-required"`, mirroring the existing `subscription:free-usage-exhausted`
well-known code), and the active auth method (oauth vs api-key) surfaced somewhere queryable —
`initialize`'s response or the `_x.ai/session/info` family — so a client can warn about the
shadowing instead of parsing a hint out of an error message.

**Source-verified partial fix (2026-07-29, `5da6962`).** `initialize._meta` now includes
`defaultAuthMethodId`, explicitly so clients consume the agent's resolved precedence instead of
re-deriving it (`xai-grok-shell/src/agent/mvp_agent/acp_agent.rs:515-527`). That satisfies the
queryable-auth-method half once confirmed in a shipped build. The 403 arm still emits
`internal_error` with prose and no structured entitlement discriminator
(`sampling/error.rs:119-137`), so the first half remains open.

**Live confirmation (2026-07-29, 0.2.112).** `initialize._meta.defaultAuthMethodId` is present and
populated (`"cached_token"` on this box, alongside an `authMethods` list describing it as *"Cached
token from ~/.grok/auth.json"*) — so the auth-method half of this ask **is answered on the shipped
build**, and a client can now warn about the OAuth-shadows-`XAI_API_KEY` trap instead of parsing a
hint out of an error string. Related: `_x.ai/settings/update` carries `subscription_tier_display`
(`"X Premium+"`), `allow_access`, and `gate_message`/`gate_url`/`gate_label` (§2.16) — entitlement
*state* now rides a rail even though entitlement *errors* remain prose-only. The structured 403
discriminator is still the open half, and it is the half that matters for #58.

### 2.15 Rewind: inverted-sounding semantics, and `reverted_files` over-reports

`_x.ai/rewind/points` + `_x.ai/rewind/execute` are unadvertised and undocumented, and the
extension now builds two user-facing actions on them (Rewind, and Edit-a-sent-message). Three
findings, all measured on **0.2.111** — probes are checked in
(`research/rewind-semantics-probe.cjs`, `research/rewind-newfile-probe.cjs`).

**Source-only correction (2026-07-29): the created-file report is fixed by different behavior.**
Latest source treats a missing before-snapshot as “delete the file,” calls `delete_file`, and only
then appends the path to `reverted_files`
(`xai-grok-shell/src/session/acp_session_impl/rewind.rs:236-266`). Thus its response is truthful:
the created file is actually removed. That behavior is also present in the first public snapshot,
so 0.2.111 demonstrably lagged published source. Keep the measured bug in the history, but mark
item 3 **fixed in source, awaiting a 0.2.112/0.2.114 live recheck**. The documentation/advertising
asks and discard-inclusive semantics remain unchanged.

**1. `execute` discards the target, inclusive.** Rewinding to prompt N removes N *and*
everything after it:

| target | points before → after | target survived? |
|---|---|---|
| `#1` of `0..3` | 4 → 1 | no |
| `#3` (the tip) | 4 → 3 | no |

The method name reads like "rewind **to** N, keeping N". It doesn't. This is the dangerous kind
of ambiguity because **getting it wrong does not error** — it silently truncates one turn too far
and, under `mode:"all"`, reverts that extra turn's file changes. We shipped it backwards for a
day. A one-line doc note, or a name like `discardFrom`, would have prevented it.

**2. The tip is a legal target.** We had previously recorded
`Cannot rewind to prompt #N — current prompt index is N`; on a settled session, targeting the
newest point succeeds and discards exactly that turn. That's what makes "edit my last message"
implementable. Worth stating explicitly, since the error text implies otherwise.

**3. `reverted_files` includes files that were never reverted.** A turn that *creates* a file
reports it in `reverted_files`, but the file is left on disk:

```jsonc
// grok created created.txt and edited existing.txt, then rewind mode:"all"
{ "reverted_files": ["existing.txt", "created.txt"] }
// on disk afterwards: existing.txt restored to its old content;
//                     created.txt STILL PRESENT
```

That is defensible *behavior* — a content-snapshot system has no previous content to write back
for a new file, and deleting user files is a bigger hammer than restoring them. But the **report
is wrong**, and a client that says "restored 2 files" is then lying on the CLI's behalf. Either
omit created files from `reverted_files`, or split the array (`restored` vs `created_left_in_place`)
so a client can tell the user the truth.

**Ask:** document the discard-inclusive semantics and the tip's validity; fix or split
`reverted_files`; and — since these RPCs are unadvertised — consider advertising them, as clients
otherwise have to feature-gate on `-32601` and guess at the contract.

**Live re-verification (2026-07-29, 0.2.112): item 3 still reproduces on the shipped build.** A turn
that created `created.txt` and edited `existing.txt`, rewound with `mode:"all"`, returned
`reverted_files: ["existing.txt","created.txt"]` — and `created.txt` was **still on disk**
afterwards. Published source now deletes the created file before reporting it (so its response is
truthful), but that has not reached stable: this is a *source-only* fix. Items 1 and 2
(discard-inclusive semantics, tip is a legal target) also re-confirmed unchanged.

---

### 2.16 The wire has outgrown its documentation

(measured 2026-07-29 on **0.2.112**; probe: `research/acp-surface-audit-probe.cjs`)

Every other section here starts from a behavior we noticed and asks whether it is right. This one
starts from the opposite question — *what ships that no client has been told about?* — and the
answer turned out to be large enough to change what several earlier asks should say.

**Six unadvertised RPCs are already routed on the shipped build.** Existence was established by
error code (`-32601` = absent; `-32602` = routed, parameter shape wrong), with a known-present
control (`_x.ai/session/list`), a known-absent control, and a bare-prefix control (`x.ai/session/list`
→ `-32601`, confirming the decoder rule from §2.8):

| Method | Status on 0.2.112 | Why it matters |
|---|---|---|
| `_x.ai/session/usage` | returns data | Cumulative token **and cost** ledger — see below |
| `_x.ai/session/state` | `-32602` (routed) | Transcript-adjacent state for cross-host move |
| `_x.ai/session/import` | `-32602` (routed) | Recreates that state on another host |
| `_x.ai/session/updates` | `-32602` (routed) | The update log behind both |
| `_x.ai/compact_conversation` | returns `{}` | A compact that needs no slash at position 0 (§2.2) |
| `_x.ai/hooks/list` | `-32602` (routed) | Hooks, now also advertised in `initialize` |

**Five push rails exist that nothing announces.** Full payloads captured:

- **`_x.ai/sessions/changed`** — `{upserted:[{sessionId,title,cwd,isWorktree,modelId,reasoningEffort,yolo,activity:"working",resident,lastChangeUnixMs,origin}],removed:[]}`. This is, essentially, §2.6's headline ask already implemented and pushed. It is strictly better than the paginated list we asked for, because it is incremental.
- **`_x.ai/queue/changed`** — `{sessionId, entries:[{id,version,kind:"prompt",text,position}]}`. The CLI now owns a prompt queue; the settings rail's own tip says *"Use Ctrl+Enter to interject messages. Or just Enter to queue messages."*
- **`_x.ai/settings/update`** — carries `permission_mode`, `auto_permission_mode_enabled`, `subscription_tier_display` (`"X Premium+"` on this account), `allow_access`, and `gate_message`/`gate_url`/`gate_label`.
- **`_x.ai/models/update`** and **`_x.ai/session/prompt_complete`** — model-catalog and turn-settlement rails paralleling data already available elsewhere.

**`initialize` now advertises more than it used to**, which is genuinely the right direction:
`agentCapabilities._meta` carries `x.ai/hooks` (`blockingEvents: [pre_tool_use, stop,
subagent_stop]`, `decisions: [deny, block]`) and `x.ai/fs_notify`; `initialize._meta` carries
`defaultAuthMethodId`, a full `modelState` (so the model catalog is known *before* `session/new`),
`availableCommands`, and the feature flags `cancelRewind` / `sessionRecap` / `voiceMode`.

**What this changes in the asks above:**

- **§2.7 / §2.14 are partly self-served now.** `permission_mode` and `auto_permission_mode_enabled`
  ride `settings/update`, and `defaultAuthMethodId` rides `initialize._meta`. Caveat: both
  permission fields were `null` in our capture on a default config, so the *encoding* is unknown —
  a client can't tell "not set" from "not reported". **Ask:** document the null semantics and
  include the policy's **source file**, which is what §2.11 showed is the actually-load-bearing part.
- **§2.3's workaround is retirable, but the defect stands.** Every `session/update` envelope carries
  a live, truthful `_meta.totalTokens` (observed climbing 5487 → 15781 → 16015 *within* one turn,
  and matching `/session-info`'s prose exactly). So the fragile prose-regex has a clean replacement.
  The reported defect is unchanged: the prompt **result**'s `_meta.totalTokens` is still `0` on
  no-inference slash turns.
- **§2.13 is NOT closed.** `_x.ai/session/usage` returns a real cumulative ledger including
  `costUsdTicks` — the first dollar figure anywhere on the wire. But it is scoped to the **agent
  process, not the session**: measured `totalTokens: 31673, numTurns: 2` before resume, and
  **`0` immediately after `session/load` in a fresh process**. So it cannot back a session-lifetime
  total, and it still carries no account quota, limit, or reset window. **Ask:** either make it
  session-scoped (rehydrating from the persisted log on load) or name it for what it is
  (`process/usage`), because a cumulative-looking counter that silently resets is worse for a client
  than no counter — the number keeps looking authoritative while under-reporting.

**Ask, overall:** this is a lot of good, shipped capability that no client can discover without
guessing method names. Advertise it — an `initialize` capability set naming the extension methods
and rails that are safe to use would let clients adopt them deliberately instead of by probe, and
would let you deprecate one without breaking the clients that reverse-engineered it. Several of
these directly implement asks we filed months ago; we simply had no way to know.

---

## 3. What the extension silently hides from users today

A quick inventory of everything we suppress to keep the chat sane — each is a place the
protocol shows users something it shouldn't:

- `/context` and `/always-approve` (removed from autocomplete and dispatch)
- `totalTokens: 0` reports (stripped before the UI)
- The hidden primer turn and its "ok" ack — plus its replayed copy on every restore
- The hidden post-`/compact` `/session-info` turn (our own workaround, invisible by design)
- Grok's post-verdict "I'll wait for your verdict…" filler (cancelled + suppressed)
- Marker-only `[Plan approved/rejected/cancelled]` protocol messages on replay
- `<system-reminder>` turns replayed as user messages
- The subagent result envelope (`<subagent_meta>`, `<subagent_result>`, lead-ins, Agent ID hint)
- The background-spawn "started" ack pretending to be a result
- Subagent child sessions in the history list (`session_kind:"subagent"`)
- Empty primer-only sessions on disk (swept) and primer-derived session titles (renamed)

**Most of this list is primer-downstream and is now on its way out** (2026-07-29). With the native
`{outcome:"cancelled"}` verdict contract live-verified (§2.1), the hidden primer, its "ok" ack, its
replayed copy, the marker-only `[Plan approved/rejected/cancelled]` turns, the primer-derived title
repair and the empty-primer sweep all lose their reason to exist. The hidden `/session-info` turn
goes too, replaced by the envelope `_meta.totalTokens` (§2.3/§2.16). What is left afterwards is the
genuinely upstream-owned set: `<system-reminder>` replay, the subagent result envelope, the
background-spawn "started" ack, `session_kind:"subagent"` rows, `totalTokens: 0`, and the two
advertised-but-broken slash commands.

---

## 4. What works well (credit where due)

- **Streaming** `agent_message_chunk`/`agent_thought_chunk` — clean, separable reasoning.
- **`fs/*` + `terminal/*` delegation** — being mandatory made them a reliable client-side
  enforcement point (it's what makes our plan gate possible at all).
- **`session/request_permission`** — clear option kinds; `kind:"edit"` maps neatly to a diff preview.
- **`session/load` replay through the same update stream as live** — most features restored
  with zero extra code.
- **`_meta` turn accounting** and per-model `totalContextTokens` — rich and useful (modulo the zero).
- **`_meta["x.ai/tool"]`** — an authoritative, title-independent tool identity. This is the
  *right* design; it single-handedly fixed subagent misclassification. Put it on everything.
- **`session/cancel`** as an id-less notification that settles the turn `cancelled` and leaves
  the session usable — exactly what a Stop button needs.
- **Concurrent sessions** — multiple `stdio` processes on one workspace with no cross-talk.
- **Vision** actually works; **`ask_user_question`** is a good structured surface once its
  response shape is known; **`spawn_subagent` (0.2.93)** is well-structured on grok-build.
- **The plan-mode verdict contract** (`{outcome:"approved"|"cancelled"|"abandoned"}`) is a genuinely
  good design — `cancelled` keeps plan mode up *and* tells the model to revise, which is exactly the
  three-way choice a UI needs, with no client-side protocol invention. Verified live on 0.2.112
  (§2.1). Our only complaint is that we had to read the source to discover it.
- **`_x.ai/sessions/changed`** (§2.16) is better than the paginated `session/list` we asked for in
  §2.6: it is incremental, carries `activity`/`yolo`/`reasoningEffort`/`isWorktree` per row, and
  makes a client's session catalog push-driven instead of a disk poll. Same for
  `initialize._meta.modelState`, which means the model catalog no longer requires a session.
- **`costUsdTicks`** on `_meta.usage` is the first actual money figure on the wire, and it is the
  one number users ask us for that we have never been able to show. (Scope caveat in §2.16.)

---

## 5. Grok 4.5 verification (grok 0.2.93, 2026-07-11)

Every grok-build-family fact above was re-verified against **Grok 4.5** — the current default
model of that family. **Grok Build (`grok-build`) still ships for some accounts/builds**, so the
Grok Build observations in §1–§4 stand; the differences below are per-model *within the same
`grok-build-plan` agent*, not a replacement. The full live suite (`npm run test:live` —
**12 passed · 0 skipped · 0 failed**) plus targeted probes ran against the real binary on native
Windows; Composer 2.5 was independently re-verified in the same run (`subagent-composer`).

**Model surface (`session/new` → `availableModels`):**
- `currentModelId: "grok-4.5"`, name **"Grok 4.5"**, `_meta.agentType: "grok-build-plan"`.
- `_meta.totalContextTokens: 500000` — **500K, where Grok Build reports 512K** (per-model, same
  agent). Corroborated by `/session-info` prose (`Context: N / 500000 tokens`).
- `_meta.supportsReasoningEffort: true` with `reasoningEfforts` [high (default) / medium / low]
  now advertised **in the model list itself** — previously reasoning effort was visible only as
  a process-start flag (§2.7). ~~It is still not settable per-turn over ACP; changing it still
  restarts the process.~~ **Superseded 2026-07-16:** `session/set_model._meta.reasoningEffort`
  changes and persists it per session; see §2.7.
- Only two models advertised: `grok-4.5` and `grok-composer-2.5-fast` (Composer 2.5).
  **Superseded 2026-07-29 (0.2.112):** only `grok-4.5` is advertised now; Composer is no longer
  reachable on this account/build (see §1).

**`session/set_model` is clean on Grok 4.5.** `set_model("grok-4.5")` returns
`{"_meta":{"model":{"Ok":"grok-4.5"}}}` — the requested id verbatim, resolvable in
`availableModels`. The **versioned-id defect (§1, §2.6) still applies to Grok Build**
(`grok-build` → `grok-build-0.1`) but does **not** reproduce on Grok 4.5 — so `resolveModelId`
stays necessary for the Grok Build model.

**Delegation (`spawn_subagent`) confirmed on Grok 4.5.** A real delegation emitted genuine
`spawn_subagent` calls with kebab-case `subagent_type` values (`explore`, `general-purpose`),
the completion arriving as a **same-id `tool_call_update`, `status:"completed"`** — exactly the
§1 grok-build shape. The `get_command_or_subagent_output` poller was correctly **not** carded.
~~The `subagent_spawned`/`subagent_finished` lifecycle events are still not transmitted over
ACP (`finished=0` observed while `updates.jsonl` filled).~~ **Superseded 2026-07-16:** they do
transmit live on `_x.ai/session_notification`; the earlier probe watched the persisted
`_x.ai/session/update` rail. See §2.4.

**The rest of §1–§4 reproduces on Grok 4.5:**
- Tool-call ids are `call-<uuid>-<n>`; `_meta["x.ai/tool"]` carries
  `{name, kind, namespace:"grok_build", label, read_only}` — the authoritative, title-independent
  tool identity praised in §4.
- Cross-agent switch after the first turn errors `MODEL_SWITCH_INCOMPATIBLE_AGENT`
  (`activeAgentType:"grok-build-plan"` → `requiredAgentType:"cursor"`,
  `suggestion:"start_new_session"`) — the agent is locked at spawn (§2.6).
- `promptCapabilities.image:false` while inline `{type:"image"}` blocks work — the model
  correctly named a solid red PNG (§2.5).
- Plan mode: `exit_plan_mode` still can't be rejected; the client-side write/terminal gate
  contained a rejected plan (0 workspace mutations) and released an approved one (§2.1).
  — **Superseded 2026-07-15: fixed in 0.2.101, a rejection is now honored. See §2.1.**
- Live prompts echo back as `user_message_chunk` (§2.6); `session/cancel` (Stop), two concurrent
  sessions on one workspace, session restore, and structured edit-diff restore all behave as
  documented.

**Live suite (all against Grok 4.5 except the last):** handshake, capabilities, prompt-roundtrip,
cancel-mid-turn, parallel-sessions, vision-prompt, session-restore, edit-diff-restore, plan-mode,
image-gen, subagent, subagent-composer — **12/12 green.** Grok-free floor: **808/808.**
