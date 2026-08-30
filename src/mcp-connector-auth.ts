/**
 * One-shot `mcp-remote` spawn that drives the vendor OAuth flow. Credentials
 * land in `~/.mcp-auth`. We used to say "we never read that directory", and
 * {@link connectorsLackingOAuthToken} at the bottom of this file deliberately
 * reverses that: it is the only way to know a connector will open a browser
 * before the CLI spawns one. It reads presence, never contents. Injected spawn keeps
 * this testable without npx or a browser. A connector with `oauthScope`
 * writes that JSON to a temp `@file` (`writeOAuthClientMetadataFile`) because
 * Windows Connect uses `shell: true` and inline `{...}` is mangled; dispose
 * after the child exits. `session/new` gets the same flag from
 * `persistConnectorOAuthClientMetadata` so grok's later spawn agrees.
 *
 * A live Grok session already running the same endpoint holds the OAuth
 * callback port pinned in mcp-remote's client registration, and Windows skips
 * mcp-remote's lockfile so a second instance cannot learn the first exists.
 * That collision is REPORTED, never worked around — see
 * {@link authorizeMcpRemote} for why retrying on another port re-authorised
 * every host on the machine. `quoteSpawnArgs` wraps whitespace-bearing argv
 * entries only for this shell spawn — never in `mcpRemoteArgs`.
 */
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  connectorAuth,
  oauthClientMetadataJson,
  parseInitializeResult,
  summarizeConnectOutput,
  type ConnectedConnectorStore,
  type ConnectFailureKind,
  type ConnectorAuth,
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
   * Key-auth connectors: a DCR-incompatibility failure means the pasted
   * token was rejected, not that the app can never work.
   */
  auth?: ConnectorAuth;
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
 * A port conflict is REPORTED, never worked around.
 *
 * This used to retry on a free port, and that retry is what made connectors
 * re-authorise whenever more than one host was open. The chain, measured
 * 2026-08-20/23:
 *
 *  1. The callback port is pinned by the OAuth registration — mcp-remote reads
 *     `client_info.json` and takes the port out of the registered
 *     `redirect_uris` (Linear: 22227). It is not ours to choose.
 *  2. mcp-remote's cross-instance lockfile coordination is disabled on
 *     Windows, so a second instance never learns the first exists.
 *  3. The holder is one of OUR OWN live proxies — grok's ACP session running
 *     the `mcpServers` entry we handed it. Already authorised, working.
 *
 * Handing mcp-remote a DIFFERENT port then means, by its own rule, "delete
 * `client_info.json` and re-register" — a brand-new OAuth client and a fresh
 * consent screen. Worse, `~/.mcp-auth` is shared by every host, so that
 * deletion invalidates the registration the OTHER windows were using, and they
 * re-authorise in turn. The retry did not recover from the conflict; it
 * converted a harmless collision into a machine-wide re-authorisation.
 *
 * So there is nothing to retry. A conflict means this connector is already
 * signed in and in use, which is the good case — the caller says so and stops.
 */
export async function authorizeMcpRemote(
  opts: AuthorizeMcpRemoteOpts,
): Promise<AuthorizeMcpRemoteResult> {
  return runAuthorizeMcpRemote(opts);
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
          kind === "port-conflict" || kind === "oauth-incompatible" || kind === "key-rejected"
            ? undefined
            : detail,
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
        fail(opts.auth === "key" ? "key-rejected" : "oauth-incompatible");
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
      fail(classifyConnectFailure({ spawnError, output: spawnError.message, auth: opts.auth }), spawnError.message);
      return;
    }

    proc.on("error", (error) => {
      spawnError = {
        code: (error as NodeJS.ErrnoException).code,
        message: error.message,
      };
      fail(
        classifyConnectFailure({
          spawnError,
          output: `${spawnError.message}\n${chunks.join("")}`,
          auth: opts.auth,
        }),
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
        auth: opts.auth,
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


/* ------------------------------------------------------------------------- *
 * Which connectors would open a browser if we handed them to the CLI
 * ------------------------------------------------------------------------- */

/**
 * The parts of the token store we look at. Injected so the tests never touch a
 * real home directory, and so the whole thing is decidable from two facts:
 * which version directories exist, and whether one file is in one of them.
 */
export interface McpAuthStoreFs {
  /** Immediate subdirectories of `root`, with each one's modification time. */
  versionDirs(root: string): { name: string; mtimeMs: number }[];
  hasFile(path: string): boolean;
}

const defaultAuthStoreFs: McpAuthStoreFs = {
  versionDirs(root) {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          let mtimeMs = 0;
          try { mtimeMs = statSync(join(root, entry.name)).mtimeMs; } catch { /* oldest */ }
          return { name: entry.name, mtimeMs };
        });
    } catch {
      return []; // no store yet, or unreadable — the caller treats that as "cannot tell"
    }
  },
  hasFile(path) {
    try { return existsSync(path); } catch { return false; }
  },
};

