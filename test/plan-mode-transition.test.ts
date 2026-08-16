import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";

function makeSidebar(session: Session): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.focused = session;
  sidebar.view = undefined;
  sidebar.sendRemoteSession = vi.fn();
  sidebar.emit = vi.fn();
  sidebar.host = {
    getConfiguration: () => ({ update: vi.fn(async () => {}) }),
    showErrorMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
  };
  return sidebar;
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
