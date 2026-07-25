# Changelog

## 2.0.1 — 2026-07-25

### Added

- **Keep this machine awake while an [AFK Pilot](https://afkpilot.com) device is linked**, so a turn you started from your phone isn't cut off by idle sleep — `caffeinate` on macOS, `SetThreadExecutionState` on Windows, `systemd-inhibit` on Linux. Only system sleep is blocked (the display still sleeps), the lock is released the moment you sign out, and it never survives closing VS Code. Turn it off with `grok.remote.keepAwake`. A closed laptop lid still suspends on every OS.

---

## 2.0.0 — 2026-07-25

The extension pairs with **[AFK Pilot](https://afkpilot.com)** — a companion web client that brings your Grok sessions to your phone or any browser — and moves to a Fair Source license.

### Added

- **Remote control via [AFK Pilot](https://afkpilot.com)** — gear → *Remote Control* → **Sign in (link this device)** pairs this machine with the AFK Pilot web client: follow running turns, approve permissions, answer questions, and send or steer messages from a phone or any browser while away from your desk. The extension dials out to the service (no inbound port); **Sign out** unlinks the device here and revokes it on your account. The experimental `grok.remoteControl.relayUrl` setting is gone — pairing is one click now.
- **Touch-ready chat UI** — real tap targets on touch screens, always-visible actions on history rows / images / equations / diagrams (previously hover-only), roomier question and permission cards, and in-browser PNG download for generated images, math, and Mermaid diagrams. A resize (e.g. the mobile keyboard collapsing) no longer yanks the chat to the bottom.
- ` ```math ` / ` ```latex ` / ` ```tex ` code fences render as display equations, like ` ```mermaid ` already did for diagrams.

### Changed

- **License: MIT → FSL-1.1-MIT (Fair Source).** Free to use, modify, and redistribute for any purpose except a competing commercial product or service; each release automatically becomes plain **MIT two years after publication**. Versions up to and including 1.8.1 were published under MIT and remain MIT. ([LICENSE](LICENSE))
- **Destructive confirmations are now in-chat dialogs** (delete session, clear all history, apply/remove worktree, remote sign-out) instead of native VS Code modals, so they behave identically in the sidebar and the AFK Pilot browser client.
- Card titles render in the UI font instead of the editor's monospace.

---

Older releases (before 2.0.0): see [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md).
