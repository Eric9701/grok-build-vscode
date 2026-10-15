/**
 * A click on a conversation always wins over another view's load of it.
 *
 * The reservation keeps two CLI processes from `session/load`ing one session
 * directory at once. It used to do that by REFUSING the second view: a desk
 * click while a web tab was loading logged "refused local resume", showed a
 * toast and sent the view nothing, so the rail's give-up timer snapped the
 * selection back. Now the click waits for that load, takes the reservation
 * itself, and opens what the load left -- still never two loads at once.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";

const cwd = "/repo";

function makeSidebar(): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.sessionLoadReservations = new Map();
  sidebar.localOpenSeq = 0;
  sidebar.remoteOpenSeq = new Map();
  sidebar.remoteClients = new RemoteClientState<Session>(cwd);
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.cwd = cwd;
  sidebar.log = [] as string[];
  sidebar.host = {
    canSwitchWorkspaceFolder: false,
    appendLine: vi.fn((line: string) => sidebar.log.push(line)),
    showInformationMessage: vi.fn(async () => undefined),
  };
  sidebar.local = [] as HostMsg[];
  sidebar.postLocal = vi.fn((msg: HostMsg) => sidebar.local.push(msg));
  sidebar.sent = [] as Array<{ clientId: string; msg: HostMsg }>;
  sidebar.sendRemoteClient = vi.fn((clientId: string, msg: HostMsg) => sidebar.sent.push({ clientId, msg }));
  sidebar.loads = [] as string[];
  sidebar.openSessionReserved = vi.fn(async (id: string) => {
    sidebar.loads.push(id);
    sidebar.focused.activeSessionId = id;
  });
  sidebar.openRemoteSessionReserved = vi.fn(async (_clientId: string, id: string) => { sidebar.loads.push(`remote:${id}`); });
  sidebar.refuseRemoteResume = vi.fn();
  sidebar.sweepEmptySessions = vi.fn();
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  sidebar.resolveLocalRepoTarget = vi.fn(() => undefined);
  return sidebar;
}

/** Another view's cold load of `id`, as openRemoteSession / openSession take it. */
function holdLoad(sidebar: any, id: string, tabToken?: string) {
  const claim = sidebar.reserveSessionLoad(id, tabToken);
  expect(claim).toBeTruthy();
  return {
    finish: (error?: unknown) => sidebar.releaseSessionLoad(id, claim.reservation, error),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a click on a conversation another view is loading", () => {
  it("waits for that load and then opens the conversation, instead of being refused", async () => {
    const sidebar = makeSidebar();
    const web = holdLoad(sidebar, "conv-1", "web-tab");

    const click = sidebar.openSession("conv-1");
    await flush();
    // Not refused: no refusal line, no toast, and the view is told it waits.
    expect(sidebar.log.join("\n")).not.toContain("refused local resume");
    expect(sidebar.host.showInformationMessage).not.toHaveBeenCalled();
    expect(sidebar.local).toEqual([
      { type: "sessionOpening", sessionId: "conv-1" },
      { type: "sessionOpening", sessionId: "conv-1", queued: true },
    ]);
    // ...and it does not load alongside the web tab's load (the race the
    // reservation exists for).
    expect(sidebar.loads).toEqual([]);

    web.finish();
    await click;
    expect(sidebar.loads).toEqual(["conv-1"]);
    expect(sidebar.focused.activeSessionId).toBe("conv-1");
    expect(sidebar.local.some((m: any) => m.failed)).toBe(false);
    expect(sidebar.sessionLoadReservations.size).toBe(0);
  });

  it("loads it itself when the load it waited for failed", async () => {
    const sidebar = makeSidebar();
    const web = holdLoad(sidebar, "conv-1", "web-tab");
    const click = sidebar.openSession("conv-1");
    await flush();
    web.finish(new Error("spawn failed"));
    await click;
    expect(sidebar.loads).toEqual(["conv-1"]);
  });

  it("gives way to a newer click, which opens at once", async () => {
    const sidebar = makeSidebar();
    const web = holdLoad(sidebar, "conv-1", "web-tab");
    const first = sidebar.openSession("conv-1");
    await flush();
    await sidebar.openSession("conv-2");
    expect(sidebar.loads).toEqual(["conv-2"]);
    web.finish();
    await first;
    // The superseded click neither loads nor tells the view it failed: the
    // view is on conv-2, which the newer click owns.
    expect(sidebar.loads).toEqual(["conv-2"]);
    expect(sidebar.local.filter((m: any) => m.sessionId === "conv-1" && m.failed)).toEqual([]);
    expect(sidebar.host.showInformationMessage).not.toHaveBeenCalled();
  });

  it("tells the view when the open ends without the conversation", async () => {
    const sidebar = makeSidebar();
    sidebar.openSessionReserved = vi.fn(async () => { /* startSession swallowed a failed load */ });
    await sidebar.openSession("conv-1");
    expect(sidebar.local.at(-1)).toEqual({ type: "sessionOpening", sessionId: "conv-1", failed: true });
  });

  it("a tap on a phone waits behind the desk's load the same way; a reconnect restore still refuses", async () => {
    const sidebar = makeSidebar();
    sidebar.remoteClients.ready("phone");
    const desk = holdLoad(sidebar, "conv-1");

    // Reconnect restore: no claim, not a person choosing it.
    await sidebar.openRemoteSession("phone", "conv-1", undefined, true, false);
    expect(sidebar.refuseRemoteResume).toHaveBeenCalledTimes(1);

    const tap = sidebar.openRemoteSession("phone", "conv-1", undefined, true, true);
    await flush();
    expect(sidebar.sent.map((s: any) => s.msg)).toEqual([{ type: "sessionOpening", sessionId: "conv-1", queued: true }]);
    expect(sidebar.loads).toEqual([]);
    desk.finish();
    await tap;
    expect(sidebar.loads).toEqual(["remote:conv-1"]);
    expect(sidebar.refuseRemoteResume).toHaveBeenCalledTimes(1);
  });
});
