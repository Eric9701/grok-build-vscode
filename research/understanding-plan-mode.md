# Understanding Plan Mode in Grok Build (VS Code Extension) — Course

> **Current status (grok 0.2.117):** plan verdicts are native JSON-RPC success
> outcomes (`approved`, `cancelled`, `abandoned`). The hidden primer and bracket
> protocol are retired; no verdict prompt, `afterTurn`, or verdict-time cancel is
> sent. The client-side gate remains because the CLI's plan gate still lets
> `terminal/create` through. `isPrimerText` / `isPrimerSummary` and their readers
> deliberately remain for old sessions already on disk. Plan is disabled
> fail-closed below `GROK_REQUIRED_VERSION` or when the version cannot be read.

> **Goal of this course**: After completing this material you will have a correct mental model of the native-verdict + client-side-gate architecture and what happens on every user action (Approve / Keep planning / Cancel). You will be able to predict behavior, debug surprising states, and explain the design to others.

This is the official **course** companion to the raw research notes in [research/plan-mode.md](plan-mode.md). Work through the sections in order for understanding; treat the research notes as the historical source of truth and reference for deep technical details and probe results.

---

## Lesson 1: Mental Model (The One-Page Explanation)

**Plan mode is a CLI-owned planning phase with an extension-owned safety gate.**

When you (or the agent) enter Plan mode:
- Grok is allowed to **read** your workspace freely (`fs/read_text_file`, search tools, etc.).
- Grok is **blocked** from mutating anything inside your workspace.
  - Every `fs/write_text_file` whose target resolves inside the workspace cwd is refused.
  - Every `terminal/create` whose command is not on a curated read-only allowlist is refused.
- The only write that is deliberately allowed is grok writing its own plan through `fs/write_text_file` to `~/.grok/sessions/<...>/plan.md` (outside your workspace). The extension *snoops* that write so it can show you the plan text. A shell command that writes the same path is blocked and grok falls back to the filesystem callback.

The CLI eventually emits `_x.ai/exit_plan_mode`. The extension answers with the
CLI's typed native outcome while keeping its own gate as defense-in-depth.

**Three user verdicts on the plan card produce three different outcomes:**

| Verdict (button)          | Gate after click | Native outcome and comment path | Observable result for the user |
|---------------------------|------------------|---------------------------------|--------------------------------|
| **Approve & implement**   | Lowered          | Restore the pre-plan Auto-accept choice, interject any comment, then return `approved`. | Grok implements inside the original turn. |
| **Reject** ("Keep planning") | Stays up      | Interject any comment, then return `cancelled`. | Grok stays in Plan, revises, and asks again inside the original turn. |
| **Cancel**                | Lowered          | Return `abandoned`; queue any comment as an ordinary send because abandon has no continuation step. | The planning turn ends in Agent mode. |

The verdict is carried by the `exit_plan_mode` response itself. There is no
bracketed marker or hidden primer. `src/grok-primer.ts` contains legacy-only
recognizers used to hide historical primer turns and keep their replay/rewind
coordinates from shifting visible content.

**The fundamental asymmetry (the thing most people get wrong on first encounter):**

- Entering Plan mode **any way at all** (picker click, agent saying "switch to plan mode", session restore) **raises the gate**.
- The gate is **only lowered** by an explicit user action on a plan card (Approve or Cancel) or by the user manually switching to Agent/YOLO.
- A non-plan `current_mode_update` is descriptive and does **not** lower the gate. `handleExitPlan` or a direct user mode choice settles the gate explicitly before native continuation can run.

The toolbar label is derived from the client-side `planActive` / `autoApprove`
state, not by blindly echoing the CLI's last mode announcement.

---

## Lesson 2: Why This Architecture Exists (The Root Cause)

The grok CLI sends an `x.ai/exit_plan_mode` (or `_x.ai/...`) server request when it finishes a planning turn. The extension receives it, shows the nice review card, and the user picks a verdict.

Current CLIs define three successful outcomes:

- `approved` — leave Plan and implement;
- `cancelled` — keep planning and revise;
- `abandoned` — leave Plan and end the planning turn.

`makeExitPlanResponse` maps the UI's internal `rejected` name to wire
`cancelled`. A JSON-RPC error is reserved for a stray plan-exit request on an
old or unverifiable CLI where Plan is unavailable.