/** `MCP_REMOTE_CONFIG_DIR` overrides only the BASE; mcp-remote appends its own
 *  version segment unconditionally, which is the whole reason for the pin. */
export function mcpAuthRoot(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.MCP_REMOTE_CONFIG_DIR?.trim();
  return configured || join(home, ".mcp-auth");
}

/**
 * Which `mcp-remote-<version>` directory the proxy is actually writing.
 *
 * NOT derived from `MCP_REMOTE_PACKAGE`. The pinned `mcp-remote@0.1.37` reports
 * its own version as the string `0.1.36`, so the spec does not name the
 * directory — that is measured, and it is exactly the coupling that makes
 * guessing wrong. The one thing that is reliably true is that the directory in
 * use is the one being written, so take the most recently touched.
 *
 * `undefined` when there is nothing to choose from, and every caller must treat
 * that as "cannot tell" rather than "nothing is authorized".
 */
export function activeMcpRemoteDir(
  dirs: readonly { name: string; mtimeMs: number }[],
): string | undefined {
  let best: { name: string; mtimeMs: number } | undefined;
  for (const dir of dirs) {
    if (!dir.name.startsWith("mcp-remote-")) continue;
    if (!best || dir.mtimeMs > best.mtimeMs) best = dir;
  }
  return best?.name;
}

/**
 * mcp-remote's own name for a server's files: md5 of the endpoint URL.
 *
 * Confirmed against a real store rather than read off its source: all seven
 * hashes in `~/.mcp-auth/mcp-remote-0.1.36` on the dev box matched md5 of an
 * endpoint in TIER1_CONNECTORS (2026-08-30).
 */
export function mcpServerUrlHash(endpoint: string): string {
  return createHash("md5").update(endpoint).digest("hex");
}

/**
 * OAuth connectors in `store` that have NO token file — the ones mcp-remote
 * would re-authorize, with a browser, on the next spawn.
 *
 * **Fails open, always.** No store directory, an unreadable one, no md5 (a
 * FIPS-restricted Node), anything unexpected: the answer is the empty set and
 * every connector is passed through exactly as before. A false positive here
 * silently removes a working connector, which is worse than the prompt this
 * exists to prevent — so uncertainty resolves toward doing nothing.
 */
export function connectorsLackingOAuthToken(opts: {
  store: ConnectedConnectorStore;
  home?: string;
  env?: NodeJS.ProcessEnv;
  fs?: McpAuthStoreFs;
}): ReadonlySet<string> {
  const empty: ReadonlySet<string> = new Set();
  try {
    const fs = opts.fs ?? defaultAuthStoreFs;
    const root = mcpAuthRoot(opts.env ?? process.env, opts.home ?? homedir());
    const versionDir = activeMcpRemoteDir(fs.versionDirs(root));
    if (!versionDir) return empty;
    const out = new Set<string>();
    for (const connector of TIER1_CONNECTORS) {
      if (connectorAuth(connector) !== "oauth") continue;
      const record = opts.store[connector.id];
      if (!record) continue;
      const endpoint = record.endpoint || connector.endpoint;
      const file = join(root, versionDir, `${mcpServerUrlHash(endpoint)}_tokens.json`);
      if (!fs.hasFile(file)) out.add(connector.id);
    }
    return out;
  } catch {
    return empty;
  }
}
