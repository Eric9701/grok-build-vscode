// Live Claude/Codex ACP usage probe: several turns + /compact, log every
// usage_update and prompt-usage partition so occupancy can be compared to billed.
//   node research/adapter-usage-probe.cjs [codex|claude] [full|multi]
// `multi` is one ping plus a tool-using turn (several model calls) so
// per-call usage_update can be compared with PromptResponse.usage.
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

function occupancy(usage) {
  if (!usage || typeof usage !== "object") return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = n(usage.inputTokens);
  const output = n(usage.outputTokens);
  const billed = n(usage.totalTokens);
  const cacheRead = n(usage.cachedReadTokens) ?? 0;
  const cacheWrite = n(usage.cachedWriteTokens) ?? 0;
  if (input !== undefined) return { occupancy: input + cacheRead + cacheWrite, via: "input+cache" };
  if (billed !== undefined && output !== undefined) return { occupancy: Math.max(0, billed - output), via: "billed-output" };
  if (billed !== undefined) return { occupancy: billed, via: "billed" };
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
const toolEvents = [];
const compactSignals = [];

function usageSlice(from) {
  return usageUpdates.slice(from).map((u, i) => ({
    i,
    used: u.used,
    size: u.size,
    cost: u.cost,
    meta: u._meta,
    delta: i === 0 ? null : (typeof u.used === "number" && typeof usageUpdates[from + i - 1]?.used === "number"
      ? u.used - usageUpdates[from + i - 1].used
      : null),
  }));
}

function analyzeTurn(label, from, result) {
  const usage = result?.usage || result?._meta?.usage || null;
  const updates = usageSlice(from);
  const useds = updates.map((u) => u.used).filter((n) => typeof n === "number");
  const maxUsed = useds.length ? Math.max(...useds) : null;
  const lastUsed = useds.length ? useds[useds.length - 1] : null;
  const drops = updates.filter((u) => typeof u.delta === "number" && u.delta < 0);
  const occ = occupancy(usage);
  const resultPrompt = occ && typeof occ.occupancy === "number" ? occ.occupancy : null;
  log(`${label} usage_updates ${JSON.stringify(updates)}`);
  log(`${label} tools ${JSON.stringify(toolEvents.filter((t) => t.at >= from))}`);
  log(`${label} result ${JSON.stringify(usage || result?.usage || result?._meta || result)}`);
  log(`${label} occupancy ${JSON.stringify(occ)}`);
  log(`${label} compare ${JSON.stringify({
    updateCount: updates.length,
    usedSequence: useds,
    maxUsed,
    lastUsed,
    drops: drops.map((d) => ({ i: d.i, used: d.used, delta: d.delta })),
    resultPrompt,
    resultLooksLikeSum: resultPrompt != null && maxUsed != null && resultPrompt > maxUsed,
    resultMatchesLastUsed: resultPrompt != null && lastUsed != null && resultPrompt === lastUsed,
    resultMatchesMaxUsed: resultPrompt != null && maxUsed != null && resultPrompt === maxUsed,
  })}`);
  return { updates, usage, occ };
}
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
      log(`usage_update ${JSON.stringify({ used: update.used, size: update.size, cost: update.cost, meta: update._meta })}`);
    } else if (kind === "agent_message_chunk") {
      const text = update.content?.text;
      if (typeof text === "string" && text.trim()) {
        log(`text ${JSON.stringify(text.slice(0, 120))}`);
        if (/compact/i.test(text)) compactSignals.push({ kind: "text", text: text.slice(0, 160) });
      }
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const title = update.title || "";
      toolEvents.push({
        at: usageUpdates.length,
        kind,
        title,
        status: update.status,
        toolCallId: update.toolCallId,
      });
      log(`tool ${JSON.stringify({ kind, title, status: update.status, id: update.toolCallId || "" })}`);
      if (update._meta?.contextCompaction || /compact/i.test(title)) {
        compactSignals.push({ kind, title, status: update.status, meta: update._meta });
        log(`compact-tool ${JSON.stringify({ kind, title, status: update.status, meta: update._meta })}`);
      }
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
    if (msg.method === "fs/read_text_file") {
      const target = msg.params?.path;
      try {
        respond(msg.id, { content: fs.readFileSync(target, "utf8") });
      } catch (error) {
        respond(msg.id, { content: "", error: String(error && error.message ? error.message : error) });
      }
      return;
    }
    if (msg.method === "fs/write_text_file") {
      const target = msg.params?.path;
      try {
        fs.writeFileSync(target, String(msg.params?.content ?? ""), "utf8");
        respond(msg.id, {});
      } catch (error) {
        respond(msg.id, { error: String(error && error.message ? error.message : error) });
      }
      return;
    }
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
    const mode = (process.argv[3] || "full").toLowerCase();
    fs.writeFileSync(path.join(cwd, "probe-note.txt"), "alpha-mark\n", "utf8");
    const simpleTurns = mode === "multi"
      ? ["Reply with the single word ping."]
      : [
        "Reply with the single word ping.",
        "Reply with the single word pong.",
        "Reply with the single word ready.",
        "List three short words, nothing else.",
      ];
    const beforeCompact = usageUpdates.length;
    for (const [i, text] of simpleTurns.entries()) {
      const from = usageUpdates.length;
      const result = await send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      analyzeTurn(`turn ${i + 1}`, from, result);
    }
    {
      // Force several model calls in one prompt so per-call usage_update can
      // be compared with the turn-level PromptResponse.usage (Claude sums).
      const from = usageUpdates.length;
      const text = [
        "The file probe-note.txt exists in this working directory.",
        "Read it, then write probe-out.txt containing exactly that same text,",
        "then read probe-out.txt back, then reply with the single word done.",
        "Do not skip the tools.",
      ].join(" ");
      log("sending multi-call tool turn");
      const result = await send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      analyzeTurn("multi-call", from, result);
    }
    if (mode !== "multi") {
      const midUpdates = usageUpdates.slice(beforeCompact).map((u) => u.used);
      log(`pre-compact usage_update.used sequence ${JSON.stringify(midUpdates)}`);
      const compactFrom = usageUpdates.length;
      log("sending /compact");
      try {
        const compactResult = await send("session/prompt", { sessionId, prompt: [{ type: "text", text: "/compact" }] });
        log(`compact result ${JSON.stringify(compactResult.usage || compactResult._meta || compactResult)}`);
        log(`compact occupancy ${JSON.stringify(occupancy(compactResult.usage || compactResult._meta?.usage))}`);
      } catch (error) {
        log(`compact FAILED ${error && error.message ? error.message : error}`);
      }
      log(`compact usage_updates ${JSON.stringify(usageUpdates.slice(compactFrom).map((u) => ({ used: u.used, size: u.size, cost: u.cost })))}`);
      log(`compact signals ${JSON.stringify(compactSignals)}`);
      const after = await send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply with the single word done." }] });
      log(`post-compact usage ${JSON.stringify(after.usage || after._meta || after)}`);
      log(`post-compact occupancy ${JSON.stringify(occupancy(after.usage || after._meta?.usage))}`);
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
