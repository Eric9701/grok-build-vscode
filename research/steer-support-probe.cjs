// Is there ANY mid-turn injection on the codex / claude adapters (#52 "Steer")?
// Usage: node research/steer-support-probe.cjs codex|claude|grok
// Fires a long turn, then mid-flight (a) probes candidate method names for
// -32601 and (b) sends a second session/prompt to see how a busy session answers.
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PROVIDER = (process.argv[2] || "codex").toLowerCase();
const REPO = "C:/GitHub/grok-build-vscode";
const SPEC = {
  grok:   { command: path.join(os.homedir(), ".grok", "bin", "grok.exe"), args: ["agent","--no-leader","stdio"], env: {} },
  codex:  { command: process.execPath, args: [path.join(REPO,"node_modules/@agentclientprotocol/codex-acp/dist/index.js")],
            env: { CODEX_PATH: "C:/Users/Dell/AppData/Local/OpenAI/Codex/bin/e305f1c75d8da435/codex.exe" } },
  claude: { command: process.execPath, args: [path.join(REPO,"node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")],
            env: { CLAUDE_CODE_EXECUTABLE: "C:/Users/Dell/.local/bin/claude.exe" } },
}[PROVIDER];
if (!SPEC) { console.error("unknown provider"); process.exit(2); }

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-steer-"));
const log = (s) => process.stderr.write("[" + PROVIDER + "] " + s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(SPEC.command, SPEC.args, { cwd, env: { ...process.env, ...SPEC.env } });
let nextId = 1;
const waiters = new Map();
const send = (m,p) => { const id = nextId++; proc.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method:m,params:p})+"\n"); return new Promise((r)=>waiters.set(id,r)); };
const respond = (id,result) => proc.stdin.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\n");
proc.stderr.on("data", () => {});

let chunks = "";
readline.createInterface({ input: proc.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method && msg.id != null) {
    if (msg.method === "session/request_permission") {
      const a = (msg.params.options||[]).find((o)=>/allow/.test(o.kind));
      return respond(msg.id, { outcome:{ outcome:"selected", optionId: a && a.optionId } });
    }
    if (msg.method === "fs/read_text_file") { let t=""; try{t=fs.readFileSync(msg.params.path,"utf8")}catch{} return respond(msg.id,{content:t}); }
    if (msg.method === "terminal/create") return respond(msg.id, { terminalId:"t1" });
    if (msg.method === "terminal/output") return respond(msg.id, { output:"", truncated:false, exitStatus:{exitCode:0} });
    if (msg.method === "terminal/wait_for_exit") return respond(msg.id, { exitCode:0 });
    return respond(msg.id, {});
  }
  if (msg.method === "session/update") {
    const u = (msg.params && msg.params.update) || {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content && u.content.text) chunks += u.content.text;
    return;
  }
  if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
});

const CANDIDATES = [
  "_x.ai/interject", "session/interject", "session/steer", "session/input",
  "session/send_input", "session/queue", "session/follow_up", "_codex/interject",
];

(async () => {
  await send("initialize", { protocolVersion:1, clientCapabilities:{ fs:{readTextFile:true,writeTextFile:true}, terminal:true } });
  const s = await send("session/new", { cwd, mcpServers: [] });
  if (s.error) { log("session/new ERROR " + JSON.stringify(s.error)); process.exit(1); }
  const sid = s.result.sessionId;
  log("session=" + sid);

  let done = false;
  const turn = send("session/prompt", { sessionId: sid, prompt: [{ type:"text",
    text: "Count slowly from 1 to 30, one number per line, with a short sentence about each number. Do not use any tools." }] }).then((r)=>{done=true; return r;});

  await sleep(4000);
  log("--- mid-turn (turnDone=" + done + ") ---");

  for (const m of CANDIDATES) {
    const r = await send(m, { sessionId: sid, text: "STEER_PROBE: stop counting and say BANANA instead." });
    const code = r.error ? r.error.code : "OK";
    const msg2 = r.error ? String(r.error.message).slice(0,90) : JSON.stringify(r.result).slice(0,90);
    log("  " + m.padEnd(22) + " -> " + code + "  " + msg2);
  }

  log("--- second session/prompt while busy (turnDone=" + done + ") ---");
  const second = await Promise.race([
    send("session/prompt", { sessionId: sid, prompt: [{ type:"text", text:"STEER_PROBE2: say PINEAPPLE now." }] }),
    sleep(20000).then(()=>({ timedOut:true })),
  ]);
  log("  second prompt -> " + (second.timedOut ? "NO RESPONSE within 20s (queued/blocked)"
      : second.error ? "ERROR " + JSON.stringify(second.error).slice(0,160) : "ACCEPTED " + JSON.stringify(second.result).slice(0,160)));

  await Promise.race([turn, sleep(60000)]);
  log("steer text landed in the turn: BANANA=" + /BANANA/.test(chunks) + "  PINEAPPLE=" + /PINEAPPLE/.test(chunks));
  proc.kill(); process.exit(0);
})();
