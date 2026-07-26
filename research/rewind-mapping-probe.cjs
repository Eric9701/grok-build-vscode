// READ-ONLY probe: what does `_x.ai/rewind/points` actually return for an
// EXISTING session, and how does our bubble->point mapping resolve against it?
//
// The on-disk rewind_points.jsonl carries no `prompt_preview` — the RPC
// synthesizes it — and that preview is the ONLY thing isHiddenRewindPoint uses
// to decide whether a point is plumbing (primer / system-reminder / marker-only
// plan verdict) or a real user bubble. So the file cannot tell us whether the
// mapping is right; only the RPC can.
//
// Executes NOTHING. It loads the session and lists points. No rewind, no
// prompt, no writes to the workspace.
//
// Usage:
//   node research/rewind-mapping-probe.cjs <sessionId> <cwd>
//   GROK_BIN=… node research/rewind-mapping-probe.cjs 019f9afb-… "c:\GitHub\grok-build-vscode"

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const SESSION_ID = process.argv[2];
const CWD = process.argv[3] || process.cwd();
if (!SESSION_ID) {
  console.error("usage: node research/rewind-mapping-probe.cjs <sessionId> [cwd]");
  process.exit(2);
}

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");

// Reuse the SHIPPED helpers, so what this prints is what the extension computes.
const rw = require(path.join(__dirname, "..", "out", "rewind.js"));

const proc = spawn(GROK, ["agent", "stdio"], { cwd: CWD });
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
      continue;
    }
    // Server->client requests during load: answer minimally so it can finish.
    if (msg.id != null && msg.method) {
      if (msg.method === "fs/read_text_file") respond(msg.id, { content: "" });
      else if (msg.method.startsWith("terminal/")) respond(msg.id, {});
      else respond(msg.id, {});
    }
  }
});
proc.stderr.on("data", () => {});

const INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
};

(async () => {
  await send("initialize", INIT);
  const load = await send("session/load", { sessionId: SESSION_ID, cwd: CWD, mcpServers: [] });
  if (load.error) {
    console.error("session/load failed:", JSON.stringify(load.error));
    proc.kill();
    process.exit(1);
  }

  const res = await send("_x.ai/rewind/points", { sessionId: SESSION_ID });
  if (res.error) {
    console.error("rewind/points failed:", JSON.stringify(res.error));
    proc.kill();
    process.exit(1);
  }

  const points = rw.parseRewindPoints(res.result);
  console.log(`\nRAW POINTS (${points.length})`);
  console.log("idx | hidden? | preview");
  console.log("----+---------+---------------------------------------------");
  for (const p of points) {
    const hidden = rw.isHiddenRewindPoint(p);
    const prev = String(p.promptPreview || "").replace(/\s+/g, " ").slice(0, 60);
    console.log(
      String(p.promptIndex).padStart(3),
      "|",
      (hidden ? "HIDDEN " : "  bubble").padEnd(7),
      "|",
      prev || "(empty)",
    );
  }

  const facing = rw.userFacingRewindPoints(points);
  console.log(`\nUSER-FACING (${facing.length}) — the Nth visible user bubble maps here:`);
  facing.forEach((p, i) => {
    const prev = String(p.promptPreview || "").replace(/\s+/g, " ").slice(0, 45);
    console.log(`  bubble ${i} -> prompt_index ${p.promptIndex}   "${prev}"`);
  });

  console.log("\nPER-BUBBLE RESOLUTION (what the buttons would do):");
  for (let i = 0; i < facing.length; i++) {
    const rewindTarget = rw.resolveUserBubbleRewind(points, i);
    const editTarget = rw.resolveEditRewindTarget(points, i);
    // Execute DISCARDS its target, so this is the turn Edit removes.
    const editStr = editTarget
      ? `discards #${editTarget.promptIndex} ("${String(editTarget.promptPreview || "").replace(/\s+/g, " ").slice(0, 30)}")`
      : "UNAVAILABLE (no point)";
    console.log(
      `  bubble ${i}: Rewind -> ${rewindTarget ? "#" + rewindTarget.promptIndex : "hidden/none"}   |   Edit -> ${editStr}`,
    );
  }
  console.log();
  proc.kill();
})().catch((e) => {
  console.error("probe error:", e);
  proc.kill();
  process.exit(1);
});
