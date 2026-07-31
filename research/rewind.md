# Rewind ACP surface (P2-9)

Probe-confirmed against **Grok Build CLI 0.2.111** (native Windows) on 2026-07-23.

## Methods (all `_`-prefixed on the wire)

Bare `x.ai/rewind/*` → `-32601 Method not found`. Use `_x.ai/rewind/*`.

| Method | Required params | Response |
|---|---|---|
| `_x.ai/rewind/points` | `sessionId` | `{ rewind_points: RewindPoint[] }` (snake_case fields) |
| `_x.ai/rewind/execute` | `sessionId`, `targetPromptIndex` | see below |

Missing `sessionId` on points → `-32602` with `missing field session_id`.
Missing target on execute → `-32602` `targetPromptIndex or targetResponseId is required`.

### Point row

```jsonc
{
  "prompt_index": 0,
  "created_at": "2026-07-23T03:00:00+00:00",
  "num_file_snapshots": 0,
  "has_file_changes": false,
  "prompt_preview": "Reply with exactly: ok. Do not use tools."
}
```

One point per user prompt. Snapshots live in the session dir as `rewind_points.jsonl`
(file contents); the RPC is the UI-facing summary.

### Execute result

```jsonc
{
  "success": true,
  "target_prompt_index": 1,
  "mode": "all",
  "reverted_files": ["note.txt"],
  "clean_files": [],
  "conflicts": [],
  "prompt_text": "Say B only. No tools.",
  "error": null
}
```

**Modes** (serde enum): `all` | `conversation_only` | `code_only` | `files_only`.
(`code_only` is accepted and echoed as `files_only` on 0.2.111.)

### Force flag is load-bearing

Without `force: true`, execute returns `success: false` with empty arrays and
`error: null` — **no truncation**. The TUI confirmation gate uses this path; the
extension always confirms in VS Code UI, then passes `force: true`.

**Superseded:** an earlier note here said rewinding to the current tip errors
(`Cannot rewind to prompt #N — current prompt index is N`). That is not true for
a settled session — targeting the newest point succeeds and discards exactly
that turn, which is what Edit (#56) relies on. Measured in
§ "Execute DISCARDS the target" below. Rewind still hides on the tip, but as a
PRODUCT split (the tip belongs to Edit), not a wire limitation.

## Extension mapping

| UI | Flow |
|---|---|
| **User bubble → Rewind** (primary) | Hover a user message → action row (Copy · Rewind · time) → confirm → execute → reload |
| Gear → *Rewind conversation* / `Grok: Rewind Conversation` | QuickPick fallback (newest first, tip excluded) |

**Bubble index → wire index:** sessions created by older builds may contain a
hidden plan-mode primer as a real rewind point (`prompt_index` 0 typically) and
marker-only verdict turns, neither of which renders a bubble.
`userFacingRewindPoints` / `resolveUserBubbleRewind` retain those legacy filters,
along with the system-reminder filter, so bubble `N` maps to the Nth user-facing
point. Current native verdicts create no primer or marker prompt. The latest
bubble hides its Rewind button as a product split (the tip belongs to Edit), not
because the tip is an invalid wire target.

Pure helpers: `src/rewind.ts`. ACP: `AcpClient.listRewindPoints` / `executeRewind`.

## Notes

- Fork (#48) branches **conversation only** — rewind is the complementary feature that restores **file** snapshots.
- After compact, rewinding *before* the compaction checkpoint can fail ("Try rewinding to a prompt after the compaction point instead") — surface `error` as-is.
- Probes: `research/rewind-probe.cjs`, `research/rewind-execute-probe.cjs`.

## Execute DISCARDS the target (probe-verified 2026-07-25)

`_x.ai/rewind/execute` removes the target prompt **and** everything after it.
The method name reads like "rewind TO N, keeping N" — it does not, and building
on that reading silently costs the user one extra turn (and, in `mode=all`, one
extra turn's file changes).

Measured by `research/rewind-semantics-probe.cjs` on CLI 0.2.111, 4-prompt
session (ALPHA/BRAVO/CHARLIE/DELTA, indices 0–3):

| target | points before → after | survived? |
|---|---|---|
| `#1` (BRAVO) | 4 → 1 | no — only `#0` remains |
| `#3` (DELTA, the tip) | 4 → 3 | no — `#0..#2` remain |

Two consequences:

- **The tip is a legal target.** The older note that rewinding to the current
  tip errors does not hold for a settled session; "discard just the last turn"
  is a plain `execute` against the newest point. That is exactly what Edit
  (#56) needs, so `resolveEditRewindTarget` targets the edited message's OWN
  point.
- `prompt_text` in the result is the **discarded** target's text — which is why
  the CLI returns it (its TUI puts it back in the input box). The extension
  still restores the webview's own bubble text, since that copy already has the
  `<vscode-context>` envelope, selection blocks and image tags peeled off.

`rewindConfirmMessage` was corrected to say "This message and everything after
it will be discarded" — it previously promised the clicked message survived.

## Probes + the live gate

| Tool | Kind | What it answers |
|---|---|---|
| `research/rewind-semantics-probe.cjs` | manual, throwaway session | Does `execute` keep or discard the target? Builds a 4-prompt session with known indices, rewinds to a known one, re-lists. `node … last` targets the tip instead of the second point. |
| `research/rewind-mapping-probe.cjs` | manual, **read-only** | For a REAL session id, what does `/points` return and how does the shipped `out/rewind.js` map each user bubble onto it? Loads + lists only — executes nothing. The on-disk `rewind_points.jsonl` has no `prompt_preview`, so only the RPC can answer this. |
| `plan-cancel-rewind` (live suite) | repeatable gate | Three no-op-plan-then-Cancel rounds using native `abandoned` outcomes, then rewind. Asserts those verdicts create no primer/marker prompt or phantom user point, that Edit targets the message itself, that the tip is a legal target, and that `execute` still DISCARDS its target. |

The discard assertion is the one that matters: keep-semantics would not error, it would
just quietly remove one turn too many — including that turn's file changes.

## What a rewind must also undo (extension-side state)

grok truncates its own history; anything the EXTENSION persists per session has
to be truncated in the same breath, or it outlives the turns that produced it.

| State | Where | On rewind |
|---|---|---|
| Plan cards | `SessionMetaOverride.plans` | dropped past the surviving turn; `lastPlanVerdict` recomputed (it gates plan-mode restore) |
| Permission cards | `SessionMetaOverride.permissions` | dropped past the surviving turn |
| Per-turn billing | `SessionMetaOverride.usageLog` | dropped past the surviving turn; `usage` re-derived with `sumUsage` |
| Plan snapshot files | `globalStorage/plan-reviews/<sessionId>/` | left in place — content-addressed, so they're reused rather than duplicated, and the whole directory is removed when the session is deleted |
| Subagent / media / tool rows | grok's `updates.jsonl` | nothing to do — they ride grok's replay and truncate with it |

Sessions recorded before `usageLog` existed keep their stored total uncorrected:
there is nothing to subtract, and zeroing it would be a worse lie than a stale
number.
