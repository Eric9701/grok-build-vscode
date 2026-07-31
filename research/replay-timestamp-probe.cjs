// Does grok 0.2.117 carry ORIGINAL timestamps on replayed session/update frames?
//
// Claim under test (#87): `params._meta.agentTimestampMs` survives a session/load
// replay, alongside `isReplay: true`. If true, the extension can stamp resumed
// messages with their real times straight off the wire — no updates.jsonl read.
//
// Reads only. Loads an EXISTING session in a fresh process and dumps params._meta
// for every replayed update. Never prompts, never writes to the workspace.
//
// Usage: node replay-meta-probe.cjs <sessionId> <cwd>

const { spawn } = require("node:child_process");
const path = require("node:path");

const SID = process.argv[2];
const CWD = process.argv[3];
if (!SID || !CWD) { console.error("usage: node replay-meta-probe.cjs <sessionId> <cwd>"); process.exit(2); }

const GROK = process.env.GROK_BIN || path.join(process.env.USERPROFILE || process.env.HOME, ".grok", "bin", "grok.exe");
const p = spawn(GROK, ["agent", "stdio"], { cwd: CWD, env: process.env });

let buf = "", nextId = 1, initId, loadId;
const seen = [];
const send = (method, params) => { const id = nextId++; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return id; };
const respond = (id, result) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

function finish() {
  console.log("\n================ REPLAY _meta SUMMARY ================");
  console.log(`replayed updates seen: ${seen.length}`);
  const withTs = seen.filter((s) => s.ts != null);
  const withReplay = seen.filter((s) => s.isReplay === true);
  console.log(`  carrying a timestamp field: ${withTs.length}`);
  console.log(`  carrying isReplay:true    : ${withReplay.length}`);
  const kinds = {};
  for (const s of seen) { kinds[s.kind] = kinds[s.kind] || { n: 0, ts: 0 }; kinds[s.kind].n++; if (s.ts != null) kinds[s.kind].ts++; }
  console.log("  by update kind (with-timestamp / total):");
  for (const [k, v] of Object.entries(kinds)) console.log(`    ${k}: ${v.ts}/${v.n}`);
  if (withTs.length) {
    const first = withTs[0], last = withTs[withTs.length - 1];
    console.log(`  first ts: ${first.ts}  -> ${new Date(Number(first.ts)).toISOString()}  (${first.kind})`);
    console.log(`  last  ts: ${last.ts}  -> ${new Date(Number(last.ts)).toISOString()}  (${last.kind})`);
    console.log(`  NOW     : ${Date.now()} -> ${new Date().toISOString()}`);
    console.log(withTs[0].ts && Math.abs(Date.now() - Number(first.ts)) > 60_000
      ? "  => ORIGINAL time preserved (not now)  ✔"
      : "  => within a minute of now — inconclusive, replay a session older than that");
  }
  console.log("======================================================");
  try { p.kill(); } catch {}
  process.exit(0);
}

function handle(m) {
  if (m.id != null && m.method == null) {
    if (m.id === initId) { console.log("--- session/load (replay below) ---"); loadId = send("session/load", { sessionId: SID, cwd: CWD, mcpServers: [] }); return; }
    if (m.id === loadId) { console.log("--- LOAD DONE ---"); setTimeout(finish, 400); return; }
    return;
  }
  if (m.method === "session/update" || m.method === "_x.ai/session/update") {
    const u = (m.params && m.params.update) || {};
    const meta = (m.params && m.params._meta) || {};
    const ts = meta.agentTimestampMs ?? meta.timestampMs ?? meta.timestamp ?? null;
    seen.push({ kind: u.sessionUpdate, ts, isReplay: meta.isReplay });
    if (seen.length <= 8) console.log(`  ${u.sessionUpdate}  _meta=${JSON.stringify(meta).slice(0, 220)}`);
    return;
  }
  if (m.method) { if (m.id != null) respond(m.id, {}); return; }
}

p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
p.stderr.on("data", (d) => { const s = d.toString(); if (/error|panic/i.test(s)) console.log("STDERR", s.slice(0, 160)); });
p.on("exit", (c) => console.log("EXIT", c));

initId = send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
setTimeout(() => { console.log("TIMEOUT"); finish(); }, 60_000);
