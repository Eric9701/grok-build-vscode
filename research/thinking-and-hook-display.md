# Thinking and hook display

## Thinking footer (#216)

`appendThought` creates a sibling button after `.thinking-body`, so streaming
text replacement cannot remove it. The block's `_setExpanded` keeps the header's
ARIA state, body, footer and chevron synchronized, including find-in-conversation
reveals. Show Less disables stream-following, collapses, focuses the header with
`preventScroll`, then brings it into view with `block: nearest`. The header also
accepts Enter and Space. This is shared by panel, sidebar, desktop and remote.

## Grok hooks (#215)

Grok sends a live-only `hook_run_started` with `event_name`, `prompt_id` and
`count`, then a persisted `hook_execution` with `runs: [{name, status}]`.
`status` is `{status: "success"|"skipped"|"failed", elapsed_ms?, error?, blocked?}`.
The current [upstream hook dispatcher](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/hook_dispatch.rs)
announces an awaited batch only when hooks will run. A failed status marked
`blocked: true` must not be described as ignored.

The existing local 2026-09-29 Grok wire capture confirms this ordering for Stop:
`response_completed` → `hook_run_started` → `hook_execution` → `turn_completed`
→ prompt result → host `promptComplete` / `agentEnd`. The host already waits for
the prompt result before releasing the composer. No synthetic busy interval,
hook execution, hook configuration change or inferred completion timer is added.

`GrokHookCalls` converts only Stop, StopFailure and SubagentStop batches to the
existing ACP tool-call channel. The renderer gives each parent batch its own
row and settles that row immediately on its result. Failure text is assigned
as text, including the hook name and Grok's error. Child hooks use `childStream`
and stay inside their delegation card. Other hook event types remain ignored.

Pending batches are keyed by session, event and prompt; distinct turns cannot
finish one another's rows. Event IDs deduplicate results arriving on both rails.
Cold replay can start from the result alone. Starting a new replay clears that
deduplication state. Pending rows without a result are marked interrupted when
their prompt finishes or their process is disposed/closes; no success is invented.

## Verification

`test/grok-hooks.test.ts` exercises normalization and the real `AcpClient`
dispatcher without a provider CLI. `test/display-features.dom.test.ts` drives
the shipped renderer, including keyboard access, live/replayed traces, child
hooks and escaped failures. Chromium checks at 390, 520 and 1100px verify that
collapsing a many-screen trace returns its header to the viewport and that hook
activity settles into its failure row. New code has not been exercised against
a live provider in the restricted Windows test environment.
