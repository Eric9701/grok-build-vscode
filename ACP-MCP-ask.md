# Asks: MCP connectors and embedded (ACP) clients

**For:** the Grok Build CLI team
**From:** the maintainer of *Grok Build for VS Code (Community)* — an ACP client
built on `grok agent stdio`
**Originally measured against:** `grok 1.0.0 (3cd0d0cbce)` on Windows 11
**Re-measured 2026-08-18 against:** `grok 1.0.5 (5115b46bc9)`, same machine, same
account, the same Canva connector still active

> **Ask 1 is substantially resolved — thank you.** Managed connectors now reach
> ACP sessions and are callable there. What remains is much narrower and is
> written up below: every discovery signal a client can read still reports that
> there are no MCP tools, while the tools work. Ask 2 has **not** been re-tested
> on 1.0.5 and is left as originally written.

---

# Ask 1 — RESOLVED for capability, open for discovery

## What changed

On 1.0.0 a connector activated at `grok.com/connectors` was visible to the TUI
and invisible to every embedded client. On 1.0.5 an ACP session can **use** it.

Measured on a plain `grok agent stdio` session, `session/new {cwd, mcpServers: []}`
— no client-supplied servers, nothing in `~/.grok/config.toml` for Canva:

```
tool_call        use_tool  rawInput={"tool_name":"canva__search-designs", …}
tool_call_update status="completed"
                 rawOutput={"type":"MCP","tool_name":"canva__search-designs",
                            "server_name":"Canva","output":{"OkayOutput":"{\"items\":[…"}}
```

It returned real designs and folders from the account, and each call raised a
normal `session/request_permission`. There is also now an undocumented RPC that
reports the truth:

```
_x.ai/mcp/list → {"servers":[{"name":"managed_gateway:canva","displayName":"Canva",
                              "source":"managed","type":"managedGateway",
                              "session":{"enabled":true,"status":"ready","tools":[ … ]}}]}
```

That is the capability the original ask was for, and it works.

## What is still wrong — every discovery signal denies it

The account has **three managed gateways, all `status: "ready"`, carrying 42 tools
between them**:

| `_x.ai/mcp/list` says | source | status | tools |
|---|---|---|---|
| Canva | managed | ready | 32 |
| Automations | managed | ready | 9 |
| Voice | managed | ready | 1 |
| linear | local (stdio) | initializing | — |

In the same session, at the same moment, while those Canva calls were succeeding
and those 42 tools were reachable:

| Signal a client can read | Reports |
|---|---|
| `_x.ai/mcp/list` | ✅ Canva, `source: managed`, `status: ready`, full tool list |
| **actually calling a Canva tool** | ✅ works |
| `_x.ai/mcp/servers_updated` | ❌ local (config-file) servers only |
| `_x.ai/mcp_initialized` | ❌ `mcpToolCount: 0` |
| `initialize._meta.mcpApps` | ❌ `false` |
| `grok mcp list` | ❌ absent |
| `grok mcp doctor --json` | ❌ absent — **this changed since 1.0.0**, where it reported the connector healthy with a tool count |
| `grok inspect` | ❌ absent |

So a client that does the reasonable thing — read the advertised rails, see
`mcpToolCount: 0` and an empty `servers_updated`, and conclude there are no MCP
tools — is wrong, and has no way to know it. The one surface that tells the
truth, `_x.ai/mcp/list`, is advertised nowhere.

`initialize._meta.mcpApps: false` is the most actively misleading of these: it
reads exactly like the capability flag a client should gate on, and it is false
while the capability works.

## The ask, restated

1. Report managed connectors on `_x.ai/mcp/servers_updated` and count their tools
   in `_x.ai/mcp_initialized`, so the rails match reality.
2. Document `_x.ai/mcp/list`, or fold its contents into the rails above.
3. Make `initialize._meta.mcpApps` mean something a client can gate on — or
   remove it. A false flag beside a working capability is worse than no flag.
4. Decide what `grok mcp list` / `doctor` / `inspect` should show, and make the
   three agree. On 1.0.0 `doctor` showed managed connectors and the other two did
   not; on 1.0.5 none of them do, while an ACP session can use them.

## Reproduction

1. Activate any connector at `grok.com/connectors`.
2. Drive an ACP session: `grok agent stdio`, `initialize`,
   `session/new {cwd, mcpServers: []}`.
3. Call `_x.ai/mcp/list` → the managed connector is there, `status: ready`.
4. Observe `_x.ai/mcp/servers_updated` (local only) and `_x.ai/mcp_initialized`
   (`mcpToolCount: 0`) on the same session.
