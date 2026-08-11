# Asks: MCP connectors and embedded (ACP) clients

**For:** the Grok Build CLI team
**From:** the maintainer of *Grok Build for VS Code (Community)* — an ACP client
built on `grok agent stdio`
**Measured against:** `grok 1.0.0 (3cd0d0cbce)` on Windows 11

Two requests, both about MCP. The first is the one that changes what users can
do; the second is smaller and independent.

---

# Ask 1 — managed connectors never reach ACP or headless sessions

**A connector activated on grok.com works in the TUI and is invisible to every
embedded client**, in the same directory, on the same account, at the same
moment.

## What we observed

Connecting **Canva** at `grok.com/connectors` (one click, OAuth handled entirely
on your side) produced this split:

| Client | Sees the connector? |
|---|---|
| **TUI** (`grok`, `/mcps`) | ✅ *"Managed by grok.com (3)"* — Automations, Canva, Voice, each `[ready] (managed)`. Canva expands to **32 tools**, and a prompt successfully ran `(Canva) List-folder-items`. |
| **Headless** (`grok -p`) | ❌ replies `NO_CANVA_TOOLS` |
| **ACP** (`grok agent stdio`) | ❌ `_x.ai/mcp/servers_updated → {"mcpServers":[]}`, `_x.ai/mcp_initialized → {"mcpToolCount":0}` |
| `grok mcp doctor --json` | ✅ healthy — see below |
| `grok mcp list` | ❌ *"No MCP servers configured"* |
| `grok inspect` | ❌ lists only the project-scoped server from `.mcp.json` |

The headless and ACP runs were executed **after** the TUI session, in the **same
working directory** the TUI used, so neither ordering nor `cwd` explains it.

`doctor` reports the connector as fully working:

```json
{
  "sources": [ … { "path": "grok.com", "status": { "status": "found", "server_count": 1 } } ],
  "servers": [{
    "name": "grok_com_canva",
    "transport": "http",
    "target": "https://mcp.canva.com/mcp",
    "source": "managed",
    "checks": [
      { "label": "server started",  "passed": true, "detail": "0.0s" },
      { "label": "handshake OK",    "passed": true, "detail": "protocol 2025-06-18" },
      { "label": "33 tools discovered", "passed": true }
    ],
    "healthy": true
  }]
}
```

And `grok mcp enable grok_com_canva` answers **"already enabled"**.

So the connector is enabled, reachable, handshakes successfully and exposes its
tools — to a diagnostic and to the TUI. An embedded client gets nothing, with no
error and no signal that anything is missing.

## Ruled out

- **Stale state.** No leader process was running (`grok leader list` → *"No
  leader candidates found"*), and every test used a fresh process with a new
  `session/new`.
- **A local cache.** There is no file under `~/.grok` holding the account's
  connector list — `doctor` fetches it live at probe time.
- **Working directory.** Reproduced from the same `cwd` as the working TUI
  session.
- **Discovery framing.** `search_tool` *is* available in headless mode and
  returns nothing; and in the TUI the connector's tools are called **directly**
  (`(Canva) List-folder-items`), not via `search_tool`/`use_tool` — so this is
  not a lazy-discovery artifact.

## Reproduction

1. Activate any connector at `grok.com/connectors`.
2. `grok mcp doctor --json` → the `grok.com` source reports 1 server, healthy,
   with a tool count.
3. `grok` → `/mcps` → the connector is listed `[ready] (managed)` and its tools
   are callable.
4. In the **same directory**: `grok -p "List my <connector> items. If you have
   no <connector> tools available at all, reply exactly NONE."` → `NONE`.
5. In the **same directory**, drive an ACP session — `grok agent stdio`,
   `initialize`, `session/new {cwd, mcpServers: []}` → `_x.ai/mcp/servers_updated`
   carries an empty list and `_x.ai/mcp_initialized` reports `mcpToolCount: 0`.

## The ask

**Deliver managed connectors to `grok agent stdio` and `grok -p` the same way
the TUI receives them.** The capability plainly exists — the TUI has the code
path, `doctor` fetches and validates the same list — it just isn't in the shared
session-construction path that embedded clients use.

If that is deliberate — the connector's credential lives on your side, and
handing it to an arbitrary local agent process is a different security posture
than using it inside grok.com — then please say so in the docs, and **stop
reporting these connectors as healthy in `grok mcp doctor`**. Today the only
signals a client can see all say the connector is working, so the gap reads as a
defect in the client rather than a boundary in the product.

Either answer is fine. The current state is the problem: it is indistinguishable
from a bug, and every IDE integration built on the documented ACP surface hits it.

## Consistency notes, same area

- `grok mcp list` and `grok inspect` both omit managed connectors while `doctor`
  includes them. One of the three is wrong.
- `doctor` counts **33** tools where the TUI shows **32** — a small thing, but it
  suggests two separate code paths reading the same connector.

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
