# Changelog

## 2.0.4 — 2026-07-26

### Fixed

- **The native diff editor shows the whole file**, opened on the first changed line, instead of a context-free preview of only the replaced lines ([#66](https://github.com/phuryn/grok-build-vscode/issues/66)). Grok never sends the file itself, so both sides are reconstructed from the copy on disk plus its per-site line metadata — anchored per site, so a repeated token can't become a phantom change. An unreadable, oversized, or since-modified file falls back to the previous region-only diff. Thanks to [@padixa](https://github.com/padixa) for the report and the follow-up that scoped it.

---

## 2.0.3 — 2026-07-26

### Added

- **Edit a sent message** — hover your latest message → *Edit*. It removes that turn (restoring any files it changed) and puts the text back in the composer so you can fix it and send again. The exact complement of Rewind, which is offered on every earlier message. ([#56](https://github.com/phuryn/grok-build-vscode/issues/56))
- **Rewind now returns the message's text to the composer** too — it always deleted that message, so it no longer discards what you wrote.
- **Keyboard on permission cards** ([#68](https://github.com/phuryn/grok-build-vscode/issues/68)): *Allow once* is ordered first and takes focus when the composer is idle, so Enter approves. Arrows move between options, Escape returns to the composer without answering, and typing any character jumps to the composer instead of pressing a button. A keystroke never selects *Allow always*.

### Fixed

- **Turning off the active-file context chip is now remembered** ([#67](https://github.com/phuryn/grok-build-vscode/issues/67)). The chip is rebuilt whenever you switch files, which silently re-enabled it — so dismissing it was futile. The eye-off choice now persists across file switches and restarts.
- **Rewind discarded one turn too many.** Grok's rewind removes the message it targets, not just what follows; the confirmation said the opposite. Both the wording and the targeting are corrected, so Rewind and Edit now remove exactly the turns they name.
- **Rewind left stale plan and permission cards behind.** Those cards are stored by the extension, not by Grok, so rewinding the conversation stranded the ones belonging to deleted turns — they reappeared at the bottom of the restored chat. Both actions now drop them.
- **Plan snapshot files no longer pile up.** Reopening a session re-wrote a fresh copy of every saved plan, so one session accumulated 13 identical files. Snapshots are now named by their content and reused, and a session's snapshots are deleted with the session.
- **Rewinding now refunds the discarded turns' tokens.** The session billing total counted turns that no longer exist. Usage is recorded per turn, so the total is recomputed from what survives. (Sessions from before this change keep their existing total — there's nothing stored to subtract.)
- **Rewind and Edit no longer reload the conversation.** They deleted the whole chat, showed the welcome screen and re-rendered every message; now only the removed turns disappear.
- **Confirmations for Rewind/Edit are now in-chat**, like every other destructive confirm — no native VS Code modal.
- **No confirmation dialog unless code will be reverted.** A conversation-only rewind or edit just happens — the message goes straight back to the composer. Turns that changed files on disk still ask, since that part cannot be undone.
- **Steered messages no longer break Rewind and Edit.** A message sent mid-turn isn't a separate prompt and has no restore point; counting it shifted every later message by one, so Rewind targeted the wrong turn (reverting the wrong files) and Edit failed. Steered messages are now excluded and offer neither action.

### Changed

- Gear → Remote Control: *Your AFK Pilot account* → *Your account*.

---

## 2.0.2 — 2026-07-25

### Fixed

- **Files missing from the composer's `@` autocomplete** in large workspaces ([#69](https://github.com/phuryn/grok-build-vscode/issues/69)). The file index was capped at 5000 entries, and past that cap VS Code returns an arbitrary subset — so real source files could be absent while less relevant ones still showed. Any file open as a tab is now always mentionable, and the new `grok.mentionIndexLimit` setting raises the cap for big repos. Thanks to [@datvm](https://github.com/datvm) for the diagnosis and the fix ([#70](https://github.com/phuryn/grok-build-vscode/pull/70)).

---

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
