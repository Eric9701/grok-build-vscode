# Changelog

## 3.2.8 — 2026-08-08

### Fixed

- **The chat opens in Cursor.** Cursor reserves the secondary side bar for its own agent UI and refuses to place an extension there, so the panel Grok Build asks for was never created — the view was dropped into Explorer and every way of opening it answered "command not found". It now opens the view wherever the editor actually put it, and moves the chat into a right-docked panel: the same place on screen under a different name.
- **That move happens on its own, without opening the chat first.** It has to: someone whose chat is buried in an Explorer section has no way to open it, so a correction that waits for them to open it never runs. It repeats after each update — installing a new version is what puts the chat back where the editor cannot show it — and it goes to wherever you last chose from **Move view**, not to our default.

### Changed

- **Move view offers what your editor can actually do.** Where the secondary side bar is unavailable, the three destinations collapse into one **Move view…** that opens the editor's own picker, and **Grok: Move Chat View** does the same from the command palette. Cursor keeps our other view containers but ignores where they asked to live, so every destination we could name led to the same place — three labels for one outcome, two of them untrue. Its own picker moves the chat by *location*, which is how it reaches the panel and the secondary side bar. In VS Code the three direct destinations are unchanged.
- **Move view is hidden in the browser client.** Where the chat sits is a property of the machine running the extension, so those entries could never do anything from a phone.

## 3.2.7 — 2026-08-08

### Changed

- **Grok Build Desktop for macOS is signed and notarised by Apple.** It opens on first double-click — no *unidentified developer* warning, no trip through Privacy & Security, and no *"damaged and can't be opened"* on Apple silicon. Installers on this release are the first signed ones.

### Fixed

- **Voice finds ffmpeg where it is actually installed.** The desktop app only searched the `PATH` it inherits, which on macOS leaves out Homebrew's directory — so `brew install ffmpeg` looked like it had done nothing, and voice kept reporting ffmpeg missing until you pointed a setting at the binary by hand. It now checks the standard install locations too.
- **A useful answer when ffmpeg is missing.** The error offered only *Open Settings*, which cannot help when the program isn't installed at all — it sent you to a text field to name a file you don't have. It now shows the install command, and on macOS offers to open a terminal with it typed ready to run. Pointing the setting at a folder instead of the program is also named as such, rather than failing as a permissions error.

## 3.2.6 — 2026-08-08

### Fixed

- **The extension loads again.** 3.2.0 through 3.2.5 failed to start: a module the sidebar needs at runtime was left out of the published package, so activation threw before a single command was registered — every `Grok:` command answered "command not found" and the sidebar never appeared. Update from any 3.2.x; the downgrade to 3.1.0 is no longer needed. Grok Build Desktop was never affected. Found and diagnosed in #101.
- **Packaging refuses to build a package that cannot load.** Every `require` in the packed code is now resolved against the files actually being shipped, so a missing module fails the build instead of reaching a marketplace.

## 3.2.5 — 2026-08-07

### Changed

- **"Update available" opens a page that just gives you the download.** It used to open the GitHub release, which lists ten files — installers for three platforms, their checksums, and the VS Code extension — with nothing saying which one is yours. Now it detects your platform, offers one button, and shows how to get past the first-launch warning.

## 3.2.4 — 2026-08-07

### Added

- **Hide a project from the desktop rail** — in a project's `⋯` menu. It leaves the list; nothing leaves your disk, and **+** adds it back.

### Changed

- **Projects are listed by name**, in the rail and the repository picker. They used to reorder by recent activity, so starting a conversation moved the project you were in to the top and shifted everything under your cursor.

### Fixed

- **A new conversation appears in the rail straight away.** The project moved to the top but gained no row, and only closing and reopening it made the conversation show up.
- **New session is never disabled.** While the app was switching projects, every **+** in the rail greyed out at once — and on a switch that opens no conversation it stayed that way.
- **"+" on another project starts the conversation there**, rather than switching and leaving you on whatever was already open.

## 3.2.3 — 2026-08-07

### Fixed

- **Grok Build Desktop opens on macOS.** Earlier builds were refused outright — *"Grok Build Desktop is damaged and can't be opened"* — because the app carried no signature at all, which Apple silicon will not load. It is now ad-hoc signed, so macOS asks whether to open it (*right-click → Open*, or *Privacy & Security → Open Anyway*) instead of telling you to bin it. Still not notarised; a certificate is on the way. If you already downloaded an earlier build, `xattr -dr com.apple.quarantine "/Applications/Grok Build Desktop.app"` recovers it.

