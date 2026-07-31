# What the 0.2.112 re-verification unlocks — recommended next steps

**Status: recommendation, not a plan. Nothing here is implemented.** Written 2026-07-29 alongside
the [ACP-feedback](ACP-feedback.md) re-verification pass (live basis: grok **0.2.112**; source
basis: the OSS daily sync, now `5da6962`). Every claim below is either **live-verified** on 0.2.112
or explicitly marked otherwise — see *Evidence discipline* at the end, which is the part most worth
keeping regardless of what we build.

**The one-line answer to "usage? native plan mode? something else?":** native plan mode, decisively
— it is the biggest code deletion available to us and it is now live-verified. Usage is real but
smaller than it looks, because the new RPC is per-process. The "something else" is the interesting
one: **session portability shipped without anyone noticing**, and it happens to attack AFK Pilot's
hardest unsolved problem.

---

## 1. Retire the hidden primer; adopt the CLI's native plan verdicts

**Live-verified (0.2.112).** Replying to `_x.ai/exit_plan_mode` with a JSON-RPC **success**
`{outcome: "approved" | "cancelled" | "abandoned"}` — instead of the JSON-RPC error we send today —
does the right thing: the plan turn ends `end_turn` (not `cancelled`), mode stays `["plan"]` on
`cancelled`, and the model volunteers *"You asked me to **revise** the plan (not approve or reject),
and **yes — I am still in plan mode**."* That is the whole job the primer performs, done natively,
with no synthetic turn.

This is the highest-leverage item by a wide margin, because the primer is load-bearing for a
surprising amount of machinery that exists *only* to clean up after it:

| Goes away | Why it existed |
|---|---|
| `src/grok-primer.ts`, `ensurePrimed`, `primingPromise` | Teaching the model the bracket protocol |
| `isPrimerText` / `isPrimerSummary` | Hiding the primer when grok replays it |
| The empty-primer sweep + `parkFocused` recycle (`sessions.ts`) | Primer-only sessions littering history |
| Primer-derived title repair, incl. `forkDisplayName`'s carve-out | grok titles from message #1 = the primer |
| Marker-only `[Plan approved/rejected/cancelled]` hidden turns | The protocol itself |
| `suppressContent` / `SUPPRESS_TYPES` plumbing | Hiding the primer's turn |
| Post-`/compact` re-priming | `/compact` folds the primer away |
| Prompt-index compensation in rewind/plan positioning | The primer counts as a user message |

**Keep the client-side gate.** This is not "trust native plan mode." `terminal/create` still escapes
the CLI's plan gate — re-confirmed live on 0.2.112 for the third consecutive build (4 `terminal/create`
calls passed through during one plan turn while the edit tool was correctly refused). So
`src/plan-gate.ts` stays exactly as-is. The clean split:

- **CLI owns** mode state, plan review, verdict semantics.
- **We remain** defense-in-depth for delegated mutation.

That is a partial migration on purpose. The terminal hole is a reason to keep one small safety
layer — it is not a reason to keep an entire synthetic conversation protocol.

**Caveat worth designing for:** `_meta.rules` on `session/new` (live-verified — a nonce in `rules`
reaches the model) is the sanctioned home for any standing instruction that survives. It is *not* a
place to re-implement the bracket protocol; the typed verdict already exists.

---

## 2. Session portability — probe it now, before committing AFK Pilot to disk-copying

**Live-verified as routed on 0.2.112** (`-32602`, not `-32601`): `_x.ai/session/state`,
`_x.ai/session/import`, `_x.ai/session/updates`. Source says `state` returns the transcript-adjacent
`plan` / `planMode` / `signals` / `goal` / `announcement` / `summary` columns and `import` recreates
them plus `updates.jsonl` on another host.

This ranks second — above usage — because it is the first upstream-owned primitive for moving a
session between hosts, which is precisely AFK Pilot's hardest problem. Today that feature reaches
across private session directories; these RPCs are the sanctioned version of that.

**But treat existence, call contract, and behavioral contract as three separate facts.** We know
only the first. So:

1. Recover the parameter shapes (they answer `-32602`, so the methods are there and our params are wrong).
2. Test fresh-process, then cross-host: update ordering, identity, conflicts, failure recovery.
3. Only then productize — gate on `-32601` **and** fail safe on `-32602`/semantic mismatch, and keep
   directory-copying as the fallback until the behavioral contract is proven.

Shipping on an unadvertised RPC is not itself disqualifying — Steer, Fork, worktrees and Rewind all
already do it, feature-gated on `-32601`. The difference is that for those we knew the contract
before we shipped. Here we don't yet.

