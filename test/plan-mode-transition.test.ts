import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import type { AcpBackend } from "../src/acp-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { CodexBackend } from "../src/codex-backend";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

function makeSidebar(session: Session): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.focused = session;
  sidebar.view = undefined;
  sidebar.sendRemoteSession = vi.fn();
  sidebar.emit = vi.fn();
  sidebar.setStatus = vi.fn();
  sidebar.host = {
    getConfiguration: () => ({ update: vi.fn(async () => {}) }),
    showErrorMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
  };
  return sidebar;
}

function clientWithFakeProc(opts?: { backend?: AcpBackend }): { client: AcpClient; written: string[] } {
  const client = new AcpClient({
    cliPath: "x",
    cwd: "/workspace",
    log: () => {},
    ...(opts?.backend ? { backend: opts.backend } : {}),
  });
  const written: string[] = [];
  (client as any).proc = {
    killed: false,
    stdin: { writable: true, write: (s: string) => written.push(s) },
  };
  (client as any).sessionId = "session-1";
  return { client, written };
}

function permissionReply(written: string[], id: number): any {
  return written.map((line) => JSON.parse(line)).find((msg) => msg.id === id && msg.result);
}

const EDIT_PERMISSION = {
  sessionId: "session-1",
  toolCall: { toolCallId: "tc-edit", kind: "edit", title: "Edit file.ts" },
  options: [
    { optionId: "allow-always", kind: "allow_always", name: "Always" },
    { optionId: "allow-once", kind: "allow_once", name: "Once" },
    { optionId: "reject-once", kind: "reject_once", name: "Reject" },
  ],
};

/** Codex adapter shape: allow_once means "implement this plan". */
const CODEX_PLAN_REVIEW = {
  sessionId: "session-1",
  toolCall: {
    toolCallId: "plan-review:item-1",
    title: "Implement this plan?",
    kind: "switch_mode",
    status: "pending",
    rawInput: { plan: "# Plan\n\n1. Change it" },
  },
  options: [
    { optionId: "implement_plan", name: "Yes, implement this plan", kind: "allow_once" },
    { optionId: "revise_plan", name: "No, and tell Codex what to do differently", kind: "reject_once" },
  ],
  _meta: { codex: { kind: "plan_review", planItemId: "item-1" } },
};

/** Claude ExitPlanMode: allow_once/always options all mean leave Plan and implement. */
const CLAUDE_EXIT_PLAN = {
  sessionId: "session-1",
  toolCall: {
    toolCallId: "exit-plan-1",
    title: "Ready to code?",
    kind: "switch_mode",
    rawInput: { plan: "# Plan\n\n1. Change it" },
  },
  options: [
    { optionId: "acceptEdits", kind: "allow_always", name: "Yes, and auto-accept edits" },
    { optionId: "default", kind: "allow_once", name: "Yes, and manually approve edits" },
    { optionId: "plan", kind: "reject_once", name: "No, keep planning" },
  ],
};

async function dispatchSetModeThenPermission(
  sidebar: any,
  session: Session,
  client: AcpClient,
  written: string[],
  permission: object = EDIT_PERMISSION,
): Promise<any> {
  client.on("permissionRequest", (req) => {
    sidebar.handlePermissionRequest(session, client, req, "/workspace");
  });

  const stdout = new PassThrough();
  const rl = createInterface({ input: stdout });
  rl.on("line", (line) => (client as any).onLine(line));

  try {
    const pending = sidebar.setMode("plan", session);
    const req = JSON.parse(written[0]);
    expect(["session/set_mode", "session/set_config_option"]).toContain(req.method);

    stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }) + "\n" +
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: permission,
      }) + "\n",
    );

    await pending;
    return permissionReply(written, 99);
  } finally {
    rl.close();
    stdout.destroy();
  }
}

function liveSession(overrides: Partial<Session> = {}): Session {
  const session = new Session();
  session.planModeAvailable = true;
  session.planModeVersionVerified = true;
  session.priming = false;
  session.planActive = false;
  session.autoApprove = false;
  session.client = {
    sessionId: "s1",
    planActive: false,
    setMode: vi.fn(async () => {}),
  } as any;
  Object.assign(session, overrides);
  return session;
}