## 3.2.2 — 2026-08-07

### Fixed

- **The Marketplace and Open VSX listing shows its screenshot again.** A screenshot removed in 3.2.1 was still referenced by the store page, which renders from its own copy of the README, so the listing showed alt text where the picture should be.

## 3.2.1 — 2026-08-07

### Fixed

- **The projects rail lists other projects' conversations from a phone again.** It said *"Update Grok Build to preview"* against a host that was fully up to date and had already answered — the reply was dropped on the way out because it described a project other than the one that browser tab was working in, which is exactly what the rail asks about.
- **Grok Build Desktop wears its own icon on Windows.** The Start menu, the taskbar and Task Manager showed Electron's default: the packaging step that stamps the icon and version details onto the app had been switched off. The installer wizard carries the mark now too.

## 3.2.0 — 2026-08-07

### Added

- **Grok Build Desktop (Community) — a standalone app for Windows and macOS.** The same coding agent, without an editor or a terminal in front of it: open a folder and start. Projects on the left, the conversation in the middle, your files on the right. The builds are **not code-signed yet** — Windows SmartScreen and macOS Gatekeeper will warn you the first time. [Download](https://afkpilot.com/desktop).
- **The desktop file panel edits text files, in tabs.** Several files open at once, each with its own unsaved-changes dot. Markdown opens as a preview with a source toggle, `Ctrl`/`Cmd+S` saves, **Cancel changes** reverts, and closing a tab with unsaved edits asks first. If the agent changed the file underneath you, the save is refused and you choose: reload its version, or keep yours. Silently winning that race in either direction is how people lose work.
- **The app tells you when a new version exists.** It checks on start and every twelve hours, and shows how to update. It does not install anything behind your back — and it cannot on macOS anyway, since an unsigned app can't be replaced automatically.
- **Add project folders from the rail.** A `+` on the PROJECTS heading, and the empty rail offers it too.
- **A project that turns off permission prompts now asks you first.** A repository can ship a `.grok/config.toml` setting `permission_mode = "always-approve"`, and it overrides your own setting — so cloning someone's code was enough to remove every prompt between the agent and your machine. Opening such a project now says so and waits for you. Your own global setting is unaffected and stays silent.

### Changed

- **"Continue in a new chat" moved to the conversation's `⋯` menu**, beside Rename and Delete — the things you do *to* a conversation. The composer's settings keep model and effort, which is what they are for. Worktree apply and remove moved with it.
- **The file tree and the projects rail can be resized** by dragging their edge, on desktop and in the browser.

### Fixed

- **File icons are visible in dark themes.** Around thirty file types drew almost black on a dark background, so `.dockerignore` and friends were nearly invisible.
- **Markdown files render properly in the desktop panel** — lists, tables and the rest, using the same renderer the conversation uses, rather than a reduced one that handled only links and headings.
- **The settings button under the composer opens settings on the first click** when the gear menu is already open, instead of only focusing the composer.
- **A phone's project drawer is full width again.** It had collapsed to about 150px in AFK Pilot.
- **Closing a project folder asks first when something is still running.** It ends every conversation in that folder and stops the agent, which discarded a turn in progress with no warning.
- **`--config-json` applies to one run.** It was merged into your real configuration and left there, so a throwaway setting passed once kept applying on every later launch, with nothing on screen explaining why.
- **Files in one project can no longer be opened from a conversation in another.** Having both projects open was treated as permission to reach either from either.
- **Markdown with Windows line endings renders properly.** Headings kept their `#` and bullets kept their `-`, while tables and links worked — so it looked like the renderer was mostly fine when the document's structure was actually gone. Affected chat messages too, not just the file panel.
- **A file saved after you switch projects goes to the file you opened**, not to a same-named file in the project you switched to.
- **Selecting a project no longer opens a conversation in it.** It shows you what is there; you choose what to open.
- **The `⋯` menus close when you click them again.**

## 3.1.0 — 2026-08-06

### Added

- **The panel says which conversation you are in.** The name sits at the top, the same one the history list shows, with the full text in a tooltip when it is too long to fit. Renaming happens there too: hover it and a pencil appears, or tap the name on a phone. Enter or clicking away saves, Escape cancels — no trip through the history list or the `⋯` menu.

### Changed

- **Conversation names, pinned and archived projects now live in `~/.grok/client-state/`** instead of inside VS Code. Nothing changes for you — your existing names, pins and archives move across on first launch and keep working — but they are now readable files rather than editor-private storage, so they can follow you to other Grok clients on the same machine. One visible consequence if you use **multiple VS Code profiles**: those profiles previously kept separate names and pins, and now share one set.

### Fixed

- **A question from Grok always offers a free-text answer** ([#85](https://github.com/phuryn/grok-build-vscode/issues/85)). "Other" only appeared when Grok itself supplied that choice, which it usually doesn't — so there was no way to answer anything the listed options didn't cover.
- **A long command no longer swallows the chat** ([#71](https://github.com/phuryn/grok-build-vscode/issues/71), [#92](https://github.com/phuryn/grok-build-vscode/issues/92)). The six-line limit counted line breaks rather than the lines you actually see, so a few very long lines filled the bubble regardless — and the permission card showed the whole command with no limit at all. Both are bounded by what is drawn now, with **View all** for the rest, and nothing gained a scrollbar of its own.
- **"View all" opens a command in its own language** ([#71](https://github.com/phuryn/grok-build-vscode/issues/71)). A Python command was always opened as a shell script; VS Code detects it now.
- **"Scroll to bottom" stops reappearing while you are already at the bottom** ([#92](https://github.com/phuryn/grok-build-vscode/issues/92)). Tool details growing above the view made the browser adjust the scroll position itself, which read as though you had scrolled away — the more the UI is scaled up, the more often it happened.
- **An unsent draft no longer gains a copy of itself** every time you leave a conversation and come back. Pulling a message back to the composer with **Edit** was recorded as part of the conversation, so re-opening it did the same thing again — and again.
- **The project you are working in can be folded** in AFK Pilot's project rail. It was held open so a fold could never hide where you are; now it re-opens only when a conversation actually moves into it, so folding the one you are in sticks.
- **Rewind no longer states a file count it can't stand behind.** The CLI can report a file it created but left on disk, so the message says what was rolled back and warns that anything created after that point may remain.
- **The panel wastes less width in VS Code.** The gutter that suits a browser tab is a visible slice of a narrow sidebar, so the desk gets its own — and the conversation's name lines up with the messages under it.
- **"Scroll to bottom" stops going see-through when you hover it.** It borrowed a colour themes intend as a tint over a toolbar, not as a background of its own, so on many themes the conversation showed through the button.
- **`Expand tool details` is documented as it behaves.** It has opened tool groups since 1.5.10; the README and the setting description still described the older behaviour.

## 3.0.1 — 2026-08-05

### Fixed

- **History filled up with "Untitled" conversations that would not open.** Sessions you never typed into were being left on disk — one for every window you opened on a project and closed again without asking anything. Nothing removed them, and some the CLI cannot load at all, so clicking one appeared to do nothing. They are cleaned up now, at startup and whenever you start or open a conversation. Anything you renamed, pinned, or actually used is left alone. ([#97](https://github.com/phuryn/grok-build-vscode/issues/97))
- **A conversation you have not renamed now shows the title Grok gave it** — the same one `grok sessions list` shows — instead of the first 50 characters of whatever you happened to type first. Your own renames still win, and names you have already given are untouched. ([#96](https://github.com/phuryn/grok-build-vscode/issues/96))

## 3.0.0 — 2026-08-05

### Added

- **A projects rail in AFK Pilot.** Every project with Grok history down the left, each showing its newest conversations, with your pinned conversations lifted above them across all projects and a search that filters both. You can start a new session in any project without switching to it first, and rename, delete or clear history from the row itself. On a phone it is a drawer behind the handle in the header.
- **Archived projects.** Put a project away from its `⋯` menu, and anything untouched for 30 days goes there on its own — into a folded section that stays out of your way. Nothing is lost: an archived project still works, and starting or continuing a conversation in one brings it back. The three most recent projects are never archived automatically, so the list can't empty itself out.
- **You can delete the conversation you have open**, in VS Code and in AFK Pilot. It closes and a new one starts in the same project.

### Changed

- **AFK Pilot's toolbar moved into the conversation.** The header names the conversation and its project, with Session history and New session beside it; the project controls live in the rail instead. Projects are ordered by their newest conversation rather than by when their folder was last written to, so clearing a project's history no longer moves it to the top.

### Fixed

- **A conversation could be wedged shut by a Stop that never landed.** If the CLI ignored a stop request, the turn never ended, and from then on every message you sent turned into a queued message that could never be sent — only reloading the window cured it. A stop that goes unanswered for ten seconds now restarts the CLI, keeping the conversation, rather than leaving it stuck.
- **A message sent while Grok was working appeared twice**, once as your bubble and once as the queued block.
- **Renaming, deleting and clearing history now work in a project you have not switched to**, instead of being refused — and clearing another project's history shows the result there rather than writing a line into whatever conversation you happen to be reading.

---

## 2.3.1 — 2026-08-02

### Changed

- **Dictation inserts where your cursor is** instead of always appending to the end, and replaces the text you had selected — so you can pause, correct a sentence in the middle, and carry on in place. Authored by [@tarcisiomiranda](https://github.com/tarcisiomiranda) in [#72](https://github.com/phuryn/grok-build-vscode/pull/72), co-authored here; it was ported onto the current voice transport rather than merged, because the branch predated the shared-PCM rewrite.
- **Clicking Send or Queue now turns the microphone off** and sends exactly the text you can see. A transcript still in flight can no longer refill the composer you just cleared. Saying **"grok send"** still submits hands-free and keeps listening — that flow is unchanged on purpose.

### Fixed

- **Dictation could wipe a draft you had already typed.** The composer position was only remembered when the extension believed voice was configured, but recording is the host's call — so when the two disagreed, the first words transcribed replaced everything in the box.

---

## 2.3.0 — 2026-08-01

### Added

- **You can see what you attached** ([#88](https://github.com/phuryn/grok-build-vscode/issues/88)). Images preview as thumbnails in the composer and in the conversation itself, in VS Code and in AFK Pilot, live and after a restore. Click or tap one to open it full size — on a phone that version is fetched on demand, so it arrives a moment after the preview instead of being carried around with every conversation. Photos work, not just screenshots: JPEG is decoded and downscaled on your own machine.
- **What a conversation cost.** A running total per conversation, taken from what the CLI reports and shown only when the whole conversation can be accounted for — a partial figure is worse than none.
- **AFK Pilot can read a shorter, speech-friendly version of each reply** ([#94](https://github.com/phuryn/grok-build-vscode/issues/94)), matching the switch VS Code already had. Each browser keeps its own preference.

### Changed

- **"Summarize before speaking" is now "Read simplified summaries", and defaults on.** The setting key is unchanged. If the summary fails or never arrives, the original reply is spoken rather than nothing.
- **Switching repository lands somewhere predictable** — that repository's newest conversation, or a new one if it has none — and says "Loading conversation" while it does, with the switcher held until it finishes.

### Fixed

- **Opening an older conversation from history no longer re-types itself** ([#93](https://github.com/phuryn/grok-build-vscode/issues/93)). It arrives in one update, as a reconnect already did.
- **The scrollbar reaches the bottom with "Expand tool detail" on** ([#92](https://github.com/phuryn/grok-build-vscode/issues/92)), and a clipped command can be revealed by tapping on a touch screen.
- **A phone no longer bounces between two repositories.** Reconnecting — which happens every time a phone tab goes to the background — re-asserted a repository that disagreed with the conversation it then restored, so the view flipped back and forth.
- **An attachment can no longer arrive in the wrong conversation.** If a phone reconnected while an image was still being written to disk, that image could land in whichever conversation VS Code happened to be showing.
- **Reading replies aloud no longer stops after switching conversation** on a phone.

---

## 2.2.0 — 2026-07-31

### Changed

- **Plan mode now uses the CLI's own approve/reject, instead of a workaround.** Older Grok Build CLIs treated *any* answer to a plan card as approval, so the extension shipped a hidden instruction message teaching the model to read your real verdict from a follow-up, and cancelled the planning turn to re-drive the work itself. The CLI fixed that, so all of it is gone. **Approve & implement** now continues straight into the work in the same turn rather than starting a second one, and **Keep planning** leaves Grok planning — sometimes it revises immediately, sometimes it waits for you to say what to change. A comment you attach to a verdict still reaches Grok *before* it starts implementing.
- **Plan mode needs Grok Build CLI 0.2.117 or newer.** Updating the extension updates the CLI on your next session. If it can't be updated — or its version can't be read — Plan is shown disabled with the reason, while Agent and Auto-accept carry on working. That's deliberate: the verdict handling above isn't safe on an older CLI.

### Fixed

- **A conversation opened on your phone no longer re-types itself.** Mobile browsers discard a backgrounded tab, so coming back to AFK Pilot rebuilt the conversation one message at a time. It now arrives in a single update, showing your recent exchanges. Opening an *older* session from the history list still streams — that one is next.
- **Grok Build CLI installs that resolve to a `grok.cmd` shim** (common on Windows) failed the version read, which in turn disabled Plan mode.
- **Conversations recorded by earlier versions still restore cleanly.** They contain the old hidden instruction message; it stays hidden, and plan cards stay where they belong.

---

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
