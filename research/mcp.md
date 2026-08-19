# MCP settings inventory

Settings → MCP servers reads `_x.ai/mcp/list` through the active Grok ACP
session. The parser accepts both the current `{ "servers": [] }` response and
a bare array, and the extra `{ result: ... }` envelope emitted by Grok 1.0.5
over ACP. It prefers `session.enabled`, `session.status`, `session.tools`, and
`session.error` over top-level values, and preserves per-tool metadata for the
host view model. Managed gateway rows are identified from `source: "managed"`
or `type: "managedGateway"` and are labelled as grok.com-managed in the UI.

The surface is read-only. Enable/disable is intentionally absent because it is
machine-global rather than conversation-scoped, and a remote settings page
must not be able to change it.

The ACP client also consumes `_x.ai/mcp/servers_updated`,
`_x.ai/mcp/init_progress`, `_x.ai/mcp_initialized`, and
`_x.ai/mcp/server_status`. Status notifications merge into the catalog already
loaded by the panel; the panel does not poll. An older CLI returning JSON-RPC
`-32601` from `_x.ai/mcp/list` is treated as an unsupported optional surface and
renders an empty catalog.