---

## 3. Usage: harvest `costUsdTicks`, but do **not** retire our ledger

This is the item most likely to be over-read, so the finding first:

**`_x.ai/session/usage` is per-PROCESS, not per-session.** Measured: `totalTokens: 31673,
numTurns: 2, costUsdTicks: 178580000` after two turns → **all zeros** on the next call after a
`session/load` in a fresh agent process. A cumulative-looking counter that silently resets is worse
for users than no counter, because it keeps looking authoritative while under-reporting. So:

- **Keep** `SessionMetaOverride.usageLog` and the derived total. It is still the only thing that
  survives a reload *and* the only thing a rewind can subtract from.
- **Do** start capturing **`costUsdTicks`**, which rides the per-turn `_meta.usage` we already parse.
  It is the first real money figure anywhere on the wire and the number users actually ask for; we
  have never been able to show it. This is a small change to an existing path, not a new subsystem.
- Optionally use `_x.ai/session/usage` as a per-run cross-check, labelled **"this run"** — never as
  the session total.

**§2.13 is not closed.** There is still no account quota, no used/limit, no reset timestamp. The
sweep tried eight plausible method names; all `-32601`. [#64](https://github.com/phuryn/grok-build-vscode/issues/64)
remains blocked upstream.

---

## 4. Cheap wins worth taking on their own

Each is small, independent, and deletes a workaround we currently maintain:

- **Replace the `/session-info` prose scrape** with the envelope `_meta.totalTokens` that rides
  every `session/update` (observed climbing 5487 → 15781 → 16015 within one turn, matching the prose
  exactly). Kills the regex ACP-feedback §2.3 calls "as fragile as it sounds", and the hidden turn
  that feeds it.
- **`_x.ai/compact_conversation` ships** (returns `{}`). A compact that needs no slash at position 0
  — retires the send-reordering dance for the command where it was most fragile.
- **`initialize._meta.modelState`** carries the full model catalog *before* `session/new`, so the
  model picker no longer needs a live session to populate.
- **`initialize._meta.defaultAuthMethodId`** is populated (`"cached_token"`), so we can finally warn
  about the OAuth-shadows-`XAI_API_KEY` trap instead of regexing an error string.
- **`_x.ai/sessions/changed`** pushes an incremental session catalog with `activity`, `yolo`,
  `reasoningEffort`, `isWorktree`. It is strictly better than the paginated list we asked upstream
  for. Tempting — but it overlaps our most delicate subsystem (the disk index, mtime cache, live-session
  synthesis, dot derivation), so it is a deliberate *later*, not a cheap win. Flagged here so it
  isn't forgotten.

---

## What NOT to change yet

Confirmed still broken on 0.2.112 — several **despite being fixed in published source**, which is
exactly why shipped-behavior evidence is the only kind that may remove a fallback:

| Workaround | Keep because |
|---|---|
| Vision with no capability gate | `promptCapabilities.image:false` still advertised while image blocks work |
| The "do not Read" image hint | `read_file` on a plain 109-byte PNG still fails `Cannot read binary file` — **source has an image-aware branch that has not shipped** |
| Whole-session-only fork | Source truncates both logs; last measured shipped build did not |
| Conservative rewind wording | `reverted_files` still lists created files left on disk — **source deletes them; stable doesn't** |
| `/context` + `/always-approve` denylist | Both still advertised over ACP |
| The client-side plan gate | The terminal hole is open on 0.2.112 |
| Composer dual-path code | Composer is no longer advertised on this account — but don't delete on one account's evidence |

---

## Evidence discipline (the part worth keeping either way)

This pass produced three genuinely different states that were previously collapsed into "verified".
Recommend using these in code comments and release decisions:

- **Live-verified** — observed on a named CLI build.
- **Source-verified** — present in a dated OSS snapshot.
- **Source-only** — changed upstream, *not* observed in any shipped build.

**Only live-verified may remove a compatibility fallback.** The binary-`read_file` and
`reverted_files` cases above are the concrete proof of why: both are fixed in published source and
both still fail on the shipped binary. Source-only evidence is enough to write a probe and pre-plan
a migration — never enough to tell a user they have the feature.

Two supporting facts: the OSS repo now publishes a **daily** sync (not the single squashed snapshot
the older doc assumed), so source claims can be dated and diffed; and `research/acp-surface-audit-probe.cjs`
now exists to re-run the discovery sweep — most of §2.16 came from asking "what ships that we've
never looked at?", which is worth repeating after each CLI bump rather than only re-checking known
claims.
