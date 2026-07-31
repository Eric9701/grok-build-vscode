import { AcpClient } from "./acp";
import type { PromptUsage } from "./acp";
import type { HostMsg } from "./protocol";
import type { FileChip } from "./chips";
import { permissionOptionsForPlan } from "./plan-gate";

/** Live state for the dashboard dot. `cold` (no live process) is represented by
 *  the absence of a Session, so it isn't in this union. */
export type SessionStatus = "idle" | "working" | "needs-you" | "done" | "error";

export interface PendingPermissionOption {
  optionId: string;
  kind: string;
  name: string;
}

export interface PendingPermission {
  title: string;
  toolCallId?: string;
  toolKind?: string;
  /** Full option set offered by the CLI. */
  options: PendingPermissionOption[];
  /** Subset safe to expose while the client-side Plan gate remains active. */
  planOptions: PendingPermissionOption[];
}

export function createPendingPermission(
  input: Omit<PendingPermission, "planOptions">,
): PendingPermission {
  return {
    ...input,
    planOptions: permissionOptionsForPlan(input.options, true, input.toolKind),
  };
}

export function pendingPermissionOptions(
  pending: PendingPermission,
  planActive: boolean,
): PendingPermissionOption[] {
  return planActive ? pending.planOptions : pending.options;
}

export function preferredPermissionAllowOption(
  pending: PendingPermission,
  planActive: boolean,
): PendingPermissionOption | undefined {
  const options = pendingPermissionOptions(pending, planActive);
  return options.find((option) => option.kind === "allow_always")
    ?? options.find((option) => option.kind === "allow_once");
}

/**
 * All state that belongs to a single grok session — extracted from GrokSidebar so
 * the sidebar can hold a *pool* of these (one live `grok agent stdio` process per
 * session) and switch focus between them without tearing the others down.
 *
 * Today the sidebar keeps exactly one of these (the focused session). Steps C–F
 * add the pool, a per-session generation guard (`gen`), the webview post buffer,
 * and a derived `status` for the dashboard dots. For now this is a pure state bag
 * so the extraction is behavior-preserving (the field set + defaults mirror the
 * singletons it replaces 1:1).
 */
export class Session {
  /** Host-owned composer attachments for this session/view. */
  chips: FileChip[] = [];
  /** The live ACP client (one spawned `grok agent stdio` process), once started. */
  client?: AcpClient;

  /** YOLO: auto-approve every permission request for this session. */
  autoApprove = false;

  /** Plan-mode gate is up for this session (client-side enforcement mirror). */
  planActive = false;

  /**
   * Deferred post-turn action. The CLI's exit_plan_mode arrives *during* an
   * in-flight session/prompt, so we can't send a new prompt/set_mode from the
   * approval handler — we'd collide with the running turn. We stash the action
   * here and run it once the current prompt resolves (see handleSend).
   */
  afterTurn?: () => Promise<void>;

  /** This session has conversational history (vs. a fresh, empty one). */
  hasHistory = false;

  /**
   * True for the whole session-start window (spawn → newSession/load → primer).
   * Model/effort changes are settings that restart or race the session, so they
   * are ignored while priming — the webview also disables the controls (busy),
   * this is the host-side backstop for a click that slips through that window.
   */
  priming = false;

  /**
   * False until the hidden primer has been sent on THIS session load. The primer
   * is no longer sent at session start — it's deferred to the first outbound
   * prompt (ensurePrimed), so a startup or glance-only restore costs nothing.
   * It's (re-)sent on the first send of every load, new OR restored: a primer
   * buried in a restored session's replayed history isn't reliably honored by
   * grok (a /compact can drop it from effective context), so we re-assert it
   * once before the first post-restore turn rather than trusting history.
   */
  primed = false;

  /**
   * In-flight (or settled) hidden-primer turn for THIS session load, if one has
   * been kicked off. The primer now fires eagerly + non-blocking the moment a
   * session goes live (ensurePrimed in sidebar), so the user can send straight
   * away; their first real prompt awaits this promise (grok can't run two turns
   * at once) and is released the instant the silent primer acks. Reused so a
   * concurrent send doesn't start a second primer; cleared on failure so the
   * next send retries. undefined until the primer is first requested.
   */
  primingPromise?: Promise<void>;

  /** Drop streaming content from the webview (primer / summary injection). */
  suppressContent = false;

  /**
   * True once a live `auto_compact_completed` notification (with a usable
   * `tokens_after`) has updated the donut for the CURRENT manual /compact. Reset
   * to false just before each manual compact prompt. Gates the pre-rail
   * `/session-info` fallback + the signals.json backup so they run ONLY when the
   * live rail didn't already give us the exact post-compact count.
   */
  sawCompactNotification = false;

