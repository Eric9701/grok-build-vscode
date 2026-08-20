# Host-owned MCP connectors (Tier 1)

One connector list, handed to whichever agent is active through ACP
`session/new` / `session/load` `mcpServers`. Tokens stay in `~/.mcp-auth`
(`mcp-remote`); the host stores only ids and endpoints (`grok.mcpConnectors`).

## Catalog (verified 2026-08-19; Figma measured out 2026-08-20)

| id | endpoint | vendor source |
|---|---|---|
| linear | `https://mcp.linear.app/mcp` | [linear.app/docs/mcp](https://linear.app/docs/mcp) (DCR; `/sse` deprecated) |
| notion | `https://mcp.notion.com/mcp` | [developers.notion.com/guides/mcp](https://developers.notion.com/guides/mcp/get-started-with-mcp) |
| atlassian | `https://mcp.atlassian.com/v1/mcp/authv2` | [Atlassian Rovo getting started](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/). Brief listed `/v1/sse`; that path was retired 2026-06-30 |
| canva | `https://mcp.canva.com/mcp` | [canva.dev/docs/mcp](https://www.canva.dev/docs/mcp/) (DCR still available; CIMD preferred) |
| stripe | `https://mcp.stripe.com` | [docs.stripe.com/mcp](https://docs.stripe.com/mcp) |
| sentry | `https://mcp.sentry.dev/mcp` | [mcp.sentry.dev](https://mcp.sentry.dev/) |
| cloudflare | `https://observability.mcp.cloudflare.com/mcp` | [Cloudflare's own MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/). Brief listed `/sse`; official catalog now lists `/mcp` |

**Checked (2026-08-20), so nobody re-tests them to put Figma back:** linear, notion, atlassian, and stripe are connected on the owner's machine; sentry and cloudflare reach the authorize step (owner + probe); canva registers cleanly. Figma is the only one that cannot.

**Left out:** GitHub (`https://api.githubcopilot.com/mcp/`). Official README: each host must register a GitHub App / OAuth App. GitHub staff (2026): "We don't support DCR and we are not going to be able to do so." That is not Tier 1.

Figma (`https://mcp.figma.com/mcp`) advertises a `registration_endpoint` (`https://api.figma.com/v1/oauth/mcp/register`) and then answers HTTP 403 Forbidden. Measured twice through mcp-remote itself, including with `--static-oauth-client-metadata {"scope":"mcp:connect"}` — the scope Figma's AS metadata advertises. This is not Stripe's missing-scope refusal: DCR is claimed and then refused. That is Tier 2 (we would have to pre-register an OAuth client and ship the client id), not one-click. A Connect button that cannot succeed is worse than no row; do not re-add on the strength of advertised metadata.

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

Stripe is the only catalog vendor that rejects mcp-remote's default DCR
scopes (`openid, email, profile`). Its `oauthScope` is `"mcp"` — measured
against `https://access.stripe.com/mcp`, not inferred from
`scopes_supported` (Notion advertises only `default` and Atlassian
advertises none; both accept the defaults). Connect and `session/new` pass
`--static-oauth-client-metadata @<file>` with `{"scope":"mcp"}`. Inline JSON
is not used: Windows Connect spawns with `shell: true`, which mangles
`{...}`. A DCR client-metadata rejection classifies as `oauth-incompatible`
(`summarizeConnectOutput` never surfaces `at …` frames or `file:///` paths).

See `research/mcp-orphan-probe.cjs`.

## Remote

`mcpConnectors` is mirrored (ids, names, connected — no tokens).
`mcpServers` is `allowlist`-projected (`projectMcpServerForRemote`: page
fields only, never the launch recipe). `scopeName` is on that allowlist
(the team name in the grok.com section). `tag` and `configFile` are not.
Project-file servers are omitted from this list (`mcpSettingsVisible`);
the session still loads them. Classification for that inventory always
runs against Grok config files for the workspace the catalog was
read from (`mcpServersCwd` / `mcpSettingsServersForCwd` → `mcpNameCatalogFor`
→ `mcpConfigPaths` with `provider: "grok"`), never the receiving or
focused session's cwd or provider. The classified global-only view is
stored (`mcpServersView`) and rendered anywhere; project-file rows
never enter it.
`connectMcpConnector` / `disconnectMcpConnector` are host-local:
OAuth needs a browser on the machine that owns `~/.mcp-auth`. Settings →
Connectors on a remote shows the desk-owned catalog read-only, the live Grok
inventory, and a grok.com/connectors Open in the grok.com section header.
Local Grok connectors show a header Open on the desk (`openGlobalConfig`,
even when the section is empty) and a sentence on remote; there is no
per-row Open. A host-injected echo is omitted from Local. `listMcpServers` is inbound view
so a phone can refresh that inventory without the desk opening the page.

## Settings display

`sortConnectorsForDisplay` (`media/settings.js`) orders On this computer:
connected, then disconnected, each A–Z by display name (case-insensitive).
`TIER1_CONNECTORS` order is unchanged — `hostMcpServers` walks that array.

Vendor marks live in `media/connector-logos/<id>.webp` and render only on
On this computer rows (a 1:1 vendor map). They sit in a white chip and
desaturate when disconnected. A missing or failed image is omitted — no
empty box. Grok.com / Local rows are CLI-named and get no mark.

Local header Open uses the lucide `settings` gear (`ICON_SETTINGS`, same
path as `chat.js` `ICON.gear`). Grok.com Open keeps the external-link icon.
