/**
 * One-shot `mcp-remote` spawn that drives the vendor OAuth flow. Credentials
 * land in `~/.mcp-auth`; we never read that directory. Injected spawn keeps
 * this testable without npx or a browser.
 *
 * A live Grok session already running the same endpoint holds the OAuth
 * callback port pinned in mcp-remote's client registration. Windows also
 * skips mcp-remote's lockfile, so a second instance cannot learn the first
 * exists. On `EADDRINUSE` we retry once with a free loopback port as
 * `mcp-remote <url> <port>`, which forces re-registration. The first
 * failure never reaches the UI.
 */
import { createInterface } from "node:readline";
import { createServer as defaultCreateServer } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  MCP_INITIALIZE_REQUEST,
  MCP_REMOTE_CONNECT_TIMEOUT_MS,
  classifyConnectFailure,
  connectFailureMessage,
  connectOutputLooksLikePortConflict,
  connectOutputLooksSuccessful,
  isUsableListenPort,
  parseInitializeResult,
  summarizeConnectOutput,
  withMcpRemoteCallbackPort,
  type ConnectFailureKind,
} from "./mcp-connectors";

export type McpRemoteSpawn = (
  command: string,
  args: readonly string[],
  opts: {
    stdio: ["pipe", "pipe", "pipe"];
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    windowsHide?: boolean;
  },
) => Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "kill"> & {
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export interface AuthorizeMcpRemoteOpts {
  spawn: McpRemoteSpawn;
  command: string;
  args: readonly string[];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * I/O seam for the port-conflict retry. Bind port 0, take what the OS
   * gives, close it, pass that as mcp-remote's callback port. Tests inject
   * this so they never open a real socket. Omit it and a port-conflict is
   * returned as-is (no retry).
   */
  pickFreeListenPort?: PickFreeListenPort;
}

export type PickFreeListenPort = () => Promise<number>;

/** Minimal listen-server surface so tests can drive {@link listenFreeLoopbackPort} without `net`. */
export interface FreePortProbe {
  unref(): void;
  listen(port: number, host: string, cb: () => void): void;
  close(cb?: (err?: Error) => void): void;
  address(): { port: number } | string | null;
  once(event: "error", listener: (err: Error) => void): void;
}

export type AuthorizeMcpRemoteResult =
  | { ok: true }
  | { ok: false; kind: ConnectFailureKind; message: string };

export { npxSpawnPlan } from "./npx-locator";

/**
 * Bind loopback port 0, read the OS-assigned port, close. mcp-remote's
 * `specifiedPort` cannot be 0 (falsy in its own check), so we have to
 * materialize a real port before spawning.
 */
export function listenFreeLoopbackPort(
  createServer: () => FreePortProbe = () => defaultCreateServer() as unknown as FreePortProbe,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    const fail = (err: Error) => {
      try { server.close(); } catch { /* already closed */ }
      reject(err);
    };
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!isUsableListenPort(port)) {
          reject(new Error("Could not allocate a local callback port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function authorizeMcpRemote(
  opts: AuthorizeMcpRemoteOpts,
): Promise<AuthorizeMcpRemoteResult> {
  const first = await runAuthorizeMcpRemote(opts);
  if (first.ok || first.kind !== "port-conflict" || !opts.pickFreeListenPort) {
    return first;
  }
  let port: number;
  try {
    port = await opts.pickFreeListenPort();
  } catch {
    return first;
  }
  if (!isUsableListenPort(port)) return first;
  const retryArgs = withMcpRemoteCallbackPort(opts.args, port);
  if (!retryArgs) return first;
  return runAuthorizeMcpRemote({
    ...opts,
    args: retryArgs,
    pickFreeListenPort: undefined,
  });
}

function runAuthorizeMcpRemote(
  opts: AuthorizeMcpRemoteOpts,
): Promise<AuthorizeMcpRemoteResult> {
  const timeoutMs = opts.timeoutMs ?? MCP_REMOTE_CONNECT_TIMEOUT_MS;
  const chunks: string[] = [];
  let settled = false;
  let timedOut = false;
  let spawnError: { code?: string; message?: string } | undefined;
  let proc: ReturnType<McpRemoteSpawn> | undefined;

  const finish = (result: AuthorizeMcpRemoteResult): AuthorizeMcpRemoteResult => {
    if (settled) return result;
    settled = true;
    try { proc?.kill(); } catch { /* already gone */ }
    return result;
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve(finish({
        ok: false,
        kind: "timeout",
        message: connectFailureMessage("timeout"),
      }));
    }, timeoutMs);

    const succeed = () => {
      clearTimeout(timer);
      resolve(finish({ ok: true }));
    };

    const fail = (kind: ConnectFailureKind, detail?: string) => {
      clearTimeout(timer);
      resolve(finish({
        ok: false,
        kind,
        message: connectFailureMessage(kind, kind === "port-conflict" ? undefined : detail),
      }));
    };

    const considerOutput = (chunk: string) => {
      chunks.push(chunk);
      const combined = chunks.join("");
      if (connectOutputLooksSuccessful(chunk) || connectOutputLooksSuccessful(combined)) {
        succeed();
        return;
      }
      if (connectOutputLooksLikePortConflict(combined)) {
        fail("port-conflict");
        return;
      }
    };

    try {
      proc = opts.spawn(opts.command, [...opts.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: opts.env,
        shell: opts.shell,
        windowsHide: true,
      });
    } catch (error) {
      spawnError = {
        code: (error as NodeJS.ErrnoException).code,
        message: (error as Error).message,
      };
      fail(classifyConnectFailure({ spawnError, output: spawnError.message }), spawnError.message);
      return;
    }

    proc.on("error", (error) => {
      spawnError = {
        code: (error as NodeJS.ErrnoException).code,
        message: error.message,
      };
      fail(
        classifyConnectFailure({ spawnError, output: `${spawnError.message}\n${chunks.join("")}` }),
        spawnError.message,
      );
    });

    const onDone = (code: number | null) => {
      if (settled) return;
      const output = chunks.join("");
      if (connectOutputLooksSuccessful(output)) {
        succeed();
        return;
      }
      const kind = classifyConnectFailure({
        spawnError,
        timedOut,
        exitCode: code,
        output,
      });
      fail(kind, summarizeConnectOutput(output) || spawnError?.message);
    };
    proc.on("exit", onDone);
    proc.on("close", onDone);

    const onLine = (line: string) => {
      considerOutput(line);
      if (settled) return;
      const initialized = parseInitializeResult(line);
      if (initialized === true) succeed();
      if (initialized === false) {
        fail("failed", summarizeConnectOutput(line) || "The MCP server rejected initialize.");
      }
    };

    createInterface({ input: proc.stdout }).on("line", onLine);
    createInterface({ input: proc.stderr }).on("line", onLine);
    proc.stdout.on("data", (buf: Buffer | string) => considerOutput(String(buf)));
    proc.stderr.on("data", (buf: Buffer | string) => considerOutput(String(buf)));

    try {
      proc.stdin.write(MCP_INITIALIZE_REQUEST);
    } catch {
      // The process may still be authenticating; output watchers remain.
    }
  });
}
