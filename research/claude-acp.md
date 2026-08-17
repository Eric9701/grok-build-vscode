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
