/**
 * Pure helpers for Deep Research / Workflow / Goal progress cards (P2-10).
 *
 * These ride the live `_x.ai/session_notification` rail as:
 *   - `workflow_updated`  — background workflow / deep-research runs
 *   - `goal_updated`      — `/goal` autonomous loops
 *
 * Field names on the wire are snake_case (same family as subagent lifecycle /
 * auto_compact_*). We accept camelCase fallbacks so a future rename doesn't
 * blank the card. See research/run-progress.md.
 */

export type RunProgressKind = "workflow" | "goal";

/** Terminal-ish phases that stop the live dots. */
const DONE_PHASES = new Set([
  "completed",
  "failed",
  "cancelled",
  "cleared",
  "stopped",
  "budget_exceeded",
  "error",
  "success",
]);

export interface RunProgressUpdate {
  kind: RunProgressKind;
  /** Stable id for the card (run_id / goal_id / display name). */
  id: string;
  /** User-facing name (workflow display handle or "Goal"). */
  title: string;
  /** Optional objective / query line. */
  subtitle?: string;
  /** Coarse phase string (running / paused / completed / …). */
  phase: string;
  /** One-line status (last_event + detail, deliverable title, …). */
  detail?: string;
  /** 0–1 progress when known (deliverables completed/total, etc.). */
  progress?: number;
  /** True when the run is finished (success, fail, cancel, clear). */
  done: boolean;
  failed: boolean;
  cancelled: boolean;
  /** Display name for /workflow pause|resume|stop (workflows only). */
  displayName?: string;
  /** Raw sessionUpdate for debugging / tests. */
  sessionUpdate: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function lower(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase() : "";
}

/**
 * True when an `_x.ai/session_notification` update is a workflow/goal progress
 * event the progress cards act on. Excludes high-frequency noise (no
 * subagent_progress equivalent here — workflow_updated is the rollup).
 */
export function isRunProgressUpdate(update: unknown): boolean {
  const k = asRecord(update)?.sessionUpdate;
  if (typeof k !== "string") return false;
  return (
    k === "workflow_updated" ||
    k === "goal_updated" ||
    k === "workflow_started" ||
    k === "workflow_completed" ||
    k === "workflow_failed" ||
    k === "workflow_cancelled" ||
    k === "workflow_paused" ||
    k === "workflow_resumed" ||
    k === "goal_created" ||
    k === "goal_completed" ||
    k === "goal_cleared" ||
    k === "goal_paused" ||
    k === "goal_resumed"
  );
}

/**
 * Normalize a session_notification update into a card-friendly shape, or null
 * when it isn't a run-progress kind / lacks an id.
 */
export function parseRunProgressUpdate(update: unknown): RunProgressUpdate | null {
  const u = asRecord(update);
  if (!u) return null;
  const sessionUpdate = str(u.sessionUpdate);
  if (!sessionUpdate || !isRunProgressUpdate(u)) return null;

  if (sessionUpdate === "workflow_updated" || sessionUpdate.startsWith("workflow_")) {
    return parseWorkflow(u, sessionUpdate);
  }
  if (sessionUpdate === "goal_updated" || sessionUpdate.startsWith("goal_")) {
    return parseGoal(u, sessionUpdate);
  }
  return null;
}

function parseWorkflow(u: Record<string, unknown>, sessionUpdate: string): RunProgressUpdate | null {
  const displayName =
    str(u.display_name) ||
    str(u.displayName) ||
    str(u.name) ||
    str(u.run_name) ||
    str(u.runName);
  const runId = str(u.run_id) || str(u.runId) || displayName;
  if (!runId) return null;

  const phaseRaw =
    str(u.current_phase) ||
    str(u.currentPhase) ||
    str(u.phase) ||
    str(u.status) ||
    lastEventPhase(u) ||
    sessionUpdate.replace(/^workflow_/, "") ||
    "running";
  const phase = phaseRaw.toLowerCase();
  const objective = str(u.objective) || str(u.query) || str(u.description);
  const lastEvent = str(u.last_event) || str(u.lastEvent);
  const lastDetail = str(u.last_event_detail) || str(u.lastEventDetail);
  const pauseMsg = str(u.pause_message) || str(u.pauseMessage);
  const resultSummary = str(u.result_summary) || str(u.resultSummary);
  const agentLabel = str(u.current_agent_label) || str(u.currentAgentLabel);

  const detailParts: string[] = [];
  if (pauseMsg) detailParts.push(pauseMsg);
  else if (resultSummary) detailParts.push(resultSummary);
  else if (lastEvent) detailParts.push(lastDetail ? `${lastEvent}: ${lastDetail}` : lastEvent);
  else if (agentLabel) detailParts.push(agentLabel);

  const agentsUsed = num(u.agents_used ?? u.agentsUsed);
  const agentBudget = num(u.agent_budget ?? u.agentBudget);
  let progress: number | undefined;
  if (agentsUsed != null && agentBudget != null && agentBudget > 0) {
    progress = Math.min(1, Math.max(0, agentsUsed / agentBudget));
  }

  const done = DONE_PHASES.has(phase) || /completed|failed|cancelled|stopped/.test(sessionUpdate);
  const failed = phase === "failed" || phase === "error" || phase === "budget_exceeded" || sessionUpdate === "workflow_failed";
  const cancelled = phase === "cancelled" || phase === "stopped" || sessionUpdate === "workflow_cancelled";

  return {
    kind: "workflow",
    id: runId,
    title: displayName || runId,
    subtitle: objective,
    phase,
    detail: detailParts.join(" · ") || undefined,
    progress,
    done: done || failed || cancelled,
    failed,
    cancelled,
    displayName: displayName || runId,
    sessionUpdate,
  };
}

function parseGoal(u: Record<string, unknown>, sessionUpdate: string): RunProgressUpdate | null {
  const goalId = str(u.goal_id) || str(u.goalId) || str(u.id) || "goal";
  const objective = str(u.objective) || str(u.title) || str(u.goal);
  const phaseRaw =
    str(u.phase) ||
    str(u.status) ||
    str(u.current_phase) ||
    str(u.currentPhase) ||
    sessionUpdate.replace(/^goal_/, "") ||
    "running";
  const phase = phaseRaw.toLowerCase();

  const total = num(u.total_deliverables ?? u.totalDeliverables);
  const completed = num(u.completed_deliverables ?? u.completedDeliverables);
  const curTitle =
    str(u.current_deliverable_title) ||
    str(u.currentDeliverableTitle) ||
    str(u.current_subagent_role) ||
    str(u.currentSubagentRole);

  let progress: number | undefined;
  if (total != null && total > 0 && completed != null) {
    progress = Math.min(1, Math.max(0, completed / total));
  }

  const detailParts: string[] = [];
  if (total != null && completed != null) detailParts.push(`${completed}/${total} deliverables`);
  if (curTitle) detailParts.push(curTitle);

  const done =
    DONE_PHASES.has(phase) ||
    sessionUpdate === "goal_completed" ||
    sessionUpdate === "goal_cleared";
  const failed = phase === "failed" || phase === "budget_exceeded" || phase === "error";
  const cancelled = phase === "cancelled" || phase === "cleared" || sessionUpdate === "goal_cleared";

  return {
    kind: "goal",
    id: goalId,
    title: "Goal",
    subtitle: objective,
    phase,
    detail: detailParts.join(" · ") || undefined,
    progress,
    done: done || failed || cancelled,
    failed,
    cancelled,
    sessionUpdate,
  };
}

function lastEventPhase(u: Record<string, unknown>): string | undefined {
  const e = str(u.last_event) || str(u.lastEvent);
  return e ? e.toLowerCase() : undefined;
}

/**
 * Build the slash command to control a workflow run by display name.
 * Returns null when the action isn't applicable (e.g. goal has no pause via /workflow).
 */
export function workflowControlCommand(
  action: "pause" | "resume" | "stop",
  displayName: string | undefined,
): string | null {
  const name = (displayName || "").trim();
  if (!name) return null;
  // Display names are session-unique handles (review-changes, deep-research-2).
  // Don't shell-quote — slash dispatch is plain text, and names are [a-z0-9-].
  if (!/^[\w.:-]+$/.test(name)) return null;
  return `/workflow ${action} ${name}`;
}

/** Human label for the card's kind badge. */
export function runProgressKindLabel(kind: RunProgressKind): string {
  return kind === "goal" ? "Goal" : "Workflow";
}

/** Format a 0–1 progress fraction as a short percent, or "" when unknown. */
export function formatRunProgressPct(progress: number | undefined): string {
  if (progress == null || !Number.isFinite(progress)) return "";
  return `${Math.round(progress * 100)}%`;
}
