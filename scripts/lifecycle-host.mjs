#!/usr/bin/env node
// Long-lived REAL host participant for the cross-repo lifecycle e2e.
//
// Part 2 (the relay repo) spawns this as a child and drives everything else
// through a real browser against a real relay. This process is a participant:
// boot the shipped desktop host, wait until the uplink is actually connected,
// print one ready line, then idle until killed. A restart is the orchestrator
// killing us and spawning us again with the same GROK_HOME + token.
//
//   npm --prefix <this repo> run e2e:lifecycle-host
//
// Environment (all required unless noted):
//   GROK_RELAY_URL              ws(s)://…  — already a development-only override
//   GROK_RELAY_DEVICE_TOKEN     linked-device token from the relay
//   GROK_HOME                   session store; STABLE across a restart
//   GROK_LIFECYCLE_WORKSPACES   one or more absolute project folders.
//                               `path.delimiter`-separated (`;` on Windows, `:`
//                               on POSIX). A JSON array is also accepted when
//                               the value trims to `[…`. Repo switching needs
//                               two distinct folders; one is enough to boot.
//   GROK_LIFECYCLE_READY_MS     optional ready timeout, default 60000
//
// Ready line (stdout, once, greppable):
//   GROK_LIFECYCLE_HOST_READY
//
// Why desktop, not @vscode/test-electron: the contract is "boot and idle
// until killed", which is Electron's natural shape. vscode-test is "run a
// suite and exit"; a never-finishing mocha test would also hang
// `npm run test:integration` if it ever landed in that glob. The shipped
// code path is `src/sidebar.ts` + `src/remote-uplink.ts` either way.
//
// Token injection cannot be a Node pre-seed of SecretStorage — desktop
// ciphertext is OS-keyed. The env token is honoured only by
// resolveInjectedDeviceToken (production + un-overridden URL ⇒ no token,
// no overlay, no uplink). A packaged build never accepts it.
//
// Fake ACP: grok.cliPath → test/fixtures/fake-grok-acp.{cmd,sh}. A configured
// path is never followed by a PATH search (locateGrokCli), so an installed
// grok cannot leak in.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const LIFECYCLE_HOST_READY_LINE = "GROK_LIFECYCLE_HOST_READY";
export const LIFECYCLE_WORKSPACES_ENV = "GROK_LIFECYCLE_WORKSPACES";
export const UPLINK_CONNECTED_NEEDLE = "[remote] uplink connected";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Parse GROK_LIFECYCLE_WORKSPACES: JSON array or OS-delimited paths. */
export function parseLifecycleWorkspaces(
  raw,
  delimiter = path.delimiter,
) {
  if (raw == null) return [];
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(
        `GROK_LIFECYCLE_WORKSPACES is not valid JSON: ${(e && e.message) || e}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error("GROK_LIFECYCLE_WORKSPACES JSON must be an array of paths");
    }
    return parsed.map((p) => String(p).trim()).filter(Boolean);
  }
  return trimmed.split(delimiter).map((p) => p.trim()).filter(Boolean);
}

function resolveFakeCli() {
  const name = process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh";
  const cli = path.join(root, "test", "fixtures", name);
  if (!fs.existsSync(cli)) throw new Error(`fake ACP CLI missing: ${cli}`);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(cli, 0o755);
    } catch {
      /* best-effort */
    }
  }
  return cli;
}

function writeProfile(userData, workspaces, fakeCli) {
  fs.mkdirSync(userData, { recursive: true });
  const abs = workspaces.map((w) => path.resolve(w));
  const prefs = {
    workspaceRoot: abs[0],
    workspaceRoots: abs,
    discoverySeedCompleted: true,
    config: {
      "grok.cliPath": fakeCli,
      "grok.telemetry.enabled": false,
      "grok.remote.keepAwake": false,
    },
  };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(prefs, null, 2), "utf8");
  const sessionOverrides = path.join(userData, "lifecycle-config.json");
  fs.writeFileSync(
    sessionOverrides,
    JSON.stringify({ "grok.cliPath": fakeCli, "grok.telemetry.enabled": false }, null, 2),
    "utf8",
  );
  return sessionOverrides;
}

function ensureSessionCatalogs(grokHome, workspaces) {
  for (const cwd of workspaces) {
    const dir = path.join(grokHome, "sessions", encodeURIComponent(path.resolve(cwd)));
    fs.mkdirSync(dir, { recursive: true });
  }
}

function killTree(child) {
  if (!child || child.killed || child.exitCode != null) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

export async function runLifecycleHost(opts) {
  const envIn = opts.env ?? process.env;
  const framesPath = path.join(root, "out", "remote-frames.js");
  if (!fs.existsSync(framesPath)) {
    throw new Error(`Missing ${framesPath} — run \`npm run compile\` first`);
  }
  const {
    RELAY_URL_ENV,
    resolveInjectedDeviceToken,
    redactRelayUrl,
  } = require(framesPath);

  const token = resolveInjectedDeviceToken({ isProduction: false, env: envIn });
  if (!token) {
    throw new Error(
      "refusing to start: GROK_RELAY_DEVICE_TOKEN is not usable. " +
        "Need a development build, GROK_RELAY_URL overridden away from production, " +
        "and a non-empty token. A production build never accepts an injected token.",
    );
  }

  const grokHome = typeof envIn.GROK_HOME === "string" ? envIn.GROK_HOME.trim() : "";
  if (!grokHome) throw new Error("GROK_HOME is required and must be stable across a restart");
  fs.mkdirSync(grokHome, { recursive: true });

  const workspaces = parseLifecycleWorkspaces(envIn[LIFECYCLE_WORKSPACES_ENV]);
  if (!workspaces.length) {
    throw new Error(
      "GROK_LIFECYCLE_WORKSPACES is required (OS-delimited paths, or a JSON array). " +
        "Repo switching needs at least two distinct folders.",
    );
  }
  for (const cwd of workspaces) {
    let st;
    try {
      st = fs.statSync(cwd);
    } catch {
      throw new Error(`workspace does not exist: ${cwd}`);
    }
    if (!st.isDirectory()) throw new Error(`workspace is not a directory: ${cwd}`);
  }

  const mainJs = path.join(root, "out", "desktop", "main.js");
  if (!fs.existsSync(mainJs)) {
    throw new Error(`Missing ${mainJs} — run \`npm run compile\` first`);
  }
  const electronExe = path.join(
    root,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron",
  );
  if (!fs.existsSync(electronExe)) {
    throw new Error(`Missing Electron at ${electronExe}`);
  }

  const fakeCli = resolveFakeCli();
  const userData = path.join(path.resolve(grokHome), ".lifecycle-desktop-user-data");
  const configJson = writeProfile(userData, workspaces, fakeCli);
  ensureSessionCatalogs(path.resolve(grokHome), workspaces);

  const env = { ...envIn };
  delete env.ELECTRON_RUN_AS_NODE;
  env.GROK_HOME = path.resolve(grokHome);
  env.NODE_ENV = "test";
  env.GROK_DESKTOP_TEST_ALLOW_MULTIPLE = "1";
  // Isolate from a developer instance that might hold the same branded profile.
  env.GROK_DESKTOP_USER_DATA = userData;

  const child = spawn(
    electronExe,
    [
      mainJs,
      `--user-data-dir=${userData}`,
      `--config-json=${configJson}`,
      "--disable-gpu",
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  const readyMs = Number(envIn.GROK_LIFECYCLE_READY_MS) || 60_000;
  let ready = false;
  let finished = false;
  let carry = "";

  const scan = (buf, stream) => {
    const text = buf.toString("utf8");
    stream.write(text);
    const combined = carry + text;
    if (!ready && combined.includes(UPLINK_CONNECTED_NEEDLE)) {
      ready = true;
      process.stdout.write(`${LIFECYCLE_HOST_READY_LINE}\n`);
    }
    carry = combined.slice(-UPLINK_CONNECTED_NEEDLE.length);
  };
  child.stdout.on("data", (buf) => scan(buf, process.stdout));
  child.stderr.on("data", (buf) => scan(buf, process.stderr));

  return await new Promise((resolve, reject) => {
    const done = (err, code) => {
      if (finished) return;
      finished = true;
      clearTimeout(readyTimer);
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      if (err) reject(err);
      else resolve(code ?? 0);
    };
    const readyTimer = setTimeout(() => {
      killTree(child);
      done(
        new Error(
          `uplink did not connect within ${readyMs}ms ` +
            `(relay ${redactRelayUrl(envIn[RELAY_URL_ENV] || "")})`,
        ),
      );
    }, readyMs);
    const shutdown = () => {
      killTree(child);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    child.once("error", (err) => done(err));
    child.once("exit", (code, signal) => {
      if (!ready) {
        done(
          new Error(
            `host exited before uplink connected (code ${code}, signal ${signal})`,
          ),
        );
        return;
      }
      // Orchestrator kill after ready is the expected end of a run.
      done(undefined, 0);
    });
  });
}

function launchedDirectly() {
  const self = fileURLToPath(import.meta.url);
  const argv1 = process.argv[1] && path.resolve(process.argv[1]);
  return argv1 === self;
}

if (launchedDirectly()) {
  runLifecycleHost({ env: process.env })
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      process.stderr.write(`[lifecycle-host] ${e && e.message ? e.message : e}\n`);
      process.exit(1);
    });
}