  /**
   * True when an `auto_compact_failed` notification arrived for the CURRENT
   * manual /compact (reset with `sawCompactNotification` before each). Gates the
   * "Compacted." confirmation so a failed compaction doesn't paint a false
   * success next to the failure note.
   */
  sawCompactFailed = false;

  /**
   * Guards the one-shot expired-token auto-recovery: set when a turn's auth-like
   * error triggers a transparent process reload + resend, so a second failure
   * (genuinely dead auth or real billing) surfaces the error / re-login prompt
   * instead of looping. Reset on any turn that completes successfully, re-arming
   * recovery for a later token expiry.
   */
  authRecoveryTried = false;

  /**
   * When set (to ""), the sidebar's messageChunk handler accumulates the
   * agent's streamed text here instead of only forwarding it — used by the
   * pre-rail post-/compact /session-info fallback, whose reply text carries the
   * fresh context count. undefined = no capture.
   */
  captureAgentText?: string;

  /**
   * Plan-reject specific suppression: drop streaming output (the false-approval
   * ramble) but let lifecycle events through so the webview clears `busy` and
   * re-enables the send button when the cancelled turn finally ends.
   */
  suppressPlanReject = false;

  /** Live permission requests awaiting an answer, by request id. Set when the
   *  card is shown, read when the user answers so we can persist the resolved
   *  card (title + outcome) for replay on a resumed session, then deleted. */
  pendingPermissions = new Map<number | string, PendingPermission>();

  /** Most recent plan text seen for this session (exit_plan_mode fallback). */
  lastPlanText = "";

  /**
   * Plan text currently shown in the live exit_plan_mode card. Set when we post
   * the card to the webview, read by persistPlanVerdict when the user picks a
   * verdict, then cleared. Decoupled from lastPlanText (which gets nuked the
   * moment we render the card) so the saved history actually has content.
   */
  pendingPlanText = "";

  /**
   * Count of user messages that have entered this session (replayed + live).
   * Persisted on each resolved plan as `afterUserMessage` so the resume view
   * can render plan cards inline with the conversation rather than at the end.
   */
  userMessageCount = 0;

  /**
   * True while a sequence of user_message_chunk events is mid-flight, so we
   * only increment userMessageCount once per user message during replay.
   */
  inUserMessage = false;

  /**
   * True only while replaying a resumed session (session/load). grok ≥0.2.33
   * echoes the *live* prompt back as user_message_chunk too, so this gates the
   * handler to replay-only — the live bubble already comes from send().
   */
  replaying = false;

  /** grok's id for this session (set on session/new or session/load). */
  activeSessionId?: string;

  /** Last browser-reported AFK Pilot preferences, in displayed percent + boolean.
   * Undefined until a remote client reports them for this focused session. */
  remoteFontScale?: number;
  remoteReadRepliesAloud?: boolean;
  remoteUsesTouch?: boolean;

  /**
   * Effective working directory for this session's `grok agent stdio` process.
   * Usually the workspace root; for a worktree-isolated session (P2-8) this is
   * the worktree path under `~/.grok/worktrees/…`. Pinned at startSession —
   * history reopen must reuse the same cwd so `session/load` finds the dir.
   */
  cwd?: string;

  /**
   * When this session runs inside an isolated git worktree, the worktree's
   * path/label/source root. Drives Apply/Remove and the history badge.
   */
  worktree?: { path: string; label: string; sourceGitRoot: string; id?: string };

  /**
   * Session-scoped `[Image #N]` counter — the highest index used so far.
   * Incremented per attached image and NEVER reset on send, so every image in
   * one conversation gets a distinct tag (per-composer numbering would restart
   * at #1 each turn and make "image #1" ambiguous in the transcript). On
   * restore it's re-seeded from the replayed prompts' tags (sidebar's
   * userMessageChunk handler).
   */
  imageCounter = 0;

  titleGenerated = false;
  firstUserMessageForTitle?: string;

  /**
   * Per-session generation counter — bumped only when THIS session's client is
   * torn down/restarted. Replaces the old global `sessionGen`: in a pool a
   * backgrounded session's in-flight events must not be judged "stale" just
   * because focus moved to another session, so each session guards its own
   * events against its own gen (captured when its handlers were wired).
   */
  gen = 0;

  /** Derived status for the dashboard dot (see SessionStatus). */
  status: SessionStatus = "idle";

  /**
   * ms-epoch of the last time this session was made the focus, created, or put to
   * work — its "recency" for the pool's LRU/TTL reaping (see session-pool.ts).
   * 0 until the sidebar touches it (kept off the constructor so this stays a pure
   * state bag — the host stamps it via `touch`).
   */
  lastActiveAt = 0;

