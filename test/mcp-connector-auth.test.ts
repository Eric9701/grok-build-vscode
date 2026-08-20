import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  authorizeMcpRemote,
  listenFreeLoopbackPort,
  npxSpawnPlan,
  persistConnectorOAuthClientMetadata,
  quoteSpawnArgs,
  writeOAuthClientMetadataFile,
} from "../src/mcp-connector-auth";
import {
  MCP_INITIALIZE_REQUEST,
  STATIC_OAUTH_CLIENT_METADATA_FLAG,
  connectFailureMessage,
} from "../src/mcp-connectors";

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

  it("hands the child npxSpawnPlan's env, not the stripped process.env", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const start = src.indexOf("private async connectMcpConnector(");
    const end = src.indexOf("private async disconnectMcpConnector(");
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("env: npx.env");
    expect(body).not.toContain("env: process.env");
    expect(body).toContain("writeOAuthClientMetadataFile");
    expect(body).toMatch(/mcpRemoteArgs\(endpoint,\s*undefined,\s*metadata\?\.path\)/);
    expect(body).not.toContain("quoteSpawnArgs");
  });

  it("session/new Stripe entry also carries static OAuth client metadata", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const start = src.indexOf("private hostMcpServersFor(");
    const end = src.indexOf("private async connectMcpConnector(");
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("persistConnectorOAuthClientMetadata");
    expect(body).toContain("hostMcpServers(");
    expect(body).not.toContain("quoteSpawnArgs");
  });
});

const SPACED_METADATA_PATH =
  "C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\grok-mcp-oauth-x\\oauth-client-metadata.json";
const SPACED_METADATA_ARG = `@${SPACED_METADATA_PATH}`;
const SPACED_MCP_ARGV = [
  "-y", "mcp-remote", "https://mcp.stripe.com",
  STATIC_OAUTH_CLIENT_METADATA_FLAG, SPACED_METADATA_ARG,
];

