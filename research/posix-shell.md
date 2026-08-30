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
  `/bin/sh` / `/usr/bin/sh`, else `true` (`/bin/sh`).
- `pref === "cmd"` still forces `/bin/sh` on POSIX (escape hatch).
- `grokShellEnvValue` sets **nothing on POSIX**. This document originally
  described mapping `$SHELL` to `zsh`/`bash`; that was dropped before merge,
  because upstream builds the model-facing `Shell:` from `$SHELL` on Unix
  (`resolve_shell_display`) and reads `GROK_SHELL` there as a PATH to a shell
  binary it validates as executable — a bare `zsh` never reached the model.
  Running the shell `$SHELL` names is itself the alignment. `GROK_SHELL`
  still carries the dialect on Windows.
- `$SHELL` must also be in the POSIX-grammar allowlist (`POSIX_SHELL_NAMES`)
  and be a regular executable file: `posixSpawnArgv` hands the agent's POSIX
  script to it directly, so fish/nushell would break commands that work, and a
  directory or non-executable named `zsh` would fail every one with
  `EISDIR`/`EACCES`.

That alone is not enough. Grok 1.0.x still sends `terminal/create` as
`/bin/bash -lc <script>` even when `GROK_SHELL=zsh`. Node
`spawn(cmd, { shell: zsh })` becomes `zsh -c '/bin/bash -lc …'`; zsh execs
bash; macOS bash 3.2 sources `~/.bash_profile`; sdkman still fails.

POSIX spawn is therefore an explicit argv (`posixSpawnArgv`):

1. `unwrapGrokBashLoginWrapper` peels grok's login-bash wrapper (one layer).
2. `spawn(host, ['-c', script], { shell: false })` so the host cannot exec
   that wrapper. `host` is `$SHELL` or `/bin/sh`.

Production `terminalShell()` passes `process.env.SHELL` and falls back to
`/bin/sh` if that path is missing on disk.

## Trade-off

A missing or relative `$SHELL` still uses `/bin/sh`. That is the old behavior
and is what Linux CI sees when `SHELL` is unset in the job env. A script that
the *model* wrote as `bash -lc …` is left intact (only grok's outer wrapper
is peeled).
