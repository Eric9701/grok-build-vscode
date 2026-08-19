#!/usr/bin/env node
/**
 * Research probe — can grok's shared leader back "attach to a live terminal session"?
 * (GitHub issue #50). Diagnostic only. Does not import or modify shipped extension
 * code. Burns a few short SuperGrok turns.
 *
 * An ad-hoc 2026-08-18 measurement already showed two `--leader` clients on one
 * cwd, second attaching mid-turn via session/load, saw 107 session/update in 8s
 * vs 1 with `--no-leader`. That run was not saved. This script reproduces it
 * and answers the two questions that decide whether attach mode is buildable:
 *
 *   Q1  Where does session/request_permission go with two clients on one leader?
 *   Q2  Do two workspaces on one leader bleed into each other?
 *
 * Also records: leader list/info/kill as a session picker, mid-turn history
 * completeness, creator-disconnect, and leader-death.
 *
 * Isolation: throwaway cwds, throwaway GROK_HOME (auth.json copied, nothing
 * else), `--leader-socket` in that temp tree. Never touches the developer's
 * `~/.grok/leader.sock` / default `leader.lock`. On Windows the IPC handle is
 * a named pipe (`\\.\pipe\grok-leader-<hash>`), not a unix socket file — the
 * probe discovers that rather than assuming.
 *
 * Usage:
 *   node research/leader-attach-probe.cjs
 *   GROK_BIN=… SKIP_NOLEADER=1 node research/leader-attach-probe.cjs
 */
const { spawn, execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function resolveGrok() {
  if (process.env.GROK_BIN && fs.existsSync(process.env.GROK_BIN)) return process.env.GROK_BIN;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const win = process.platform === "win32";
  const candidates = win
    ? [path.join(home, ".grok", "bin", "grok.exe"), path.join(home, ".grok", "bin", "grok.cmd")]
    : [path.join(home, ".grok", "bin", "grok")];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return win ? "grok.exe" : "grok";
}

const GROK = resolveGrok();
const WIN = process.platform === "win32";
const USE_SHELL = /\.(cmd|bat)$/i.test(GROK) && WIN;
const SKIP_NOLEADER = /^(1|true|yes)$/i.test(process.env.SKIP_NOLEADER || "");
const WINDOW_MS = Number(process.env.ATTACH_WINDOW_MS) || 8000;
const INIT_CAPS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  clientInfo: { name: "leader-attach-probe", version: "0" },
};
const STREAM_PROMPT =
  "Count from 1 to 40. Write each number on its own line as `N: noun` where noun is a single short English noun. Do not skip. Do not use tools. Stop after 40.";
const SECRET_A = "WORKSPACE_A_SECRET_7f3c19aa";
const SECRET_B = "WORKSPACE_B_SECRET_9a21d4ee";
const PERM_MARK = "PERM_PROBE_OK_c41e";

const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);

function log(s) {
  process.stderr.write(`[leader-attach ${stamp()}] ${s}\n`);
}
function out(s) {
  process.stdout.write(String(s) + "\n");
}
function j(v, n) {
  let s;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  if (n && s.length > n) return s.slice(0, n) + `…(+${s.length - n})`;
  return s;
}
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms: ${label}`)), ms)),
  ]);
}
function killTree(proc) {
  try {
    if (!proc || proc.killed) return;
    if (WIN && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill();
    }
  } catch { /* */ }
}
function listGrokPipes() {
  if (!WIN) return [];
  try {
    return fs.readdirSync("\\\\.\\pipe\\").filter((n) => /grok-leader/i.test(n));
  } catch (e) {
    return ["(readdir pipe failed: " + e.message + ")"];
  }
}
function describePath(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, isFile: st.isFile(), isSocket: typeof st.isSocket === "function" && st.isSocket(), size: st.size, mode: st.mode };
  } catch (e) {
    return { exists: false, error: e.code || e.message };
  }
}

// ── isolated workspace ───────────────────────────────────────────────────────
const REAL_GROK_HOME = process.env.GROK_HOME || path.join(process.env.USERPROFILE || os.homedir(), ".grok");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "grok-leader-attach-"));
const ISOLATED_HOME = path.join(ROOT, "ghome");
const SOCK = path.join(ROOT, "leader.sock");
const CWD_A = path.join(ROOT, "wsA");
const CWD_B = path.join(ROOT, "wsB");
fs.mkdirSync(ISOLATED_HOME, { recursive: true });
fs.mkdirSync(CWD_A, { recursive: true });
fs.mkdirSync(CWD_B, { recursive: true });

const realAuth = path.join(REAL_GROK_HOME, "auth.json");
if (!fs.existsSync(realAuth)) {
  console.error("no auth.json at " + realAuth + " — probe needs a logged-in grok");
  process.exit(2);
}
fs.copyFileSync(realAuth, path.join(ISOLATED_HOME, "auth.json"));

// Global ask rule lives in the isolated home so we do not edit the developer's
// config. ask beats allow (deny > ask > allow), which is how we try to force a
// card even if ~/.claude/settings.local.json still loads from the real user
// profile — GROK_HOME does not isolate Claude-compat files.
const ASK_TOML = `[cli]
auto_update = false
use_leader = false

[features]
support_permission = true

[ui]
permission_mode = "ask"
yolo = false

