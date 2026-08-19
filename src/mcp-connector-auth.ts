/**
 * One-shot `mcp-remote` spawn that drives the vendor OAuth flow. Credentials
 * land in `~/.mcp-auth`; we never read that directory. Injected spawn keeps
 * this testable without npx or a browser.
 */
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  MCP_INITIALIZE_REQUEST,
  MCP_REMOTE_CONNECT_TIMEOUT_MS,
  classifyConnectFailure,
  connectFailureMessage,
  connectOutputLooksSuccessful,
  parseInitializeResult,
  summarizeConnectOutput,
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
}

export type AuthorizeMcpRemoteResult =
  | { ok: true }
  | { ok: false; kind: ConnectFailureKind; message: string };

export function npxSpawnPlan(platform: NodeJS.Platform = process.platform): {
  command: string;
  shell: boolean;
} {
  // Windows npm shims are `.cmd`; Node's spawn without a shell cannot run them.
  return platform === "win32"
    ? { command: "npx.cmd", shell: true }
    : { command: "npx", shell: false };
}

export async function authorizeMcpRemote(
  opts: AuthorizeMcpRemoteOpts,
): Promise<AuthorizeMcpRemoteResult> {
  const timeoutMs = opts.timeoutMs ?? MCP_REMOTE_CONNECT_TIMEOUT_MS;
  const chunks: string[] = [];
  let settled = false;
  let timedOut = false;
  let spawnError: { code?: string; message?: string } | undefined;
  let exitCode: number | null | undefined;
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
        message: connectFailureMessage(kind, detail),
      }));
    };

    const considerOutput = (chunk: string) => {
      chunks.push(chunk);
      if (connectOutputLooksSuccessful(chunk) || connectOutputLooksSuccessful(chunks.join(""))) {
        succeed();
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
      exitCode = code;
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
