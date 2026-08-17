# Desktop first-run default project

A first launch with no `workspaceRoots` must still be a working chat. The
project question is not asked.

## Provision (`provisionDefaultProjectDir`)

`ensureWorkspaceRoot` in `src/desktop/electron-host.ts` runs **before**
`GrokSidebar` is constructed (`src/desktop/main.ts`).

1. Forced `--workspace=` / already-open prefs: leave them, mark seed complete.
2. First seed (`shouldSeedProjectDiscovery`): open discovered git checkouts.
3. First seed and discovery is empty: create a default folder and open it.
4. Seed already completed and the open set is empty: stay empty (user-owned).

Default location, in order:

1. `~/Grok Build` (`preferredDefaultProjectPath` + `desktopUserHomeDir` —
   USERPROFILE on Windows, HOME elsewhere). Not TCC-protected on macOS.
2. `app.getPath("userData")` (`fallbackDefaultProjectPath`) when creating (1)
   fails for any reason. Silent. The profile is already writable.

A project is just a folder. No `git init`. The row is ordinary: visible in
the rail, removable, never re-created, never a hidden catch-all.

## Empty open set (`presentEmptyProjectState`)

`workspaceRoot()` still returns `""` on desktop when nothing is open. An
unauthorized cwd is still refused.

When `startSession` has no folder to start in, or the user closes the last
folder, the host emits `setBusy: false` plus `onboarding` `no-project`. That
replaces the HTML-default "Starting" spinner. Chat send and New session stay
blocked until a folder is added.

See `#116`.
