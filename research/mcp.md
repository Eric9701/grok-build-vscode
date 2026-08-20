# MCP settings inventory

Settings → Connectors reads `_x.ai/mcp/list` through
a Grok ACP session (a live pooled client, else a lazily started empty
session when Grok is connected and Connectors is opened) and splits it
into Grok.com connectors (managed) and Local Grok connectors (user-level
config files). A `source: "local"` name that appears in no config layer
is our session/new echo and is omitted from Local — it already has an
On this computer row. The host stamps that session's cwd on the catalog
(`mcpServersCwd`) and
classifies against it once (`mcpSettingsServersForCwd`), storing the
global-only view (`mcpServersView`). A later focus switch, remote
snapshot, or second tab on another project renders that view as-is —
project-file rows were already dropped, and global rows are
workspace-independent. Servers declared in a project file
(`.mcp.json`, `.grok/config.toml`) are omitted from the page
(`mcpSettingsVisible`); they still load in the session. The raw
`this.mcpServers` list stays complete for `hostMcpServers` dedup. The parser accepts
both the current `{ "servers": [] }` response and a bare array, and the extra
`{ result: ... }` envelope emitted by Grok 1.0.5 over ACP. It prefers `session.enabled`, `session.status`, `session.tools`, and
`session.error` over top-level values, and preserves per-tool metadata for the
host view model. Managed gateway rows are identified from `source: "managed"`
or `type: "managedGateway"` and land in the grok.com section (`scopeName` is
the team name). Origin tags are gone.

The surface is read-only. Enable/disable is intentionally absent because it is
machine-global rather than conversation-scoped, and a remote settings page
must not be able to change it. Remotes may view and refresh the list
(`listMcpServers` inbound view). The desk catalog keeps launch recipes
(`command`/`args`/`url`) for the local panel; remotes receive
`projectMcpServerForRemote` — an allowlist of page fields (`name`,
`displayName`, `enabled`, `source`, `type`, `managed`, `scope`, `scopeName`,
`status`, `toolCount`). `tag` and `configFile` are not on it. `tools`
(including `inputSchema`) and per-server `error` stay
on the desk: the Connectors page does not render tool schemas, and an error
string can quote the command line. `transformHostMsgForRemote` is the choke
point (`mcpServers` is `allowlist`, not `mirror`); an unknown `allowlist`
type is dropped rather than ferried.

The ACP client also consumes `_x.ai/mcp/servers_updated`,
`_x.ai/mcp/init_progress`, `_x.ai/mcp_initialized`, and
`_x.ai/mcp/server_status`. Those notifications always update
`grokMcpReserved` (dedup must not wait on a catalog read) and merge
into the stored inventory when no catalog is stamped or the notifying
session's cwd matches `mcpServersCwd`. The panel does not poll. An older CLI returning JSON-RPC
`-32601` from `_x.ai/mcp/list` is treated as an unsupported optional surface and
renders an empty catalog. Live catalog posts are device-wide because
the stored view is global.
