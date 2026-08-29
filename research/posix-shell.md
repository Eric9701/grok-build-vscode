# POSIX `$SHELL` host (ACP vs TUI)

Why the extension runs the agent's `terminal/*` commands under `$SHELL` on
macOS/Linux instead of always `/bin/sh`.

## Root cause

In ACP mode grok does not run shell commands itself. It sends `terminal/create`
with a raw command string and the client spawns it (`src/acp.ts` →
`TerminalManager.create`). The host used Node's `shell: true`, which is
**`/bin/sh`**. On macOS `/bin/sh` is bash 3.2. A login bash sources
`~/.bash_profile`, sdkman sees `$BASH_VERSION`, and `${candidate_name^^}`
fails (bash 4+ only):

```
/Users/…/.sdkman/src/sdkman-path-helpers.sh: line 61: ${candidate_name^^}: bad substitution
```

That line prepends every command in the VS Code plugin. The standalone TUI does
not: it is started from the user's real terminal (`SHELL=/bin/zsh`) and wraps
commands in that detected shell, so sdkman takes the zsh branch
(`${candidate_name:u}`).

This is the POSIX half of #46 (Windows already matched the user's PowerShell
instead of cmd.exe).

## Fix

`resolveTerminalShell(..., posixShell)`:

- POSIX `auto` → `posixShellFromEnv($SHELL)`: absolute path other than
  `/bin/sh` / `/usr/bin/sh`, else `true` (Node `/bin/sh`).
- `pref === "cmd"` still forces `/bin/sh` on POSIX (escape hatch).
- `grokShellEnvValue` maps `/bin/zsh` → `zsh` and `/…/bash` → `bash` so the
  agent's `GROK_SHELL` matches the executor. The `/bin/sh` fallback still
  leaves `GROK_SHELL` unset.

Production `terminalShell()` passes `process.env.SHELL` and falls back to
`/bin/sh` if that path is missing on disk.

## Trade-off

A missing or relative `$SHELL` still uses `/bin/sh`. That is the old behavior
and is what Linux CI sees when `SHELL` is unset in the job env.
