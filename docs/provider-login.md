# Signing agents in

Grok Build drives three command-line agents, and it never holds their
credentials. Each one signs you in itself, stores its own token in its own
directory, and talks to its own vendor. The extension's job is to start the
right command in the right place.

That matters more than it sounds, because it decides what is possible from a
phone and on a machine with no screen.

## What the app does today

**Settings → Providers → Connect** opens a terminal on the computer running the
extension and runs the agent's own login command:

| Agent | Command | Credential lands in |
|---|---|---|
| Grok Build | `grok login` | `~/.grok/auth.json` |
| Codex | `codex login` | `~/.codex/auth.json` |
| Claude Code | `claude auth login` | `~/.claude/` (or the OS keychain) |

Signing in is classified `host-local` in
[`src/remote-policy.ts`](../src/remote-policy.ts) — a linked phone or browser
can *see* that an agent is disconnected but cannot start the login, because the
flow needs a terminal and a browser on the machine that will hold the token.
The remote empty state says so rather than offering a control that would do
nothing.

## Signing in without a browser on that machine

Every one of the three has a headless path, and they are not the same shape.
Verified against the versions below — check `--help` on yours before relying on
any of it, because two of these are recent.

### Grok Build — device code

```bash
grok login --device-auth      # alias: --device-code
```

Prints a URL and a short code. Open the URL on any device, enter the code, and
the CLI polls until it is confirmed. Present in `grok 1.0.5`.

`GROK_HOME` overrides `~/.grok`, so pointing it at a persistent volume keeps a
container's login across restarts.

There is also an API-key path: set `XAI_API_KEY` (a console.x.ai key). Two traps
if you use it — the CLI reads it internally as `GROK_CODE_XAI_API_KEY`, and **a
cached OAuth session shadows the env key**, so `grok logout` is needed before an
API key takes effect. The extension detects that second case and says so.

### Codex — device code, in beta

```bash
codex login --device-auth
```

Documented by OpenAI as the preferred path for headless environments, and gated
behind a ChatGPT security setting you have to enable on your account first.
**Not present in `codex-cli 0.149.0`** — the flag is newer than that build, so
check yours before planning around it. Until it lands there are three fallbacks:

- run `codex login` on a machine with a browser and copy `~/.codex/auth.json`
  across (documented, with the obvious warning — the file is a password);
- `printenv OPENAI_API_KEY | codex login --with-api-key`;
- `CODEX_HOME` to relocate the whole directory.

### Claude Code — a long-lived token

```bash
claude setup-token
```

Prints a URL, waits for the OAuth flow to finish, and stores a token valid for
about a year. Requires a Claude subscription. Present in `claude 2.1.243`. The
token can also be supplied as `CLAUDE_CODE_OAUTH_TOKEN`.

Claude Code additionally accepts `ANTHROPIC_API_KEY` for anyone with API access,
which is billed separately from a subscription.

## Running Claude Code somewhere we host

Anthropic states this explicitly, so it is worth quoting rather than
paraphrasing. From [Claude Code's legal and compliance
page](https://code.claude.com/docs/en/legal-and-compliance):

> Nor does it prevent an end user from signing in to the unmodified Claude Code
> binary with their own Claude subscription, including where a platform hosts
> Claude Code.

Hosting is permitted, with conditions: the binary must be unmodified, no
built-in authentication method may be removed or restricted, the host must
agree to Anthropic's Commercial Terms, and — the one that shapes the design —

> Customers may not pay for, resell, or intermediate Claude usage on their end
> users' behalf.

and

> developers may not collect, store, or intermediate Claude.ai credentials or
> session tokens — sign-in to a Claude account must complete through Anthropic's
> own flow.

**So "log in at your desk and copy the token to the server" is not an option for
Claude**, however convenient it looks. The sign-in has to complete where the
agent runs. That is a constraint on us, not on you: it is why any hosted
environment would run the login inside the environment rather than forwarding
anything from your machine.

The same principle is worth applying to all three even where it is only good
practice rather than a rule. A token that never moves is a token that cannot
leak in transit.

## What this means for remote control

A phone can do almost everything the desk can — start conversations, answer
permission prompts, schedule routines, browse and edit project files. It cannot
sign an agent in, because the credential belongs to the desk and the flow needs
a browser there.

If you are setting up a machine you will only ever reach remotely, sign the
agents in **before** you walk away from it, using the headless commands above.

## Where the credentials live

Nothing in this list is ever read, copied, or transmitted by the extension or by
the AFK Pilot relay. They are listed so you know what to protect and what to
delete.

| Agent | Path | Override |
|---|---|---|
| Grok Build | `~/.grok/auth.json` | `GROK_HOME` |
| Codex | `~/.codex/auth.json` | `CODEX_HOME` |
| Claude Code | `~/.claude/` or the OS keychain | — |

`~/.grok/auth.json` is refused by name everywhere the extension serves files,
and the relay never sees any of them. See [Privacy](privacy.md).

## Signing out

`grok logout`, `codex logout`, `claude auth logout` — or **Settings → Providers
→ Sign out**, which runs the same command. Signing out of Grok is also the fix
for a cached OAuth session shadowing an `XAI_API_KEY` you would rather use.
