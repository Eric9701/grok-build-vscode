# Claude Code as an ACP provider

Measured against `@agentclientprotocol/claude-agent-acp` 0.69.0
(2026-08-16). The adapter handshake reports `agentInfo.version` `0.49.0` —
a stale constant. Display the user's `claude --version` and the pinned
package version, never that handshake field.

## Runtime

The adapter is compiled ESM, not a single bundle like `codex-acp`.

- Resolve the entry through `require.resolve("…/package.json")` and the
  manifest `bin`. `require.resolve("@agentclientprotocol/claude-agent-acp")`
  throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- Spawn with `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (Node 20 works
  today; `engines` says `>=22` and is advisory).
- It imports `@anthropic-ai/claude-agent-sdk`, `@agentclientprotocol/sdk`,
  and `zod`. Those JS packages must ship in the vsix. The optional native
  `@anthropic-ai/claude-agent-sdk-*` packages (~300MB) must not.
- Set `CLAUDE_CODE_EXECUTABLE` to the user's official `claude` CLI. Without
  it the adapter looks for those optional natives.
- That path must be a native executable. The SDK spawn is `shell: false`;
  modern Node rejects a Windows `.cmd` with `EINVAL`. `locateClaudeCli`
  prefers `claude.exe` and `resolveClaudeSpawnTarget` follows an npm
  `claude.cmd` shim to the package `bin/claude.exe`.

It does **not** need us to install Claude. Find `claude` on PATH (or
`grok.claudeCliPath` / well-known user-bin paths) and spawn.

## Auth

`initialize` advertises `authMethods: []` unless the client opts into
`auth.terminal` / `_meta["terminal-auth"]`. We do not advertise those, so
ACP-level Claude.ai / Console login methods never appear.

The adapter *can* offer `claude-ai-login` (`auth login --claudeai`) if a
client asks. We never do. Login is the user's own `claude auth login`
(no `--claudeai` flag from us). We do not implement, proxy, hold, or
forward a Claude credential. Anthropic's CLI may use the user's Claude
subscription or an Anthropic Console account depending on how they sign
in — we do not restrict which account type it offers.

`--hide-claude-auth` is a **deliberate omission**. The flag would reject
subscription accounts at `session/new` that already work in official
Claude Code. We never handle the credential either way.

Logged-out turns fail with `authRequired` / `Please run /login`. That is
`isClaudeCredentialError`. Quota and rate-limit text is not.

## Sessions

`session/list` is first-class. The request takes `{ cwd }` (unlike Codex,
which lists globally and we filter). The 0.69.0 response is one page of
`{ sessionId, cwd, title, updatedAt }` with no cursor. We still paginate
defensively. Do not scrape `~/.claude`.

`session/delete`, `session/load`, and `session/resume` are advertised.

`session/new` returns `configOptions` + `modes`, not a `models` envelope.
The backend synthesizes the host picker from the `model` / `effort` options.

## Plan gate

Claude has a native `plan` permission mode described as "no actual tool
execution", plus `bypassPermissions` for Auto accept. The client plan gate
exists because grok's Plan still lets shell through. It is not applied here
(`usesClientPlanGate: false`).

Plan review is `ExitPlanMode` over `session/request_permission` with
`kind: "switch_mode"` and title `"Ready to code?"`. The plan string is
`toolUse.input.plan`, forwarded as `rawInput.plan` and as a `content`
text block. The host lifts that with `planTextFromPermissionToolCall`
and the webview shows grok's plan-review card plus Claude's mode options
(`default` / `acceptEdits` / `auto` / `bypassPermissions` / keep planning).

## Context usage

`usage_update.used` is the **current assistant call's** billed total
(`input + output + cache_read + cache_write`). Prompt
`usage.totalTokens` is **not** that number: the adapter accumulates
every model call in the turn into `session.accumulatedUsage` and that
SUM is what `PromptResponse.usage` carries.

Measured on Claude Code 2.1.233 / adapter 0.69.0
(`research/adapter-usage-probe.cjs claude multi`): a Read+Write+Read
turn emitted 13 `usage_update`s, `used` staying in a 36172→37475 band
(never dropping; each later call is slightly larger). The prompt result
was `{ inputTokens: 12, outputTokens: 1136, cachedReadTokens: 219067,
cachedWriteTokens: 1965, totalTokens: 222180 }` —
`adapterContextOccupancy` 221044, about six times the largest call.
That is the sum of six prompts, not the conversation.

Occupancy is therefore `occupancyFromAdapterTurn`: the largest
`usage_update.used` in the turn, preferring the result's partition
occupancy only when it does not exceed that max (Codex / a one-call
Claude turn, where the result excludes output). The host persists that
figure per session (`SessionMetaOverride.contextUsed`) and keeps it
monotonic between compactions. Ordinary `usage_update.used` is not
occupancy by itself (it includes that call's output); the adapter sends
real occupancy via `getContextUsage` only on compact (`compact_boundary`),
and the host adopts that `usage_update.used` after `adapterCompactSignal`
reports completed. A later summed PromptResponse must not overwrite
that adoption. `size` is the window and must ride
`contextUsage.window` — Claude's live id is often `opus[1m]`, which does
not match the picker model list, so stamping
`availableModels[].totalContextTokens` alone never updates the webview.
