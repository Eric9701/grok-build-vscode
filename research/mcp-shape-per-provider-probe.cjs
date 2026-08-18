// Measure the ACP tool-call shape for an MCP call on EVERY provider, before
// any client code renders it. Usage:
//   node research/mcp-shape-per-provider-probe.cjs grok|codex|claude
//
// The MCP server is the official @modelcontextprotocol/server-everything,
// passed through ACP's own session/new `mcpServers` parameter, so all three
// providers get an identical server with no per-CLI config.
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PROVIDER = (process.argv[2] || "grok").toLowerCase();
const REPO = "C:/GitHub/grok-build-vscode";
const SPEC = {
  grok: {
    command: path.join(os.homedir(), ".grok", "bin", "grok.exe"),
    args: ["agent", "--no-leader", "stdio"],
    env: {},
  },
  codex: {
    command: process.execPath,
    args: [path.join(REPO, "node_modules/@agentclientprotocol/codex-acp/dist/index.js")],
    env: { CODEX_PATH: "C:/Users/Dell/AppData/Local/OpenAI/Codex/bin/e305f1c75d8da435/codex.exe" },
  },
  claude: {
    command: process.execPath,
    args: [path.join(REPO, "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")],
    env: { CLAUDE_CODE_EXECUTABLE: "C:/Users/Dell/.local/bin/claude.exe" },
  },
}[PROVIDER];
if (!SPEC) { console.error("unknown provider " + PROVIDER); process.exit(2); }

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mcpshape-"));
fs.writeFileSync(path.join(cwd, "readme.md"), "probe workspace\n");
const log = (s) => process.stderr.write("[" + PROVIDER + "] " + s + "\n");

const MCP = [{
  name: "everything",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything", "stdio"],
  env: [],
}];

const proc = spawn(SPEC.command, SPEC.args, { cwd, env: { ...process.env, ...SPEC.env } });
let nextId = 1;
const waiters = new Map();
const send = (m, p) => { const id = nextId++; proc.stdin.write(JSON.stringify({ jsonrpc:"2.0", id, method:m, params:p })+"\n"); return new Promise((r)=>waiters.set(id,r)); };
const respond = (id, result) => proc.stdin.write(JSON.stringify({ jsonrpc:"2.0", id, result })+"\n");
const stderrBuf = [];
proc.stderr.on("data", (d) => stderrBuf.push(String(d)));

const rows = [];
readline.createInterface({ input: proc.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method && msg.id != null) {
    if (msg.method === "session/request_permission") {
      const allow = (msg.params.options||[]).find((o)=>/allow/.test(o.kind));
      log("permission -> auto-allow (" + (msg.params.options||[]).map(o=>o.kind).join(",") + ")");
      return respond(msg.id, { outcome: { outcome:"selected", optionId: allow && allow.optionId } });
    }
    if (msg.method === "fs/read_text_file") { let c=""; try{c=fs.readFileSync(msg.params.path,"utf8")}catch{} return respond(msg.id,{content:c}); }
    if (msg.method === "fs/write_text_file") return respond(msg.id, {});
    if (msg.method === "terminal/create") return respond(msg.id, { terminalId: "t"+nextId++ });
    if (msg.method === "terminal/output") return respond(msg.id, { output:"", truncated:false, exitStatus:{exitCode:0} });
    if (msg.method === "terminal/wait_for_exit") return respond(msg.id, { exitCode: 0 });
    return respond(msg.id, {});
  }
  if (msg.method === "session/update") {
    const u = (msg.params && msg.params.update) || {};
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") rows.push(u);
    return;
  }
  if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
});

(async () => {
  const init = await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
  if (init.error) { log("initialize ERROR " + JSON.stringify(init.error)); log(stderrBuf.join("").slice(-800)); process.exit(1); }
  const s = await send("session/new", { cwd, mcpServers: MCP });
  if (s.error) { log("session/new ERROR " + JSON.stringify(s.error)); log(stderrBuf.join("").slice(-1200)); process.exit(1); }
  log("session=" + (s.result && s.result.sessionId));

  const r = await send("session/prompt", { sessionId: s.result.sessionId, prompt: [{ type:"text",
    text: "Use the MCP tool called `echo` from the `everything` server, passing message=\"MCPSHAPE_9931\". Call it exactly once, then stop and tell me what it returned." }] });
  if (r.error) log("prompt ERROR " + JSON.stringify(r.error));

  const mcpRows = rows.filter((u) => /MCPSHAPE_9931|echo|everything/i.test(JSON.stringify(u)));
  log("=== " + rows.length + " tool rows, " + mcpRows.length + " matching the MCP call ===");
  for (const u of mcpRows) {
    log("-- " + u.sessionUpdate + " keys=" + JSON.stringify(Object.keys(u)));
    log("   title=" + JSON.stringify(u.title) + " kind=" + JSON.stringify(u.kind) + " status=" + JSON.stringify(u.status));
    if (u.rawInput  !== undefined) log("   rawInput="  + JSON.stringify(u.rawInput).slice(0,300));
    if (u.rawOutput !== undefined) log("   rawOutput=" + JSON.stringify(u.rawOutput).slice(0,500));
    if (u.content   !== undefined) log("   content="   + JSON.stringify(u.content).slice(0,400));
    if (u._meta     !== undefined) log("   _meta="     + JSON.stringify(u._meta).slice(0,250));
  }
  const out = path.join(os.tmpdir(), "mcp-shape-" + PROVIDER + ".json");
  fs.writeFileSync(out, JSON.stringify({ provider: PROVIDER, allRows: rows, mcpRows }, null, 2));
  log("full dump -> " + out);
  proc.kill(); process.exit(0);
})();
