# Changelog

## 2.1.1 — 2026-07-31

### Added

- **Custom voice keyterms** ([#73](https://github.com/phuryn/grok-build-vscode/issues/73)). `grok.voiceKeyterms` biases dictation toward your own vocabulary — cmdlets, hooks, internal package names — with User and Workspace scope. `grok.voiceLanguage` additionally formats spoken numbers, currencies and units.

### Fixed

- **Plan mode no longer refuses harmless exploration** ([#89](https://github.com/phuryn/grok-build-vscode/issues/89), [#91](https://github.com/phuryn/grok-build-vscode/issues/91)). Inspection commands — `file`, `ls`, `sips -g`, `git log … 2>$null`, read-only PowerShell conditionals — run while planning again, and answering a question card no longer reports "approve the plan first".
- **Security: plan mode could be bypassed, letting an agent change your workspace before you approved a plan.** Three routes: a parenthesised subexpression behind an allowlisted command (`echo (Set-Content …)`), agent-supplied environment overrides (`NODE_OPTIONS` on the allowlisted `node --version`), and a plan-file exemption that let any mutating command ride along with a plan write. Affects earlier releases — update when convenient.
- **Resumed conversations showed the time you opened them** ([#87](https://github.com/phuryn/grok-build-vscode/issues/87)) rather than when the messages were written.
- **A device revoked from the web left VS Code claiming it was still linked**, with no route out of the state. It now unlinks itself and offers to link again.
- **A prompt queued from a phone could be lost** when the send that consumed it failed — it is now kept and retried once the problem is cleared.

### Changed

- The device commands are now **AFK Pilot: Link this device** and **AFK Pilot: Unlink this device**, matching the product name.
- "Summarize before speaking" follows "Read replies aloud": switched off and disabled while replies aren't being spoken, so it can't silently bill an API call later.

---

## 2.1.0 — 2026-07-30

### Added

- **Voice input from AFK Pilot.** Dictate on your phone: the audio streams to your machine, which transcribes it with xAI speech-to-text and puts the text in the composer. End with "grok send" to submit hands-free.
- **Every browser tab is its own conversation, with its own repository.** Open several tabs against one linked machine, pick a different repo in each, and they stay independent across reloads, reconnects and phone tab-discards.
- **The same conversation can be open in VS Code and the browser at once**, live in both — start at the desk, carry on from the phone, switch back whenever. A tab that arrives with nothing of its own now continues what the desk is showing, instead of opening an empty session.
- **"Continue remotely" is one tap** from the chat toolbar on a linked machine, and *Add document*/*Add photo* now sit behind a phone-friendly picker.
- **"Other" answers take free text** ([#85](https://github.com/phuryn/grok-build-vscode/issues/85)), macOS gets Emacs-style `Ctrl+F`/`Ctrl+P` composer navigation ([#84](https://github.com/phuryn/grok-build-vscode/issues/84)), and a still-processing sound cue plus an opt-in "summarize before speaking" join the audio settings ([#78](https://github.com/phuryn/grok-build-vscode/issues/78)).

### Fixed

- **Security: a linked remote device could delete directories outside the session store.** A crafted session id (e.g. `../..`) passed through `deleteSession` without validation, so a remote client could recursively remove paths outside `~/.grok`. Session ids are now validated at the wire boundary *and* again before any filesystem operation. Affects earlier releases with Remote Control linked — update when convenient.
- **Expanding a Thinking block could land your click on "No, and tell Grok…"** ([#76](https://github.com/phuryn/grok-build-vscode/issues/76)) — the permission card's scroll no longer moves the buttons out from under the pointer.
- **Messages sent from a phone appear immediately** instead of vanishing until the round trip completes, which on a weak connection made a send look lost.
- **The gear no longer offers "Sign in (link this device)" before it knows the answer** — an already-linked machine could be invited to re-link itself during startup.

---

## 2.0.10 — 2026-07-27

### Added

- **Read completed replies aloud.** A new toggle (gear → Config & debug) speaks each finished reply via speech synthesis, skipping code blocks — separate on/off state for VS Code and for AFK Pilot.

### Fixed

- **AFK Pilot's text size no longer follows VS Code's own chat zoom.** The two are meant to be fully independent; changing the desktop zoom while a device was linked could silently affect AFK Pilot's own scale too.
- **Picking a different repository from AFK Pilot could get stuck showing the old one.** A live, not-yet-saved-to-disk session from whichever repository you'd been in could leak into the newly selected repository's history and be mistaken for "already open," so the screen sometimes never switched over.

---

## 2.0.9 — 2026-07-27

### Added

- **Attach documents from AFK Pilot.** The remote **+** picker gains *Add document* next to *Add photo* — `.md`, `.txt`, `.pdf`, `.csv`, `.xlsx`, and `.docx` (up to 20 MiB) attach as an explicit path chip, exactly like a local drag-and-drop, so Grok reads the file with its own tools. Linked devices on an older release simply don't see the option.

### Fixed

- **Security: a linked remote device could reference files outside your workspace via an `@`-mention.** Selecting a mention result resolved the picked path by joining it to the workspace root with no containment check, so a crafted path from a remote client could point outside the workspace and have its contents attached to the next message. Remote mentions are now resolved exclusively against the host's own indexed file catalog — the same list the autocomplete popup offered — never against an arbitrary path. Present since `@`-mention shipped (v1.7.5); if you use Remote Control (AFK Pilot), update when convenient.

---

## 2.0.8 — 2026-07-26

### Fixed

- **Long command output and diffs no longer scroll inside a small box** ([#71](https://github.com/phuryn/grok-build-vscode/issues/71)). A command's captured output and an edit's inline diff now show a short preview that grows **inline** — *View all* / *Show more* — so the page scrolls normally instead of trapping you in a nested scrollbar. On a linked device, where there's no editor to open the full text, both expand in place.
- **Permission-card keyboard polish** ([#68](https://github.com/phuryn/grok-build-vscode/issues/68)): the option with keyboard focus now shows a clear outline, and answering a card returns focus to the composer.

---

## 2.0.7 — 2026-07-26

### Fixed

- **Switching repository from your phone no longer changes what VS Code shows.** The choice is shared across your remote devices on purpose — that's the point of it — but VS Code has no repository picker, so it now stays on the workspace you have open: its history list keeps showing that project's sessions, and *New session* starts there. Previously a phone switching projects silently re-scoped the list and pointed *New session* at a different checkout.

---

## 2.0.6 — 2026-07-26

### Fixed

- **Worktree sessions are back in their repository's history** ([2.0.5](#205--2026-07-26) regression). They were matched to their parent by comparing the repository's *git root* against the folder open in VS Code — the same path in the usual case, but not when you open a *subdirectory* of a repository, and then those sessions vanished from the list. The parent repository now lists every worktree session again, as it did before 2.0.5.
- **A worktree opened directly as your workspace is now a repository in its own right.** It was excluded from the picker as "not a repository you choose between", which left *Clear all history* pointing at an entry that wasn't in the list — so it silently did nothing after you confirmed it.

---

## 2.0.5 — 2026-07-26

### Added

- **Switch repositories from a linked AFK Pilot device.** The chat header on the web client gains a repo chip listing every project Grok has sessions for — pick one to browse its history, pin the ones you reach for, then *New session* to start Grok there. A project's worktrees come with it instead of appearing as separate entries. The chip is remote-only: in VS Code the window already *is* the repository.

### Fixed

- **Re-linking a machine no longer costs you a device slot.** Linking was tracked per link rather than per machine, so re-pairing after a reinstall or a failed connection added a *second* device and could push you past your device limit — for hardware you already had. A re-link now supersedes that machine's previous entry.

---

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
