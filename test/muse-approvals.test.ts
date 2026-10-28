import { describe, expect, it, vi } from "vitest";
import { Approvals, permissionOptions } from "../adapters/muse/approvals.mts";

const once = { choiceId: "minted_17", label: "Allow", scope: "once", decision: "approved" };
const session = { choiceId: "minted_29", label: "Allow this session", scope: "session", decision: "approvedForSession" };
const persistent = { choiceId: "minted_31", label: "Save rule", scope: "localPersistent", decision: "approvedPolicyAmendment" };
const deny = { choiceId: "minted_44", label: "Deny", scope: "once", decision: "denied" };
const request = { sessionId: "session", approvalId: "approval", toolCallId: "call", toolName: "bash",
  currentRequirementId: { approvalId: "approval", sourceIndex: 0 }, availableChoices: [once, session, persistent, deny] };

describe("Muse permission correlation", () => {
  it.each([
    ['{"command":"echo example"}', { command: "echo example" }, "echo example"],
    ['{"cmd":"echo alias"}', { cmd: "echo alias" }, "echo alias"],
    ['{"path":"example.txt"}', { path: "example.txt" }, "bash"],
    ['{"command":42}', { command: 42 }, "bash"],
    ['{"command":""}', { command: "" }, "bash"],
    [undefined, undefined, "bash"], ["{invalid", undefined, "bash"], ["null", undefined, "bash"],
    ["[]", undefined, "bash"], ['"not an object"', undefined, "bash"],
  ])("shows the parsed approval arguments without inventing a command for %s", (rawArgs, rawInput, title) => {
    const ask = vi.fn((_params: any) => new Promise<any>(() => {}));
    new Approvals(ask, vi.fn(), vi.fn(), vi.fn()).accept("approval/requested", { ...request, rawArgs });
    expect(ask.mock.calls[0][0].toolCall).toEqual({ toolCallId: "call", title, kind: "execute", status: "pending", rawInput });
  });

  it("shows a PowerShell approval as its command, like bash", () => {
    const ask = vi.fn((_params: any) => new Promise<any>(() => {}));
    new Approvals(ask, vi.fn(), vi.fn(), vi.fn())
      .accept("approval/requested", { ...request, toolName: "powershell", rawArgs: '{"command":"Get-ChildItem -Force"}' });
    expect(ask.mock.calls[0][0].toolCall).toMatchObject({ title: "Get-ChildItem -Force", kind: "execute" });
  });

  it("preserves offered ids and does not advertise a session grant as persistent", () => {
    expect(permissionOptions(request.availableChoices)).toEqual([
      { optionId: once.choiceId, name: "Allow (once)", kind: "allow_once", _meta: { scope: "once" } },
      { optionId: session.choiceId, name: "Allow this session (session)", kind: "allow_once", _meta: { scope: "session" } },
      { optionId: persistent.choiceId, name: "Save rule (localPersistent)", kind: "allow_always", _meta: { scope: "localPersistent" } },
      { optionId: deny.choiceId, name: "Deny (once)", kind: "reject_once", _meta: { scope: "once" } },
    ]);
  });

  it("decides each requirement once, including a requirement delivered through approval/updated", async () => {
    const ask = vi.fn().mockResolvedValue({ outcome: { outcome: "selected", optionId: session.choiceId } });
    const decide = vi.fn().mockResolvedValue({});
    const fail = vi.fn();
    const approvals = new Approvals(ask, decide, vi.fn(), fail);
    approvals.accept("approval/requested", request);
    approvals.accept("approval/requested", request);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenLastCalledWith({ sessionId: "session", approvalId: "approval",
      requirementId: request.currentRequirementId, choiceId: session.choiceId });
    approvals.accept("approval/updated", { ...request, currentRequirementId: { approvalId: "approval", sourceIndex: 1 } });
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    expect(fail).not.toHaveBeenCalled();
  });

  it("rejects fabricated choices and uses an offered denial on ACP cancellation", async () => {
    const decide = vi.fn(), fail = vi.fn();
    const invalid = new Approvals(async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }), decide, vi.fn(), fail);
    invalid.accept("approval/requested", request);
    await vi.waitFor(() => expect(fail).toHaveBeenCalled());
    expect(decide).not.toHaveBeenCalled();
    const cancelled = new Approvals(async () => ({ outcome: { outcome: "cancelled" } }), decide, vi.fn(), fail);
    cancelled.accept("approval/requested", request);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ choiceId: deny.choiceId })));
  });

  it("discards a late client answer after Muse resolves the approval", async () => {
    let answer!: (value: any) => void;
    const ask = vi.fn(() => new Promise<any>(resolve => { answer = resolve; }));
    const decide = vi.fn();
    const approvals = new Approvals(ask, decide, vi.fn(), vi.fn());
    approvals.accept("approval/requested", request);
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    approvals.accept("approval/resolved", request);
    answer({ outcome: { outcome: "selected", optionId: once.choiceId } });
    await new Promise(resolve => setImmediate(resolve));
    expect(decide).not.toHaveBeenCalled();
  });
});


it("echoes an explicit rejection and surfaces a server refusal", async () => {
  const decide = vi.fn(async () => { throw new Error("approvalRequirementStale"); });
  const fail = vi.fn();
  const approvals = new Approvals(async () => ({ outcome: { outcome: "selected", optionId: deny.choiceId } }), decide, vi.fn(), fail);
  approvals.accept("approval/requested", request);
  await vi.waitFor(() => expect(fail).toHaveBeenCalled());
  expect(decide).toHaveBeenCalledWith(expect.objectContaining({ choiceId: deny.choiceId }));
});

// #221: Muse starts a subagent in its own On request profile, so under the
// parent's Allow all every child step still asked.
describe("a subagent's approval under the parent's Allow all", () => {
  const child = { ...request, subagentOrigin: { childRunId: "run", childSessionId: "kid", subagentId: "sub" },
    subject: { kind: "shell", command: "echo hi" }, protectedWrite: false, judgeEscalated: false };

  function run(params: Record<string, unknown>, allowsAll = true) {
    const ask = vi.fn((_params: any) => new Promise<any>(() => {}));
    const decide = vi.fn().mockResolvedValue({});
    const fail = vi.fn();
    new Approvals(ask, decide, vi.fn(), fail, () => allowsAll).accept("approval/requested", params);
    return { ask, decide, fail };
  }

  it("is answered with the offered once-allow, without a card", async () => {
    const { ask, decide, fail } = run(child);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenCalledWith({ sessionId: "session", approvalId: "approval",
      requirementId: request.currentRequirementId, choiceId: once.choiceId });
    expect(ask).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it.each([
    ["the parent is not in Allow all", child, false],
    ["it is the parent's own approval", { ...child, subagentOrigin: undefined }, true],
    ["its subject kind is one MSP does not name", { ...child, subject: { kind: "teleport" } }, true],
    ["it has no subject", { ...child, subject: undefined }, true],
    ["it is a protected write", { ...child, protectedWrite: true }, true],
    ["the judge escalated it", { ...child, judgeEscalated: true }, true],
    ["no once-allow is offered", { ...child, availableChoices: [session, persistent, deny] }, true],
  ])("still asks the person when %s", async (_label, params, allowsAll) => {
    const { ask, decide } = run(params as Record<string, unknown>, allowsAll as boolean);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(decide).not.toHaveBeenCalled();
  });
});
