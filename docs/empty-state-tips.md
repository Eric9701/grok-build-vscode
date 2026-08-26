# Tips on the empty screen

Once an agent is connected, the welcome screen has nothing to say. One quiet
line sits there instead, naming something you have not set up yet.

It is advice, not a call to action, and it behaves like advice: never more than
one, never in the way, and gone entirely once there is nothing left to say.

## What it can suggest

| | Shown while |
|---|---|
| Connect Codex or Claude Code | Neither is connected |
| Set up a routine | You have none |
| Connect Notion, Linear or GitHub | No connector is linked |
| Continue on your phone | This machine is not linked |
| Read replies out loud | Read aloud is off |
| Voice control | Voice is not set up |
| Mention a file with `@` | Always |
| Start it in a worktree | Coding mode, on a git checkout |

Every one of these links to the exact place it names — the settings page, or the
control itself. Nothing here is a tour you have to sit through.

## The rules

**Only what you haven't done.** Each tip states the condition under which it is
worth saying, and every one of those reads something the app already knows. You
will not be told to connect an agent you have connected, or to set up routines
you are already running.

**Once a day, at most.** A tip that has appeared today does not appear again
until tomorrow. The list is short, so without this the same two or three lines
would come round every time a conversation ended.

**✕ means not today.** It hides that tip until tomorrow. It is not a permanent
refusal, and there is nothing to undo.

**Taking it retires it.** Clicking the link is different: you have been where it
pointed, so that one does not come back at all.

**Silence when it would compete.** No tip while the screen is still starting or
loading, and none while an empty state already has something for you to do —
signing an agent in, or adding a project folder.

**It runs out.** When everything applies to you, or you have seen them all
today, the slot is simply empty and the screen is what it always was.

## On a phone

The pool is smaller, because some advice cannot be taken from where you are
standing. Signing an agent in, linking a connector and starting a worktree all
need the computer running the extension, so those are never offered on a remote
client — the same reason the move-view hint has never appeared there.

What a phone does see: routines, read aloud, voice, and file mentions.

## Where the state lives

Two small files under `~/.grok/client-state/`, machine-wide:

- `welcome-tips.json` — tips retired by being taken.
- `welcome-tips-shown.json` — which tip appeared on which day. Only today is
  kept; yesterday has no reader.

Delete either to start over. Nothing about tips is sent anywhere: the relay
never sees them, and a linked phone and the desk share one list because they are
the same person.
