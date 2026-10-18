/** Grok's lifecycle hooks use xAI notifications, not ACP tool calls. */
const HOOK_LABELS: Record<string, string> = {
  stop: "Stop hook",
  stop_failure: "StopFailure hook",
  subagent_stop: "SubagentStop hook",
};

interface HookBatch {
  sessionId: string;
  toolCallId: string;
  label: string;
}

export interface HookToolUpdate {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId: string;
  kind: "other";
  tool: string;
  title: string;
  status: "in_progress" | "completed" | "failed";
  _meta: { afkPilotHook: true };
  content?: { type: "content"; content: { type: "text"; text: string } }[];
}

/** Keep batches separate by session AND prompt: delayed results can cross turns. */
export class GrokHookCalls {
  private nextId = 0;
  private pending = new Map<string, HookBatch>();
  private seenEvents = new Set<string>();

  reset(): void {
    this.pending.clear();
    this.seenEvents.clear();
  }

  update(u: any, sessionId: string, meta?: any): HookToolUpdate[] | null {
    if (u?.sessionUpdate !== "hook_run_started" && u?.sessionUpdate !== "hook_execution") return null;
    const label = typeof u.event_name === "string" && Object.hasOwn(HOOK_LABELS, u.event_name)
      ? HOOK_LABELS[u.event_name] : undefined;
    if (!label) return [];
    const starting = u.sessionUpdate === "hook_run_started";
    if (starting && !(Number.isInteger(u.count) && u.count > 0)) return [];
    if (!starting && !Array.isArray(u.runs)) return [];
    const runs = starting ? [] : u.runs.filter((run: any) => typeof run?.name === "string"
      && ["success", "failed", "skipped"].includes(run.status?.status));
    if (!starting && (!runs.length || runs.length !== u.runs.length)) return [];
    const eventId = typeof meta?.eventId === "string" ? `${sessionId}:${meta.eventId}` : undefined;
    if (eventId && this.seenEvents.has(eventId)) return [];
    if (eventId) this.seenEvents.add(eventId);
    const key = JSON.stringify([sessionId, u.event_name, typeof u.prompt_id === "string" ? u.prompt_id : ""]);
    const existing = this.pending.get(key);
    if (starting && existing) return [];
    const batch = existing ?? { sessionId, toolCallId: `afk-hook-${++this.nextId}`, label };
    if (starting) {
      this.pending.set(key, batch);
      return [this.call(batch, "tool_call", "in_progress", label)];
    }
    this.pending.delete(key);
    const failures = runs.filter((run: any) => run.status.status === "failed");
    const failed = failures.length > 0;
    // A hook that did its job leaves nothing behind (#215 asks only for the running
    // state and for failures). Live, the running row is settled "completed" so the
    // renderer removes it; a success with no running row (replay) emits nothing.
    if (!failed && !existing) return [];
    const blocked = failures.some((run: any) => run.status.blocked === true);
    const title = `${label}${blocked ? " blocked" : failed ? " failed" : ""}${runs.length === 1 ? ` (${runs[0].name})` : ""}`;
    const text = runs.map((run: any) => run.status.status === "failed"
      ? `${u.event_name} hook (${run.name}) ${run.status.blocked === true ? "blocked" : "failed, ignored"}: ${typeof run.status.error === "string" ? run.status.error : "Unknown error"}`
      : `${u.event_name} hook (${run.name}): ${run.status.status}`).join("\n");
    return [{ ...this.call(batch, existing ? "tool_call_update" : "tool_call", failed ? "failed" : "completed", title),
      content: [{ type: "content", content: { type: "text", text } }] }];
  }

  /** Missing results on cancellation/disconnect must not leave a running row. */
  finish(sessionId?: string): { sessionId: string; update: HookToolUpdate }[] {
    const updates: { sessionId: string; update: HookToolUpdate }[] = [];
    for (const [key, batch] of this.pending) {
      if (sessionId !== undefined && batch.sessionId !== sessionId) continue;
      this.pending.delete(key);
      updates.push({ sessionId: batch.sessionId, update: {
        ...this.call(batch, "tool_call_update", "failed", `${batch.label} interrupted`),
        content: [{ type: "content", content: { type: "text", text: "Hook ended without a result." } }],
      } });
    }
    return updates;
  }

  private call(batch: HookBatch, sessionUpdate: HookToolUpdate["sessionUpdate"],
    status: HookToolUpdate["status"], title: string): HookToolUpdate {
    return { sessionUpdate, toolCallId: batch.toolCallId, kind: "other", tool: batch.label, title, status,
      _meta: { afkPilotHook: true } };
  }
}
