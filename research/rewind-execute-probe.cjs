// Focused probe: why does `_x.ai/rewind/execute` return success:false?
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-rwx-")));
const proc = spawn(GROK, ["agent", "stdio"], { cwd });
let nextId = 1;
const waiters = new Map();
let buf = "";
let sessionId;

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => waiters.set(id, res));
}
function respond(id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const w = waiters.get(msg.id);
      if (w) {
        waiters.delete(msg.id);
        w(msg);
      }
      continue;
    }
    if (msg.method && msg.id != null) {
      if (msg.method === "session/request_permission") {
        respond(msg.id, { outcome: { outcome: "selected", optionId: "allow-always" } });
      } else if (msg.method === "fs/read_text_file") {
        try {
          respond(msg.id, { content: fs.readFileSync(msg.params.path, "utf8") });
        } catch {
          respond(msg.id, { content: "" });
        }
      } else if (msg.method === "fs/write_text_file") {
        fs.mkdirSync(path.dirname(msg.params.path), { recursive: true });
        fs.writeFileSync(msg.params.path, msg.params.content ?? "");
        respond(msg.id, {});
      } else if (msg.method === "terminal/create") {
        respond(msg.id, { terminalId: "t" });
      } else if (msg.method === "terminal/output") {
        respond(msg.id, { output: "", truncated: false, exitCode: 0 });
      } else if (msg.method === "terminal/wait_for_exit") {
        respond(msg.id, { exitCode: 0, signal: null });
      } else {
        respond(msg.id, {});
      }
    }
  }
});
proc.stderr.on("data", () => {});

function counts() {
  const d = path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(cwd), sessionId);
  return {
    ch: fs.readFileSync(path.join(d, "chat_history.jsonl"), "utf8").trim().split(/\n+/).length,
    up: fs.readFileSync(path.join(d, "updates.jsonl"), "utf8").trim().split(/\n+/).length,
    rp: fs.readFileSync(path.join(d, "rewind_points.jsonl"), "utf8").trim().split(/\n+/).length,
  };
}

(async () => {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "rwx", version: "0" },
  });
  notify("authenticated", { methodId: "probe" });
  sessionId = (await send("session/new", { cwd, mcpServers: [] })).result.sessionId;
  await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Say A only. No tools." }],
  });
  await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Say B only. No tools." }],
  });
  console.log("before", counts());

  const pts = await send("_x.ai/rewind/points", { sessionId });
  console.log("points", JSON.stringify(pts.result, null, 2));

  for (const p of [
    { sessionId, targetPromptIndex: 0, mode: "conversation_only" },
    { sessionId, targetPromptIndex: 0, mode: "all", force: true },
    { sessionId, targetPromptIndex: 0, mode: "all", restoreCode: true },
    { sessionId, targetPromptIndex: 0, mode: "all", dryRun: false },
    // Maybe index is 1-based?
    { sessionId, targetPromptIndex: 1, mode: "conversation_only" },
  ]) {
    const r = await send("_x.ai/rewind/execute", p);
    console.log("EXEC params", JSON.stringify(p));
    console.log("  full response", JSON.stringify(r));
    console.log("  counts", counts());
    if (r.result?.success) break;
  }

  // Does result live under result.result?
  const raw = await send("_x.ai/rewind/execute", {
    sessionId,
    targetPromptIndex: 0,
    mode: "all",
  });
  console.log("raw keys", raw.result && Object.keys(raw.result));
  console.log("raw", JSON.stringify(raw));

  try {
    proc.kill();
  } catch {}
  process.exit(0);
})().catch((e) => {
  console.error(e);
  try {
    proc.kill();
  } catch {}
  process.exit(1);
});
