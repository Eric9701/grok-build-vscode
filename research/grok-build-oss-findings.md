# Grok Build CLI open-source drop — what our ACP feedback can now become

**Basis:** https://github.com/xai-org/grok-build cloned to `C:\github\grok-build-CLI` (2026-07-16).
Single squashed commit ("Publish harness and TUI open-source"), synced periodically from xAI's
monorepo; crate versions are lockstep dev placeholders (`0.1.220-alpha.4` / `0.2.0-dev`), so the
tree can't be pinned to a shipped 0.2.x — but it contains the `exit_plan_mode` outcome semantics we
first observed on **0.2.101**, so it is at least that new. **External contributions are not
accepted** (CONTRIBUTING.md), so "implement" below means *client-side in grok-build-vscode*; the
source access additionally lets [docs/ACP-feedback.md](../docs/ACP-feedback.md) cite exact
file:line, which makes each ask trivially actionable for xAI.

**Every "implement now" item still needs a live probe against the shipped Windows stable build
before we build on it** — the OSS tree may be ahead of what `x.ai/cli/install.ps1` ships. Paths
below are relative to `C:\github\grok-build-CLI\crates\codegen\`.

---

## Probe results — shipped grok 0.2.101 stable (2026-07-16)

Run via `research/oss-surfaces-probe.cjs` against the installed binary. **The OSS tree is genuinely
ahead of shipped**, so the gate earned its keep — one surface we were about to adopt does not exist
yet on the real CLI.

> **Correction (2026-07-16, after Codex peer-review + re-probe):** the session-RPC row below was initially marked "not shipped" — that was a **probe bug**, not a CLI fact. ACP extension methods must be **`_`-prefixed on the wire** (`_x.ai/session/list`): the `agent-client-protocol` decoder routes a custom method to `ext_method` only when it carries the `_` prefix and rejects a bare `x.ai/...` with `-32601 method_not_found` **at decode**, before the router runs (source: `xai-grok-shell/src/agent/app.rs` comment). The first probe sent bare methods. Re-run with `_x.ai/...`: **the RPCs work on 0.2.101** — `rename` → `{success:true}`, `delete` → removed the session dir, `list`/`info` → OK. Verdict flipped to ✅ below.

| Surface | Shipped 0.2.101 | Verdict |
|---|---|---|
| §2.6 session RPCs (`_x.ai/session/{list,info,rename,delete,fork}`) | ✅ **shipped** (unadvertised) — `_`-prefixed on the wire; `rename`→`{success:true}`, `delete` removed the dir, `list` returns `{sessions[],nextCursor}` with `sessionKind` a **top-level** row field | ✅ **adoptable now** — can replace disk-scraping for rename/delete/list; probe the `list`/`info` response shapes fully before wiring |
| §2.7 reasoning effort via `set_model` `_meta.reasoningEffort` | ✅ OK, no error; `session/new` `models[]._meta` advertises `reasoningEffort:"high"`, `supportsReasoningEffort:true`, full `reasoningEfforts` list | ✅ **implement** — drop the process-restart on effort change |
| §2.3/2.4/2.5 live rail | ✅ present as **`_x.ai/session_notification`** (underscore) — carries `auto_compact_completed{tokens_after}`, `subagent_spawned`/`subagent_progress`/`subagent_finished{duration_ms,tokens_used,output,will_wake}`, `turn_completed`, `session_summary_generated`, `image_dropped{notes}` | ✅ **implement** — we already *receive* it (`acp.ts:655` → `xaiNotification`) but don't consume the kinds |
| §2.1 plan verdict via success `{outcome:"cancelled"}` | ✅ mode stays `[plan]`, model reads it as "revise" not a tool failure, turn ends `end_turn` | ✅ **implemented** — all three native outcomes now replace JSON-RPC-error rejection and synthetic markers |
| §2.6 `session/new` `_meta.rules` | ✅ injected rule reached the model (nonce echoed verbatim) | ℹ️ available for general standing rules; no plan primer is needed now that typed verdicts ship |
| §2.9 `GROK_SHELL` env at spawn | ✅ sets the model's first-message `Shell:` line (`powershell`/`bash`/`cmd.exe`; unset → host-detected `powershell`) | ✅ **implement** (small) |
| `_x.ai/interject` — mid-turn steering (#52) | ✅ **shipped + works** — `{sessionId,text}` → `{status:"queued"}`; the model changed course **mid-stream** and echoed the interjected token, turn still ended `end_turn` (**not** cancelled, no work lost) | ✅ **implement** — this is "Steer"; no cancel-and-resend needed |
| `_x.ai/session/fork` (#48) | ✅ **shipped + works** — copied 17/17 messages, model recalled the parent's codeword after `session/load`, **parent untouched** | ✅ **implement** — don't hand-roll a dir copy |
| `_meta.usage` / `turn_completed.usage` (#53) | ✅ **shipped** — full per-prompt billing split, incl. `modelUsage` per model. **No cache-creation field exists anywhere** | ⚠️ **partial** — it's per-prompt *billing*, not *context* composition; see § Token surfaces |

Pure client-side, needing no probe: **§2.5 media `rawOutput.path`** parsing and **§2.11 permissions
honesty** (note: issue #49 is **CLOSED** — the reporter had auto-approval enabled for one workspace
via grok's per-project `permission.toml`, another machine-local input; so this is a nice-to-have,
not an open ticket).

**Two live rails, both `_`-prefixed on the wire (corrected framing, Codex review).** It is NOT a
"`_x.ai` = persist / `x.ai` = live" prefix duality — ALL x.ai extension methods are `_`-prefixed on
the wire; the bare `x.ai/...` name is only the *internal logical* name the Rust router matches after
the decoder strips the `_`. The two rails differ by METHOD, not prefix:
- **`_x.ai/session_notification`** — the live lifecycle envelope (`updates.rs:701`): carries
  `auto_compact_completed`, `subagent_spawned/progress/finished`, `turn_completed`,
  `session_summary_generated`, `image_dropped`. **`acp.ts:654-661` already receives it** → emits
  `xaiNotification`.
- **`_x.ai/session/update`** — persisted ACP update records (`storage/mod.rs:92`), replayed on
  `session/load`. `acp.ts:670-682` routes it to `subagentLifecycle`.

**The §2.4 gap is downstream, not a wrong method.** The `subagent_*` kinds arrive on the
`session_notification` envelope → `xaiNotification`, but our subagent UI waits on `subagentLifecycle`
(fed by `session/update`), and the `xaiNotification` consumer (`sidebar.ts:1619`) forwards to the
webview without acting on `auto_compact_completed` / `subagent_*` / `image_dropped` (v1.6.1 consumes
only `auto_compact_completed`). Wiring exists; consumption beyond the compact donut doesn't.

### Already true on the shipped CLI today (grok 0.2.101) — ready to adopt, no xAI change needed

These are confirmed *available now*; the only work is wiring them into the extension. None waits on an upstream fix:

- **Reasoning effort is live-settable per session** — `session/set_model` accepts `_meta.reasoningEffort` (`"none"|"minimal"|"low"|"medium"|"high"|"xhigh"`) and applies it without a process restart; `session/new` already reports the current effort + full effort list in `models[]._meta`. (We still kill/restart the process on effort change — that restart is now removable.)
- **The live event rail is already flowing** — `_x.ai/session_notification` delivers `auto_compact_completed`, `subagent_spawned/progress/finished` (with `duration_ms`/`tokens_used`/`output`), `turn_completed` (per-turn billing usage), and `image_dropped` (the first four probe-observed; `image_dropped` source-confirmed). The extension already receives it; only the compact-donut kind is consumed so far (v1.6.1).
- **Session RPCs are shipped (unadvertised)** — `_x.ai/session/{list,info,rename,delete,fork}` work on 0.2.101 (`rename`→`{success:true}`, `delete` removed the dir). They can replace the disk-scraping catalog for rename/delete/list.
- **Plan verdicts have a real semantic reply** — replying to `x.ai/exit_plan_mode` with a success `{outcome:"cancelled"|"abandoned"|"approved"}` is honored (mode stays `[plan]` on cancel; the model treats it as "revise", not a tool failure). The extension now sends these native outcomes.
- **The model's shell dialect is steerable** — setting `GROK_SHELL` in the agent's spawn env (`pwsh`/`powershell`/`bash`/`cmd`) sets the model's `Shell:` hint directly.
- **System-prompt injection is sanctioned** — `session/new` `_meta.rules` reaches the model verbatim. The plan primer was retired rather than moved because native verdicts make it unnecessary.
- **Generated media carries a typed path** — the completed tool result includes `rawOutput` with a typed `path`, cleaner than parsing the JSON/prose text (and free of the Windows `\\?\` noise).

**Implementation status (originally recorded at v1.6.1; plan rows updated to current):**

*Done + tested (grok-free suite, 932):*
- ✅ **`auto_compact_completed` → context donut** (retires the hidden `/session-info` scrape; kept as a pre-rail fallback).
- ✅ **Subagent lifecycle from the live rail** — `isSubagentLifecycleUpdate` re-routes `subagent_spawned/finished` from `xaiNotification` to the webview's existing `subagentUpdate` cards (real `duration_ms` + output, incl. Composer).
- ✅ **Live reasoning-effort switch** — `set_model` `_meta.reasoningEffort`, gated on the model's advertised `supportsReasoningEffort`; restart fallback for old CLIs / unset.
- ✅ **`GROK_SHELL` at spawn** — `grokShellEnvValue` aligns the model's shell dialect with the shell we run.

*Status of items originally deferred:*
- ⏸ **Session RPCs adoption** (`_x.ai/session/{rename,delete,list}`) — confirmed shipped, but **unadvertised** (could change), the disk-scraping catalog is robust, rename would fight the `customName` override system, and delete-of-an-arbitrary-history-id is unprobed. Adopt when advertised/stable, or if disk-scraping becomes a real problem.
- ✅ **Native plan verdicts** — implemented with `approved` / `cancelled` / `abandoned`; Approve/Keep-planning comments use `_x.ai/interject` before the verdict response releases the original turn. The client-side terminal/write gate remains.
- ⏸ **Media `rawOutput.path` parsing** — needs a live `/imagine` wire capture to confirm the typed `rawOutput` shape; guessing would repeat the bare-`x.ai/` mistake. Text-parsing works meanwhile.
- ✅ **Primer write side retired** — no `_meta.rules` migration was needed. Legacy primer readers remain for resumed sessions already on disk.

Permissions honesty (§2.11) is optional (#49 is closed).

---

## The headline: three discoveries that change our architecture

### 1. §2.11 / issue #49 — machine-dependent permission prompts: ROOT CAUSE FOUND

grok silently merges **Claude Code's settings** into its permission policy. The resolver
(`xai-grok-workspace/src/permission/resolution.rs:493-498` → `find_claude_settings_paths`,
`claude_settings.rs:374-430`) reads, per host:

- `~/.claude/settings.local.json`, `~/.claude/settings.json` (global, per-user)
- every project `.claude/settings*.json` from cwd up to the repo root

`permissions.defaultMode: "acceptEdits"` becomes a synthetic **Allow Edit** rule
(`resolution.rs:60-67`); `"bypassPermissions"` becomes **Allow Any** (`:52-59`); an
edit-covering `permissions.allow` entry translates directly (`claude_settings.rs:50-72`). Any of
these makes the policy evaluation return Allow, which short-circuits **before the prompter**
(`manager.rs:1320-1336`) — so `session/request_permission` is never sent. The client's
`support_permission` capability is read and then **explicitly ignored** (`spawn.rs:217`).

So: a dev box that also runs Claude Code with `acceptEdits`/`bypassPermissions`/edit-allow in
`~/.claude/settings.json` gets zero edit prompts; a pristine VM prompts every time. Identical grok
config. Exactly the #49 symptom.

Other machine-dependent inputs on the same path:
- `~/.grok/config.toml` `[claude_compat].imported = true` (or env `_GROK_CLAUDE_MARKER_OVERRIDE=1`)
  **disables** the whole `.claude` fallback (`claude_settings.rs:512-554`) — a user-side remedy.
- `~/.grok/sessions/<encoded-cwd>/permission.toml` — persisted per-project grants (`manager.rs:935`).
- Managed layers: `requirements.toml`, `managed-settings.json` (`resolution.rs:194-210, 508-524`).
- `defaultMode: "dontAsk"` produces the *opposite* failure (auto-deny instead of prompt,
  `manager.rs:1476-1484`).

**Implement:** extend `src/grok-config.ts` to read the Claude-settings chain (+
`permission.toml`, `[claude_compat].imported`) and (a) show an honest mode label
("Auto accept — from ~/.claude/settings.json") like we already do for `[ui] permission_mode`,
(b) explain *why* no permission cards appear, with the remedy. Then answer #49 with the root
cause. Also check this dev box's `~/.claude/settings.json` — it is almost certainly the reason
our machine never prompts.

### 2. The `_x.ai/session_notification` live rail — downstream consumption is the gap

> **Superseded by the probe + Codex review — read the corrected framing under "Probe results" above.**
> This section was the pre-probe hypothesis and got two things wrong: (a) it framed the rails as a
> `_x.ai`-vs-`x.ai` PREFIX duality — in fact ALL x.ai extension methods are `_`-prefixed on the wire,
> and the two rails differ by METHOD (`session_notification` vs `session/update`); (b) it claimed we
> "never subscribed" to the live rail — `acp.ts:654-661` DOES receive `_x.ai/session_notification`.
> The real gap is downstream (we don't consume its kinds beyond the compact donut).

There are **two rails** for xAI session events, distinguished by method (both `_`-prefixed on wire):

- **`_x.ai/session_notification`** — the **live** lifecycle envelope. Emitters are unconditional (no
  capability/config gate): the session actor's `send_xai_notification`
  (`session/acp_session_impl/updates.rs:701-744`) and the subagent coordinator's
  `emit_subagent_notification` (`agent/subagent/mod.rs:2216-2242`). **`acp.ts:654-661` receives it**
  and emits `xaiNotification`.
- **`_x.ai/session/update`** — the **persist/replay** records written to `updates.jsonl`
  (`storage/mod.rs:92`), re-forwarded on `session/load` (`agent/mvp_agent/mod.rs:1307-1351`).
  `acp.ts:670-682` routes it to `subagentLifecycle`.

The §2.4 "zero lifecycle events" measurement (grok 0.2.93) counted the wrong signal — the subagent
UI reads `subagentLifecycle` (fed by `session/update`), but the lifecycle actually rides
`session_notification` → `xaiNotification`, which the UI ignores. Wiring exists; consumption doesn't.

Payloads on this one rail (`extensions/notification.rs`):
- `SubagentSpawned` (`:560-595` — model, persona, role, capability_mode) and `SubagentFinished`
  (`:629-657` — **duration_ms, tokens_used, output, will_wake**); `SubagentProgress` (live-only,
  not persisted, `subagent/mod.rs:2291-2293`).
- `AutoCompactStarted` / **`AutoCompactCompleted { tokens_before, tokens_after }`**
  (`:369-392`) — **also fired by a manual `/compact`** (`session/compaction.rs:629-639`).
- `TurnCompleted { usage }` (billing usage per turn, `session/turn_completion.rs:18-33`).
- `ImageDropped { notes }` (`acp_session_impl/turn.rs:189-196`) — the "silently dropped
  attachment" from §2.5, not silent after all.

**Implement:** the `acp.ts` handler for `_x.ai/session_notification` already exists (`:654-661`);
the work is *consuming* its kinds. This unlocks: the post-`/compact` token count (**done, v1.6.1** —
the compact donut now reads `auto_compact_completed.tokens_after`, with the hidden `/session-info`
scrape kept as a pre-rail fallback, not deleted), real subagent lifecycle UI (duration/tokens
without envelope parsing), and a dropped-image notice. **Probe-confirmed on 0.2.101** for
`auto_compact_completed` + `subagent_*`; `image_dropped` is source-confirmed only.

### 3. §2.6 — session list/search/rename/delete/fork RPCs exist, unadvertised — AND ship in 0.2.101

The `ext_method` router (`agent/mvp_agent/acp_agent.rs:3164-3508`) dispatches — unconditionally,
no feature gate, just never advertised in `initialize`. **Wire form is `_`-prefixed**
(`_x.ai/session/list`); the router matches the logical `x.ai/...` name after the decoder strips the
`_`. **Confirmed shipped + working on 0.2.101** (probe re-run with the underscore): `rename` →
`{success:true}`, `delete` removed the session dir.

- `_x.ai/session/list` + `_x.ai/sessions/list` (:3168), `_x.ai/session/search` (:3181 — the SQLite
  FTS index behind `grok sessions search`), `_x.ai/session/rename`, `_x.ai/session/delete`,
  `_x.ai/session/fork` (:3189, `extensions/session_admin.rs`), `_x.ai/session/info`,
  `_x.ai/session/close`, `_x.ai/session/load_history`, `_x.ai/session/updates`, `_x.ai/session/repair`.
- `list` returns **`{ sessions, nextCursor, _meta }`** (`unified_list/mod.rs:298` `ExtListResponse`),
  NOT `{ rows }`. **`sessionKind` is a TOP-LEVEL flattened row field** (`row.rs:123`), not in `_meta`
  — `_meta["x.ai/session"].kind` is only the coarse `"build"`/`"chat"` class and can't distinguish a
  subagent. Rename params: `{ sessionId, title, cwd? }`; delete: `{ sessionId, cwd? }`; info:
  `{ sessionId }`.

**Implement (staged):** probe the request/response schemas, then adopt **rename/delete** first
(kills the `grok.sessionMeta` rename-override store and our `deleteSessionDir`), then
**list/search** (replaces `indexSessions`/`readSessionEntries`/`sessionCache` disk scraping — §
History pagination). Keep the disk path as fallback for older builds.
The full router table (git, worktree, interject, rewind, task/scheduler, compact_conversation…)
is in the same match — see "Roadmap unlocks" below.

### 3a. `fork` + `interject` — probe-confirmed WORKING on 0.2.101 (2026-07-17)

Both were parked as "future"/unprobed. Both ship and work **today**; params came from the OSS
source, not guesswork (`--scenario=fork`, `--scenario=interject`).

**`_x.ai/session/fork`** — `ForkSessionRequest` (`session/fork.rs:15-38`, camelCase serde). Three
**required** fields; `{sessionId}` alone is the `-32602 Invalid params` you get if you guess:

```jsonc
// → {sourceSessionId, sourceCwd, newCwd, newSessionId?, newModelId?,
//    targetPromptIndex?, sessionKind?, sourceWorkspaceDir?}
// ← {newSessionId, chatMessagesCopied, updatesCopied, planStateCopied,
//    newCwd, parentSessionId, newModelId?}
{"newSessionId":"019f6fbd-07b7-…","chatMessagesCopied":17,"updatesCopied":25,
 "planStateCopied":false,"parentSessionId":"019f6fbc-c636-…"}
