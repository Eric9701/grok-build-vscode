# Keep-awake while AFK Pilot is linked

**Problem.** AFK Pilot lets you start a turn from your phone. If the desk machine
idle-suspends while you're away, the uplink drops and the turn dies with it — the
one failure mode that makes the whole feature untrustworthy, and the user has no
way to see it happened.

**Scope.** The lock is held for exactly the uplink's lifetime: a device token is
stored *and* the extension host is alive. It is asserted in `maybeStartUplink`,
released in `unlinkRemoteDevice` and `GrokSidebar.dispose`, and re-asserted on a
`grok.remote.keepAwake` config change. Not gated on a turn running or on a
browser client being connected: the point is that the machine is *reachable* at
all, and a phone that can't wake the box can't start the turn that would have
justified the lock.

## Why a child process per platform

There is no cross-platform Node/VS Code API for this, and a native module
(`node-powersaveblocker` et al) would mean prebuilds for every
platform×Electron-ABI the extension runs on (VS Code, Cursor, Antigravity, three
OSes). Every OS already ships a wake lock; we spawn it.

| Platform | Mechanism | Why this one |
|---|---|---|
| macOS | `caffeinate -i -s -w <hostpid>` | Built into macOS since 10.8 (`/usr/bin/caffeinate`) — *not* the third-party "Caffeine" app, so there's nothing to install. `-i` is the same `PreventUserIdleSystemSleep` IOPMAssertion Electron's `powerSaveBlocker` takes; `-s` additionally blocks system sleep on AC; `-w` makes it die with the extension host. |
| Windows | `powershell.exe -EncodedCommand` → `SetThreadExecutionState(ES_CONTINUOUS｜ES_SYSTEM_REQUIRED)` | The documented Win32 wake lock. No native binding needed; `Add-Type` P/Invoke reaches it from the PowerShell that ships with every Windows. |
| Linux | `systemd-inhibit --what=idle:sleep --mode=block` | logind is what GNOME/KDE's idle-suspend actually consults. |
| WSL | *nothing* | The Windows host owns the sleep decision, and systemd often isn't running. `isWslRelease` no-ops with a log line rather than spawning a process that fails on every start. |

**No display lock anywhere.** `-d` (macOS) and `ES_DISPLAY_REQUIRED` (Windows) are
deliberately absent: you are away from the desk, the screen should go dark. Only
system/idle sleep is blocked. Pinned by tests.

## Windows details

`ES_CONTINUOUS | ES_SYSTEM_REQUIRED` is `0x80000001`. Written as a hex literal
PowerShell parses it as a **negative Int32** and the `uint` P/Invoke signature
rejects the call — so the script passes the decimal `2147483649` through an
explicit `[uint32]` cast (`ES_CONTINUOUS_SYSTEM_REQUIRED`, asserted in the tests).

`SetThreadExecutionState` is a **per-thread** flag that lasts until the thread
clears it or exits, so a one-shot call from a process that immediately returns
does nothing. The script therefore parks on its own main thread in a
`Start-Sleep` loop. `-EncodedCommand` (UTF-16LE base64) rather than `-Command`:
the script embeds quotes, brackets and a C# fragment, and encoding sidesteps
every layer of shell quoting. `-NoProfile` keeps a user profile out of it; inline
commands aren't subject to the script execution policy.

## Failure is silent, by design

A wake lock we couldn't take is a missing convenience, not an error the user
needs to act on — and this runs on **every** linked machine, including locked-down
enterprise ones (PowerShell Constrained Language Mode blocks `Add-Type`; polkit
can refuse a logind block; `systemd-inhibit` may not exist at all). So nothing in
`keep-awake.ts` throws to its caller, shows a notification, or retries in a loop.
The worst case is one line in the Grok output channel and a machine that sleeps
exactly the way it did before the feature existed. `refreshKeepAwake` in
`sidebar.ts` is itself wrapped, so a failure here can never break the link,
unlink, or config-change path that called it. `unsupportedLogged` latches the
"can't do this here" line so a config change can't spam the channel.

## Orphan safety

Every child watches the extension-host pid and exits on its own when it's gone
(`-w` on macOS, `Get-Process -Id` on Windows, `kill -0` on Linux) — so a crashed
or force-killed extension host cannot strand a wake lock on the user's machine.
On POSIX the child is spawned `detached` and stopped by killing the **process
group**, so `systemd-inhibit`'s own child goes with it instead of orphaning and
holding the inhibitor open. On Windows `taskkill /T /F` reaps the tree.

## Linux polkit fallback

A logind `block` on `sleep` can be refused by polkit
(`org.freedesktop.login1.inhibit-block-sleep`); `idle` alone is always permitted
and still stops the idle-suspend timer, which is the case that actually bites an
AFK box. On a non-zero exit the runner retries once with `--what=idle`
(`keepAwakeFallbackWhat`) and logs both attempts.

## Verification (Windows 11, 2026-07-25)

- `SetThreadExecutionState([uint32]2147483649)` returned `2147483648` — non-zero,
  i.e. the assertion was accepted, and the previous state was plain
  `ES_CONTINUOUS`.
- One `powershell.exe -EncodedCommand` child appears while the lock is held and
  is gone after `stop()` (counted via `Win32_Process`: 7 → 8 → 7).
- Orphan guard: `taskkill /F` on the host process with **no** `stop()` call — the
  child was gone within the 30s watch interval (8 → 7 after 40s).
- `powercfg /requests` would show the SYSTEM request directly but requires an
  elevated prompt, so it wasn't used as the check.

macOS and Linux are unverified on real hardware; their plans are pinned by unit
tests only.

## Known limits

- **A closed laptop lid still suspends** on all three platforms. No user-space
  wake lock overrides the lid switch (Linux could via
  `--what=handle-lid-switch`, deliberately not taken — silently changing what a
  closed lid does is too surprising).
- Windows *Modern Standby* (S0ix) machines can still enter connected standby;
  `ES_SYSTEM_REQUIRED` prevents the idle transition, not every path into it.
- The lock does not survive VS Code being closed — that's the intended scope, not
  a gap. A machine with no extension host has no uplink either.
