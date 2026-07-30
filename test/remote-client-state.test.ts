import { describe, expect, it } from "vitest";
import { RemoteClientState, serializesRemoteSessionTransition } from "../src/remote-client-state";

const norm = (cwd: string) => cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

describe("RemoteClientState", () => {
  it("tracks repo selection per client without moving another tab", () => {
    const state = new RemoteClientState<object>("C:\\Work\\A", norm);
    state.ready("tab-a");
    state.ready("tab-b");

    state.select("tab-a", "C:\\Work\\B");

    expect(state.cwd("tab-a")).toBe("C:\\Work\\B");
    expect(state.cwd("tab-b")).toBe("C:\\Work\\A");
    expect(state.clientsForCwd("C:\\Work\\B")).toEqual(["tab-a"]);
    expect(state.clientsForCwd("C:\\Work\\A")).toEqual(["tab-b"]);
  });

  it("cannot inspect a missing client's cwd by implicitly recreating it", () => {
    const state = new RemoteClientState<object>("/work/a", norm);

    expect(state.cwdIfPresent("departed")).toBeUndefined();
    expect(state.clients()).toEqual([]);
    expect(() => state.cwd("departed")).toThrow(/not ready/);
    expect(state.clients()).toEqual([]);
  });

  it("keeps active sessions independent for clients on the same cwd", () => {
    const state = new RemoteClientState<{ id: string }>("/work/a", norm);
    state.ready("tab-a");
    state.ready("tab-b");
    state.ready("tab-c");
    state.select("tab-b", "/work/a");
    state.select("tab-c", "/work/b");
    const sessionA = { id: "session-a" };
    const sessionB = { id: "session-b" };
    state.setActive("tab-a", sessionA);
    state.setActive("tab-b", sessionB);

    expect(state.active("tab-a")).toBe(sessionA);
    expect(state.active("tab-b")).toBe(sessionB);
    expect(state.clientsForCwd("/work/a")).toEqual(["tab-a", "tab-b"]);
    expect(state.clientsForCwd("/work/b")).toEqual(["tab-c"]);
  });

  it("removes a departed client from cwd groups", () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    state.ready("tab-a");
    state.ready("tab-b");
    state.deleteClient("tab-a");

    expect(state.clients()).toEqual(["tab-b"]);
    expect(state.clientsForCwd("/work/a")).toEqual(["tab-b"]);
  });

  it("reconciles a reconnect roster without losing surviving clients' repo selection", () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    const ghostSession = {};
    state.ready("survivor");
    state.ready("ghost");
    state.select("survivor", "/work/b");
    state.select("ghost", "/work/c");
    state.setActive("ghost", ghostSession);

    expect(state.retainClients(["survivor"])).toEqual(["ghost"]);
    expect(state.clients()).toEqual(["survivor"]);
    expect(state.cwd("survivor")).toBe("/work/b");
    expect(state.isActiveValueVisible(ghostSession)).toBe(false);
  });

  it("hands one logical tab's cwd and active session to a replacement relay connection", () => {
    const state = new RemoteClientState<{ id: string }>("/work/a", norm);
    const session = { id: "remembered" };
    state.identify("old-socket", "same-logical-tab-token");
    state.ready("old-socket");
    state.select("old-socket", "/work/b");
    state.setActive("old-socket", session);

    expect(state.identify("new-socket", "same-logical-tab-token")).toBe("old-socket");
    expect(state.cwd("new-socket")).toBe("/work/b");
    expect(state.active("new-socket")).toBe(session);
    expect(state.clients()).toEqual(["new-socket"]);
    expect(state.isCurrent("new-socket")).toBe(true);
    expect(state.isCurrent("old-socket")).toBe(false);

    state.deleteClient("old-socket");
    expect(state.active("new-socket")).toBe(session);
    expect(state.isCurrent("new-socket")).toBe(true);
    expect(state.tabToken("new-socket")).toBe("same-logical-tab-token");
    expect(state.clientForTabToken("same-logical-tab-token")).toBe("new-socket");
  });

  it("does not hand ownership to an unrelated logical tab", () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    const session = {};
    state.identify("owner", "owner-logical-tab-token");
    state.ready("owner");
    state.setActive("owner", session);

    expect(state.identify("unrelated", "different-logical-tab-token")).toBeUndefined();
    expect(state.active("owner")).toBe(session);
    expect(state.active("unrelated")).toBeUndefined();
  });

  it("retains startup ownership when client-left precedes the replacement handshake", () => {
    const state = new RemoteClientState<{ id: string }>("/work/a", norm);
    const session = { id: "starting" };
    state.identify("old-client", "stable-tab-token");
    state.ready("old-client");
    state.select("old-client", "/work/b");
    state.setActive("old-client", session);

    state.detachClient("old-client");
    expect(state.clients()).toEqual([]);
    expect(state.identify("replacement", "stable-tab-token")).toBeUndefined();
    state.ready("replacement");

    expect(state.cwd("replacement")).toBe("/work/b");
    expect(state.active("replacement")).toBe(session);
  });

  it("drops a tab's active session when that tab selects another repository", () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    const session = {};
    state.ready("tab");
    state.setActive("tab", session);

    state.select("tab", "/work/b");

    expect(state.active("tab")).toBeUndefined();
    expect(state.cwd("tab")).toBe("/work/b");
  });

  it("evicts a disposed session from every cwd active map", () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    state.ready("tab-a");
    state.ready("tab-b");
    const session = {};
    state.setActive("tab-a", session);
    state.setActive("tab-b", session);

    state.deleteActiveValue(session);

    expect(state.active("tab-a")).toBeUndefined();
    expect(state.active("tab-b")).toBeUndefined();
  });

  it("marks an active session visible only while a client is looking at its cwd", () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    const session = {};
    state.ready("tab");
    state.setActive("tab", session);

    expect(state.isActiveValueVisible(session)).toBe(true);
    state.deleteClient("tab");
    expect(state.isActiveValueVisible(session)).toBe(false);
  });

  it("serializes one tab's transitions while allowing another tab to proceed", async () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = state.runExclusive("tab-a", async () => {
      events.push("a1:start");
      await blocked;
      events.push("a1:end");
    });
    const second = state.runExclusive("tab-a", async () => {
      events.push("a2");
    });
    const other = state.runExclusive("tab-b", async () => {
      events.push("b");
    });

    await other;
    expect(events).toEqual(["a1:start", "b"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1:start", "b", "a1:end", "a2"]);
  });

  it("queues New and Resume together per tab while resumes also serialize by session id", async () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    state.ready("tab-a");
    state.ready("tab-b");
    const events: string[] = [];
    let releaseResume!: () => void;
    const blockedResume = new Promise<void>((resolve) => { releaseResume = resolve; });

    const resumeA = state.runSessionTransition("tab-a", "shared", async () => {
      events.push("resume-a:start");
      await blockedResume;
      events.push("resume-a:end");
    });
    const newA = state.runSessionTransition("tab-a", undefined, async () => {
      events.push("new-a");
    });
    const resumeB = state.runSessionTransition("tab-b", "shared", async () => {
      events.push("resume-b");
    });
    const newB = state.runSessionTransition("tab-b", undefined, async () => {
      events.push("new-b");
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["resume-a:start"]);
    releaseResume();
    await Promise.all([resumeA, newA, resumeB, newB]);
    expect(events.indexOf("resume-a:end")).toBeLessThan(events.indexOf("new-a"));
    expect(events.indexOf("resume-a:end")).toBeLessThan(events.indexOf("resume-b"));
    expect(events.indexOf("resume-b")).toBeLessThan(events.indexOf("new-b"));
  });

  it("does not resurrect a departed client from a queued runSessionTransition", async () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    state.ready("tab-a");
    const dispatchCwd = state.cwd("tab-a");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let queuedRan = false;

    const first = state.runSessionTransition("tab-a", undefined, async () => {
      await blocked;
    });
    const second = state.runSessionTransition("tab-a", undefined, async () => {
      const currentCwd = state.cwdIfPresent("tab-a");
      if (!currentCwd || norm(currentCwd) !== norm(dispatchCwd)) return;
      queuedRan = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    state.deleteClient("tab-a");
    release();
    await Promise.all([first, second]);

    expect(queuedRan).toBe(false);
    expect(state.cwdIfPresent("tab-a")).toBeUndefined();
    expect(state.clients()).toEqual([]);
  });

  it("drops the prefixed transition tail when a client departs", async () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    state.ready("tab-a");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];

    const departed = state.runSessionTransition("tab-a", undefined, async () => {
      events.push("departed:start");
      await blocked;
      events.push("departed:end");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    state.deleteClient("tab-a");
    state.ready("tab-a");
    const replacement = state.runSessionTransition("tab-a", undefined, async () => {
      events.push("replacement");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual(["departed:start", "replacement"]);
    release();
    await Promise.all([departed, replacement]);
  });

  it("lets only the first of two concurrent new-session requests replace the captured active session", async () => {
    const state = new RemoteClientState<{ id: string }>("/work/a", norm);
    state.ready("tab-a");
    const original = { id: "original" };
    state.setActive("tab-a", original);
    const created: string[] = [];

    const request = () => {
      const expected = state.active("tab-a");
      return state.runSessionOperation("client:tab-a", "newSession", async () => {
        if (state.active("tab-a") !== expected) return false;
        const session = { id: `new-${created.length + 1}` };
        created.push(session.id);
        state.setActive("tab-a", session);
        await Promise.resolve();
        return true;
      });
    };

    const first = request();
    const second = request();

    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(created).toEqual(["new-1"]);
    expect(state.active("tab-a")?.id).toBe("new-1");
  });

  it("does not serialize a turn or the later control that must unblock it", async () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    let release!: () => void;
    const answer = new Promise<void>((resolve) => { release = resolve; });

    const send = state.runSessionOperation("client:tab-a", "send", async () => { await answer; });
    let processed = false;
    const permission = state.runSessionOperation("client:tab-a", "permissionAnswer", async () => {
      processed = true;
      release();
    });

    await permission;
    await send;
    expect(processed).toBe(true);
    expect(serializesRemoteSessionTransition("newSession")).toBe(true);
    expect(serializesRemoteSessionTransition("resumeSession")).toBe(true);
    expect(serializesRemoteSessionTransition("selectRepo")).toBe(true);
  });

  it("holds an adjacent send until New finishes but leaves mid-turn controls unblocked", async () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    state.ready("tab-a");
    const events: string[] = [];
    let finishNew!: () => void;
    const newReady = new Promise<void>((resolve) => { finishNew = resolve; });

    const newSession = state.runSessionTransition("tab-a", undefined, async () => {
      events.push("new:start");
      await newReady;
      events.push("new:ready");
    });
    const send = state.runAfterSessionTransition("tab-a", async () => {
      events.push("send");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["new:start"]);
    const permission = state.runSessionOperation("tab-a", "permissionAnswer", async () => {
      events.push("permission");
      finishNew();
    });

    await permission;
    await Promise.all([newSession, send]);
    expect(events).toEqual(["new:start", "permission", "new:ready", "send"]);
  });

  it("keeps a logical tab's transition tail across a relay-client handoff", async () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    const events: string[] = [];
    let finishNew!: () => void;
    const newReady = new Promise<void>((resolve) => { finishNew = resolve; });
    state.identify("old-client", "stable-tab-token");
    state.ready("old-client");

    const newSession = state.runSessionTransition("old-client", undefined, async () => {
      events.push("new:start");
      await newReady;
      events.push("new:ready");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(state.identify("replacement", "stable-tab-token")).toBe("old-client");
    state.deleteClient("old-client");
    const nextTransition = state.runSessionTransition("replacement", undefined, async () => {
      events.push("next-transition");
    });
    const send = state.runAfterSessionTransition("replacement", async () => {
      events.push("send");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["new:start"]);

    const permission = state.runSessionOperation("replacement", "permissionAnswer", async () => {
      events.push("permission");
      finishNew();
    });
    await permission;
    await Promise.all([newSession, nextTransition, send]);
    expect(events).toEqual([
      "new:start",
      "permission",
      "new:ready",
      "next-transition",
      "send",
    ]);
  });

  it("executes a send already queued by a superseded client as the replacement owner", async () => {
    const state = new RemoteClientState<object>("/work/a", norm);
    const tabToken = "stable-tab-token";
    let finishTransition!: () => void;
    const transitionReady = new Promise<void>((resolve) => { finishTransition = resolve; });
    state.identify("old-client", tabToken);
    state.ready("old-client");
    state.select("old-client", "/work/b");

    const transition = state.runSessionTransition("old-client", undefined, async () => {
      await transitionReady;
    });
    const dispatched: Array<{ clientId: string; cwd: string }> = [];
    const alreadyQueuedSend = state.runAfterSessionTransition("old-client", async (currentClientId) => {
      dispatched.push({ clientId: currentClientId, cwd: state.cwd(currentClientId) });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(state.identify("replacement", tabToken)).toBe("old-client");
    state.ready("replacement");
    state.deleteClient("old-client");
    finishTransition();
    await Promise.all([transition, alreadyQueuedSend]);

    expect(dispatched).toEqual([{ clientId: "replacement", cwd: "/work/b" }]);
    expect(state.cwdIfPresent("old-client")).toBeUndefined();
    expect(() => state.cwd("old-client")).toThrow(/not ready/);
    expect(state.clients()).toEqual(["replacement"]);
  });
});