[permission]
ask = ["Bash(*)", "Bash(node *)"]
rules = [
  { action = "ask", tool = "bash" },
]
`;
fs.writeFileSync(path.join(ISOLATED_HOME, "config.toml"), ASK_TOML);
fs.writeFileSync(
  path.join(ISOLATED_HOME, "trusted_folders.toml"),
  `[folders.${JSON.stringify(CWD_A)}]\ntrusted = true\ndecided_at = 1\n\n[folders.${JSON.stringify(CWD_B)}]\ntrusted = true\ndecided_at = 1\n`,
);

function seedWorkspace(cwd, markName, secret) {
  fs.mkdirSync(path.join(cwd, ".grok"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".grok", "config.toml"), ASK_TOML);
  fs.writeFileSync(path.join(cwd, markName), secret + "\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "leader-attach probe workspace\n");
  // Deliberately no `git init`. An untrusted git repo discards project
  // permission rules; a non-git folder stays trusted on this host.
}
seedWorkspace(CWD_A, "MARK_A.txt", SECRET_A);
seedWorkspace(CWD_B, "MARK_B.txt", SECRET_B);

const CHILD_ENV = {
  ...process.env,
  GROK_HOME: ISOLATED_HOME,
  GROK_DISABLE_AUTOUPDATER: "1",
};

const TRACKED = [];
function track(proc, label) {
  TRACKED.push({ proc, label });
  return proc;
}

function grokCli(args, opts) {
  const timeout = (opts && opts.timeout) || 20000;
  const cwd = (opts && opts.cwd) || ROOT;
  try {
    const outb = execFileSync(GROK, args, {
      cwd,
      env: CHILD_ENV,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(outb || "").trim(), stderr: "" };
  } catch (e) {
    return {
      ok: false,
      stdout: String((e && e.stdout) || "").trim(),
      stderr: String((e && e.stderr) || "").trim(),
      error: e && e.message,
    };
  }
}

// ── ACP client ───────────────────────────────────────────────────────────────
class AcpClient {
  constructor(label, cwd, mode) {
    this.label = label;
    this.cwd = cwd;
    this.mode = mode; // "leader" | "noleader"
    this.nextId = 1;
    this.waiters = new Map();
    this.buf = "";
    this.stderr = "";
    this.events = [];
    this.updates = [];
    this.requests = [];
    this.notifications = [];
    this.permissions = [];
    this.held = [];
    this.permPolicy = "allow"; // allow | reject | hold
    this.text = "";
    this.sessionId = null;
    this.exitCode = null;
    this.spawnedAt = now();
    const args = mode === "leader"
      ? ["agent", "--leader", "--leader-socket", SOCK, "--reasoning-effort", "low", "stdio"]
      : ["agent", "--no-leader", "--reasoning-effort", "low", "stdio"];
    this.proc = track(spawn(GROK, args, {
      cwd,
      env: CHILD_ENV,
      shell: USE_SHELL,
      windowsHide: true,
    }), label);
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => {
      this.stderr += d.toString();
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000);
    });
    this.proc.on("exit", (c) => {
      this.exitCode = c;
      this._note("exit", { code: c });
      for (const [, w] of this.waiters) w({ error: { message: "process-exited", code: c } });
      this.waiters.clear();
    });
    this.proc.on("error", (e) => this._note("spawn-error", { message: e.message }));
  }
  _note(kind, extra) {
    this.events.push({ t: now(), kind, ...extra });
  }
  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { this._note("non-json", { line: line.slice(0, 160) }); continue; }
      this._handle(m);
    }
  }
  _handle(m) {
    if (m.id != null && m.method == null) {
      const w = this.waiters.get(m.id);
      if (w) { this.waiters.delete(m.id); w(m); }
      return;
    }
    if (m.method && m.id != null) {
      this.requests.push({ t: now(), method: m.method, id: m.id, params: m.params });
      this._note("request", { method: m.method, id: m.id });
      return this._serverRequest(m);
    }
    if (m.method) {
      this.notifications.push({ t: now(), method: m.method, params: m.params });
      if (m.method === "session/update") {
        const u = (m.params && m.params.update) || {};
        const sid = (m.params && m.params.sessionId) || u.sessionId || null;
        const kind = u.sessionUpdate || "?";
        if (kind === "agent_message_chunk" && u.content && u.content.type === "text") {
          this.text += u.content.text || "";
        }
        this.updates.push({ t: now(), kind, sessionId: sid, update: u, paramsKeys: m.params ? Object.keys(m.params) : [] });
      }
    }
  }
  _serverRequest(m) {
    const meth = m.method;
    if (meth === "fs/read_text_file") {
      const p = m.params && m.params.path;
      try { return this._respond(m.id, { content: fs.readFileSync(p, "utf8") }); }
      catch (e) { return this._respondErr(m.id, -32603, e.message); }
    }
    if (meth === "fs/write_text_file") {
      const p = (m.params && m.params.path) || "";
      const inside = [CWD_A, CWD_B].some((root) => {
        const rel = path.relative(root, path.resolve(p));
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      });
      if (!inside) return this._respondErr(m.id, -32602, "probe refuses writes outside temp cwds");
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, (m.params && m.params.content) || "");
        return this._respond(m.id, {});
      } catch (e) { return this._respondErr(m.id, -32603, e.message); }
    }
    if (meth === "terminal/create") return this._respond(m.id, { terminalId: "t-" + this.label + "-" + this.nextId });
    if (meth === "terminal/output") return this._respond(m.id, { output: "", truncated: false, exitStatus: { exitCode: 0 } });
    if (meth === "terminal/wait_for_exit") return this._respond(m.id, { exitCode: 0 });
    if (meth === "terminal/kill" || meth === "terminal/release") return this._respond(m.id, {});
    if (meth === "session/request_permission") {
      const rec = {
        t: now(),
        client: this.label,
        rpcId: m.id,
        sessionId: m.params && m.params.sessionId,
        options: (m.params && m.params.options) || [],
        toolCall: m.params && m.params.toolCall,
        paramsKeys: m.params ? Object.keys(m.params) : [],
      };
      this.permissions.push(rec);
      log(`${this.label} PERMISSION rpcId=${m.id} keys=${j(rec.paramsKeys)} tool=${j(rec.toolCall && { kind: rec.toolCall.kind, title: rec.toolCall.title, status: rec.toolCall.status }, 240)}`);
      if (this.permPolicy === "hold") {
        this.held.push(rec);
        this._note("perm-held", { rpcId: m.id });
        return;
      }
      return this._answerPermission(rec, this.permPolicy === "reject" ? "reject" : "allow");
    }
    if (/ask_user_question/.test(meth)) return this._respond(m.id, { outcome: "cancelled" });
    if (/exit_plan_mode/.test(meth)) return this._respond(m.id, { outcome: "cancelled" });
    return this._respond(m.id, {});
  }
  _answerPermission(rec, which) {
    const opts = rec.options || [];
    const pick = which === "reject"
      ? (opts.find((o) => /reject/.test(o.kind)) || opts[opts.length - 1])
      : (opts.find((o) => o.kind === "allow_once") || opts.find((o) => /allow/.test(o.kind)) || opts[0]);
    const result = pick
      ? { outcome: { outcome: "selected", optionId: pick.optionId } }
      : { outcome: { outcome: "cancelled" } };
    rec.answered = { which, result, at: now() };
    this._respond(rec.rpcId, result);
    this._note("perm-answered", { rpcId: rec.rpcId, which, optionId: pick && pick.optionId });
    return result;
  }
  answerHeld(which) {
    const rec = this.held.shift();
    if (!rec) return null;
    return this._answerPermission(rec, which || "allow");
  }
  send(method, params) {
    const id = this.nextId++;
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
    catch (e) { return Promise.resolve({ error: { message: "stdin-write: " + e.message } }); }
    return new Promise((res) => this.waiters.set(id, res));
  }
  _respond(id, result) {
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); } catch { /* */ }
  }
  _respondErr(id, code, message) {
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); } catch { /* */ }
  }
  async initialize() {
    const r = await withTimeout(this.send("initialize", INIT_CAPS), 60000, this.label + " initialize");
    if (r.error) throw new Error(this.label + " initialize: " + j(r.error));
    this.init = r.result;
    return r.result;
  }
  async sessionNew(cwd) {
    const r = await withTimeout(this.send("session/new", { cwd: cwd || this.cwd, mcpServers: [] }), 60000, this.label + " session/new");
    if (r.error) throw new Error(this.label + " session/new: " + j(r.error));
    this.sessionId = r.result && r.result.sessionId;
    return r;
  }
  async sessionLoad(sessionId, cwd) {
    const r = await withTimeout(
      this.send("session/load", { sessionId, cwd: cwd || this.cwd, mcpServers: [] }),
      90000,
      this.label + " session/load",
    );
    if (r.result && r.result.sessionId) this.sessionId = r.result.sessionId;
    return r;
  }
  prompt(text, sessionId) {
    return this.send("session/prompt", {
      sessionId: sessionId || this.sessionId,
      prompt: [{ type: "text", text }],
    });
  }
  async waitUntil(pred, ms, label) {
    const t0 = now();
    while (now() - t0 < ms) {
      if (pred(this)) return true;
      await sleep(80);
    }
    throw new Error(`waitUntil ${ms}ms: ${label || this.label}`);
  }
  updatesSince(t0, t1) {
    return this.updates.filter((u) => u.t >= t0 && u.t <= (t1 == null ? Infinity : t1));
  }
  snapshotAround(t, beforeMs, afterMs) {
    const lo = t - beforeMs, hi = t + afterMs;
    return {
      updates: this.updates.filter((u) => u.t >= lo && u.t <= hi).map(summarizeUpdate),
      requests: this.requests.filter((r) => r.t >= lo && r.t <= hi).map((r) => ({ t: r.t, method: r.method, id: r.id })),
      notifications: this.notifications.filter((n) => n.t >= lo && n.t <= hi).map((n) => n.method),
    };
  }
  kill() { killTree(this.proc); }
}

function summarizeUpdate(u) {
  const x = { t: u.t, kind: u.kind, sessionId: u.sessionId };
  const up = u.update || {};
  if (up.status) x.status = up.status;
  if (up.title) x.title = up.title;
  if (up.kind) x.toolKind = up.kind;
  if (up.toolCallId) x.toolCallId = up.toolCallId;
  if (up.content && up.content.type === "text" && up.content.text) {
    x.text = String(up.content.text).slice(0, 80);
  }
  return x;
}
function kindCounts(updates) {
  const m = {};
  for (const u of updates) m[u.kind] = (m[u.kind] || 0) + 1;
  return m;
}

// ── leader process ───────────────────────────────────────────────────────────
let leaderProc = null;
function startLeader() {
  const args = ["agent", "leader", "--leader-socket", SOCK, "--no-exit-on-disconnect", "--relay-on-demand", "--no-auto-update"];
  leaderProc = track(spawn(GROK, args, {
    cwd: ROOT,
    env: CHILD_ENV,
    shell: USE_SHELL,
    windowsHide: true,
  }), "leader");
  leaderProc.stdout.on("data", () => {});
  leaderProc.stderr.on("data", () => {});
  return leaderProc;
}
async function waitLeaderReady(ms) {
  const t0 = now();
  while (now() - t0 < ms) {
    if (leaderProc && leaderProc.exitCode != null) {
      throw new Error("leader exited during startup code=" + leaderProc.exitCode);
    }
    const lock = describePath(path.join(ROOT, "leader.lock"));
    if (lock.exists) return { readyMs: now() - t0, lock, sock: describePath(SOCK), pipes: listGrokPipes() };
    await sleep(150);
  }
  return { readyMs: now() - t0, lock: describePath(path.join(ROOT, "leader.lock")), sock: describePath(SOCK), pipes: listGrokPipes(), timedOut: true };
}

const VERDICT = {
  version: null,
  socket: null,
  leaderCli: null,
  baseline: {},
  history: null,
  q1: null,
  q2: null,
  disconnect: null,
  leaderDeath: null,
};

function cleanup() {
  for (const { proc } of TRACKED) killTree(proc);
  // Only our socket. Never `grok leader kill` without --leader-socket.
  try { grokCli(["leader", "kill", "--leader-socket", SOCK], { timeout: 8000 }); } catch { /* */ }
  try { if (leaderProc) killTree(leaderProc); } catch { /* */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
}

process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

// ── phases ───────────────────────────────────────────────────────────────────
async function phaseDiscover() {
  out("");
  out("════════════════════════════════════════════════════════");
  out(" PHASE 0 — environment, socket shape, leader CLI");
  out("════════════════════════════════════════════════════════");
  let ver = "";
  try { ver = execFileSync(GROK, ["--version"], { encoding: "utf8", timeout: 15000 }).trim(); }
  catch (e) { ver = "unreadable: " + e.message; }
  VERDICT.version = ver;
  out(`grok binary : ${GROK}`);
  out(`grok version: ${ver}`);
  out(`platform    : ${process.platform} ${os.release()}`);
  out(`probe root  : ${ROOT}`);
  out(`GROK_HOME   : ${ISOLATED_HOME}  (isolated; auth copied from ${realAuth})`);
  out(`leader sock : ${SOCK}`);
  out(`cwd A       : ${CWD_A}`);
  out(`cwd B       : ${CWD_B}`);
  out(`real home   : ${REAL_GROK_HOME}  (not used for sessions / default leader)`);

  const pipesBefore = listGrokPipes();
  out(`named pipes before leader: ${j(pipesBefore)}`);

  log("starting isolated leader");
  startLeader();
  const ready = await waitLeaderReady(15000);
  await sleep(400);
  const pipesAfter = listGrokPipes();
  const newPipes = pipesAfter.filter((p) => !pipesBefore.includes(p));
  const sockDesc = describePath(SOCK);
  const lockDesc = describePath(path.join(ROOT, "leader.lock"));
  VERDICT.socket = {
    requestedPath: SOCK,
    pathExistsAsFile: sockDesc.exists,
    pathStat: sockDesc,
    lockSibling: lockDesc,
    pipesBefore,
    pipesAfter,
    newPipes,
    interpretation: !sockDesc.exists && newPipes.length
      ? "Windows named pipe (no unix socket inode at --leader-socket path)"
      : sockDesc.exists
        ? "filesystem socket/file appeared at --leader-socket path"
        : "no socket file and no new named pipe — see lock/leader logs",
  };
  out(`leader pid  : ${leaderProc && leaderProc.pid}`);
  out(`socket file : ${j(sockDesc)}`);
  out(`lock sibling: ${j(lockDesc)}`);
  out(`new pipes   : ${j(newPipes)}`);
  out(`socket kind : ${VERDICT.socket.interpretation}`);

  const listCustom = grokCli(["leader", "list", "--json", "--leader-socket", SOCK]);
  const infoCustom = grokCli(["leader", "info", "--json", "--leader-socket", SOCK]);
  const listPlainIsolated = grokCli(["leader", "list", "--json"]);
  // Default-home list is read-only evidence of the picker schema. Do not kill.
  let listDefaultHome = { skipped: "set GROK_HOME" };
  const prev = process.env.GROK_HOME;
  try {
    delete CHILD_ENV.GROK_HOME;
    listDefaultHome = grokCli(["leader", "list", "--json"]);
  } finally {
    CHILD_ENV.GROK_HOME = ISOLATED_HOME;
    if (prev !== undefined) process.env.GROK_HOME = prev;
  }
  VERDICT.leaderCli = {
    listCustom,
    infoCustom,
    listPlainIsolated,
    listDefaultHome,
  };
  out(`leader list --json --leader-socket <ours>:`);
  out(`  ok=${listCustom.ok} stdout=${listCustom.stdout || "(empty)"} stderr=${listCustom.stderr || infoCustom.error || ""}`);
  out(`leader info --json --leader-socket <ours>:`);
  out(`  ok=${infoCustom.ok} stdout=${infoCustom.stdout || "(empty)"} stderr=${infoCustom.stderr || infoCustom.error || ""}`);
  out(`leader list --json (isolated GROK_HOME, no socket flag): ${listPlainIsolated.stdout || listPlainIsolated.stderr || listPlainIsolated.error}`);
  out(`leader list --json (developer GROK_HOME, read-only): ${listDefaultHome.stdout || listDefaultHome.stderr || j(listDefaultHome)}`);

  const insp = grokCli(["inspect", "--json"], { cwd: CWD_A, timeout: 30000 });
  let inspObj = null;
  try { inspObj = JSON.parse(insp.stdout || "{}"); } catch { /* */ }
  const perm = inspObj && inspObj.permissions;
  out(`inspect cwdA projectTrusted=${inspObj && inspObj.projectTrusted} projectRoot=${j(inspObj && inspObj.projectRoot)}`);
  out(`inspect permissions.sources=${j(perm && perm.sources)} loaded=${perm && perm.loaded}`);
  const inspAsk = (insp.stdout || "").includes("Bash(*)") || (insp.stdout || "").includes('"ask"');
  out(`inspect text mentions our ask rule: ${inspAsk}`);
}

async function runAttachArm(mode) {
  const label = mode === "leader" ? "LEADER" : "NO-LEADER";
  out("");
  out(`── attach arm: ${label} (${WINDOW_MS}ms window) ──`);
  const a = new AcpClient(`A-${mode}`, CWD_A, mode);
  a.permPolicy = "allow";
  await a.initialize();
  await a.sessionNew(CWD_A);
  out(`  ${a.label} session ${a.sessionId}`);

  const promptP = a.prompt(STREAM_PROMPT);
  const promptState = { done: false, res: null };
  promptP.then((r) => { promptState.done = true; promptState.res = r; }).catch((e) => {
    promptState.done = true;
    promptState.res = { error: { message: e.message } };
  });
  await a.waitUntil((c) => c.updates.some((u) => u.kind === "agent_message_chunk" || u.kind === "agent_thought_chunk"), 90000, label + " first stream");
  const aTextAtAttach = a.text;
  const aUpdatesAtAttach = a.updates.length;
  out(`  ${a.label} live: ${aUpdatesAtAttach} updates, text=${j(aTextAtAttach.slice(0, 80))}`);

  const b = new AcpClient(`B-${mode}`, CWD_A, mode);
  b.permPolicy = "allow";
  await b.initialize();
  const tLoadSent = now();
  const load = await b.sessionLoad(a.sessionId, CWD_A);
  const tLoadDone = now();
  out(`  ${b.label} session/load ${load.error ? "ERR " + j(load.error) : "ok"} in ${tLoadDone - tLoadSent}ms`);

  await sleep(WINDOW_MS);
  const tEnd = now();
  const aStillInFlight = !promptState.done;
  const bWindow = b.updatesSince(tLoadSent, tEnd);
  const bAfterLoad = b.updatesSince(tLoadDone, tEnd);
  const bReplayish = bWindow.filter((u) => u.kind === "user_message_chunk" || u.kind === "available_commands_update" || u.kind === "current_mode_update");
  const bHasUserChunk = bWindow.some((u) => u.kind === "user_message_chunk");
  const bText = b.text;
  const aPrefixInB = aTextAtAttach && bText.includes(aTextAtAttach.slice(0, Math.min(24, aTextAtAttach.length)));
  const result = {
    mode,
    sessionId: a.sessionId,
    loadError: load.error || null,
    loadMs: tLoadDone - tLoadSent,
    aUpdatesAtAttach,
    aTextAtAttach: aTextAtAttach.slice(0, 200),
    aStillInFlightAtWindowEnd: aStillInFlight,
    bUpdatesIn8sFromLoadSent: bWindow.length,
    bUpdatesIn8sFromLoadDone: bAfterLoad.length,
    bKindCounts: kindCounts(bWindow),
    bHasUserMessageChunk: bHasUserChunk,
    bReplayishKinds: kindCounts(bReplayish),
    bTextHead: bText.slice(0, 240),
    aPrefixPresentInB: !!aPrefixInB,
    bFirstUpdates: bWindow.slice(0, 12).map(summarizeUpdate),
  };
  out(`  B saw ${result.bUpdatesIn8sFromLoadSent} session/update in ${WINDOW_MS}ms from load-sent (${result.bUpdatesIn8sFromLoadDone} after load resolved)`);
  out(`  B kinds: ${j(result.bKindCounts)}`);
  out(`  B user_message_chunk: ${result.bHasUserMessageChunk}  A-prefix in B text: ${result.aPrefixPresentInB}`);
  out(`  A still in-flight at window end: ${aStillInFlight}`);

  if (!promptState.done) {
    try { await withTimeout(promptP, 90000, label + " drain prompt"); } catch { /* */ }
  }
  a.kill();
  b.kill();
  await sleep(300);
  return result;
}

async function phaseBaseline() {
  out("");
  out("════════════════════════════════════════════════════════");
  out(" PHASE 1 — reproduce the 107-vs-1 mid-turn attach count");
  out("════════════════════════════════════════════════════════");
  if (!SKIP_NOLEADER) {
    try { VERDICT.baseline.noleader = await runAttachArm("noleader"); }
    catch (e) { VERDICT.baseline.noleader = { error: e.message }; out("  NO-LEADER arm failed: " + e.message); }
  } else {
    VERDICT.baseline.noleader = { skipped: true };
    out("  NO-LEADER arm skipped (SKIP_NOLEADER)");
  }
  try { VERDICT.baseline.leader = await runAttachArm("leader"); }
  catch (e) { VERDICT.baseline.leader = { error: e.message }; out("  LEADER arm failed: " + e.message); }

  const n = VERDICT.baseline.noleader && VERDICT.baseline.noleader.bUpdatesIn8sFromLoadSent;
  const l = VERDICT.baseline.leader && VERDICT.baseline.leader.bUpdatesIn8sFromLoadSent;
  out("");
  out(`  BASELINE TABLE`);
  out(`    no-leader  B updates in ${WINDOW_MS}ms : ${n == null ? j(VERDICT.baseline.noleader) : n}`);
  out(`    leader     B updates in ${WINDOW_MS}ms : ${l == null ? j(VERDICT.baseline.leader) : l}`);
  VERDICT.history = VERDICT.baseline.leader && !VERDICT.baseline.leader.error
    ? {
        attachedSawUserChunk: VERDICT.baseline.leader.bHasUserMessageChunk,
        attachedSawCreatorsPrefix: VERDICT.baseline.leader.aPrefixPresentInB,
        aUpdatesAtAttach: VERDICT.baseline.leader.aUpdatesAtAttach,
        bThoughts: VERDICT.baseline.leader.bKindCounts && VERDICT.baseline.leader.bKindCounts.agent_thought_chunk,
        meaning: VERDICT.baseline.leader.aPrefixPresentInB
          ? "attacher's text included the creator's pre-attach agent prefix — missed tokens were replayed or caught up"
          : VERDICT.baseline.leader.bHasUserMessageChunk
            ? "attacher got user_message_chunk (the prompt) but not the creator's pre-attach agent text — treat in-flight thoughts/tokens as live-tail unless a later run shows a prefix match"
            : "attacher did not receive the pre-attach transcript — live tail only",
      }
    : { error: "leader arm did not complete" };
  out(`  HISTORY: ${VERDICT.history.meaning || VERDICT.history.error}`);
}

function permBrief(p) {
  if (!p) return null;
  return {
    client: p.client,
    rpcId: p.rpcId,
    sessionId: p.sessionId,
    optionKinds: (p.options || []).map((o) => o.kind),
    tool: p.toolCall && { kind: p.toolCall.kind, title: p.toolCall.title, status: p.toolCall.status },
    paramsKeys: p.paramsKeys,
    answered: p.answered && { which: p.answered.which, at: p.answered.at },
  };
}

async function phasePermission() {
  out("");
  out("════════════════════════════════════════════════════════");
  out(" PHASE 2 — Q1 permission routing (two clients, one leader)");
  out("════════════════════════════════════════════════════════");
  const a = new AcpClient("perm-A", CWD_A, "leader");
  const b = new AcpClient("perm-B", CWD_A, "leader");
  a.permPolicy = "hold";
  b.permPolicy = "hold";
  await a.initialize();
  await a.sessionNew(CWD_A);
  await b.initialize();
  const load = await b.sessionLoad(a.sessionId, CWD_A);
  out(`  both on session ${a.sessionId}  B load=${load.error ? "ERR " + j(load.error) : "ok"}`);

  const permPrompt =
    `Run this exact shell command now, do not skip it, do not only describe it: ` +
    `node -e "console.log('${PERM_MARK}')". ` +
    `Use the bash/shell tool. After it prints, reply with only the printed line.`;
  const tried = [];
  const promptP = a.prompt(permPrompt);
  tried.push({ how: "ask-rule Bash(*) + node -e marker, hold both clients" });

  const waitMs = 120000;
  const tWait = now();
  while (now() - tWait < waitMs && a.permissions.length + b.permissions.length === 0) {
    if (a.updates.some((u) => u.kind === "tool_call") && now() - tWait > 25000) break;
    await sleep(100);
  }
  const received = {
    A: a.permissions.map(permBrief),
    B: b.permissions.map(permBrief),
  };
  out(`  permission requests: A=${a.permissions.length} B=${b.permissions.length}`);
  out(`  A: ${j(received.A, 800)}`);
  out(`  B: ${j(received.B, 800)}`);

  const q1 = {
    tried,
    received,
    whoReceived: [
      a.permissions.length ? "perm-A" : null,
      b.permissions.length ? "perm-B" : null,
    ].filter(Boolean),
    otherAtArrival: null,
    afterOneAnswer: null,
    bothAnswer: null,
    nullResult: a.permissions.length + b.permissions.length === 0,
    toolsSeenWithoutPerm: a.updates.filter((u) => u.kind === "tool_call" || u.kind === "tool_call_update").map(summarizeUpdate).slice(0, 12),
  };

  if (q1.nullResult) {
    out("  NULL RESULT: no session/request_permission on either client.");
    out("  tool_call rows while waiting: " + j(q1.toolsSeenWithoutPerm, 600));
    try { await withTimeout(promptP, 45000, "perm drain"); } catch { /* */ }
    a.kill(); b.kill();
    VERDICT.q1 = q1;
    return;
  }

  const firstT = Math.min(
    ...[...a.permissions, ...b.permissions].map((p) => p.t),
  );
  const other = a.permissions.length && !b.permissions.length ? b
    : b.permissions.length && !a.permissions.length ? a
    : null;
  if (other) {
    q1.otherAtArrival = {
      label: other.label,
      snapshot: other.snapshotAround(firstT, 500, 1500),
      held: other.held.length,
      permissions: other.permissions.length,
    };
    out(`  other client (${other.label}) at arrival: updates=${q1.otherAtArrival.snapshot.updates.length} reqs=${j(q1.otherAtArrival.snapshot.requests)} notifs=${j(q1.otherAtArrival.snapshot.notifications)}`);
  } else {
    q1.otherAtArrival = { bothReceived: true };
    out("  BOTH clients received session/request_permission");
  }

  // Answer from A if A has one, else from B.
  const answerer = a.held.length ? a : b;
  const watcher = answerer === a ? b : a;
  const beforeAns = now();
  const ans = answerer.answerHeld("allow");
  out(`  ${answerer.label} answered allow → ${j(ans)}`);
  await sleep(2500);
  q1.afterOneAnswer = {
    answerer: answerer.label,
    watcher: watcher.label,
    watcherNewPerms: watcher.permissions.filter((p) => p.t >= beforeAns).map(permBrief),
    watcherStillHeld: watcher.held.map(permBrief),
    watcherSnapshot: watcher.snapshotAround(beforeAns, 0, 2500),
    watcherNewRequests: watcher.requests.filter((r) => r.t >= beforeAns).map((r) => ({ method: r.method, id: r.id })),
  };
  out(`  watcher ${watcher.label} after answer: stillHeld=${watcher.held.length} newReqs=${j(q1.afterOneAnswer.watcherNewRequests)} kinds=${j(kindCounts(watcher.updates.filter((u) => u.t >= beforeAns)))}`);

  if (watcher.held.length) {
    const r2 = watcher.answerHeld("allow");
    q1.bothAnswer = { secondAnswerer: watcher.label, result: r2, note: "second client also had a held request and we answered it" };
    out(`  BOTH-ANSWER: ${watcher.label} also answered → ${j(r2)}`);
  } else if (answerer.held.length) {
    const r2 = answerer.answerHeld("allow");
    q1.bothAnswer = { secondAnswerer: answerer.label, result: r2, note: "same client had a second held request" };
  } else {
    q1.bothAnswer = {
      skipped: true,
      reason: "only one held request existed — cannot dual-answer the same RPC on the client that never received it",
    };
    out("  BOTH-ANSWER: skipped (the other client had no request to answer)");
  }

  try { await withTimeout(promptP, 90000, "perm turn finish"); } catch (e) { q1.promptError = e.message; }
  out(`  perm turn text A: ${j(a.text.slice(0, 200))}`);
  a.kill(); b.kill();
  VERDICT.q1 = q1;
}

async function phaseBleed() {
  out("");
  out("════════════════════════════════════════════════════════");
  out(" PHASE 3 — Q2 cross-workspace bleed (adversarial)");
  out("════════════════════════════════════════════════════════");
  const a = new AcpClient("bleed-A", CWD_A, "leader");
  const b = new AcpClient("bleed-B", CWD_B, "leader");
  a.permPolicy = "allow";
  b.permPolicy = "allow";
  await a.initialize();
  await a.sessionNew(CWD_A);
  await b.initialize();
  await b.sessionNew(CWD_B);
  out(`  A session ${a.sessionId} cwd=${CWD_A}`);
  out(`  B session ${b.sessionId} cwd=${CWD_B}`);

  const lists = {};
  for (const [name, client, params] of [
    ["A._x.ai/session/list {cwdA}", a, { cwd: CWD_A }],
    ["A._x.ai/session/list {}", a, {}],
    ["B._x.ai/session/list {cwdB}", b, { cwd: CWD_B }],
    ["B._x.ai/session/list {cwdA}", b, { cwd: CWD_A }],
    ["B._x.ai/session/list {}", b, {}],
    ["B.session/list {cwdB}", b, { cwd: CWD_B }],
    ["B.session/list {}", b, {}],
  ]) {
    const method = name.includes("session/list") && !name.includes("_x.ai") ? "session/list" : "_x.ai/session/list";
    const r = await withTimeout(client.send(method, params), 30000, name).catch((e) => ({ error: { message: e.message } }));
    const rows = (r.result && (r.result.sessions || r.result.rows || r.result.entries)) || [];
    const ids = rows.map((row) => row.sessionId || row.id).filter(Boolean);
    lists[name] = {
      error: r.error || null,
      rowCount: rows.length,
      ids: ids.slice(0, 12),
      containsA: ids.includes(a.sessionId),
      containsB: ids.includes(b.sessionId),
      sampleKeys: rows[0] ? Object.keys(rows[0]) : [],
    };
    out(`  ${name}: ${r.error ? "ERR " + j(r.error, 200) : rows.length + " rows"} containsA=${lists[name].containsA} containsB=${lists[name].containsB}`);
  }

  const bUpdatesBefore = b.updates.length;
  const bNotifsBefore = b.notifications.length;
  const readPrompt = `Read the file at this exact absolute path and reply with only its exact contents, no extra words: ${path.join(CWD_B, "MARK_B.txt")}`;
  const readRes = await withTimeout(a.prompt(readPrompt), 120000, "bleed read").catch((e) => ({ error: { message: e.message } }));
  const aText = a.text;
  const aSawB = aText.includes(SECRET_B);
  const bNewUpdates = b.updates.slice(bUpdatesBefore);
  const bGotASession = bNewUpdates.some((u) => u.sessionId && u.sessionId === a.sessionId);
  out(`  A read-B-file: prompt ${readRes.error ? "ERR " + j(readRes.error, 160) : "ok"} sawSecret=${aSawB} text=${j(aText.slice(0, 180))}`);
  out(`  B received ${bNewUpdates.length} updates during A's turn; any with A's sessionId: ${bGotASession}`);
  out(`  B new notif methods: ${j([...new Set(b.notifications.slice(bNotifsBefore).map((n) => n.method))])}`);

  const loadWrongCwd = await withTimeout(b.send("session/load", { sessionId: a.sessionId, cwd: CWD_B, mcpServers: [] }), 60000, "load A from B cwdB")
    .catch((e) => ({ error: { message: e.message } }));
  const loadRightCwd = await withTimeout(b.send("session/load", { sessionId: a.sessionId, cwd: CWD_A, mcpServers: [] }), 60000, "load A from B cwdA")
    .catch((e) => ({ error: { message: e.message } }));
  out(`  B session/load(A, cwdB): ${loadWrongCwd.error ? "ERR " + j(loadWrongCwd.error, 200) : "ok " + j(loadWrongCwd.result && { sessionId: loadWrongCwd.result.sessionId }, 160)}`);
  out(`  B session/load(A, cwdA): ${loadRightCwd.error ? "ERR " + j(loadRightCwd.error, 200) : "ok " + j(loadRightCwd.result && { sessionId: loadRightCwd.result.sessionId }, 160)}`);

  VERDICT.q2 = {
    sessionA: a.sessionId,
    sessionB: b.sessionId,
    lists,
    aReadForeignFile: aSawB,
    aReadTextHead: aText.slice(0, 200),
    bSawAsUpdates: bGotASession,
    bUpdateCountDuringA: bNewUpdates.length,
    loadAfromB_cwdB: { error: loadWrongCwd.error || null, sessionId: loadWrongCwd.result && loadWrongCwd.result.sessionId },
    loadAfromB_cwdA: { error: loadRightCwd.error || null, sessionId: loadRightCwd.result && loadRightCwd.result.sessionId },
  };
  a.kill();
  b.kill();
}

async function phaseDisconnectAndDeath() {
  out("");
  out("════════════════════════════════════════════════════════");
  out(" PHASE 4 — creator disconnect + leader death");
  out("════════════════════════════════════════════════════════");
  const a = new AcpClient("die-A", CWD_A, "leader");
  const b = new AcpClient("die-B", CWD_A, "leader");
  a.permPolicy = "allow";
  b.permPolicy = "allow";
  await a.initialize();
  await a.sessionNew(CWD_A);
  await b.initialize();
  await b.sessionLoad(a.sessionId, CWD_A);
  const promptP = a.prompt(STREAM_PROMPT);
  await a.waitUntil((c) => c.text.length > 20, 90000, "disconnect stream");
  const bBefore = b.updates.length;
  const aTextAtKill = a.text;
  out(`  killing creator ${a.label} mid-turn (text so far ${j(aTextAtKill.slice(0, 80))})`);
  a.kill();
  await sleep(10000);
  const bAfter = b.updates.slice(bBefore);
  const bGrew = bAfter.length;
  const bTextGrew = b.text.length > aTextAtKill.length || b.text.length > 0;
  VERDICT.disconnect = {
    killed: "die-A (session creator, in-flight prompt)",
    bUpdatesAfterKill: bGrew,
    bKindsAfterKill: kindCounts(bAfter),
    bTextHead: b.text.slice(0, 200),
    aTextAtKill: aTextAtKill.slice(0, 200),
    bProcessExit: b.exitCode,
    promptSettledOnDeadClient: "n/a — process killed",
    meaning: bGrew > 0
      ? "attached client kept receiving updates after the creator died — turn continued (or drained) on the leader"
      : "attached client went silent after creator death — turn likely bound to the prompting connection",
  };
  out(`  B after creator kill: +${bGrew} updates kinds=${j(VERDICT.disconnect.bKindsAfterKill)} exit=${b.exitCode}`);
  out(`  ${VERDICT.disconnect.meaning}`);
  void promptP;

  const bUpdatesBeforeDeath = b.updates.length;
  const bAlive = b.exitCode == null;
  out(`  killing the leader pid=${leaderProc && leaderProc.pid}`);
  if (leaderProc) killTree(leaderProc);
  await sleep(4000);
  VERDICT.leaderDeath = {
    leaderExit: leaderProc && leaderProc.exitCode,
    bExitAfterLeaderKill: b.exitCode,
    bWasAlive: bAlive,
    bNewUpdates: b.updates.length - bUpdatesBeforeDeath,
    bNewEvents: b.events.filter((e) => e.kind === "exit" || e.kind === "non-json").slice(-6),
    pipesAfter: listGrokPipes(),
  };
  out(`  after leader kill: B exit=${b.exitCode} newUpdates=${VERDICT.leaderDeath.bNewUpdates} pipes=${j(VERDICT.leaderDeath.pipesAfter)}`);
  b.kill();
}

function printVerdict() {
  out("");
  out("════════════════════════════════════════════════════════");
  out(" VERDICT");
  out("════════════════════════════════════════════════════════");
  const n = VERDICT.baseline.noleader && VERDICT.baseline.noleader.bUpdatesIn8sFromLoadSent;
  const l = VERDICT.baseline.leader && VERDICT.baseline.leader.bUpdatesIn8sFromLoadSent;
  out("");
  out("BASELINE (reproduce 107-vs-1)");
  out(`  no-leader B updates / ${WINDOW_MS}ms : ${n == null ? j(VERDICT.baseline.noleader) : n}`);
  out(`  leader    B updates / ${WINDOW_MS}ms : ${l == null ? j(VERDICT.baseline.leader) : l}`);
  if (typeof n === "number" && typeof l === "number") {
    out(`  leader/no-leader ratio              : ${n === 0 ? (l > 0 ? "∞" : "0") : (l / n).toFixed(1) + "×"}`);
    out(`  live-attach claim                   : ${l > Math.max(5, (n || 0) * 3) ? "SUPPORTED — leader fans out the live turn" : "WEAK / NOT REPRODUCED on this run"}`);
  }
  out(`  mid-turn history                    : ${VERDICT.history && (VERDICT.history.meaning || j(VERDICT.history))}`);

  out("");
  out("Q1 — Where does a permission prompt go?");
  if (!VERDICT.q1) {
    out("  UNANSWERED — phase did not run.");
  } else if (VERDICT.q1.nullResult) {
    out("  UNANSWERED — this host emitted 0 session/request_permission on either client.");
    out("  Tried: " + j(VERDICT.q1.tried));
    out("  Tools seen without a card: " + j(VERDICT.q1.toolsSeenWithoutPerm, 400));
    out("  A null result is a real result (previous probes on this machine also saw zero).");
    out("  Attach-mode implication: we could not measure permission fan-out. Do not claim cards appear on both surfaces.");
  } else {
    out("  recipients: " + j(VERDICT.q1.whoReceived));
    out("  A requests: " + j(VERDICT.q1.received.A, 500));
    out("  B requests: " + j(VERDICT.q1.received.B, 500));
    out("  other client at arrival: " + j(VERDICT.q1.otherAtArrival, 500));
    out("  after one answer: " + j(VERDICT.q1.afterOneAnswer && {
      answerer: VERDICT.q1.afterOneAnswer.answerer,
      watcher: VERDICT.q1.afterOneAnswer.watcher,
      watcherStillHeld: VERDICT.q1.afterOneAnswer.watcherStillHeld,
      watcherNewRequests: VERDICT.q1.afterOneAnswer.watcherNewRequests,
    }, 600));
    out("  both-answer: " + j(VERDICT.q1.bothAnswer, 400));
    const both = VERDICT.q1.whoReceived && VERDICT.q1.whoReceived.length === 2;
    const dangling = VERDICT.q1.afterOneAnswer && VERDICT.q1.afterOneAnswer.watcherStillHeld
      && VERDICT.q1.afterOneAnswer.watcherStillHeld.length > 0;
    out("  attach-mode implication: " + (both
      ? ("BOTH clients got the card — the AFK surface can show the prompt."
        + (dangling
          ? " The non-answerer's request stayed held (no cancel RPC); it learned the turn continued only via later session/update (tool_call_update). A second answer was accepted with no JSON-RPC error."
          : " The non-answerer's request did not stay held — see after-one-answer."))
      : "ONLY ONE client got the card — attach mode is broken for the AFK-approval case unless we pin routing to every attached surface."));
  }

  out("");
  out("Q2 — Do two workspaces on one leader bleed?");
  if (!VERDICT.q2) {
    out("  UNANSWERED — phase did not run.");
  } else {
    const q2 = VERDICT.q2;
    out(`  A=${q2.sessionA}  B=${q2.sessionB}`);
    for (const [k, v] of Object.entries(q2.lists || {})) {
      out(`  list ${k}: rows=${v.rowCount} containsA=${v.containsA} containsB=${v.containsB}${v.error ? " ERR " + j(v.error, 120) : ""}`);
    }
    out(`  A read B's distinguishing file by abs path: ${q2.aReadForeignFile}`);
    out(`  B received A's sessionId on session/update: ${q2.bSawAsUpdates} (${q2.bUpdateCountDuringA} updates during A's turn)`);
    out(`  B session/load(A, cwdB): ${q2.loadAfromB_cwdB.error ? "ERR " + j(q2.loadAfromB_cwdB.error, 160) : "SUCCEEDED " + q2.loadAfromB_cwdB.sessionId}`);
    out(`  B session/load(A, cwdA): ${q2.loadAfromB_cwdA.error ? "ERR " + j(q2.loadAfromB_cwdA.error, 160) : "SUCCEEDED " + q2.loadAfromB_cwdA.sessionId}`);
    const listBleed = Object.entries(q2.lists).some(([name, v]) => name.startsWith("B.") && name.includes("cwdB") && v.containsA);
    const notifBleed = q2.bSawAsUpdates;
    const loadBleed = !q2.loadAfromB_cwdB.error || !q2.loadAfromB_cwdA.error;
    out("  attach-mode implication: " + (
      listBleed || notifBleed
        ? "CROSS-WORKSPACE LEAK observed (list and/or live updates). That would kill a host-wide attach feature unless we filter by cwd ourselves."
        : `no live-update leak onto the other workspace's client. session/load of a foreign id from the other client ${loadBleed ? "SUCCEEDED — the leader does not bind a session to the connecting client's cwd" : "FAILED — sessions are cwd-scoped at load"}. File read of the other workspace is ${q2.aReadForeignFile ? "possible (same OS user; not leader isolation)" : "did not return the secret"}.`
    ));
  }

  out("");
  out("SOCKET / PICKER");
  out("  " + (VERDICT.socket && VERDICT.socket.interpretation));
  out("  requested path exists as file: " + (VERDICT.socket && VERDICT.socket.pathExistsAsFile));
  out("  new named pipes: " + j(VERDICT.socket && VERDICT.socket.newPipes));
  const listOut = VERDICT.leaderCli && VERDICT.leaderCli.listCustom && VERDICT.leaderCli.listCustom.stdout;
  out("  leader list --json (our socket): " + (listOut || (VERDICT.leaderCli && VERDICT.leaderCli.listCustom && (VERDICT.leaderCli.listCustom.stderr || VERDICT.leaderCli.listCustom.error)) || "?"));
  out("  leader info (our socket): " + j(VERDICT.leaderCli && VERDICT.leaderCli.infoCustom && (VERDICT.leaderCli.infoCustom.stdout || VERDICT.leaderCli.infoCustom.stderr || VERDICT.leaderCli.infoCustom.error), 240));
  out("  picker note: leader list/info describe leader PROCESSES (pid/lock/socket), not sessions. A 'sessions you could attach to' picker has to come from session/list (or disk), then session/load through a --leader client.");

  out("");
  out("DISCONNECT / DEATH");
  out("  creator disconnect: " + (VERDICT.disconnect && VERDICT.disconnect.meaning));
  out("  " + j(VERDICT.disconnect && { bUpdatesAfterKill: VERDICT.disconnect.bUpdatesAfterKill, bKindsAfterKill: VERDICT.disconnect.bKindsAfterKill, bProcessExit: VERDICT.disconnect.bProcessExit }, 300));
  out("  leader death: " + j(VERDICT.leaderDeath && { leaderExit: VERDICT.leaderDeath.leaderExit, bExitAfterLeaderKill: VERDICT.leaderDeath.bExitAfterLeaderKill, bNewUpdates: VERDICT.leaderDeath.bNewUpdates }, 300));

  out("");
  out("Raw verdict JSON (truncated fields already):");
  out(j({
    version: VERDICT.version,
    socket: VERDICT.socket,
    baseline: {
      noleader: VERDICT.baseline.noleader && {
        bUpdatesIn8sFromLoadSent: VERDICT.baseline.noleader.bUpdatesIn8sFromLoadSent,
        bKindCounts: VERDICT.baseline.noleader.bKindCounts,
        error: VERDICT.baseline.noleader.error,
      },
      leader: VERDICT.baseline.leader && {
        bUpdatesIn8sFromLoadSent: VERDICT.baseline.leader.bUpdatesIn8sFromLoadSent,
        bKindCounts: VERDICT.baseline.leader.bKindCounts,
        bHasUserMessageChunk: VERDICT.baseline.leader.bHasUserMessageChunk,
        aPrefixPresentInB: VERDICT.baseline.leader.aPrefixPresentInB,
        error: VERDICT.baseline.leader.error,
      },
    },
    history: VERDICT.history,
    q1: VERDICT.q1 && {
      nullResult: VERDICT.q1.nullResult,
      whoReceived: VERDICT.q1.whoReceived,
      received: VERDICT.q1.received,
      bothAnswer: VERDICT.q1.bothAnswer,
      afterOneAnswer: VERDICT.q1.afterOneAnswer && {
        answerer: VERDICT.q1.afterOneAnswer.answerer,
        watcherStillHeld: VERDICT.q1.afterOneAnswer.watcherStillHeld,
        watcherNewRequests: VERDICT.q1.afterOneAnswer.watcherNewRequests,
      },
    },
    q2: VERDICT.q2,
    disconnect: VERDICT.disconnect,
    leaderDeath: VERDICT.leaderDeath,
  }, 8000));
  out("");
  out("probe root was " + ROOT + " (removed on exit)");
}

async function run() {
  out("leader-attach-probe starting");
  try {
    await phaseDiscover();
    await phaseBaseline();
    await phasePermission();
    await phaseBleed();
    await phaseDisconnectAndDeath();
  } catch (e) {
    out("PROBE EXCEPTION: " + (e && e.stack || e));
    log("crashed: " + (e && e.stack || e));
  } finally {
    printVerdict();
    cleanup();
  }
}

run().then(() => setTimeout(() => process.exit(0), 400)).catch((e) => {
  console.error(e);
  cleanup();
  process.exit(2);
});