The historical 0.2.3 bug explained why the extension first adopted B+. The
reason the gate remains today is different: the CLI blocks its edit tool while
planning but still permits delegated terminal execution. The extension therefore
continues to gate the two mandatory client callbacks:

- `fs/write_text_file`
- `terminal/create`

This safety layer is called **Option B+** in the research notes. It is the mirror image of how Auto accept is implemented (Auto accept approves at the permission layer; Plan blocks at the mandatory fs/terminal layer).

The cost is that the extension now owns a small but security-sensitive policy (the read-only command allowlist). The benefit is that the feature actually does what users expect, even when the agent initiates plan mode via natural language.

---

## Lesson 3: The Two Layers of Enforcement

### Layer 1 — Pure Policy (`src/plan-gate.ts`)

All the decision logic is deliberately pure (no vscode, no fs, no spawn) so it can be unit-tested exhaustively (30+ tests in `test/plan-gate.test.ts`).

Key exported pieces:

- `isInsideWorkspace(target, root)` — the containment check that understands Windows `\\?\` long paths, case-insensitivity on drive letters, POSIX case-sensitivity, and safe `..` traversal rejection.
- `isReadOnlyCommand(command)` — the conservative classifier:
  - Rejects anything containing `>`, `;`, `` ` ``, `&&`, `||`, `$(`, `<(`, `&` at start/end, `{`/`}` (script blocks).
  - For `|` pipelines: *every* stage must itself be a known read-only head.
  - Special cases for `git <subcommand>`, `npm/pnpm/yarn/bun <subcommand>`, and interpreters (`node --version` etc. only).
  - The big `READONLY_HEADS` set (ls, cat, grep, rg, Get-ChildItem, Select-Object, etc.) plus PowerShell read-only cmdlets.
- `shouldBlockWrite(path, ctx)`, `shouldBlockTerminal(command, ctx)`, `shouldRejectPermission(kind, ctx)`
- `isPlanFileWrite(path)` — the filesystem-only carve-out regex that recognizes `/.grok/sessions/.../plan.md` so the extension can allow + snoop it. `terminal/create` has no matching carve-out.
- `PLAN_BLOCKED_CODE = -32010` and the two user-facing messages.

When the gate is active, a blocked mutation still lets the agent continue (it receives the JSON-RPC error with the friendly message). The extension also emits `mutationBlocked` so the webview can show a small notice instead of a scary failure.

### Layer 2 — The ACP Choke Points (`src/acp.ts`)

The real handlers live here (the host in `sidebar.ts` only wires up the fs and terminal implementations):

```ts
// fs/write_text_file (approx lines 357-371)
if (isPlanFileWrite(params.path)) emit("planFileContent", ...);
if (shouldBlockWrite(...)) {
  emit("mutationBlocked", ...);
  respondError(id, PLAN_BLOCKED_CODE, PLAN_BLOCKED_WRITE_MSG);
  return;
}
await fsWrite(...); respondOk(...);
```

```ts
// terminal/create (approx lines 373-381)
if (shouldBlockTerminal(...)) {
  emit("mutationBlocked", ...);
  respondError(id, PLAN_BLOCKED_CODE, PLAN_BLOCKED_TERMINAL_MSG);
  return;
}
respondOk(id, terminal.create(...));
```

`exit_plan_mode` handling (lines 416-426) simply emits the `exitPlanRequest` event with whatever plan text it received (usually empty — the real text comes from the snoop).

The `planActive` boolean on `AcpClient` is the single source of truth that the two handlers consult on every request.

---

## Lesson 4: The State Machine in the Host (`src/sidebar.ts`)

This is the most subtle part. The key session state:

- `planActive: boolean` — the enforcement flag. When true, the gate is up.
- `autoApprove: boolean` — Auto accept, mutually exclusive with `planActive`.
- `pendingExitPlans` — actionable plan requests keyed by the ACP request id; a failed response write leaves the request available.
- `inFlightPlanComments` — memory-only ownership for comments whose interjection response has not settled, so a controlled restart can recover their exact text.
- `lastPlanText` — plan content captured from the `plan.md` write when the exit request carries no content.
- `userMessageCount`, `interjectionCount`, and `historyEventCount` — replay coordinates for persisted plan, permission, and usage records.