describe("quoteSpawnArgs", () => {
  it("is applied at the mcp-remote spawn seam", () => {
    const src = readFileSync(new URL("../src/mcp-connector-auth.ts", import.meta.url), "utf8");
    expect(src).toMatch(/quoteSpawnArgs\(opts\.args,\s*opts\.shell\)/);
  });

  it("wraps whitespace-bearing entries for a shell spawn and leaves the rest raw", () => {
    expect(quoteSpawnArgs(SPACED_MCP_ARGV, true)).toEqual([
      "-y", "mcp-remote", "https://mcp.stripe.com",
      STATIC_OAUTH_CLIENT_METADATA_FLAG, `"${SPACED_METADATA_ARG}"`,
    ]);
    expect(quoteSpawnArgs(["-y", "mcp-remote", "https://mcp.stripe.com"], true))
      .toEqual(["-y", "mcp-remote", "https://mcp.stripe.com"]);
  });

  it("leaves argv unchanged for a non-shell spawn", () => {
    expect(quoteSpawnArgs(SPACED_MCP_ARGV, false)).toEqual(SPACED_MCP_ARGV);
    expect(quoteSpawnArgs(SPACED_MCP_ARGV)).toEqual(SPACED_MCP_ARGV);
    expect(quoteSpawnArgs(SPACED_MCP_ARGV, false).some((arg) => arg.startsWith('"'))).toBe(false);
  });

  it("a shell-spawned child receives the original unquoted path as one argument", () => {
    const root = mkdtempSync(join(tmpdir(), "Jane Doe-echo-"));
    const script = join(root, "echo-argv.cjs");
    try {
      writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(1)));\n");
      const result = spawnSync("node", quoteSpawnArgs([script, SPACED_METADATA_ARG], true), {
        encoding: "utf8",
        shell: true,
        windowsHide: true,
        timeout: 8_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([script, SPACED_METADATA_ARG]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a non-shell spawn is given the raw argv, with no quotes added", () => {
    const root = mkdtempSync(join(tmpdir(), "Jane Doe-echo-"));
    const script = join(root, "echo-argv.cjs");
    try {
      writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(1)));\n");
      const argv = quoteSpawnArgs([script, SPACED_METADATA_ARG], false);
      expect(argv).toEqual([script, SPACED_METADATA_ARG]);
      const result = spawnSync(process.execPath, argv, {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 8_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([script, SPACED_METADATA_ARG]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("npx spawn plan", () => {
  it("uses the Windows cmd shim with a shell", () => {
    const empty = { pathEnv: "", isFile: () => false };
    expect(npxSpawnPlan("win32", empty)).toMatchObject({ command: "npx.cmd", shell: true });
    expect(npxSpawnPlan("linux", empty)).toMatchObject({ command: "npx", shell: false });
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

  it("classifies a DCR client-metadata rejection as oauth-incompatible, not a stack", async () => {
    const proc = new FakeProc();
    const result = authorizeMcpRemote({
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.stripe.com"],
      timeoutMs: 1_000,
      spawn: () => proc as never,
    });
    await new Promise((r) => setImmediate(r));
    proc.stderr.write(`Connection error: InvalidClientMetadataError: Not supported: openid, email, profile
    at async auth (file:///C:/Users/foo/chunk-65X3S4HB.js:18536:12)
    at async StreamableHTTPClientTransport.send (file:///C:/Users/foo/chunk.js:99:5)\n`);
    await expect(result).resolves.toEqual({
      ok: false,
      kind: "oauth-incompatible",
      message: connectFailureMessage("oauth-incompatible"),
    });
    expect(proc.killed).toBe(true);
  });

  it("retries EADDRINUSE without dropping static OAuth client metadata", async () => {
    const first = new FakeProc();
    const second = new FakeProc();
    const spawned: string[][] = [];
    const result = authorizeMcpRemote({
      command: "npx",
      args: [
        "-y", "mcp-remote", "https://mcp.stripe.com",
        STATIC_OAUTH_CLIENT_METADATA_FLAG, "@/tmp/stripe-oauth.json",
      ],
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
      ["-y", "mcp-remote", "https://mcp.stripe.com", STATIC_OAUTH_CLIENT_METADATA_FLAG, "@/tmp/stripe-oauth.json"],
      ["-y", "mcp-remote", "https://mcp.stripe.com", "54321", STATIC_OAUTH_CLIENT_METADATA_FLAG, "@/tmp/stripe-oauth.json"],
    ]);
    second.stderr.write("Authentication successful! Caching credentials...\n");
    await expect(result).resolves.toEqual({ ok: true });
  });

  it("quotes a spaced metadata path on both the first spawn and the EADDRINUSE retry", async () => {
    const first = new FakeProc();
    const second = new FakeProc();
    const spawned: string[][] = [];
    const result = authorizeMcpRemote({
      command: "npx",
      args: SPACED_MCP_ARGV,
      shell: true,
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
      [
        "-y", "mcp-remote", "https://mcp.stripe.com",
        STATIC_OAUTH_CLIENT_METADATA_FLAG, `"${SPACED_METADATA_ARG}"`,
      ],
      [
        "-y", "mcp-remote", "https://mcp.stripe.com", "54321",
        STATIC_OAUTH_CLIENT_METADATA_FLAG, `"${SPACED_METADATA_ARG}"`,
      ],
    ]);
    second.stderr.write("Authentication successful! Caching credentials...\n");
    await expect(result).resolves.toEqual({ ok: true });
  });

  it("does not quote a spaced metadata path when the spawn is not a shell", async () => {
    const proc = new FakeProc();
    let spawned: string[] | undefined;
    const result = authorizeMcpRemote({
      command: "npx",
      args: SPACED_MCP_ARGV,
      shell: false,
      timeoutMs: 1_000,
      spawn: (_command, args) => {
        spawned = [...args];
        return proc as never;
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(spawned).toEqual(SPACED_MCP_ARGV);
    proc.stderr.write("Authentication successful! Caching credentials...\n");
    await expect(result).resolves.toEqual({ ok: true });
  });
});

describe("OAuth client metadata files", () => {
  it("writes compact scope JSON to a temp file and disposes the directory", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-mcp-oauth-test-"));
    const written = writeOAuthClientMetadataFile("mcp", { tmpRoot: root });
    expect(readFileSync(written.path, "utf8")).toBe('{"scope":"mcp"}');
    expect(written.path.endsWith("oauth-client-metadata.json")).toBe(true);
    written.dispose();
    expect(existsSync(written.path)).toBe(false);
  });

  it("persists metadata only for connected connectors that declare a scope", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-mcp-oauth-persist-"));
    const paths = persistConnectorOAuthClientMetadata({
      stripe: { endpoint: "https://mcp.stripe.com" },
      linear: { endpoint: "https://mcp.linear.app/mcp" },
    }, { root });
    expect(Object.keys(paths)).toEqual(["stripe"]);
    expect(readFileSync(paths.stripe, "utf8")).toBe('{"scope":"mcp"}');
    expect(existsSync(join(root, "linear.json"))).toBe(false);
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
