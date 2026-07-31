import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sidebar = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
const session = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8");
const primer = readFileSync(new URL("../src/grok-primer.ts", import.meta.url), "utf8");

const start = sidebar.indexOf("  private handleExitPlan(");
const end = sidebar.indexOf("  /** Persist this plan", start);
const handleExitPlan = sidebar.slice(start, end);

describe("native plan verdict orchestration", () => {
  it("settles approval state and interjects feedback before releasing exit_plan_mode", () => {
    const restoreYolo = handleExitPlan.indexOf("session.autoApprove = vscode.workspace");
    const dropGate = handleExitPlan.indexOf("this.setPlanActive(session, false)", restoreYolo);
    const settlePending = handleExitPlan.indexOf("this.autoApprovePendingPermissions(session)", dropGate);
    const interject = handleExitPlan.indexOf("client.interject(feedback)");
    const respond = handleExitPlan.indexOf("client.respondExitPlan(requestId, verdict)");

    expect(restoreYolo).toBeGreaterThan(-1);
    expect(dropGate).toBeGreaterThan(restoreYolo);
    expect(settlePending).toBeGreaterThan(dropGate);
    expect(interject).toBeGreaterThan(settlePending);
    expect(respond).toBeGreaterThan(interject);
  });

  it("keeps reject in Plan and makes abandon land in Agent, not remembered YOLO", () => {
    expect(handleExitPlan).toMatch(/else if \(verdict === "rejected"\) \{\s+session\.autoApprove = false;\s+this\.setPlanActive\(session, true\);/);
    expect(handleExitPlan).toContain("explicit Cancel lands in Agent");
    expect(handleExitPlan).toMatch(/session\.autoApprove = false;\s+this\.setPlanActive\(session, false\);/);
  });

  it("queues the user's unchanged comment when interject is unsupported or fails", () => {
    expect(handleExitPlan.match(/this\.divertRacingSend\(session, feedback, false\)/g)).toHaveLength(3);
    expect(handleExitPlan).toContain('result === "ok"');
    expect(handleExitPlan).toContain('text: feedback, chips: [], steer: true');
  });

  it("has no primer markers, cancellation, synthetic prompt, or deferred turn", () => {
    expect(handleExitPlan).not.toMatch(/client\.cancel|client\.prompt|client\.setMode/);
    expect(handleExitPlan).not.toMatch(/\[Plan (approved|rejected|cancelled)\]/);
    expect(handleExitPlan).not.toMatch(/afterTurn|planProcessing|agentStart|agentEnd|suppressPlanReject/);
  });
});

describe("primer sender retirement", () => {
  it("keeps only legacy primer readers in production", () => {
    expect(primer).toContain("isPrimerText");
    expect(primer).toContain("isPrimerSummary");
    expect(primer).not.toMatch(/GROK_PRIMER|PRIMER_MARKER|PRIMER_VERSION/);
    expect(sidebar).not.toMatch(/ensurePrimed|primingPromise|\.primed\b/);
    expect(session).not.toMatch(/primingPromise|\bprimed\b/);
  });
});
