# Antigravity over ACP

Google's Antigravity is the fifth provider (`agy` internally; "Antigravity" on
screen). It is **experimental and desk-only**: offered only with
`grok.experimentalAntigravity` on, never on a cloud machine
(`GrokSidebar.agyOffered`), and every renderer surface keys off the host naming
`agy` in `providerState`, the way Muse is gated.

Measured against `agy_acp_server` **1.4.0** on Windows 11, 2026-10-14. The
server's Python source (unpacked from the Linux bundle) was read rather than
guessed at; handler names below are its own.

## What runs

Google's official ACP server from the ACP registry entry `antigravity-acp`
(publisher Google LLC), spawned directly by `AgyBackend` -- it speaks ACP
itself, so there is no adapter. Not the `agy` CLI: headless `agy -p` cannot ask
permission (commands are auto-denied) and cannot be interrupted.

- Archives: `https://dl.google.com/agy-extensions/releases/{macos|linux|windows}/agy-acp-server-1.4.0-<target>.zip`.
  The registry publishes no checksums; `agy-managed-installer.ts` pins the
  SHA-256 and size we computed. Windows x64 is 125 MB (228 MB unpacked); Linux
  x64 is 336 MB (about 1 GB unpacked), so extraction streams each entry.
- Each zip holds `agy_acp_server(.exe|.par)` and `localharness_external(.exe)`,
  which the server spawns; they stay side by side. Linux takes `--uid=`. The
  zips carry no Unix modes, so the installer sets 0755 off Windows.
- Install path: `<global storage>/agy-managed/1.4.0/`. `grok.agyServerPath`
  overrides it. No PATH lookup.
- Cold start: 13-25 s on Windows before `initialize` answers (PyInstaller
  unpacks itself every start), about 50 s with three starting at once; 2.8 s on
  Linux. The startup strip waits 60 s before calling an Antigravity start slow.

### Windows: stop the server so it cleans up

The Windows build is a PyInstaller one-file program: a bootloader unpacks
**about 314 MB into `%TEMP%\_MEI*`** on every start and deletes it when its
Python child exits. Measured:

- Closing stdin does not stop the server (still alive 95 s later).
- Killing the bootloader, or its whole tree, skips the delete -- every start
  leaked 314 MB, and killing only the bootloader also orphaned the Python
  child and its harness, still running hours later.
- Killing the bootloader's **child** tree (`taskkill /PID <python> /T /F`)
  takes the harness with it, and the bootloader then deletes `_MEI*` and exits
  (code 1) by itself.

`AgyBackend.stopProcess` does the third, and `AcpClient.dispose` gives a
backend with `stopProcess` a 10 s budget before its usual tree kill. A crash of
the extension host itself can still leave a directory behind.

## Sign-in

- `session/new` on a server with no saved method fails with JSON-RPC
  **`-32000` "Authentication required"** and no side effects
  (`isAgyCredentialError`; the server uses -32000 for nothing else).
- A fresh process with a stored token and `settings.json`
  `{"auth":{"type":"oauth-personal"}}` needs no `authenticate`: `session/new`
  infers the method and refreshes silently (measured).
- **Never `authenticate` as a probe.** With no stored token it opens the
  person's browser (Python `webbrowser`), prints `Open the following link to
  authenticate the ACP server: <url>` to stderr and waits up to 300 s on a
  127.0.0.1 redirect. And `session/new` does the same when the method is saved
  but the token is gone. So "signed in?" is answered without any process:
  `agyCredentialPresent` = saved method `oauth-personal` AND
  `<GEMINI_HOME or ~/.gemini>/antigravity-acp/acp_token.json` (on macOS, where
  the token is in the keychain unless `AGY_ACP_FORCE_FILE_STORAGE`, a
  `security find-generic-password -s gemini -a antigravity-acp` attribute read).
- Connect: with a stored sign-in the account is adopted with nothing started.
  Otherwise the card offers **Sign in with Google**, which runs
  `authenticate {methodId:"oauth-personal"}` in a short-lived server
  (`runAgySignIn`) shaped as a device login: the card shows the stderr link,
  Cancel stops the server, and success goes through the usual credential check.
- Remote sign-in is refused before consent is recorded ("Connect Antigravity on
  the computer first."): it would open a browser on an unattended desk.
- Sign out (`Grok: Log Out`) calls ACP **`logout`** (the method name, measured
  against a server with an empty `GEMINI_HOME`; `auth/logout` and
  `session/logout` are -32601). It clears the token and the saved method.
  Settings' button only disconnects, as for every desk provider (#203).

## Sessions

- `initialize`: `loadSession`, `sessionCapabilities {list, resume}`,
  `auth {logout}`, `_meta.antigravity.systemPrompt.append`. The host advertises
  **no client fs or terminal**: with fs the server swaps its own file tools for
  callbacks into ours, which is not the server measured here.
- `configOptions` carry one model family (`gemini-3.8-flash`) and
  `thinking_level` (low/medium/high); `models.availableModels` lists the three
  levels as separate models. `normalizeAgySessionResponse` shows one model with
  the levels as its effort ladder, and effort is `set_config_option
  thinking_level` (none/minimal -> low, xhigh -> high). `set_model` accepts only
  the three Flash ids for this account; other ids are -32602.
- Modes: Agent and Auto accept (client-side, always `allow_once` --
  `allow_always` is saved with the conversation). No Plan: `/plan` waits for a
  "Proceed" click ACP cannot deliver. `/plan` and `/logout` are hidden from the
  command list. No `/compact`, no MCP connectors (`mcpServers: []`), no
  subscription meter (`/usage` is markdown only).
- `usage_update {used, size: 1048576}` after every step feeds the context meter.
- `session/cancel` resolves the prompt `cancelled` within about 10 ms; the next
  prompt works. `session/load` replays user and agent text; context survives.

### The working folder

The harness sorts its workspace roots alphabetically and runs commands in the
first. It is handed the project plus skill folders under `~/.gemini`, so for any
project under the home folder `~/.gemini/...` sorted first and commands ran and
files landed there. The server's own system-prompt append fixes it, on
`session/new` and `session/load` (`agySessionParams`):

> The project folder for this session is `<cwd>`. It is your working directory:
> run every command with its working directory set to this folder, and create
> or edit files inside it unless the user names another location. The other
> workspace folders listed in your context hold skills only.

It is prompt-level, so `npm run smoke:acp -- --provider=agy` asserts a
command's `Cwd` and an edit's file live, in a scratch folder under the home
folder where the bug reproduces.

### An approved edit is reported twice

The approved call (`Run create_file?`, with the diff) is followed by a second
call under a new id (`<sessionId>:N`, `Running edit_file`) that actually runs.
At the end of the turn the server sweeps the first as `failed`, "Tool call was
approved but never executed." `AgyToolCallMerger` folds the executing call into
the approved card (matched by file, else the only waiting edit) and drops that
sweep for a card whose execution it saw. Commands update in place and need
nothing.

### History

`session/list` is a directory listing with placeholder titles
("Session 453a5a5a"), no recency, and an exact-string `cwd` filter.
`listAgySessions` reads the same store directly -- `<id>.db` transcripts with
`<id>.meta` sidecars naming the folder -- so listing starts no server, recency
is the transcript's mtime, and Windows case does not split a project. Titles
come from the host's first-prompt name.

## Not in v1

Cloud machines, MCP connectors, Plan mode, API-key and Enterprise sign-in,
signing in from a phone, a usage meter, workflow cards for subagents
(`invoke_subagent` renders as an ordinary tool call; its children arrive on the
parent session unattributed).
