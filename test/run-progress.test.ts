import { describe, it, expect } from "vitest";
import {
  isRunProgressUpdate,
  parseRunProgressUpdate,
  workflowControlCommand,
  runProgressKindLabel,
  formatRunProgressPct,
} from "../src/run-progress";

describe("isRunProgressUpdate", () => {
  it("accepts workflow_updated / goal_updated and lifecycle siblings", () => {
    expect(isRunProgressUpdate({ sessionUpdate: "workflow_updated" })).toBe(true);
    expect(isRunProgressUpdate({ sessionUpdate: "goal_updated" })).toBe(true);
    expect(isRunProgressUpdate({ sessionUpdate: "workflow_paused" })).toBe(true);
    expect(isRunProgressUpdate({ sessionUpdate: "goal_completed" })).toBe(true);
  });

  it("rejects unrelated rail kinds", () => {
    expect(isRunProgressUpdate({ sessionUpdate: "auto_compact_completed" })).toBe(false);
    expect(isRunProgressUpdate({ sessionUpdate: "subagent_spawned" })).toBe(false);
    expect(isRunProgressUpdate(null)).toBe(false);
    expect(isRunProgressUpdate({})).toBe(false);
  });
});

describe("parseRunProgressUpdate — workflow", () => {
  it("parses a running workflow_updated", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "workflow_updated",
      run_id: "run-abc",
      display_name: "deep-research-2",
      objective: "Compare Postgres 17 vs MySQL 9",
      current_phase: "running",
      last_event: "agent_started",
      last_event_detail: "researcher",
      agents_used: 4,
      agent_budget: 128,
    });
    expect(u).toMatchObject({
      kind: "workflow",
      id: "run-abc",
      title: "deep-research-2",
      subtitle: "Compare Postgres 17 vs MySQL 9",
      phase: "running",
      done: false,
      failed: false,
      displayName: "deep-research-2",
    });
    expect(u?.detail).toMatch(/agent_started/);
    expect(u?.progress).toBeCloseTo(4 / 128);
  });

  it("marks completed / failed / cancelled terminal", () => {
    expect(
      parseRunProgressUpdate({
        sessionUpdate: "workflow_updated",
        run_id: "r1",
        display_name: "review-changes",
        phase: "completed",
        result_summary: "All checks green",
      }),
    ).toMatchObject({ done: true, failed: false, detail: "All checks green" });

    expect(
      parseRunProgressUpdate({
        sessionUpdate: "workflow_failed",
        run_id: "r2",
        display_name: "x",
        phase: "failed",
      }),
    ).toMatchObject({ done: true, failed: true });

    expect(
      parseRunProgressUpdate({
        sessionUpdate: "workflow_cancelled",
        run_id: "r3",
        name: "y",
        phase: "cancelled",
      }),
    ).toMatchObject({ done: true, cancelled: true });
  });

  it("returns null without an id / name", () => {
    expect(parseRunProgressUpdate({ sessionUpdate: "workflow_updated" })).toBeNull();
  });

  it("falls back to display name as id", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "workflow_updated",
      display_name: "review-changes",
      phase: "running",
    });
    expect(u?.id).toBe("review-changes");
  });
});

describe("parseRunProgressUpdate — goal", () => {
  it("parses goal_updated with deliverable progress", () => {
    const u = parseRunProgressUpdate({
      sessionUpdate: "goal_updated",
      goal_id: "g1",
      objective: "Migrate auth module",
      phase: "Executing",
      total_deliverables: 4,
      completed_deliverables: 1,
      current_deliverable_title: "Rewrite login handler",
    });
    expect(u).toMatchObject({
      kind: "goal",
      id: "g1",
      title: "Goal",
      subtitle: "Migrate auth module",
      phase: "executing",
      done: false,
    });
    expect(u?.progress).toBeCloseTo(0.25);
    expect(u?.detail).toMatch(/1\/4 deliverables/);
    expect(u?.detail).toMatch(/Rewrite login handler/);
  });

  it("marks goal_completed / goal_cleared done", () => {
    expect(
      parseRunProgressUpdate({ sessionUpdate: "goal_completed", goal_id: "g1", phase: "completed" }),
    ).toMatchObject({ done: true });
    expect(
      parseRunProgressUpdate({ sessionUpdate: "goal_cleared", goal_id: "g1", phase: "cleared" }),
    ).toMatchObject({ done: true, cancelled: true });
  });
});

describe("workflowControlCommand", () => {
  it("builds pause/resume/stop slash commands", () => {
    expect(workflowControlCommand("pause", "review-changes")).toBe("/workflow pause review-changes");
    expect(workflowControlCommand("resume", "deep-research-2")).toBe("/workflow resume deep-research-2");
    expect(workflowControlCommand("stop", "x")).toBe("/workflow stop x");
  });

  it("rejects empty or unsafe names", () => {
    expect(workflowControlCommand("pause", "")).toBeNull();
    expect(workflowControlCommand("pause", "a b")).toBeNull();
    expect(workflowControlCommand("pause", "foo;rm -rf")).toBeNull();
  });
});

describe("labels", () => {
  it("kind labels", () => {
    expect(runProgressKindLabel("workflow")).toBe("Workflow");
    expect(runProgressKindLabel("goal")).toBe("Goal");
  });
  it("percent formatting", () => {
    expect(formatRunProgressPct(0.25)).toBe("25%");
    expect(formatRunProgressPct(undefined)).toBe("");
  });
});
