import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { authorizeMcpRemote, npxSpawnPlan } from "../src/mcp-connector-auth";
import { MCP_INITIALIZE_REQUEST } from "../src/mcp-connectors";

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
});
