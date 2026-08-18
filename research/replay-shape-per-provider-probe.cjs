// Does session/load replay a shell command's OUTPUT, per provider?
// Usage: node research/replay-shape-per-provider-probe.cjs grok|codex|claude
// Phase 1: run one command in a live turn. Phase 2: fresh process, session/load,
// record what comes back for that tool call.
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PROVIDER = (process.argv[2] || "grok").toLowerCase();
const REPO = "C:/GitHub/grok-build-vscode";
const MARKER = "REPLAY_MARKER_4b7c";
const SPEC = {
  grok:   { command: path.join(os.homedir(), ".grok", "bin", "grok.exe"), args: ["agent","--no-leader","stdio"], env: {} },
  codex:  { command: process.execPath, args: [path.join(REPO,"node_modules/@agentclientprotocol/codex-acp/dist/index.js")],
            env: { CODEX_PATH: "C:/Users/Dell/AppData/Local/OpenAI/Codex/bin/e305f1c75d8da435/codex.exe" } },
  claude: { command: process.execPath, args: [path.join(REPO,"node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")],
            env: { CLAUDE_CODE_EXECUTABLE: "C:/Users/Dell/.local/bin/claude.exe" } },
}[PROVIDER];
if (!SPEC) { console.error("unknown provider"); process.exit(2); }

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-replayshape-"));
const log = (s) => process.stderr.write("[" + PROVIDER + "] " + s + "\n");

function client() {
  const proc = spawn(SPEC.command, SPEC.args, { cwd, env: { ...process.env, ...SPEC.env } });
  const c = { proc, nextId: 1, waiters: new Map(), rows: [], sawTerminalCreate: false };
  proc.stderr.on("data", () => {});
  c.send = (m, p) => { const id = c.nextId++; proc.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method:m,params:p})+"\n"); return new Promise((r)=>c.waiters.set(id,r)); };
  const respond = (id, result) => proc.stdin.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\n");
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id != null) {
      const m = msg.method;
      if (m === "session/request_permission") {
        const a = (msg.params.options||[]).find((o)=>/allow/.test(o.kind));
        return respond(msg.id, { outcome:{ outcome:"selected", optionId: a && a.optionId } });
      }
      if (m === "fs/read_text_file") { let t=""; try{t=fs.readFileSync(msg.params.path,"utf8")}catch{} return respond(msg.id,{content:t}); }
      if (m === "fs/write_text_file") return respond(msg.id, {});
      if (m === "terminal/create") { c.sawTerminalCreate = true; return respond(msg.id, { terminalId: "t1" }); }
      if (m === "terminal/output") return respond(msg.id, { output: MARKER + "\n", truncated:false, exitStatus:{exitCode:0} });
      if (m === "terminal/wait_for_exit") return respond(msg.id, { exitCode: 0 });
      return respond(msg.id, {});
    }
    if (msg.method === "session/update") {
      const u = (msg.params && msg.params.update) || {};
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") c.rows.push(u);
      return;
    }
    if (msg.id != null && c.waiters.has(msg.id)) { c.waiters.get(msg.id)(msg); c.waiters.delete(msg.id); }
  });
  return c;
}
const CAPS = { fs:{ readTextFile:true, writeTextFile:true }, terminal:true };

(async () => {
  const A = client();
  await A.send("initialize", { protocolVersion:1, clientCapabilities: CAPS });
  const s = await A.send("session/new", { cwd, mcpServers: [] });
  if (s.error) { log("session/new ERROR " + JSON.stringify(s.error)); process.exit(1); }
  const sid = s.result.sessionId;
  log("session=" + sid);
  await A.send("session/prompt", { sessionId: sid, prompt: [{ type:"text",
    text: "Run exactly this shell command once, then stop: echo " + MARKER }] });
  const liveHit = A.rows.filter((u)=>JSON.stringify(u).includes(MARKER)).length;
  log("PHASE 1 live: " + A.rows.length + " tool rows, " + liveHit + " containing the marker; client terminal used=" + A.sawTerminalCreate);
  A.proc.kill();
  await new Promise((r)=>setTimeout(r,1500));

  const B = client();
  await B.send("initialize", { protocolVersion:1, clientCapabilities: CAPS });
  const load = await B.send("session/load", { sessionId: sid, cwd, mcpServers: [] });
  if (load.error) { log("PHASE 2 session/load ERROR " + JSON.stringify(load.error)); }
  await new Promise((r)=>setTimeout(r,2500));
  log("PHASE 2 replay: " + B.rows.length + " tool rows");
  let outputReplayed = false;
  for (const u of B.rows) {
    const j = JSON.stringify(u);
    const hasMarker = j.includes(MARKER);
    log("-- " + u.sessionUpdate + " keys=" + JSON.stringify(Object.keys(u)) + " marker=" + hasMarker);
    if (u.title) log("   title=" + JSON.stringify(u.title) + " kind=" + JSON.stringify(u.kind) + " status=" + JSON.stringify(u.status));
    if (u.content   !== undefined) log("   content=" + JSON.stringify(u.content).slice(0,250));
    if (u.rawOutput !== undefined) log("   rawOutput=" + JSON.stringify(u.rawOutput).slice(0,350));
    // "output replayed" = the marker appears somewhere OTHER than only the command text
    if (hasMarker && (u.content !== undefined || u.rawOutput !== undefined)) outputReplayed = true;
  }
  log("VERDICT: session/load replays command OUTPUT = " + outputReplayed);
  fs.writeFileSync(path.join(os.tmpdir(), "replay-shape-" + PROVIDER + ".json"), JSON.stringify({ provider: PROVIDER, replayRows: B.rows }, null, 2));
  B.proc.kill(); process.exit(0);
})();
