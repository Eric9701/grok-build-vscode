// Live Claude/Codex ACP usage probe: two one-word turns, log usage_update + prompt usage.
//   node research/adapter-usage-probe.cjs [codex|claude]
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const provider = (process.argv[2] || "codex").toLowerCase();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-usage-`));
const adapterRoot = path.join(__dirname, "..", "node_modules", "@agentclientprotocol");

function findCodex() {
  const extRoot = path.join(os.homedir(), ".vscode", "extensions");
  if (!fs.existsSync(extRoot)) return null;
  const dirs = fs.readdirSync(extRoot).filter((name) => name.startsWith("openai.chatgpt-")).sort().reverse();
  for (const dir of dirs) {
    const exe = path.join(extRoot, dir, "bin", "windows-x86_64", "codex.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

const spec = provider === "claude"
  ? {
    command: process.execPath,
    args: [path.join(adapterRoot, "claude-agent-acp", "dist", "index.js")],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CLAUDE_CODE_EXECUTABLE: path.join(os.homedir(), ".local", "bin", "claude.exe") },
  }
  : {
    command: process.execPath,
    args: [require.resolve("@agentclientprotocol/codex-acp")],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODEX_PATH: findCodex() || "codex" },
  };

function log(s) { process.stderr.write(`[${provider}] ${s}\n`); }
log(`cwd ${cwd}`);
log(`spawn ${spec.command} ${spec.args.join(" ")}`);
if (provider === "codex") log(`CODEX_PATH ${spec.env.CODEX_PATH}`);

const proc = spawn(spec.command, spec.args, { cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
let nextId = 1;
const waiters = new Map();
function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 180000);
    waiters.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
    });
  });
}
function respond(id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

proc.stderr.on("data", (d) => process.stderr.write(`[${provider}-stderr] ${d}`));
proc.on("exit", (code) => log(`exit ${code}`));

const usageUpdates = [];
const rl = readline.createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { log(`non-json ${line.slice(0, 160)}`); return; }
  if (msg.id != null && msg.method == null) {
    const waiter = waiters.get(msg.id);
    if (waiter) { waiters.delete(msg.id); waiter(msg); }
    return;
  }
  if (msg.method === "session/update") {
    const update = msg.params?.update;
    const kind = update?.sessionUpdate;
    if (kind === "usage_update") {
      usageUpdates.push(update);
      log(`usage_update ${JSON.stringify({ used: update.used, size: update.size, cost: update.cost })}`);
    } else if (kind === "agent_message_chunk") {
      const text = update.content?.text;
      if (typeof text === "string" && text.trim()) log(`text ${JSON.stringify(text.slice(0, 80))}`);
    } else if (kind === "current_mode_update") {
      log(`mode ${update.currentModeId}`);
    }
    return;
  }
  if (msg.method === "session/request_permission") {
    const tool = msg.params?.toolCall || {};
    log(`permission kind=${tool.kind} title=${JSON.stringify(tool.title || "")} rawKeys=${Object.keys(tool.rawInput || {}).join(",")}`);
    if (tool.rawInput?.plan) log(`permission.plan ${JSON.stringify(String(tool.rawInput.plan).slice(0, 200))}`);
    if (Array.isArray(tool.content)) log(`permission.content ${JSON.stringify(tool.content).slice(0, 240)}`);
    const opts = msg.params?.options || [];
    const allow = opts.find((o) => o.kind === "allow_once") || opts.find((o) => o.kind === "allow_always") || opts[0];
    respond(msg.id, { outcome: { outcome: "selected", optionId: allow?.optionId } });
    return;
  }
  if (msg.method && msg.id != null) {
    if (msg.method === "terminal/create") respond(msg.id, { terminalId: "t1" });
    else if (msg.method === "terminal/output") respond(msg.id, { output: "", exitStatus: { exitCode: 0 }, truncated: false });
    else if (msg.method === "terminal/wait_for_exit") respond(msg.id, { exitCode: 0 });
    else respond(msg.id, {});
  }
});

(async () => {
  try {
    await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    const session = await send("session/new", { cwd, mcpServers: [] });
    const sessionId = session.sessionId;
    log(`session ${sessionId} currentModel=${session.models?.currentModelId || session.configOptions?.find((o) => (o.id || o.configId) === "model")?.currentValue}`);
    for (const [i, text] of ["hi", "ok"].entries()) {
      const result = await send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      log(`turn ${i + 1} usage ${JSON.stringify(result.usage || result._meta || result)}`);
    }
    log(`usage_update count ${usageUpdates.length}`);
  } catch (error) {
    log(`FAILED ${error && error.message ? error.message : error}`);
    if (error && error.data) log(`data ${JSON.stringify(error.data).slice(0, 400)}`);
    process.exitCode = 1;
  } finally {
    try { proc.stdin.end(); } catch {}
    setTimeout(() => proc.kill(), 2000);
  }
})();