### Core methods

- `setPlanActive(v)` — sets the flag, syncs it to the live `AcpClient`, and posts the derived display mode to the webview.
- `displayMode()` — returns "plan" if `planActive`, else "yolo" if `autoApprove`, else "agent". The toolbar button is derived from this, not from the CLI.
- `setMode(id)` — enforces the three-way mutual exclusion and talks to the CLI only when needed.
- `handleExitPlan(...)` — the heart of the feature. It:
  1. Validates the request against `pendingExitPlans`.
  2. Settles gate and Auto-accept state before native continuation can begin.
  3. For Approve/Keep planning, starts `_x.ai/interject` first (its request write occurs before the verdict write), then responds `approved`/`cancelled`.
  4. For Cancel, responds `abandoned` and queues any comment after the response because the turn has no continuation step.
  5. Persists and resolves the card only after the verdict response write is accepted.
- `modeChanged` handler — deliberately asymmetric:
  - If the CLI says "plan" → raise gate (covers agent self-initiating).
  - If the CLI says anything else → only refresh the derived button label. Never auto-lower the gate.
- `persistPlanVerdict` + `decideRestoreState` on resume — this is what makes "Keep planning" survive a session close/reopen.

There is no `afterTurn` callback or new verdict prompt. The native response releases
the already in-flight `session/prompt`, and the CLI performs the selected continuation.

---

## Lesson 5: Session Restore & Plan History

grok only keeps the *latest* `plan.md` on disk for a session. If the user went through two or three planning iterations, earlier plans would be lost.

The extension therefore maintains its own per-session log in VS Code `globalState` (`grok.sessionMeta.<sessionId>.plans`):

```ts
interface PlanEntry {
  text: string;
  verdict: "approved" | "rejected" | "abandoned";
  afterUserMessage?: number;   // how many user messages had been sent when this plan was resolved
  afterInterjection?: number;  // accepted interjections before resolution
  afterHistoryEvent?: number;  // assistant-update boundary within the turn
}
```

On resume:
- The saved plans are queued before replay starts.
- As replay events arrive, `drainPlanHistory` inserts plan cards at their saved user/interjection/history-event boundary; `afterHistoryEvent` is what places an approval before same-turn implementation output.
- `decideRestoreState` looks at the *last* verdict:
  - `"rejected"` → restore `planActive=true` and tell the CLI to be in plan mode.
  - Anything else (including no history) → gate down, normal act mode.

This is why a session you "Kept planning" on comes back with the gate already
raised. If the CLI is below the native-verdict floor or its version is unknown,
restore fails closed by forcing Agent instead of re-entering unavailable Plan.

The pure helpers live in `src/plan-restore.ts` (15 unit tests).

---

## Lesson 6: Webview Surface (`media/chat.js`)

Two kinds of plan cards exist:

- **Live card** (`addPlanCard`, triggered by `exitPlanRequest`): shows the three buttons and an optional feedback textarea. Approve/Keep-planning comments are interjected before the verdict response and display as steer-style user bubbles once accepted; a Cancel comment is queued as the next ordinary prompt. The card collapses immediately on click, while persistence commits only after the response write succeeds.
- **History card** (`addPlanHistoryCard`, triggered by `planHistoryQueue` during replay): read-only, shows the old verdict label if we have one.

Notices (`planNotice`, `planBlocked`) are simple one-line callouts that appear in the stream when the gate silently refuses something or when the host wants to tell the user "you are still in plan mode."

The mode popover enables Plan only when `planModeAvailability` says this session's
CLI meets `GROK_REQUIRED_VERSION`; the exact version/update reason is shown otherwise.

---

## Lesson 7: How to Experiment Safely

### Without a real grok binary
- In a running extension host (F5), call the development helper:
  ```ts
  // from the debug console or by temporarily wiring a command
  sidebar.debugShowDummyPlan();
  ```
  This posts a realistic plan card and flips the mode button so you can inspect all three card states without spawning a CLI. Native response/interjection ordering is covered by tests and the live suite, not by this UI-only helper.

