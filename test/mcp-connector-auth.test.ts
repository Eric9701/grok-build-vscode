import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { authorizeMcpRemote, listenFreeLoopbackPort, npxSpawnPlan } from "../src/mcp-connector-auth";
import { MCP_INITIALIZE_REQUEST, connectFailureMessage } from "../src/mcp-connectors";

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  written = "";

  constructor() {
    super();
    this.stdin.on("data", (buf: Buffer) => { this.written += String(buf); });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    this.emit("close", null, "SIGTERM");
    return true;
  }
}

describe("sidebar connect wiring", () => {
  it("always supplies the free-port probe so Connect retries EADDRINUSE", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    expect(src).toMatch(/pickFreeListenPort:\s*listenFreeLoopbackPort/);
  });
});

describe("npx spawn plan", () => {
  it("uses the Windows cmd shim with a shell", () => {
    expect(npxSpawnPlan("win32")).toEqual({ command: "npx.cmd", shell: true });
    expect(npxSpawnPlan("linux")).toEqual({ command: "npx", shell: false });
  });
});

describe("authorizeMcpRemote", () => {
  it("succeeds when initialize returns, then kills the bridge", async () => {
    const proc = new FakeProc();
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: () => proc as never,
    });
    await new Promise((r) => setImmediate(r));
    expect(proc.written).toBe(MCP_INITIALIZE_REQUEST);
    proc.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}\n');
    await expect(result).resolves.toEqual({ ok: true });
    expect(proc.killed).toBe(true);
  });

  it("succeeds on an auth-success log without waiting for initialize", async () => {
    const proc = new FakeProc();
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: () => proc as never,
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Authentication successful! Caching credentials...\n");
    await expect(result).resolves.toEqual({ ok: true });
  });

  it("reports a distinct missing-npx error", async () => {
    const err = Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" });
    await expect(authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: () => { throw err; },
    })).resolves.toMatchObject({ ok: false, kind: "npx-missing" });
  });

  it("reports a closed-browser cancel from process output", async () => {
    const proc = new FakeProc();
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: () => proc as never,
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Authorization cancelled by the user\n");
    proc.emit("exit", 1, null);
    await expect(result).resolves.toMatchObject({ ok: false, kind: "cancelled" });
  });

  it("times out with a readable message instead of spinning", async () => {
    const proc = new FakeProc();
    await expect(authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      timeoutMs: 20,
      spawn: () => proc as never,
    })).resolves.toMatchObject({ ok: false, kind: "timeout" });
    expect(proc.killed).toBe(true);
  });

  it("surfaces a port-conflict without retry when no port probe is injected", async () => {
    const proc = new FakeProc();
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      spawn: () => proc as never,
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Error: listen EADDRINUSE: address already in use 127.0.0.1:22227\n");
    await expect(result).resolves.toEqual({
      ok: false,
      kind: "port-conflict",
      message: connectFailureMessage("port-conflict"),
    });
    expect(proc.killed).toBe(true);
  });

  it("retries once on EADDRINUSE with a free callback port and hides the first failure", async () => {
    const first = new FakeProc();
    const second = new FakeProc();
    const spawned: string[][] = [];
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      pickFreeListenPort: async () => 54321,
      spawn: (_command, args) => {
        spawned.push([...args]);
        return (spawned.length === 1 ? first : second) as never;
      },
    });
    await new Promise((r) => setImmediate(r));
    first.stderr.write("Error: listen EADDRINUSE: address already in use 127.0.0.1:22227\n");
    for (let i = 0; i < 8 && spawned.length < 2; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(spawned).toEqual([
      ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      ["-y", "mcp-remote", "https://mcp.linear.app/mcp", "54321"],
    ]);
    second.stderr.write("Authentication successful! Caching credentials...\n");
    await expect(result).resolves.toEqual({ ok: true });
    expect(first.killed).toBe(true);
    expect(second.killed).toBe(true);
  });

  it("returns the port-conflict message if the retry also fails", async () => {
    const first = new FakeProc();
    const second = new FakeProc();
    let calls = 0;
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      pickFreeListenPort: async () => 54321,
      spawn: () => {
        calls += 1;
        return (calls === 1 ? first : second) as never;
      },
    });
    await new Promise((r) => setImmediate(r));
    first.stderr.write("Error: listen EADDRINUSE: address already in use 127.0.0.1:22227\n");
    for (let i = 0; i < 8 && calls < 2; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(calls).toBe(2);
    second.stderr.write("Error: listen EADDRINUSE: address already in use 127.0.0.1:54321\n");
    await expect(result).resolves.toMatchObject({
      ok: false,
      kind: "port-conflict",
      message: connectFailureMessage("port-conflict"),
    });
  });

  it("does not retry when the port probe returns an unusable port", async () => {
    const proc = new FakeProc();
    let calls = 0;
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      pickFreeListenPort: async () => 0,
      spawn: () => {
        calls += 1;
        return proc as never;
      },
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Error: listen EADDRINUSE: address already in use :::22227\n");
    await expect(result).resolves.toMatchObject({ ok: false, kind: "port-conflict" });
    expect(calls).toBe(1);
  });

  it("does not retry when the port probe fails", async () => {
    const proc = new FakeProc();
    let calls = 0;
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
      timeoutMs: 1_000,
      pickFreeListenPort: async () => { throw new Error("no port"); },
      spawn: () => {
        calls += 1;
        return proc as never;
      },
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write("Error: listen EADDRINUSE: address already in use :::22227\n");
    await expect(result).resolves.toMatchObject({ ok: false, kind: "port-conflict" });
    expect(calls).toBe(1);
  });
});

describe("listenFreeLoopbackPort", () => {
  it("binds port 0 on loopback and returns the assigned port after close", async () => {
    let listened: { port: number; host: string } | undefined;
    const server = {
      unref() { /* */ },
      listen(port: number, host: string, cb: () => void) {
        listened = { port, host };
        cb();
      },
      address: () => ({ port: 41234 }),
      close(cb?: (err?: Error) => void) { cb?.(); },
      once() { /* */ },
    };
    await expect(listenFreeLoopbackPort(() => server)).resolves.toBe(41234);
    expect(listened).toEqual({ port: 0, host: "127.0.0.1" });
  });
});
