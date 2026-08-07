import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMsg } from "../src/protocol";
import { pathsEqual } from "../src/worktree";

const wsMock = vi.hoisted(() => {
  const sockets: any[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    handlers = new Map<string, Array<(...args: any[]) => void>>();
    constructor(public readonly url: string) { sockets.push(this); }
    on(event: string, fn: (...args: any[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    send(raw: string) { this.sent.push(raw); }
    close() {}
  }
  return { FakeWebSocket, sockets };
});

vi.mock("ws", () => ({ default: wsMock.FakeWebSocket }));

import {
  filterAuthorizedOutbound,
  filterRecipientsOwningScope,
  RemoteUplink,
  type RemoteUplinkAuth,
} from "../src/remote-uplink";

function openAuth(open: string[] = ["/work/open"]): RemoteUplinkAuth {
  return {
    authorizedCwds: () => open,
    scopeCwdForClient: () => open[0],
    sameCwd: pathsEqual,
  };
}

function makeUplink(overrides: Partial<ConstructorParameters<typeof RemoteUplink>[0]> = {}) {
  return new RemoteUplink({
    relayUrl: "ws://relay",
    token: "token",
    snapshot: () => [],
    auth: openAuth(),
    onClientMessage: () => {},
    log: () => {},
    ...overrides,
  });
}

describe("RemoteUplink client identity and targeted sends", () => {
  beforeEach(() => { wsMock.sockets.length = 0; });

  it("threads clientId inbound and emits host-to for a cwd group", () => {
    const received: unknown[] = [];
    const ready: Array<{ clientId: string; tabToken?: string }> = [];
    const left: string[] = [];
    const rosters: string[][] = [];
    const uplink = makeUplink({
      snapshot: (clientId) => [{ type: "error", text: `snapshot:${clientId}` }],
      onClientReady: (clientId, tabToken) => ready.push({ clientId, tabToken }),
      onClientLeft: (clientId) => left.push(clientId),
      onClientRoster: (clientIds) => rosters.push(clientIds),
      onClientMessage: (clientId, msg) => received.push({ clientId, msg }),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");

    uplink.broadcastTo(["tab-a", "tab-b"], { type: "error", text: "shared" });
    socket.emit("message", Buffer.from(JSON.stringify({
      t: "msg", clientId: "tab-b", msg: { type: "send", text: "hello" },
    })));
    socket.emit("message", Buffer.from(JSON.stringify({ t: "clients", count: 1 })));
    socket.emit("message", Buffer.from(JSON.stringify({
      t: "client-ready",
      clientId: "tab-a",
      tabToken: "0123456789abcdef01234567",
    })));
    socket.emit("message", Buffer.from(JSON.stringify({ t: "client-left", clientId: "tab-b" })));

    expect(socket.sent.map(JSON.parse)).toContainEqual({
      t: "host-to",
      clientIds: ["tab-a", "tab-b"],
      msg: { type: "error", text: "shared" },
    });
    expect(received).toEqual([{ clientId: "tab-b", msg: { type: "send", text: "hello" } }]);
    expect(ready).toEqual([{ clientId: "tab-a", tabToken: "0123456789abcdef01234567" }]);
    expect(left).toEqual(["tab-b"]);
    expect(rosters).toEqual([["tab-a"]]);
    expect(socket.sent.map(JSON.parse)).toContainEqual({
      t: "snapshot",
      clientId: "tab-a",
      msgs: [{ type: "error", text: "snapshot:tab-a" }],
    });
    uplink.dispose();
  });

  it("rebuilds an authoritative roster after reconnect so outage ghosts can be removed", async () => {
    vi.useFakeTimers();
    const rosters: string[][] = [];
    const uplink = makeUplink({
      onClientRoster: (clientIds) => rosters.push(clientIds),
    });
    uplink.start();
    const first = wsMock.sockets[0];
    first.emit("open");
    first.emit("message", Buffer.from(JSON.stringify({ t: "clients", count: 2 })));
    first.emit("message", Buffer.from(JSON.stringify({ t: "client-ready", clientId: "survivor" })));
    first.emit("message", Buffer.from(JSON.stringify({ t: "client-ready", clientId: "ghost" })));

    first.emit("close", 1006);
    await vi.advanceTimersByTimeAsync(1000);
    const second = wsMock.sockets[1];
    second.emit("open");
    second.emit("message", Buffer.from(JSON.stringify({ t: "clients", count: 1 })));
    second.emit("message", Buffer.from(JSON.stringify({ t: "client-ready", clientId: "survivor" })));

    expect(rosters).toEqual([["survivor", "ghost"], ["survivor"]]);
    uplink.dispose();
    vi.useRealTimers();
  });

  it("surfaces an authoritative 4001 revocation and does not retry it", async () => {
    vi.useFakeTimers();
    const revoked = vi.fn();
    const logs: string[] = [];
    const uplink = makeUplink({
      token: "revoked-token",
      onCredentialRevoked: revoked,
      log: (line) => logs.push(line),
    });
    uplink.start();

    wsMock.sockets[0].emit("close", 4001);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("AFK Pilot: Link this device");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wsMock.sockets).toHaveLength(1);

    uplink.dispose();
    vi.useRealTimers();
  });

  it("keeps retrying transient 1011 closes", async () => {
    vi.useFakeTimers();
    const revoked = vi.fn();
    const uplink = makeUplink({
      onCredentialRevoked: revoked,
    });
    uplink.start();

    wsMock.sockets[0].emit("close", 1011);
    expect(revoked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(wsMock.sockets).toHaveLength(2);

    uplink.dispose();
    vi.useRealTimers();
  });

  it("does not treat a dispose-driven 4001 close as revocation", () => {
    const revoked = vi.fn();
    const uplink = makeUplink({
      onCredentialRevoked: revoked,
    });
    uplink.start();
    const socket = wsMock.sockets[0];

    uplink.dispose();
    socket.emit("close", 4001);

    expect(revoked).not.toHaveBeenCalled();
  });

  it("finishes roster reconciliation when a client leaves during reconnect replay", () => {
    const rosters: string[][] = [];
    const uplink = makeUplink({
      onClientRoster: (clientIds) => rosters.push(clientIds),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ t: "clients", count: 2 })));
    socket.emit("message", Buffer.from(JSON.stringify({ t: "client-ready", clientId: "survivor" })));
    socket.emit("message", Buffer.from(JSON.stringify({ t: "client-left", clientId: "departed" })));
    socket.emit("message", Buffer.from(JSON.stringify({ t: "clients", count: 1 })));

    expect(rosters).toEqual([["survivor"]]);
    uplink.dispose();
  });

  it("contains a synchronous client callback failure inside the websocket listener", () => {
    const logs: string[] = [];
    const uplink = makeUplink({
      onClientMessage: () => { throw new Error("bad frame"); },
      log: (line) => logs.push(line),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    expect(() => socket.emit("message", Buffer.from(JSON.stringify({
      t: "msg", clientId: "tab", msg: { type: "send", text: "hello" },
    })))).not.toThrow();
    expect(logs).toContain("[remote] dropped malformed client message: bad frame");
    uplink.dispose();
  });
});

describe("RemoteUplink socket-level project authorization", () => {
  beforeEach(() => { wsMock.sockets.length = 0; });

  const caps = {
    uploadFile: true,
    remoteVoice: true,
    deleteActiveSession: true,
  };
  const closedChunk: HostMsg = { type: "messageChunk", text: "secret from closed" };
  const deviceOk: HostMsg = { type: "error", text: "ok" };
  const closedRepos: HostMsg = {
    type: "repos",
    entries: [{
      cwd: "/work/closed",
      label: "Closed",
      available: true,
      pinned: false,
      updatedAt: 1,
    }],
    selectedCwd: "/work/closed",
    activeCwd: "/work/closed",
  };
  const openRepos: HostMsg = {
    type: "repos",
    entries: [{
      cwd: "/work/open",
      label: "Open",
      available: true,
      pinned: false,
      updatedAt: 1,
    }],
    selectedCwd: "/work/open",
    activeCwd: "/work/open",
  };
  const closedInitial: HostMsg = {
    type: "initialState",
    effort: "",
    cwd: "/work/closed",
    useCtrlEnter: false,
    extVersion: "0",
    showThinking: false,
    expandCommandOutputs: false,
    steerByDefault: false,
    soundNotifications: false,
    processingSound: false,
    readRepliesAloud: false,
    capabilities: caps,
  };
  const unboundInitial: HostMsg = {
    type: "initialState",
    effort: "",
    cwd: "",
    useCtrlEnter: false,
    extVersion: "0",
    showThinking: false,
    expandCommandOutputs: false,
    steerByDefault: false,
    soundNotifications: false,
    processingSound: false,
    readRepliesAloud: false,
    capabilities: caps,
  };

  it("filterAuthorizedOutbound scrubs closed-project conversation and catalog frames", () => {
    const open = ["/work/open"];
    const voiceCfg: HostMsg = {
      type: "voiceConfigured",
      value: true,
      sendPhrase: "from-closed-project",
    };
    const kept = filterAuthorizedOutbound(
      [
        deviceOk,
        closedChunk,
        closedRepos,
        openRepos,
        closedInitial,
        voiceCfg,
        { type: "clearMessages" },
      ],
      open,
      "/work/closed", // stale session scope
      pathsEqual,
    );
    // voiceConfigured is project-scoped: closed scope must drop it too.
    expect(kept.map((m) => m.type)).toEqual(["error", "repos", "clearMessages"]);
    expect(kept.find((m) => m.type === "repos")).toEqual(openRepos);
    expect(kept.some((m) => m.type === "voiceConfigured")).toBe(false);
  });

  it("mutation: without the filter a closed-project snapshot would leave intact", () => {
    const leaky = [closedChunk, closedRepos, closedInitial];
    // Old path: snapshotFrame(clientId, rawMsgs) with no gate.
    expect(leaky).toHaveLength(3);
    const scrubbed = filterAuthorizedOutbound(leaky, ["/work/open"], "/work/closed", pathsEqual);
    expect(scrubbed).toEqual([]);
  });

  it("refuses broadcastTo of conversation payload under a closed scope", () => {
    const logs: string[] = [];
    const uplink = makeUplink({
      auth: openAuth(["/work/open"]),
      log: (l) => logs.push(l),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");

    uplink.broadcastTo(["tab"], closedChunk, "/work/closed");
    expect(socket.sent.map(JSON.parse).filter((f: { t: string }) => f.t === "host-to")).toEqual([]);
    expect(logs.some((l) => l.includes("dropped messageChunk"))).toBe(true);

    uplink.broadcastTo(["tab"], closedChunk, "/work/open");
    expect(socket.sent.map(JSON.parse)).toContainEqual({
      t: "host-to",
      clientIds: ["tab"],
      msg: closedChunk,
    });
    uplink.dispose();
  });

  it("refuses broadcastTo when a recipient does not own the scope", () => {
    const logs: string[] = [];
    const scopes: Record<string, string> = {
      "tab-a": "/work/a",
      "tab-b": "/work/b",
    };
    const uplink = makeUplink({
      auth: {
        authorizedCwds: () => ["/work/a", "/work/b"],
        scopeCwdForClient: (id) => scopes[id],
        sameCwd: pathsEqual,
      },
      log: (l) => logs.push(l),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");

    // Caller incorrectly includes tab-b under /work/a — ownership filter drops it.
    uplink.broadcastTo(["tab-a", "tab-b"], closedChunk, "/work/a");
    const hostTo = socket.sent.map(JSON.parse).filter((f: { t: string }) => f.t === "host-to");
    expect(hostTo).toEqual([
      {
        t: "host-to",
        clientIds: ["tab-a"],
        msg: closedChunk,
      },
    ]);
    expect(logs.some((l) => l.includes("does not own scope") && l.includes("tab-b"))).toBe(true);

    // No owners at all → no write.
    socket.sent.length = 0;
    uplink.broadcastTo(["tab-b"], closedChunk, "/work/a");
    expect(socket.sent.map(JSON.parse).filter((f: { t: string }) => f.t === "host-to")).toEqual([]);
    uplink.dispose();
  });

  it("delivers a sibling project's rail preview to a tab that does not own it", () => {
    // The regression that put "Update Grok Build to preview" on the phone
    // against a fully current desktop: the rail asks for a preview of a project
    // the tab is NOT working in, the host answered, and the ownership filter
    // ate every answer because the frame's own cwd was passed as the delivery
    // scope. Frames that carry their own cwd are ABOUT a project, not payload
    // FROM the recipient's conversation.
    const logs: string[] = [];
    const preview: HostMsg = {
      type: "repoSessions",
      cwd: "/work/sibling",
      entries: [{ id: "s1", title: "In the other project", cwd: "/work/sibling" } as any],
      dots: {},
      total: 1,
    };
    const uplink = makeUplink({
      auth: {
        // Both projects are open; the tab is working in /work/a.
        authorizedCwds: () => ["/work/a", "/work/sibling"],
        scopeCwdForClient: () => "/work/a",
        sameCwd: pathsEqual,
      },
      log: (l) => logs.push(l),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");

    uplink.broadcastTo(["tab-a"], preview, "/work/sibling");
    expect(socket.sent.map(JSON.parse).filter((f: { t: string }) => f.t === "host-to")).toEqual([
      { t: "host-to", clientIds: ["tab-a"], msg: preview },
    ]);
    expect(logs.some((l) => l.includes("does not own scope"))).toBe(false);

    // Authorization is untouched: a project that is not open is still refused,
    // and the frame's OWN cwd is what decides — not the scope argument.
    socket.sent.length = 0;
    const closedPreview = { ...preview, cwd: "/work/closed", entries: [] } as HostMsg;
    uplink.broadcastTo(["tab-a"], closedPreview, "/work/closed");
    expect(socket.sent.map(JSON.parse).filter((f: { t: string }) => f.t === "host-to")).toEqual([]);
    uplink.dispose();
  });

  it("filterRecipientsOwningScope is pure and mutation-checked", () => {
    const auth: RemoteUplinkAuth = {
      authorizedCwds: () => ["/a", "/b"],
      scopeCwdForClient: (id) => (id === "x" ? "/a" : "/b"),
      sameCwd: pathsEqual,
    };
    expect(filterRecipientsOwningScope(["x", "y"], "/a", auth)).toEqual(["x"]);
    expect(filterRecipientsOwningScope(["y"], "/a", auth)).toEqual([]);
    // Richer ownership (repo select vs session cwd).
    const rich: RemoteUplinkAuth = {
      ...auth,
      clientOwnsScope: (id, scope) => id === "y" && scope === "/a",
    };
    expect(filterRecipientsOwningScope(["x", "y"], "/a", rich)).toEqual(["y"]);

    // Mutation: without the filter, both ids would ship under a forged multi-client list.
    const withoutFilter = ["x", "y"];
    expect(withoutFilter).toContain("y");
    expect(filterRecipientsOwningScope(withoutFilter, "/a", auth)).not.toContain("y");
  });

  it("source gate: deliver/broadcastTo ownership filter is on the write path", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "remote-uplink.ts"),
      "utf8",
    );
    expect(src).toContain("filterRecipientsOwningScope");
    expect(src).toMatch(/deliver\([\s\S]*filterRecipientsOwningScope/);
    expect(src).toContain("does not own scope");
    // Sidebar wires clientOwnsScope for repo + session ownership.
    const sidebar = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
      "utf8",
    );
    expect(sidebar).toContain("clientOwnsScope:");
  });

  it("scrubs closed-project data out of the catch-up snapshot frame", () => {
    const logs: string[] = [];
    const uplink = makeUplink({
      auth: {
        authorizedCwds: () => ["/work/open"],
        // Tab still bound to closed session cwd (revoke race / stale mapping).
        scopeCwdForClient: () => "/work/closed",
        sameCwd: pathsEqual,
      },
      snapshot: () => [
        deviceOk,
        closedChunk,
        closedRepos,
        openRepos,
        { type: "clearMessages" },
        unboundInitial,
      ],
      log: (l) => logs.push(l),
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ t: "client-ready", clientId: "tab-a" })));

    const snap = socket.sent.map(JSON.parse).find((f: { t: string }) => f.t === "snapshot");
    expect(snap).toBeDefined();
    expect(snap.msgs.map((m: HostMsg) => m.type)).toEqual([
      "error",
      "repos",
      "clearMessages",
      "initialState",
    ]);
    expect(snap.msgs.find((m: HostMsg) => m.type === "repos")).toEqual(openRepos);
    expect(logs.some((l) => l.includes("scrubbed"))).toBe(true);
    uplink.dispose();
  });

  it("mutation: snapshot path without uplink gate would deliver closed transcript", () => {
    // Documents the hole deliverRemote never covered: client-ready → snapshotFrame
    // used opts.snapshot() bytes directly. With the gate, closed chunks are gone.
    const raw = [closedChunk, deviceOk];
    const scopeClosed = "/work/closed";
    const withoutGate = raw; // old
    expect(withoutGate.some((m) => m.type === "messageChunk")).toBe(true);
    const withGate = filterAuthorizedOutbound(raw, ["/work/open"], scopeClosed, pathsEqual);
    expect(withGate.some((m) => m.type === "messageChunk")).toBe(false);
    expect(withGate).toEqual([deviceOk]);
  });
});
