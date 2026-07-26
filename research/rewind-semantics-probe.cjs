// DECISIVE probe: does `_x.ai/rewind/execute` KEEP the target prompt or DISCARD it?
//
// This is load-bearing for both Rewind and Edit-and-resend (#56):
//   - if rewind to N KEEPS N, then "remove my last message" must target N-1
//   - if rewind to N DISCARDS N, then it must target N itself
// Get it wrong by one and the user silently loses an extra turn (and, in
// mode=all, an extra turn's file changes).
//
// Observation alone can't separate "off-by-one target" from "discards target" —
// both truncate to the same place. So this builds a session with KNOWN indices
// in a throwaway cwd, rewinds to a KNOWN index, and re-lists the points.
//
// mode=conversation_only: touches no files.
//
// Usage: node research/rewind-semantics-probe.cjs
//        GROK_BIN=… node research/rewind-semantics-probe.cjs

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-rwsem-")));
const proc = spawn(GROK, ["agent", "stdio"], { cwd });
let nextId = 1;
const waiters = new Map();

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => waiters.set(id, res));
}
function respond(id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

let buf = "";
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    } else if (msg.id != null && msg.method) {
      respond(msg.id, {});
    }
  }
});
proc.stderr.on("data", () => {});

const INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
};
const LABELS = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"];

function previews(result) {
  const rows = (result && (result.rewind_points || result.rewindPoints)) || [];
  return rows.map((r) => ({
    idx: r.prompt_index ?? r.promptIndex,
    preview: String(r.prompt_preview ?? r.promptPreview ?? "").replace(/\s+/g, " ").slice(0, 40),
  }));
}

(async () => {
  await send("initialize", INIT);
  const s = await send("session/new", { cwd, mcpServers: [] });
  const sessionId = s.result.sessionId;
  console.log(`session ${sessionId}\ncwd ${cwd}\n`);

  for (const label of LABELS) {
    const r = await send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: `Say only: ${label}. No tools.` }],
    });
    if (r.error) throw new Error("prompt failed: " + JSON.stringify(r.error));
  }

  const before = await send("_x.ai/rewind/points", { sessionId });
  const b = previews(before.result);
  console.log("BEFORE — points:");
  for (const p of b) console.log(`  #${p.idx}  "${p.preview}"`);

  // Which point to rewind to.
  // argv[2]: "last" targets the TIP (what Edit-on-last-message needs), else the 2nd point.
  const target = process.argv[2] === "last" ? b[b.length - 1] : b[1];
  console.log(`\nexecute: targetPromptIndex=${target.idx}  ("${target.preview}")  mode=conversation_only force=true\n`);
  const ex = await send("_x.ai/rewind/execute", {
    sessionId,
    targetPromptIndex: target.idx,
    mode: "conversation_only",
    force: true,
  });
  console.log("execute result:", JSON.stringify(ex.result || ex.error));

  const after = await send("_x.ai/rewind/points", { sessionId });
  const a = previews(after.result);
  console.log("\nAFTER — points:");
  for (const p of a) console.log(`  #${p.idx}  "${p.preview}"`);

  const survived = a.some((p) => p.idx === target.idx);
  console.log(
    `\n>>> VERDICT: rewinding to #${target.idx} ${survived ? "KEEPS the target" : "DISCARDS the target"}`,
  );
  console.log(`>>> points ${b.length} -> ${a.length}`);
  console.log(
    `>>> So "remove my last message" must target ${survived ? "the point BEFORE it (N-1)" : "the message itself (N)"}`,
  );
  proc.kill();
})().catch((e) => {
  console.error("probe error:", e);
  proc.kill();
  process.exit(1);
});