```

Measured: new UUIDv7 id, **17/17** messages copied, `session/load` on the fork OK, the model
**recalled the parent's codeword**, and the parent's history was **byte-unchanged** after forking +
using the fork. `sessionKind` defaults to `"fork"` — our `buildEntry` (`sessions.ts:139`) only
special-cases `"subagent"`, so a fork lands in the history list with no client change.

**Fork branches the CONVERSATION, not the code.** `fork_session` only calls
`copy_session_data_sync` under `grok_home()` (`fork.rs:64-113`) — it never touches the workspace.
The TUI pairs `/fork` with an optional **git worktree** to separate code; `/rewind` is the separate
feature that restores files (`rewind_points.jsonl` = file snapshots, one point per user prompt) and
"modifies files on disk" (user-guide 17-sessions.md). Don't conflate them.

**⚠️ `targetPromptIndex` works over ACP but leaves the replay DESYNCED — blocks per-message fork.**
The TUI user-guide says `--at <turn>` "is not supported in this version", but the ACP field is live:
forking a 14-message session at index 1 returned `chatMessagesCopied: 7`. **However
`updatesCopied` was 20 for BOTH the full and the truncated fork** — and a disk diff confirms the
split: in the at-1 fork the 2nd prompt is **absent from `chat_history.jsonl` (0 hits) but still
present in `updates.jsonl` (2 hits)**. `chat_history` is what the model sees; `updates.jsonl` is the
authoritative log that drives `session/load` replay — so a per-message fork renders the FULL
conversation in the panel while the model has forgotten everything after the cut. Whole-session
fork (no `targetPromptIndex`) is unaffected and safe. Per-message fork needs an upstream fix or
client-side replay truncation — **ACP-feedback material**.

**`_x.ai/interject`** — `InterjectRequest` (`extensions/interject.rs:13-24`, camelCase serde):

```jsonc
// → {sessionId, text, interjectionId?, content?}   ← content = [text|image] blocks
// ← {status:"queued"}
```

It queues into the session's pending-interjection buffer, **drained at the next safe point in
`process_conversation_turn`** — it does *not* cancel the turn. Measured mid-flight against a live
40-item count: accepted `{status:"queued"}`, the model **abandoned the count mid-stream** and
emitted the interjected token, the turn still ended `end_turn`, and the model confirmed it saw the
text verbatim. A `_x.ai/session/interjection` notification echoes back on the rail (for rendering).
`content` carries images, and its Text block overrides `text` when non-empty.

**Control, same probe:** a plain second `session/prompt` mid-turn returned `stop=end_turn` rather
than erroring — it does **not** cleanly queue, and repo lore (`test/send-queue.dom.test.ts:13-15`)
says it kills the in-flight turn. `interject` is the sanctioned channel; don't race prompts.

### 3b. Token surfaces — `_meta.usage` exists and we drop it (#53)

`session/prompt`'s `result._meta` carries a **nested `usage`** object we never extract
(`PromptResultMeta`, `acp-dispatch.ts:246-265`, stops at the flat siblings). The same object rides
`turn_completed.usage` on the live rail. Verbatim, 0.2.101:

```jsonc
"_meta": { "totalTokens":16371, "inputTokens":16328, "outputTokens":42,      // ← LAST model call
           "cachedReadTokens":16000, "reasoningTokens":15, "modelId":"grok-4.5",
  "usage": { "inputTokens":32330, "outputTokens":158, "totalTokens":32488,   // ← WHOLE prompt
             "cachedReadTokens":27264, "reasoningTokens":128,
             "modelCalls":2, "apiDurationMs":3770, "numTurns":2,
             "modelUsage": { "grok-4.5": { …same shape… } } } }