### With the real CLI (non-destructive)
The three scripts in `research/` are designed for this:
- `plan-probe.cjs` — single-turn observation (logs every server→client call).
- `plan-reject-probe.cjs` — full reject → feedback → second planning turn.
- `plan-gated-probe.cjs` — same flow but with the *shipped* `out/plan-gate.js` policy active.
- `plan-mode-recheck-probe.cjs` — native outcome, interjection, and legacy synthetic-flow comparisons.

They ACK writes without touching disk and are safe to run in a temp directory.

### Unit & DOM tests (always safe)
```bash
npm test
# or focused:
npx vitest run test/plan-gate.test.ts test/plan-restore.test.ts test/plan-card.dom.test.ts test/plan-native-verdict.test.ts test/plan-history-restore.dom.test.ts
```

These give you high confidence that the policy and the card rendering match the documented behavior.

---

## Lesson 8: Common Misconceptions & Debugging Tips

- **"The CLI log says `default`, but the mode button still says Plan"** — expected after a descriptive non-plan update: the safety gate is not lowered by that notification alone, and the button derives from `planActive`.
- **"Grok just wrote a file while I was in Plan mode"** — either the `fs/write_text_file` callback wrote its own `plan.md` (outside the workspace) or the gate was not actually up at that moment. Shell-based writes to that plan path are blocked too.
- **"I rejected the plan but Grok still started implementing"** — this should no longer happen with the shipped B+ gate. If it does, you have found a bug in the containment or the allowlist.
- **"Why did a second plan card appear after I clicked Reject?"** — native `cancelled` keeps the original turn in Plan, so grok revises and can call `exit_plan_mode` again without a synthetic prompt or extra user turn.
- **PowerShell pipeline notice** — the current allowlist is deliberately strict. A command like `Get-ChildItem -Recurse | Select-Object ...` may be blocked on the `|` if the right-hand side isn't recognized as read-only in that context. This produces one cosmetic notice per plan in practice and does not derail the agent (it falls back to native `read_file` / `list_dir` / `grep` tools).

---

## Lesson 9: Maintenance Notes

- The read-only command allowlist, native outcome mapping, pre-response interjection ordering, availability floor, and restore decision table are the parts most likely to need corresponding doc updates.
- Any PR that touches `plan-gate.ts`, `plan-restore.ts`, `handleExitPlan`, or the `modeChanged` handler should update this course (and the relevant tests).
- Line numbers in this document are "as of v1.2.0 / research notes dated 2026-05-28". Treat them as helpful pointers, not eternal truths.
- This course deliberately avoids duplicating large excerpts from `research/plan-mode.md`. Link to it for the full historical narrative and probe logs.

---

## Quick Reference — File Anchors

| Concept                        | Primary location(s)                                      |
|--------------------------------|----------------------------------------------------------|
| Policy decisions               | `src/plan-gate.ts`                                       |
| Restore decision table         | `src/plan-restore.ts`                                    |
| Gate enforcement points        | `src/acp.ts` fs/terminal request handlers                |
| Native outcome response        | `src/acp-dispatch.ts` `makeExitPlanResponse`             |
| Verdict/interjection ordering  | `src/sidebar.ts` `handleExitPlan`                        |
| Availability and recovery      | `src/sidebar.ts` `planModeCompatibility` / `recoverUnavailablePlanMode` |
| Gate asymmetry on mode updates | `src/sidebar.ts` `modeChanged` listener                  |
| Plan card rendering            | `media/chat.js` plan-card handlers                       |
| Full history & rationale       | `research/plan-mode.md` (especially § Resolution)        |

---

**Congratulations — you have completed the course.**

If you can explain why an agent-initiated `current_mode_update: plan` raises the
gate, why a non-plan update does not lower it, and why a Keep-planning comment
must be interjected before the native `cancelled` response releases the original
turn, you have the current model.

### Further reading & practice
- [research/plan-mode.md](plan-mode.md) — the original deep research + probe findings
- The `test/plan-*.test.ts` and `test/plan-*.dom.test.ts` files — executable specification of the gate, native verdicts, cards, restore, and replay ordering
- `CLAUDE.md` (the one-paragraph ACP surfaces summary)
- Try the `debugShowDummyPlan()` helper and the research probes for hands-on experience

Happy planning (and safe rejecting).