5. Prompt the model to use one of that connector's tools → it succeeds.

## Consistency note, same area

`grok mcp doctor` no longer lists managed connectors. On 1.0.0 it did, and the
inconsistency ran the other way. Whichever behaviour is intended, `list`,
`doctor` and `inspect` should agree with each other and with what a session can
actually call.

---

# Ask 2 — a non-interactive entry point for MCP OAuth

Independent of the above, and smaller.

Grok implements the full MCP OAuth flow for **self-configured** HTTP servers —
browser-based authorization plus dynamic client registration, per
`~/.grok/docs/user-guide/07-mcp-servers.md`:

> "Grok handles HTTP/SSE and OAuth directly … **It also registers Grok's own
> OAuth client with the provider.**"

> "When an MCP server requests OAuth credentials, Grok opens a browser-based
> authorization flow and stores the resulting tokens for future use."

Credentials land in `~/.grok/mcp_credentials.json`, so authorization is a
one-time, machine-wide act that every later session inherits — exactly the
property that makes it worth exposing.

**But the only trigger is the TUI's `/mcps` modal, key `i`.** `grok mcp` offers
`list · add · remove · enable · disable · doctor`; there is no auth verb.

Any of these would close it, in our order of preference:

1. **`grok mcp auth <name>`** — same flow, exits non-zero on failure. Smallest
   change, no protocol impact, works for every non-TUI client and for scripts.
2. **An ACP method**, e.g. `_x.ai/mcp/authenticate { name }`.
3. **Auto-trigger on demand** when a server answers `AuthorizationRequired`,
   gated behind a client capability so headless callers can opt out.

Option 1 alone would be enough.

## Detection already works — only initiation is missing

An ACP session reports the condition precisely:

```json
{"jsonrpc":"2.0","method":"_x.ai/mcp/server_status","params":{
  "name":"…","status":"unavailable","reason":"handshake_failed",
  "detail":"… error: Auth error: OAuth authorization required, when send initialize request"}}
```

with, on stderr:

```
ERROR worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)
```

## Why we cannot work around it

We tried to drive the TUI programmatically so the user would not have to leave
the IDE. On Windows, **grok's TUI does not accept synthetic keyboard input**:

| Method | Result |
|---|---|
| `child_process.spawn` with piped stdin | TUI renders, keystrokes ignored |
| Real ConPTY (`node-pty` 1.1.0) via `cmd /c grok` | ignored |
| Real ConPTY spawning `grok.exe` directly | ignored |
| ConPTY with `useConpty: true`, preceded by a focus-in (`CSI I`) | ignored |

Output streams back correctly in every case; input never reaches the composer.
Since VS Code's own terminal is built on the same `node-pty`/ConPTY path, we
expect `Terminal.sendText` to behave identically. The best we can offer a user
today is "open a terminal and press `i` yourself".

## Two smaller improvements, worth having regardless

**1. Classify "needs authorization" as its own state.** It currently arrives as
`reason: "handshake_failed"` with a `detail` containing a raw Rust type
signature (`rmcp::transport::worker::WorkerTransport<…>`). A machine-readable
`reason: "auth_required"` on `_x.ai/mcp/server_status`, and a distinct check in
`grok mcp doctor --json`, would let clients render "Needs authorization" without
substring-matching an internal type name.

**2. Give `doctor` a useful hint here.** It returns `hint: "check server logs"`,
which describes neither the situation nor the fix.

---

# What we are not asking for

- No change to where credentials are stored, or to their format.
- No change to the OAuth flow itself — it works.
- No protocol version bump. Ask 1 is additive data on an existing frame; Ask 2's
  option 1 is a CLI addition, and options 2 and 3 sit behind a capability.

---

# Appendix — related observations

Both appear to be working as intended, and are recorded only because they were
surprising and may be worth documenting:

- **`mcpServers: []` in `session/new` does not suppress file-discovered
  servers.** Servers from `config.toml`, `.mcp.json` and the compat sources are
  still connected. Verified with a purpose-built stdio MCP server:
  `_x.ai/mcp_initialized {mcpToolCount: 1}` and
  `_x.ai/mcp/server_status {status: "ready"}` both arrive. This is the behaviour
  we want, but the ACP examples in the docs pass `[]` without noting that file
  discovery still applies.
- **The `_x.ai/mcp/*` notifications are useful and undocumented.**
  `servers_updated`, `init_progress`, `mcp_initialized` and `server_status`
  together are enough to build a live connector UI with no polling and no
  shelling out. Documenting them as a supported surface would let clients depend
  on them deliberately rather than by discovery.
