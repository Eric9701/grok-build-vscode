import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { RemoteUplink } from "../src/remote-uplink";

describe("RemoteUplink client identity and targeted sends", () => {
  beforeEach(() => { wsMock.sockets.length = 0; });

  it("threads clientId inbound and emits host-to for a cwd group", () => {
    const received: unknown[] = [];
    const ready: Array<{ clientId: string; tabToken?: string }> = [];
    const left: string[] = [];
    const rosters: string[][] = [];
    const uplink = new RemoteUplink({
      relayUrl: "ws://relay",
      token: "token",
      snapshot: (clientId) => [{ type: "error", text: `snapshot:${clientId}` }],
      onClientReady: (clientId, tabToken) => ready.push({ clientId, tabToken }),
      onClientLeft: (clientId) => left.push(clientId),
      onClientRoster: (clientIds) => rosters.push(clientIds),
      onClientMessage: (clientId, msg) => received.push({ clientId, msg }),
      log: () => {},
    });
    uplink.start();
    const socket = wsMock.sockets[0];
    socket.emit("open");

    uplink.broadcastTo(["tab-a", "tab-b"], { type: "messageChunk", text: "shared" });
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
      msg: { type: "messageChunk", text: "shared" },
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
    const uplink = new RemoteUplink({
      relayUrl: "ws://relay",
      token: "token",
      snapshot: () => [],
      onClientRoster: (clientIds) => rosters.push(clientIds),
      onClientMessage: () => {},
      log: () => {},
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

  it("finishes roster reconciliation when a client leaves during reconnect replay", () => {
    const rosters: string[][] = [];
    const uplink = new RemoteUplink({
      relayUrl: "ws://relay",
      token: "token",
      snapshot: () => [],
      onClientRoster: (clientIds) => rosters.push(clientIds),
      onClientMessage: () => {},
      log: () => {},
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
    const uplink = new RemoteUplink({
      relayUrl: "ws://relay",
      token: "token",
      snapshot: () => [],
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