  /**
   * Every webview post that built this session's current view, in order. The
   * focused session flushes straight to the webview; a backgrounded session
   * buffers here, so re-focusing replays the buffer (clearMessages + replay)
   * to reconstruct the view losslessly — no grok reload, no process kill.
   */
  buffer: HostMsg[] = [];

  /**
   * The ONE pending message composed while THIS session was busy (typed
   * Enter-sends and dictated utterances), awaiting its turn end. Invariant:
   * length ≤ 1 — composing more while one is queued appends to the entry
   * (blank-line separator, the exact flush format), because Stop and the flush
   * collapse everything into one message anyway. Host-owned per session — the
   * webview renders a mirror (a pending user block) from `queuedSends`
   * snapshots, so it survives focus switches and the flush
   * (maybeFlushQueuedSends) fires even while the session is backgrounded.
   */
  queuedSends: string[] = [];

  /**
   * Remote-only dequeue handshake. While set, the host has asked the owning
   * browser to echo this claimed submission through the relay, but has not
   * positively acknowledged its metered frame yet.
   */
  queuedSendDispatch?: { id: string; text: string };

  /** A queued send that has reached the host but not yet reached handleSend's
   * commit point. The queue remains authoritative until this claim commits.
   *
   * Known limitation: the commit point precedes `client.prompt()`. That promise
   * resolves at TURN COMPLETION, not request acceptance, so moving the commit
   * after it would keep already-executing text flushable for the whole turn.
   * Restoring on a rejected prompt result can also execute a partially accepted
   * prompt twice. Do not widen this window without an ACP acceptance signal or
   * an explicit retained-prefix state plus a proven never-executed classifier. */
  queuedSendCommit?: { text: string };

  /** Recently accepted dequeue ids. Delayed outbox copies are ignored even
   * after the active dispatch has been retired. Bounded per live session. */
  completedQueuedSendIds: string[] = [];

  /** True when this queue originated in AFK Pilot and therefore must return
   * through the relay's metered `send` path, even across a disconnected tab.
   *
   * Known limitation: if the relay accepts a dequeue but local preflight
   * (for example, reading an attachment) fails, retrying the retained queue is
   * metered again. Avoid changing this until the queue can distinguish an
   * already-metered prefix from newly appended, unmetered text; conflating the
   * two risks duplicate delivery or work loss. */
  queuedSendRequiresRelay = false;

  /** The last completed prompt's billing usage (#53) — grok's `_meta.usage`. */
  lastTurnUsage?: PromptUsage;

  /**
   * Session-cumulative billing (#53), summed by US across the session's turns.
   * grok reports usage per prompt only and `signals.json` persists just context
   * size, so nothing on disk can seed this — it is restored from our own
   * globalState (`SessionMetaOverride.usage`) and re-persisted as turns land.
   */
  sessionUsage?: PromptUsage;
}

export function beginQueuedSendCommit(session: Session, text: string): { text: string } | undefined {
  if (session.queuedSendCommit) return undefined;
  const queued = session.queuedSends[0] ?? "";
  if (queued !== text && !queued.startsWith(text + "\n\n")) return undefined;
  const claim = { text };
  session.queuedSendCommit = claim;
  return claim;
}

export function finishQueuedSendCommit(
  session: Session,
  claim: { text: string },
  committed: boolean,
): boolean {
  if (session.queuedSendCommit !== claim) return false;
  session.queuedSendCommit = undefined;
  if (!committed) return false;

  const queued = session.queuedSends[0] ?? "";
  if (queued === claim.text) {
    session.queuedSends = [];
    session.queuedSendRequiresRelay = false;
    return true;
  }
  if (queued.startsWith(claim.text + "\n\n")) {
    session.queuedSends = [queued.slice(claim.text.length + 2)];
    return true;
  }
  return false;
}

/** Current non-chat UI state for rebuilding a view of this live session. */
export function sessionUiSnapshot(session: Session, modeId: string): HostMsg[] {
  const messages: HostMsg[] = [];
  if (session.client?.currentModelId) {
    messages.push({ type: "modelChanged", modelId: session.client.currentModelId });
  }
  messages.push({ type: "modeChanged", modeId });
  for (const [requestId, pending] of session.pendingPermissions) {
    messages.push({
      type: "permissionOptions",
      requestId,
      options: pendingPermissionOptions(pending, session.planActive),
    });
  }
  messages.push({ type: "chips", chips: session.chips });
  messages.push({ type: "queuedSends", items: [...session.queuedSends] });
  return messages;
}
