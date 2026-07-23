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

Rewinding to the current tip errors:
`Cannot rewind to prompt #N — current prompt index is N. Valid targets: 0..N`.

## Extension mapping

| UI | Flow |
|---|---|
| **User bubble → Rewind** (primary) | Hover a user message → action row (Copy · Rewind · time) → confirm → execute → reload |
| Gear → *Rewind conversation* / `Grok: Rewind Conversation` | QuickPick fallback (newest first, tip excluded) |

**Bubble index → wire index:** the hidden plan-mode primer is a real rewind point
(`prompt_index` 0 typically) but never a bubble. `userFacingRewindPoints` /
`resolveUserBubbleRewind` strip primer / system-reminder / marker-only plan
verdicts so bubble `N` maps to the Nth user-facing point. The latest bubble
hides its Rewind button (tip is not a valid target).

Pure helpers: `src/rewind.ts`. ACP: `AcpClient.listRewindPoints` / `executeRewind`.

## Notes

- Fork (#48) branches **conversation only** — rewind is the complementary feature that restores **file** snapshots.
- After compact, rewinding *before* the compaction checkpoint can fail ("Try rewinding to a prompt after the compaction point instead") — surface `error` as-is.
- Probes: `research/rewind-probe.cjs`, `research/rewind-execute-probe.cjs`.
