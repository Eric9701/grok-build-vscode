// Worktree wire probe — does the installed CLI expose `_x.ai/git/worktree/*`?
//
// READ-ONLY: calls only `list` + `show` (no create/apply/remove), so it has no
// side effects. Confirms whether the worktree feature (PR #65 / P2-8) actually
// works on THIS build or degrades to "unsupported" (-32601). The pure parsers +
// AcpClient methods return "unsupported" on -32601, so a missing method is a
// graceful no-op, not a crash — this probe just tells us which build has it.
//
// The wire contract (funkpopo, probe-confirmed 0.2.111): research/worktree.md.
//   node research/worktree-probe.cjs            # against `grok` on PATH
//   GROK_BIN=/path/to/grok node research/worktree-probe.cjs
const { spawn, execFileSync } = require("node:child_process");
const readline = require("node:readline");

const GROK = process.env.GROK_BIN || "grok";
const cwd = process.cwd();
const proc = spawn(GROK, ["agent", "stdio"], { cwd, env: process.env });
let nextId = 1;
const waiters = new Map();

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => waiters.set(id, res));
}
function respond(id, result) { proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
proc.stderr.on("data", () => {});
proc.on("error", (e) => { console.error("SPAWN ERROR", e.message); process.exit(2); });

readline.createInterface({ input: proc.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  // Minimally ack any server->client request so the CLI never blocks.
  if (msg.method && msg.id != null) return respond(msg.id, {});
  if (msg.id != null) { const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); } }
});

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`timeout ${ms}ms: ${label}`)), ms))]);

(async () => {
  let version = "";
  try { version = execFileSync(GROK, ["--version"], { encoding: "utf8" }).trim(); } catch {}
  console.log("grok:", version);
  console.log("cwd: ", cwd);

  const init = await withTimeout(send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  }), 60000, "initialize");
  if (init.error) { console.log("initialize ERR", JSON.stringify(init.error)); return done(); }

  const ns = await withTimeout(send("session/new", { cwd, mcpServers: [] }), 120000, "session/new");
  if (ns.error) { console.log("session/new ERR", JSON.stringify(ns.error)); return done(); }
  const sessionId = ns.result.sessionId;
  console.log("session:", sessionId);

  // Bare (unprefixed) must 404 at the decoder; the `_`-prefixed one is the real method.
  for (const m of ["x.ai/git/worktree/list", "_x.ai/git/worktree/list", "_x.ai/git/worktree/show"]) {
    const params = m.endsWith("/show") ? { idOrPath: cwd } : {};
    const r = await withTimeout(send(m, params), 30000, m).catch((e) => ({ error: { message: e.message } }));
    if (r.error) console.log(`${m} -> ERROR ${r.error.code ?? ""} ${r.error.message}`);
    else console.log(`${m} -> OK ${JSON.stringify(r.result).slice(0, 240)}`);
  }
  done();
})().catch((e) => { console.error(e); done(); });

function done() { try { proc.kill(); } catch {} process.exit(0); }
