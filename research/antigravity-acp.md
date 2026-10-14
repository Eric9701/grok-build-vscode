# Antigravity over ACP

Google's Antigravity is the fifth provider (`agy` internally; "Antigravity" on
screen). It is **experimental and desk-only**: offered only with
`grok.experimentalAntigravity` on, never on a cloud machine
(`GrokSidebar.agyOffered`), and every renderer surface keys off the host naming
`agy` in `providerState`, the way Muse is gated. The setting is a switch in
Settings -> Advanced (`setExperimentalAntigravity`, host-local, written
globally); the switch reads its state from that same `providerState`, so it
needs no frame of its own and is hidden on a remote.

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

Connect offers a choice, in one card in the connect dialog: **Sign in with
Google**, or **Use a Gemini API key** (a password field, with a link to
aistudio.google.com/apikey). Vertex AI and Enterprise sign-in are not offered.

- `session/new` on a server with no usable credential fails with JSON-RPC
  **`-32000` "Authentication required"** and no side effects
  (`isAgyCredentialError`; the server uses -32000 for nothing else).
- **The method is stated on every start.** The server persists the chosen
  method as `auth.type` in `<GEMINI_HOME or ~/.gemini>/antigravity-acp/settings.json`,
  which every ACP client on the machine shares, so that file says nothing about
  what *this* app chose. The choice is a non-secret preference
  (`grok.agySignInMethod`), and `AcpClient` sends
  `authenticate {methodId}` right after `initialize` (`startupAuth`). A start
  for which the chosen method holds nothing is not made at all: the card comes
  back instead.
- **Google** (`oauth-personal`): with a stored token, `authenticate` refreshes
  silently (`_ensure_oauth_logged_in` -> `get_access_token`; measured on every
  live smoke). With none it opens the person's browser (Python `webbrowser`),
  prints `Open the following link to authenticate the ACP server: <url>` to
  stderr and waits up to 300 s on a 127.0.0.1 redirect. So **never
  `authenticate` as a probe**: "signed in with Google?" is answered without a
  process (`agyGoogleSignInPresent`: `acp_token.json`, or on macOS -- where the
  token is in the keychain unless `AGY_ACP_FORCE_FILE_STORAGE` -- a
  `security find-generic-password -s gemini -a antigravity-acp` attribute read).
  Choosing Google with a token adopts the account with nothing started; without
  one, `runAgySignIn` runs `authenticate` in a short-lived server shaped as a
  device login: the dialog shows the stderr link, Cancel stops the server.
- **Gemini API key** (`gemini-api-key`): the key goes in `authenticate`
  `_meta` as `{"api-key": key}` (the server also reads `apiKey`/`api_key`, as a
  string or an object with `apiKey`/`api_key`/`api-key`/`key`, then falls back
  to `GEMINI_API_KEY`). The server holds it in memory only, and redacts those
  three `_meta` names from its own log line. The host keeps it in HostSecrets
  (`grok.agy.geminiApiKey`: VS Code SecretStorage, or the desktop's safe
  storage) and nowhere else -- not settings, state, logs, telemetry or
  `providerState`, which carries only which ways are saved. `agySignIn` is
  host-local and refused from a remote.
- **Never put the key in the server's environment.** The server's environment
  reaches the agent's shell commands: a marker variable set on the spawn was
  echoed back by a command the agent ran (measured, 1.4.0, Windows). A key in
  `GEMINI_API_KEY` would be readable by any command in any project.
- **A rejected key is only visible on the first turn.** In key mode
  `session/new` lists a hardcoded catalog and calls no API, so `authenticate`
  and `session/new` both succeed with any string. Google's refusal arrives as
  ordinary agent text ("API key not valid. Please pass a valid API key.") and
  the turn ends normally. That chunk is the whole message
  (`format_execution_error`), so `isAgyRejectedCredentialText` matches the
  API's refusals only at the start of a chunk -- an agent quoting the same
  error from someone's code mid-reply is not a refusal of ours -- and the
  client emits `credentialRejected`; the host marks the
  account as needing sign-in and opens the choice again with "Google rejected
  this API key." (Not observed live: there was no key to test with. The
  phrases are Google's documented API error messages.)
- **Disconnect** keeps both the Google sign-in and the saved key; Connect then
  offers the choice again, marking which way was last used and which are
  saved. **Sign out** (`Grok: Log Out`) clears only the current method's
  credential: for Google, ACP **`logout`** (the method name, measured against a
  server with an empty `GEMINI_HOME`; `auth/logout` and `session/logout` are
  -32601), which clears the token and the saved method; for a key, the saved
  key is deleted. Settings' button only disconnects, as for every desk provider
  (#203).
- Remote sign-in is refused before consent is recorded ("Connect Antigravity on
  the computer first."): it would open a browser, or take a key, on an
  unattended desk.

## Sessions

- `initialize`: `loadSession`, `sessionCapabilities {list, resume}`,
  `auth {logout}`, `_meta.antigravity.systemPrompt.append`. The host advertises
  **no client fs or terminal**: with fs the server swaps its own file tools for
  callbacks into ours, which is not the server measured here.
- `configOptions` carry the model families and `thinking_level` -- but only
  the *current* family's levels -- while `models.availableModels` lists every
  family-level pair as its own model. `normalizeAgySessionResponse` shows one
  row per family, each with its own levels (from the listed `<family>-<level>`
  ids) as its effort ladder, and effort is `set_config_option thinking_level`
  (none/minimal -> low, xhigh -> high).
  - Google sign-in on this account: one family, Gemini 3.8 Flash
    (low/medium/high). Other ids are -32602.
  - API key: the server's hardcoded catalog (`model_selection.py`) -- Gemini
    3.8, 3.7, 3.6 and 3.5 Flash (low/medium/high) and Gemini 3.1 Pro (low/high).
    Gemini 4 Argon is agent-platform only and is not in it.
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

Cloud machines, MCP connectors, Plan mode, Vertex AI and Enterprise sign-in,
signing in from a phone, a usage meter, workflow cards for subagents
(`invoke_subagent` renders as an ordinary tool call; its children arrive on the
parent session unattributed).
