import { AcpClient } from "./acp";
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

export interface PendingExitPlan {
  planText: string;
}

/** A submitted plan comment owned by one live ACP process until its interject
 * response arrives. This is intentionally memory-only; process exit hands the
 * text to the ordinary queue/composer recovery path. */
export interface InFlightPlanComment {
  text: string;
  client: AcpClient;
  gen: number;
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

  /** Whether this session's CLI is new enough for native plan verdicts. */
  planModeAvailable = true;
  planModeUnavailableReason?: string;

  /** Latest attempt to force an unavailable Plan session back to Agent. */
  planModeRecoveryAttempt = 0;

  /** Two-phase unavailable-Plan recovery. The write gate may drop only after
   * both the forced Agent mode change and any live planning turn have settled. */
  planModeRecovery?: {
    attempt: number;
    modeConfirmed: boolean;
    turnSettled: boolean;
    warningTimer?: ReturnType<typeof setTimeout>;
  };

  /** This session has conversational history (vs. a fresh, empty one). */
  hasHistory = false;

  /** True for the session-start window (spawn → newSession/load). Model/effort
   * changes that would race startup are ignored; the webview also locks busy. */
  priming = false;

  /** Drop streaming content from hidden summary/context-injection turns. */
  suppressContent = false;

  /**
   * True when an `auto_compact_failed` notification arrived for the CURRENT
   * manual /compact (reset before each). Gates the
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

  /** Live permission requests awaiting an answer, by request id. Set when the
   *  card is shown, read when the user answers so we can persist the resolved
   *  card (title + outcome) for replay on a resumed session, then deleted. */
  pendingPermissions = new Map<number | string, PendingPermission>();

  /** Most recent plan text seen for this session (exit_plan_mode fallback). */
  lastPlanText = "";

  /** Live exit_plan_mode requests awaiting one answer, keyed by ACP request id. */
  pendingExitPlans = new Map<number | string, PendingExitPlan>();

  /** Submitted plan comments still awaiting `_x.ai/interject` acceptance. */
  inFlightPlanComments = new Map<number | string, InFlightPlanComment>();

  /** Accepted mid-turn interjections in this session. This is the secondary
   * replay coordinate for multiple native plan reviews inside one prompt. */
  interjectionCount = 0;

  /** Number of replay-stable assistant update events observed in this session.
   * Persisted records use this common boundary to order plans, permissions, and
   * usage inside a turn rather than waiting for the next user message. */
  historyEventCount = 0;

  /** Accumulator used to classify replayed user-message chunks even when the
   * CLI splits the interjection envelope across updates. */
  replayUserRaw = "";
  replayUserCounted = false;
  replayUserIsInterjection = false;

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
   * The prompt currently in flight, or undefined when none is. A token rather
   * than a boolean so a settlement can prove WHICH turn it is settling — a
   * cancel-recovery and the real promise can both come back, and only the first
   * of them may end the turn.
   *
   * It exists because `status` was standing in for this and could not do the
   * job. Status is set to "working" beside the prompt and only leaves it when
   * that promise settles, so a cancel the CLI never answered left the session
   * "working" forever — and `turnInFlight` then diverted every later send in
   * that session into the queue instead of sending it, permanently, with
   * nothing on disk to show for it and only a window reload as a cure. Status
   * now describes the dot; this describes the turn.
   */
  turnToken: object | undefined = undefined;

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

}

/** Mark a prompt as in flight. The returned token is the only thing that can
 *  later end THIS turn. */
export function beginTurn(session: Session): object {
  const token = {};
  session.turnToken = token;
  return token;
}

/** End the turn `token` started, if it is still the one in flight. False means
 *  something already settled it — a cancel recovery, or a newer turn — and the
 *  caller must not emit a second end for it. */
export function endTurn(session: Session, token: object): boolean {
  if (session.turnToken !== token) return false;
  session.turnToken = undefined;
  return true;
}

/** Whether a prompt is genuinely running. Asked instead of reading `status`,
 *  which cannot distinguish "working" from "was working and never settled". */
export function turnIsInFlight(session: Session): boolean {
  return session.turnToken !== undefined;
}

/**
 * True when the ACP session can accept `session/prompt` (spawn finished and
 * session/new|load returned an id). During the priming window the client object
 * may already exist while `sessionId` is still unset — a prompt then throws
 * "no session" after consuming chips. Callers must queue instead.
 */
export function sessionReadyForPrompt(session: Session): boolean {
  return !!session.client && !session.priming && !!session.client.sessionId;
}

/**
 * Busy chrome restored after a webview reload reattaches to a live session.
 * Keeps the startup lock while priming (or while the client has no session id
 * yet) so a rehydrate cannot unlock the composer into a work-losing send.
 */
export function rehydrateBusyChrome(session: Session): { value: boolean; locked: boolean } {
  if (!sessionReadyForPrompt(session)) {
    return { value: true, locked: true };
  }
  const busy =
    session.status === "working" ||
    session.status === "needs-you" ||
    session.turnToken !== undefined;
  return { value: busy, locked: false };
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
export function sessionUiSnapshot(
  session: Session,
  modeId: string,
  chips: FileChip[] = session.chips,
): HostMsg[] {
  const messages: HostMsg[] = [];
  if (session.client?.currentModelId) {
    messages.push({ type: "modelChanged", modelId: session.client.currentModelId });
  }
  messages.push({ type: "modeChanged", modeId });
  messages.push({
    type: "planModeAvailability",
    available: session.planModeAvailable,
    reason: session.planModeUnavailableReason,
  });
  for (const [requestId, pending] of session.pendingPermissions) {
    messages.push({
      type: "permissionOptions",
      requestId,
      options: pendingPermissionOptions(pending, session.planActive),
    });
  }
  messages.push({ type: "chips", chips });
  messages.push({ type: "queuedSends", items: [...session.queuedSends] });
  return messages;
}
