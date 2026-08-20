# Host-owned MCP connectors (Tier 1)

One connector list, handed to whichever agent is active through ACP
`session/new` / `session/load` `mcpServers`. Tokens stay in `~/.mcp-auth`
(`mcp-remote`); the host stores only ids and endpoints (`grok.mcpConnectors`).

## Catalog (verified 2026-08-19)

| id | endpoint | vendor source |
|---|---|---|
| linear | `https://mcp.linear.app/mcp` | [linear.app/docs/mcp](https://linear.app/docs/mcp) (DCR; `/sse` deprecated) |
| notion | `https://mcp.notion.com/mcp` | [developers.notion.com/guides/mcp](https://developers.notion.com/guides/mcp/get-started-with-mcp) |
| figma | `https://mcp.figma.com/mcp` | [developers.figma.com remote MCP](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) |
| atlassian | `https://mcp.atlassian.com/v1/mcp/authv2` | [Atlassian Rovo getting started](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/). Brief listed `/v1/sse`; that path was retired 2026-06-30 |
| canva | `https://mcp.canva.com/mcp` | [canva.dev/docs/mcp](https://www.canva.dev/docs/mcp/) (DCR still available; CIMD preferred) |
| stripe | `https://mcp.stripe.com` | [docs.stripe.com/mcp](https://docs.stripe.com/mcp) |
| sentry | `https://mcp.sentry.dev/mcp` | [mcp.sentry.dev](https://mcp.sentry.dev/) |
| cloudflare | `https://observability.mcp.cloudflare.com/mcp` | [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/). Brief listed `/sse`; official catalog now lists `/mcp` |

**Left out:** GitHub (`https://api.githubcopilot.com/mcp/`). Official README: each host must register a GitHub App / OAuth App. GitHub staff (2026): "We don't support DCR and we are not going to be able to do so." That is not Tier 1.

Google / Slack / Microsoft stay out of scope (pre-registered OAuth client or enterprise app).

## Dedup

`mcpServers: []` does **not** suppress file-discovered servers. Before send,
drop a host entry whose name (including `managed_gateway:<id>`) or HTTPS
endpoint is already in the provider's config / last grok `_x.ai/mcp/list`.
Theirs wins. grok.com managed Canva is the load-bearing case.

## Connect

`authorizeMcpRemote` is a one-shot `mcp-remote` spawn. A live Grok session
already running that endpoint holds the OAuth callback port pinned in
`client_info.json` (Windows skips mcp-remote's lockfile, so a second instance
cannot see the first). `EADDRINUSE` is retried once with a free loopback port
as `mcp-remote <url> <port>`, which forces re-registration. The first failure
never reaches the UI. `buildMcpRemoteEntry` does not pin a port — a specified
port on `session/new` would re-register on every conversation.

See `research/mcp-orphan-probe.cjs`.

## Remote

`mcpConnectors` is mirrored (ids, names, connected — no tokens).
`mcpServers` is `allowlist`-projected (`projectMcpServerForRemote`: page
fields only, never the launch recipe). `scopeName` and `tag` are on that
allowlist so a phone can show the same provenance badge as the desk
(managed `scopeName` / grok.com, or `User on: <deviceDisplayName>`).
Project-file servers are omitted from this list (`mcpSettingsVisible`);
the session still loads them. Origin tags for that inventory always
classify against Grok config files (`mcpNameLayersFor` → `mcpConfigPaths`
with `provider: "grok"`), not the focused session's provider.
`connectMcpConnector` / `disconnectMcpConnector` are host-local:
OAuth needs a browser on the machine that owns `~/.mcp-auth`. Settings →
Connectors on a remote shows the desk-owned catalog read-only, the live Grok
inventory, and a grok.com/connectors link. `listMcpServers` is inbound view
so a phone can refresh that inventory without the desk opening the page.