describe("Plan transition outcome", () => {
  it("does not claim Plan when session/set_mode is rejected", async () => {
    const session = liveSession({
      autoApprove: true,
      client: {
        sessionId: "s1",
        planActive: false,
        setMode: vi.fn(async () => { throw new Error("mode refused"); }),
      } as any,
    });
    const sidebar = makeSidebar(session);

    await sidebar.setMode("plan", session);

    expect(session.planActive).toBe(false);
    expect(session.client.planActive).toBe(false);
    expect(session.autoApprove).toBe(true);
    expect(sidebar.displayMode(session)).toBe("yolo");
    expect(sidebar.host.showErrorMessage).toHaveBeenCalledWith("Couldn't switch mode: mode refused");
  });

  it("raises Plan only after session/set_mode succeeds", async () => {
    let planActiveDuringRpc = true;
    const session = liveSession({
      autoApprove: true,
    });
    session.client = {
      sessionId: "s1",
      planActive: false,
      setMode: vi.fn(async () => {
        planActiveDuringRpc = session.planActive;
      }),
    } as any;
    const sidebar = makeSidebar(session);

    await sidebar.setMode("plan", session);

    expect(planActiveDuringRpc).toBe(false);
    expect(session.planActive).toBe(true);
    expect(session.autoApprove).toBe(false);
    expect(sidebar.displayMode(session)).toBe("plan");
    expect(session.client.setMode).toHaveBeenCalledWith("plan");
  });
});

describe("Plan permission same-chunk raise", () => {
  it("does not auto-grant a same-chunk request_permission when leaving Auto accept for Plan", async () => {
    const { client, written } = clientWithFakeProc();
    const session = liveSession({ autoApprove: true, client });
    const sidebar = makeSidebar(session);

    const reply = await dispatchSetModeThenPermission(sidebar, session, client, written);

    expect(reply).toBeDefined();
    expect(reply.result.outcome.optionId).not.toBe("allow-always");
    expect(reply.result.outcome.optionId).not.toBe("allow-once");
    expect(reply.result.outcome).toEqual({
      outcome: "selected",
      optionId: "reject-once",
    });
    expect(client.planActive).toBe(true);
  });

  it("does not auto-grant a same-chunk Codex plan-review permission", async () => {
    const { client, written } = clientWithFakeProc({ backend: new CodexBackend() });
    const session = liveSession({ autoApprove: true, client });
    session.provider = "codex";
    const sidebar = makeSidebar(session);

    const reply = await dispatchSetModeThenPermission(
      sidebar,
      session,
      client,
      written,
      CODEX_PLAN_REVIEW,
    );

    expect(reply?.result?.outcome?.optionId).not.toBe("implement_plan");
    expect(client.usesClientPlanGate).toBe(false);
  });

  it("does not auto-grant a same-chunk Claude ExitPlanMode permission", async () => {
    const { client, written } = clientWithFakeProc({ backend: new ClaudeBackend() });
    const session = liveSession({ autoApprove: true, client });
    session.provider = "claude";
    const sidebar = makeSidebar(session);

    const reply = await dispatchSetModeThenPermission(
      sidebar,
      session,
      client,
      written,
      CLAUDE_EXIT_PLAN,
    );

    expect(reply?.result?.outcome?.optionId).not.toBe("acceptEdits");
    expect(reply?.result?.outcome?.optionId).not.toBe("default");
    expect(client.usesClientPlanGate).toBe(false);
  });

  it("does not apply grok's Plan write refusal to a same-chunk Codex edit", async () => {
    const { client, written } = clientWithFakeProc({ backend: new CodexBackend() });
    const session = liveSession({ autoApprove: true, client });
    session.provider = "codex";
    const sidebar = makeSidebar(session);

    const reply = await dispatchSetModeThenPermission(sidebar, session, client, written);

    expect(reply?.result?.outcome?.optionId).not.toBe("reject-once");
    expect(reply?.result?.outcome?.optionId).not.toBe("allow-always");
    expect(reply?.result?.outcome?.optionId).not.toBe("allow-once");
    expect(client.usesClientPlanGate).toBe(false);
  });
});
