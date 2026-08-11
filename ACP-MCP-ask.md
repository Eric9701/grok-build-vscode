# Ask: a non-interactive entry point for MCP OAuth

**For:** the Grok Build CLI team
**From:** the maintainer of *Grok Build for VS Code (Community)* — an ACP client
built on `grok agent stdio`
**Measured against:** `grok 1.0.0 (3cd0d0cbce)` on Windows 11

---

## The ask, in one sentence

Grok already implements the full MCP OAuth flow, but the **only way to start it
is a keystroke in the TUI**, so no ACP client can offer users a way to connect an
OAuth-based MCP server.

Any one of these would close it, in our order of preference:

1. **A CLI verb — `grok mcp auth <name>`.** Runs the same browser flow the
   `/mcps` modal runs on `i`, exits non-zero if authorization fails. Smallest
   change, no protocol impact, works for every non-TUI client and for scripts.
2. **An ACP method** — e.g. `_x.ai/mcp/authenticate { name }` — so a client can
   trigger it in-session and react to the result.
3. **Auto-trigger on demand** — when a session connects a server that answers
   `AuthorizationRequired`, start the flow. Best gated behind a client
   capability, since a headless client has nowhere to show a browser.

Option 1 alone would be enough for us.

---

## Why it is needed

The capability is already built. From `~/.grok/docs/user-guide/07-mcp-servers.md`:

> "Grok handles HTTP/SSE and OAuth directly, so the native form avoids an extra
> subprocess per session. **It also registers Grok's own OAuth client with the
> provider.**"

> "When an MCP server requests OAuth credentials, Grok opens a browser-based
> authorization flow and stores the resulting tokens for future use."

Tokens land in `~/.grok/mcp_credentials.json`, so authorization is a **one-time,
machine-wide** act — every project and every session inherits it, including ACP
sessions. That is exactly the property that makes this worth exposing: one
trigger, and the problem is solved everywhere, permanently.

But the trigger is TUI-only. The same document:

> "Authenticate an OAuth server with `i`" — in the `/mcps` modal.

And `grok mcp --help` offers `list · add · remove · enable · disable · doctor`.
There is no auth verb.

**Consequence for an IDE integration:** a user adds Linear or Sentry, the server
is discovered correctly, and it is then permanently unavailable inside the
editor. Nothing in the IDE can fix it, and nothing in the IDE can even explain it
without us hard-coding a string match on an error message.

---

## Detection is not the problem — initiation is

An ACP session already reports the condition precisely. Connecting
`https://mcp.linear.app/mcp` with no stored credentials, we receive:

```json
{"jsonrpc":"2.0","method":"_x.ai/mcp/server_status","params":{
  "name":"zzlinear","source":"local","status":"unavailable",
  "reason":"handshake_failed",
  "detail":"MCP server 'zzlinear' handshake failed: … error: Auth error: OAuth authorization required, when send initialize request"}}
```

with, on stderr:

```
ERROR worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)
```

So the CLI knows. It simply has no door a non-TUI client can open.

---

## Reproduction

```bash
grok mcp add -s user demo https://mcp.linear.app/mcp --transport http
grok mcp doctor demo --json     # handshake failed, no browser opens
# then drive an ACP session:
#   grok agent stdio  ->  initialize  ->  session/new {cwd, mcpServers: []}
# observe _x.ai/mcp/server_status above; no browser opens
grok mcp remove demo
```

For contrast, `/mcps` + `i` in the TUI performs the flow correctly.

---

## Why we cannot work around it

We tried to drive the TUI programmatically so the user would not have to leave
the IDE. On Windows, **grok's TUI does not accept synthetic keyboard input**:

| Method | Result |
|---|---|
| `child_process.spawn` with piped stdin | TUI renders, keystrokes ignored |
| Real ConPTY (`node-pty` 1.1.0), via `cmd /c grok` | ignored |
| Real ConPTY, spawning `grok.exe` directly | ignored |
| ConPTY with `useConpty: true`, preceded by a focus-in (`CSI I`) | ignored |

Output streams back correctly in every case — we receive the fully rendered
screen. Input never reaches the composer. Since VS Code's own terminal is built
on the same `node-pty`/ConPTY path, we expect `Terminal.sendText` to behave
identically.

The result is that the best experience we can offer today is: open a terminal,
and ask the user to type `/mcps` and press `i` themselves. That is a workable
fallback, but it is an odd thing to require of someone who has already clicked a
**Connect** button, and it is not something we can do at all on a surface with no
terminal.

---

## Two smaller improvements, worth having regardless

**1. Classify "needs authorization" as its own state.** Today it arrives as
`reason: "handshake_failed"` with a `detail` containing a raw Rust type
signature:

```
Send message error Transport [rmcp::transport::worker::WorkerTransport<rmcp::transport::streamable_http_client::StreamableHttpClientWorker<xai_grok_mcp::mcp_http_client::McpHttpClient<rmcp::transport::auth::AuthClient<reqwest::async_impl::client::Client>>>>] error: Auth error: OAuth authorization required, when send initialize request
```

A machine-readable code — `reason: "auth_required"` on `_x.ai/mcp/server_status`,
and a distinct check in `grok mcp doctor --json` — would let clients render
"Needs authorization" without substring-matching an internal type name that may
change at any release.

**2. Give `doctor` a useful hint for this case.** It currently returns
`hint: "check server logs"`, which does not describe the situation or the fix.
`"run <the auth command>"` would.

---

## What we are not asking for

- No change to where credentials are stored, or to their format.
- No change to the OAuth flow itself — it works.
- No protocol version bump: option 1 is a CLI addition, and options 2 and 3 are
  additive frames behind a capability.

---

## Appendix — related observations from the same investigation

Both are working-as-intended as far as we can tell, and are recorded only
because they were surprising and may be worth documenting:

- **`mcpServers: []` in `session/new` does not suppress file-discovered
  servers.** Servers from `config.toml`, `.mcp.json` and the compat sources are
  still connected. Verified with a purpose-built stdio MCP server:
  `_x.ai/mcp_initialized {mcpToolCount: 1}` and
  `_x.ai/mcp/server_status {status: "ready"}` both arrive. This is the behaviour
  we want, but the ACP examples in the docs pass `[]` without noting that file
  discovery still applies.
- **The `_x.ai/mcp/*` notifications are genuinely useful and undocumented.**
  `servers_updated`, `init_progress`, `mcp_initialized` and `server_status`
  together are enough to build a live connector UI with no polling and no
  shelling out. Documenting them as a supported surface would let clients depend
  on them deliberately rather than by discovery.
