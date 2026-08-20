/**
 * One-shot `mcp-remote` spawn that drives the vendor OAuth flow. Credentials
 * land in `~/.mcp-auth`; we never read that directory. Injected spawn keeps
 * this testable without npx or a browser. A connector with `oauthScope`
 * writes that JSON to a temp `@file` (`writeOAuthClientMetadataFile`) because
 * Windows Connect uses `shell: true` and inline `{...}` is mangled; dispose
 * after the child exits. `session/new` gets the same flag from
 * `persistConnectorOAuthClientMetadata` so grok's later spawn agrees.
 *
 * A live Grok session already running the same endpoint holds the OAuth
 * callback port pinned in mcp-remote's client registration. Windows also
 * skips mcp-remote's lockfile, so a second instance cannot learn the first
 * exists. On `EADDRINUSE` we retry once with a free loopback port as
 * `mcp-remote <url> <port>`, which forces re-registration. The first
 * failure never reaches the UI. `quoteSpawnArgs` wraps whitespace-bearing
 * argv entries only for this shell spawn — never in `mcpRemoteArgs`.
 */
import { createInterface } from "node:readline";
import { createServer as defaultCreateServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  MCP_INITIALIZE_REQUEST,
  MCP_REMOTE_CONNECT_TIMEOUT_MS,
  TIER1_CONNECTORS,
  classifyConnectFailure,
  connectFailureMessage,
  connectOutputLooksLikeOAuthIncompatible,
  connectOutputLooksLikePortConflict,
  connectOutputLooksSuccessful,
  isUsableListenPort,
  oauthClientMetadataJson,
  parseInitializeResult,
  summarizeConnectOutput,
  withMcpRemoteCallbackPort,
  type ConnectedConnectorStore,
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

const OAUTH_METADATA_DIR_NAME = "grok-mcp-oauth-metadata";

/**
 * Node's CMD `shell: true` joins argv with spaces and no quotes, so a path
 * like `C:\Users\Jane Doe\...` splits. Wrap any whitespace-bearing entry in
 * double quotes; CMD strips them. A non-shell spawn (POSIX Connect, grok's
 * `session/new`) must receive the raw strings — quoting here would make `"`
 * part of the path.
 */
export function quoteSpawnArgs(args: readonly string[], shell?: boolean): string[] {
  if (!shell) return [...args];
  return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
}

/**
 * One-shot JSON file for Connect. mcp-remote is spawned with `shell: true`
 * on Windows, so inline `{"scope":"mcp"}` is mangled; pass `@<path>` instead.
 * Dispose after the child exits — grok's later `session/new` spawn uses
 * {@link persistConnectorOAuthClientMetadata}, not this temp.
 */
export function writeOAuthClientMetadataFile(
  scope: string,
  opts?: { tmpRoot?: string },
): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(opts?.tmpRoot ?? tmpdir(), "grok-mcp-oauth-"));
  const filePath = join(dir, "oauth-client-metadata.json");
  writeFileSync(filePath, oauthClientMetadataJson(scope), "utf8");
  return {
    path: filePath,
    dispose() {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/**
 * Durable `@file` paths for `session/new`. Grok spawns mcp-remote later,
 * so these must outlive Connect. Rewritten on each call; not secrets.
 */
export function persistConnectorOAuthClientMetadata(
  store: ConnectedConnectorStore,
  opts?: { root?: string },
): Record<string, string> {
  const dir = opts?.root ?? join(tmpdir(), OAUTH_METADATA_DIR_NAME);
  const paths: Record<string, string> = {};
  for (const connector of TIER1_CONNECTORS) {
    if (!store[connector.id]) continue;
    const scope = connector.oauthScope?.trim();
    if (!scope) continue;
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${connector.id}.json`);
    writeFileSync(filePath, oauthClientMetadataJson(scope), "utf8");
    paths[connector.id] = filePath;
  }
  return paths;
}

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
        message: connectFailureMessage(
          kind,
          kind === "port-conflict" || kind === "oauth-incompatible" ? undefined : detail,
        ),
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
      if (connectOutputLooksLikeOAuthIncompatible(combined)) {
        fail("oauth-incompatible");
        return;
      }
    };

    try {
      proc = opts.spawn(opts.command, quoteSpawnArgs(opts.args, opts.shell), {
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
