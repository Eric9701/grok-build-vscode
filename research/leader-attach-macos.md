# Leader attach mode on macOS — the cross-platform check (#50)

`research/leader-attach-probe.cjs`, run on **macOS 24.6.0 (Mac mini)**, grok
**1.0.5 (5115b46bc909)**, 2026-08-19. Companion to the Windows run of the same
probe on the same CLI build.

**Why this run existed.** Attach mode rests on one fact: with two ACP clients on
one shared leader, does a `session/request_permission` reach both? Windows said
yes — but Windows carries the leader on a **named pipe** and macOS on a **unix
socket**. Building the UI on a single-transport measurement would have been
building on a guess.

## Verdict: the transport does not change the answer

**Both clients received `session/request_permission`** — same `sessionId`, same
`toolCall.kind: "execute"`, same title, logged at the same millisecond
(`14:37:17.003` on both). Identical to Windows.

| | Windows (named pipe) | macOS (unix socket) |
|---|---|---|
| permission reaches both clients | yes | **yes** |
| non-answerer's request after the other answers | stays held, no cancel, no resolve | **stays held** |
| non-answerer learns the outcome via | `tool_call_update` on the rail | **`tool_call_update` ×3** |
| second client also answering | accepted, no JSON-RPC error | **accepted, no error** |
| live fan-out, 8s window | 4 → 165 (41×) | **5 → 165 (33×)** |
| creator killed mid-turn | turn continues, +143 chunks | **turn continues, +150** |
| leader killed | attached client stays alive | **stays alive, exit=null, +5 updates** |
| `_x.ai/session/list` | 0 rows | **0 rows** |
| `session/list {}` (no cwd) | spans projects | **5 rows, spans projects** |
| `session/load(foreign id, its own cwd)` | succeeds | **succeeds** |
| `session/load(foreign id, wrong cwd)` | `FS_NOT_FOUND` | **`FS_NOT_FOUND`** |
| `grok leader list --json` | `[]` against a live leader | **`[]`** |
| `grok leader info` | reports on the cloud relay | **same: "no reachable leader found for target wss://code.grok.com/ws/code-agent"** |

## The one real difference, and it does not matter

`--leader-socket <path>` on macOS creates a **genuine filesystem socket** at that
path (`isSocket: true, mode 49645`) plus a 4-byte `.lock` sibling. On Windows no
socket file appears at all: the leader binds a named pipe
(`\.\pipe\grok-leader-<16 hex>`) and writes only the lock beside the requested
path.

This is invisible to the product. We do not pass `--leader-socket` — the probe
does, purely to isolate itself from a developer's real `~/.grok/leader.sock`.

## What this settles for the build

- **Permission routing is safe to build on.** The AFK-on-phone case works on both
  platforms: the card reaches the surface the user is actually looking at.
- **Card collapse must come from `tool_call_update`, never from awaiting our own
  permission RPC** — that request is never resolved for the client that did not
  answer, on either platform.
- **Double-answer prevention is ours.** The CLI accepts a second answer silently.
- **The session picker is `session/list { cwd }`.** `grok leader list` reports
  leader *processes*, not sessions, and returned `[]` against a live leader on
  both platforms; `_x.ai/session/list` returned 0 rows on both.
- **Scoping is entirely ours.** `session/load` of another workspace's session
  SUCCEEDS from a client in a different workspace as long as the correct cwd is
  passed — the leader does not bind a session to the connecting client's cwd. So
  only ever load ids that came from `session/list { cwd }` for that workspace.
- **Closing the terminal does not stop the turn**, on either platform. The issue's
  proposed "closing the terminal drops attach" rule is the opposite of the
  behaviour, and the actual behaviour is the one we want.

## Not settled

Reading another workspace's file by absolute path works (`WORKSPACE_B_SECRET_…`
came back on both platforms). That is ordinary same-user filesystem access, not a
leader isolation defect, and it is unchanged by attach mode.

Mid-turn attach still replays the prompt but not the creator's in-flight
reasoning: the attacher saw 1 thought chunk where the creator had 24 updates.
A sidebar joining mid-thought looks thinner than the terminal it joined.