```

Three facts that decide the #53 UI:
- **`usage` aggregates the whole prompt; the flat siblings are the last model call only.** Turn 1
  above: flat `outputTokens:42` vs `usage.outputTokens:158` across `modelCalls:2`.
- **`totalTokens` (flat) is CONTEXT size; `usage.totalTokens` is BILLING sum.** Different
  quantities — 16371 vs 32488 in the same turn. Segmenting the donut arc by input/output would be
  arithmetically wrong; they don't decompose the context window.
- **No cache-*creation* field exists anywhere** (zero hits repo-wide and in the OSS tree). The
  issue's `cache_creation_input_tokens` is unavailable — omit it, don't fake a zero.

---

## The rest, by feedback section

### §2.1 Plan mode

- **The terminal hole is confirmed present at HEAD.** `plan_mode_edit_gate`
  (`xai-grok-shell/src/session/acp_session_impl/tool_calls.rs:166-181`) rejects only
  `AccessKind::Edit`; `Bash` falls to `_ => PlanEditGate::Allow` — its own doc-comment says bash
  is never gated there. Our client-side gate (`src/plan-gate.ts`) remains the only barrier; keep
  it. Upstream fix would be ~10 lines in that one function (the caller already maps any
  non-Allow verdict to a rejection message) — worth citing in ACP-feedback.md.
- **Semantic rejection exists — we've been using the wrong shape.** The client should reply to
  `x.ai/exit_plan_mode` with a JSON-RPC **success** carrying
  `{"outcome": "approved" | "cancelled" | "abandoned"}` (+ optional feedback)
  (`xai-grok-tools/src/implementations/grok_build/exit_plan_mode/types.rs:18-25`, mapped at
  `tool_calls.rs:193-203`; unknown → cancelled, fail-closed). `cancelled` = keep planning (the CLI
  itself tells the model "user wants to revise", `tool_calls.rs:1266-1287`); `abandoned` =
  deactivate plan mode. A JSON-RPC **error** — what older extension builds sent — is treated as *client
  disconnect* (`ext_method_no_client`, `tool_calls.rs:215-220`), not a verdict.
  **Implemented:** Keep planning maps to `outcome:"cancelled"`, Cancel to
  `"abandoned"`, and Approve to `"approved"`. Approve/Keep-planning comments are
  interjected before the response; the CLI handles the continuation itself, so the
  primer and `[Plan approved/rejected/cancelled]` protocol are retired.
- `planContent: null` conditions pinned: plan.md empty/whitespace, missing, or unreadable
  (`tool_calls.rs:106-113, 1204-1227`). Keep the plan.md fallback.
- `[ui] require_plan_approval` (config) forces plan approval even in yolo
  (`util/config/permissions.rs:254-270`).

### §2.2 Slash commands

- Position-0 rule confirmed and test-pinned (`session/slash_commands.rs:1052-1074`, tests
  `:1192-1200`): first text block, leading `/` after trim. No structured invoke exists — but
  **`x.ai/compact_conversation`** (router `:3438`) may be a position-proof structured compact;
  probe it. `x.ai/commands/list` (listing only) also exists.
- `/context` over stdio is literally `ok_end_turn(0, None)` — streams nothing
  (`slash_exec.rs:82`). Keep hiding it.
- **Correction to our doc:** over ACP, `/always-approve` does **not** write `config.toml` — it
  flips an in-memory per-process yolo atomic (`slash_exec.rs:18-52` →
  `permission/manager.rs:456-477`). The config write is a TUI-side effect
  (`permission/prompter.rs:40-44`). Re-probe #31: it may now be a clean per-session server-side
  Auto-accept toggle we could use instead of (or alongside) client-side auto-approval.

### §2.3 Context accounting

- `usage_update`: **does not exist anywhere** (zero hits). `_meta.totalTokens = 0` on
  `/compact`/`/session-info` is a hardcoded `ok_end_turn(0, None)` (`slash_exec.rs:16, 371` →
  `session/commands.rs:63-72`); sibling fields are the *previous* inference turn's usage
  (`acp_agent.rs:2326-2329`).
- `signals.json` recompute timing confirmed: `update_context_usage` is called only from the
  next turn's pre-sampling auto-compact check (`session/compaction.rs:1779-1781`), persisted at
  that turn's end (`turn.rs:1643-1647`). Our probe-derived model was exactly right.
- The true post-compact size **is** in memory at compact end and ships in
  `AutoCompactCompleted.tokens_after` (`compaction.rs:629-639`) → replace the `/session-info`
  scrape via discovery #2. The scrape's format string is confirmed at `slash_exec.rs:354-369`
  (`"**Context:** {} / {} tokens ({:.0}%)"`) — our regex is in sync as the fallback.
- `session/load` response carries no token info (`acp_agent.rs:1857-1937`); `readContextUsage`
  from `signals.json` stays for cold restore. `x.ai/session/info` (ext method) is worth probing
  as a structured alternative.

### §2.4 Subagents

- Lifecycle transmission: the events DO ship live on `_x.ai/session_notification` (which our client
  already receives); the gap is that our subagent UI reads them off the persist/replay rail
  (`subagentLifecycle`) instead of the live envelope — see § Probe results and discovery #2. Not a
  missing feature, and not a wrong subscription — a wrong *downstream consumer*.
- Background-spawn "completed" ack confirmed structural: the `run_in_background` branch returns
  `Ok(ToolOutput::Text("Subagent started in background…"))` synchronously
  (`xai-grok-tools/src/implementations/grok_build/task/mod.rs:328-368`; ack text in the shared
  `crates/common/xai-tool-types/src/task.rs`). Keep our skip; `SubagentFinished`/auto-wake carries
  the real result.
- The envelope we strip is current: `<subagent_meta>` + `<subagent_result>` — the in-tree per-poll
  construction is `task_output/mod.rs:581` (the shared helper lives in
  `crates/common/xai-tool-types/src/task.rs`, a different crate prefix than the `crates/codegen/`
  default used elsewhere here); the "This is the output of the subagent:"/"Agent ID:" wrap survives
  only as a legacy *parser* (`reminders/task_completion.rs:522-544`) — `cleanSubagentOutput`'s
  all-patterns-optional design is right.
- `_meta["x.ai/tool"]` stamping points: `stamp_tool_meta` (`tool_calls.rs:260-274`) on ToolCall
  stub/refined/permission-update/bash-dispatch; unresolved wire names (uninitialized MCP,
  backend-hosted tools) legitimately lack it (`normalization.rs:27-41`) — keep title-independent
  fallbacks.

### §2.5 Capabilities and media

- `promptCapabilities.image: false` is a hardcoded omission — the builder only sets
  `.embedded_context(true)` (`acp_agent.rs:394-413`); image blocks are accepted and used
  (`session/prompt_parser.rs:119`). No config flips it. Keep behavior-over-advertisement + the
  `capabilities` live-drift test.
- Too-small drops: floors are **8×8 px** and **512 total px**
  (`session/image_normalize.rs:51-55, 429-439`); the model gets an `<image_dropped_notice>`, the
  client gets `ImageDropped` (discovery #2). **Implement:** client-side pre-validation (reject
  <8×8 / <512 px at attach time, like the 20MiB cap) + surface the notification.
- Generated media: the reporter is platform-agnostic JSON-in-text **plus a typed `rawOutput`**
  (`session/acp_conversion.rs:536-548`; `xai-grok-tools/src/types/output.rs:108-123` —
  `{path, filename, session_folder, message}`). The Windows "prose" was the JSON's `message`
  field + un-normalized `\\?\` paths (the media writer never dunce-strips, `storage.rs:101`,
  unlike read_file/search_replace). **Implement:** make `extractGeneratedMediaPaths` prefer
  `rawOutput.path`, keep text parsing as fallback. No ACP image/resource_link path exists at HEAD.
- Pasted-image asset paths are deliberately surfaced to the model in an `<image_files>` block
  (`session/image_describe.rs:329-341`) — keep our do-not-Read hint.

### §2.6 Sessions and models (beyond discovery #3)

- Versioned `set_model` echo root cause: the echo returns the catalog **entry's `.model`** while
  `availableModels` ids are the catalog **keys** (`handlers/model_switch.rs:231-235`,
  `acp_session_impl/model_switch.rs:13`, `agent/config.rs:4788-4795`; `resolve_catalog_key`
  accepts either, `agent/models.rs:1616-1629`). For `grok-build` key ≠ model (`grok-build-0.1`
  comes from the remote catalog); for `grok-4.5` they coincide. `resolveModelId` stays.
- Agent lock: `MODEL_SWITCH_INCOMPATIBLE_AGENT` fires only when `turn_count > 0`
  (`model_switch.rs:65-88`); at zero turns the harness is **rebuilt in place** (`:89-113`) —
  which is why a pre-first-turn `set_model` works.
- Replay filters only blank/rewind/ACU lines (`session/storage/mod.rs:1106-1196`) —
  `<system-reminder>` and protocol-marker replay is structural; keep client-side filters.
  Resolved `request_permission`s are never persisted (request/response RPC, not a session
  update) — keep our re-injection. `_meta.noReplay` on `session/load` skips replay entirely
  (`mod.rs:355`).
- Title generation locks onto the **first non-empty text** of message #1, no synthetic-turn skip
  (`session/summary.rs:58-97`) — historical primer-title pollution was structural and is fixed
  for new sessions by no longer sending a primer. Legacy title repair remains.

### §2.7 Session configuration

- **Reasoning effort is settable per-session over ACP** — no process restart:
  `session/set_model` reads `_meta.reasoningEffort` (`"minimal"|"low"|"medium"|"high"|"xhigh"`…)
  via `parse_reasoning_effort_meta` (`xai-grok-sampling-types/src/types.rs:852, 865-874`),
  applies + persists it per-session and broadcasts `ModelChanged`
  (`handlers/model_switch.rs:24, 117-134, 206-215`). It is also *reported*: models[]
  `_meta.reasoningEffort`/`supportsReasoningEffort` in `session/new`/`session/load`
  (`agent_ops.rs:2258-2274`) and `x.ai/sessionConfig.options`. **Implement:** `setEffort` via
  live `set_model` (same-model + effort meta), keep the restart path as fallback for old builds.
- Permission mode: still invisible over ACP (only telemetry + a remote-settings default on the
  `x.ai/settings/update` notification), no setter — the §2.7 ask stands, now with the #49
  root-cause framing (discovery #1 is the *real* fix for the trust problem).

### §2.9 Terminal shell dialect

- Root cause: everything the model is told about the shell derives from the **grok host
  process** (`detect_windows_shell()`, `xai-grok-config/src/shell.rs:30-106`) — the
  `Shell:` line in the first user message (`session/user_message.rs:33-81`), the bash tool
  description, chain separator, and unix-utility hints (`template_renderer.rs:53-163`) — while
  ACP execution hands the **raw** command to the *client's* shell with no wrapping
  (`terminal/acp_terminal.rs:15-26`, comment acknowledges it). Standalone wraps in the detected
  host shell (`local_terminal.rs:57-63`), so detection == execution there. No initialize field
  carries a client shell, and nothing consumes one from `clientCapabilities.meta`.
- **Implement:** set **`GROK_SHELL`** in the env when spawning `grok agent stdio` on Windows,
  matched to what `terminal-manager` resolved (`pwsh` | `powershell` | `cmd`; the override is
  read first in the cascade, `shell.rs:10-11, 25-69`, cached per process). That realigns *all*
  model-facing shell signals with the shell we actually run. Optionally reinforce with a
  `_meta.rules` line ("host shell is PowerShell; never `(cd x; y)`; chain with `;`").
- Execution-model split confirmed as one code path keyed on the client `terminal` capability:
  `client_terminal ? AcpTerminalRunner : TerminalRunner` (`agent_ops.rs:2830-2847, 2943-2958`) —
  the cursor/Composer CLI-side persistent shell is `TerminalRunner`.

### §2.10 Edit diffs

- The three delivery shapes and their `_meta` split confirmed exactly as documented: pre-write
  echo computes block-level `{old_line,new_line}` from the **pre-edit** file
  (`tool_calls.rs:1558-1587`; whole-file Write echo → `oldText:""`, `_meta:{}`,
  `:1774-1785`); the completed update carries `details[]`
  (`acp_conversion.rs:218-233`); session/load replays the persisted completed shape verbatim.
  Our `_diffSig` content-keyed idempotency is the right client fix; the echo is distinguishable
  only by its missing `status`.
- `details[].old_line` is post-edit because sites are located in the **rebuilt** `new_text`
  (`search_replace/helpers.rs:108-121` — `old_line == new_line` by construction).
- `line_suffix`: the struct simply lacks the field (`types/output.rs:314-335`); at the call
  site (`search_replace/mod.rs:717`) the full original content is in scope, so the upstream fix
  is one threaded parameter — cite it. Nothing more we can do client-side.

### §2.8 Transport (historical)

Now moot as "documentation asks": the source *is* the documentation. The `x.ai/`-vs-`_x.ai/`
prefix mystery is resolved (persist rail vs live rail, discovery #2); the
`ask_user_question`/`exit_plan_mode` response schemas are readable in
`xai-grok-tools/src/implementations/grok_build/*/types.rs`.

---

## Roadmap unlocks (beyond the feedback doc)

From the full `ext_method` router (`acp_agent.rs:3164-3508`) and docs
(`crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md`):

- **`_meta.rules` on `session/new`** → appended to the system prompt as `<human_rules>`
  (`agent/mvp_agent/mod.rs:1036-1058`); `_meta.systemPromptOverride` replaces it and is re-synced
  on resume (`:1024-1082`, `acp_agent.rs:1643`); `_meta.agentProfile` selects a profile.
  This remains available for general standing instructions. The plan-mode primer was instead
  retired outright once native verdicts were adopted; its legacy readers stay for old sessions.
- `x.ai/git/worktree/{create,remove,apply,list,gc}` + `x.ai/session/fork` — the "Worktree UI"
  roadmap item has a full server-side API. **`session/fork` is probe-confirmed working** — § 3a.
- `x.ai/interject` — mid-turn interjection (the TUI's Ctrl+L) over ACP. **Probe-confirmed
  working** — the "Steer" primitive for #52; § 3a.
- `x.ai/rewind/*` (+ `rewind_points.jsonl`), `x.ai/prompt_history`, `x.ai/suggest`,
  `x.ai/compact_conversation`, `x.ai/session_summaries/*`, `x.ai/task/*`, `x.ai/scheduler/*`.
- `GROK_AGENT_METADATA` env merges arbitrary keys into `initialize._meta` (`acp_agent.rs:417`).
- `grok sessions list/search` CLI subcommands (SQLite FTS) as a non-ACP fallback.

---

## Recommended order — see "Probe results" at the top (authoritative)

> This section originally held a *pre-probe* order that assumed live probing was still pending. The
> probe (`research/oss-surfaces-probe.cjs`) has since been **built and run against shipped 0.2.101**,
> so the authoritative, probe-confirmed order lives in the **"Revised implementation order"** under
> § Probe results at the top of this doc. Superseded points here: session RPCs are **shipped**
> (not deferred), the `_x.ai/session_notification` handler **already exists** (consume its kinds),
> and #49 is **closed** (permissions honesty is optional, not the #1 priority).

The probe harness that produced the § Probe results verdicts is `research/oss-surfaces-probe.cjs`
(scenarios: `sessionrpc`, `effort`, `notify`, `planoutcome`, `rules`, `shell`). It is a **diagnostic**,
not a pass/fail gate — every scenario exits 0 with no assertions; treat its output as evidence to
read, and promote the load-bearing checks into `scripts/live-tests.cjs` when they need to gate a
release (e.g. the `auto_compact_completed` donut canary).
