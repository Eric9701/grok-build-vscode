// Rewind ACP probe — discover `_x.ai/rewind/*` request/response shapes on the
// shipped CLI (0.2.111+). Diagnostic only: exits 0 and prints evidence.
//
// Flow:
//   1. session/new in a throwaway cwd
//   2. two short turns that create rewind points (optionally touch a file)
//   3. try `_x.ai/rewind/points` (and bare `x.ai/...`) with a few param shapes
//   4. try `_x.ai/rewind/execute` / `restore_code` / `rewind` against the first point
//   5. dump session_notification kinds seen along the way
//
// Usage: node research/rewind-probe.cjs
//        GROK_BIN=… node research/rewind-probe.cjs

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-rewind-")));
fs.writeFileSync(path.join(cwd, "note.txt"), "v1\n");
console.error(`[rewind] cwd=${cwd}`);
console.error(`[rewind] grok=${GROK}`);

const proc = spawn(GROK, ["agent", "stdio"], { cwd });
let nextId = 1;
const waiters = new Map();
const notifications = [];
const inbound = {};

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

let buf = "";
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
    if (msg.method) {
      inbound[msg.method] = (inbound[msg.method] || 0) + 1;
      notifications.push({ method: msg.method, params: msg.params });
      // Mandatory ACP handlers — ACK everything so the agent doesn't hang.
      if (msg.id != null) {
        if (msg.method === "session/request_permission") {
          respond(msg.id, { outcome: { outcome: "selected", optionId: "allow-always" } });
        } else if (msg.method === "fs/read_text_file") {
          const p = msg.params?.path;
          try {
            respond(msg.id, { content: fs.readFileSync(p, "utf8") });
          } catch (e) {
            respond(msg.id, { content: "" });
          }
        } else if (msg.method === "fs/write_text_file") {
          try {
            fs.mkdirSync(path.dirname(msg.params.path), { recursive: true });
            fs.writeFileSync(msg.params.path, msg.params.content ?? "");
            respond(msg.id, {});
          } catch (e) {
            respond(msg.id, {});
          }
        } else if (msg.method?.startsWith("terminal/")) {
          if (msg.method === "terminal/create") {
            respond(msg.id, { terminalId: "t-fake" });
          } else if (msg.method === "terminal/output") {
            respond(msg.id, { output: "", truncated: false, exitCode: 0 });
          } else if (msg.method === "terminal/wait_for_exit") {
            respond(msg.id, { exitCode: 0, signal: null });
          } else {
            respond(msg.id, {});
          }
        } else {
          respond(msg.id, {});
        }
      }
    }
  }
});
proc.stderr.on("data", () => {});
proc.on("error", (e) => {
  console.error("SPAWN ERROR", e.message);
  process.exit(2);
});

function summarize(label, msg) {
  if (!msg) return console.log(`\n## ${label}\n(null)`);
  if (msg.error) {
    console.log(`\n## ${label}\nERROR ${msg.error.code}: ${msg.error.message}`);
    if (msg.error.data) console.log("data:", JSON.stringify(msg.error.data).slice(0, 500));
    return;
  }
  const r = msg.result;
  const s = JSON.stringify(r, null, 2);
  console.log(`\n## ${label}\n${s.slice(0, 4000)}${s.length > 4000 ? "\n…truncated" : ""}`);
}

async function prompt(text) {
  return send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
  });
}

let sessionId;

(async () => {
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "rewind-probe", version: "0.0.1" },
  });
  summarize("initialize", init);
  notify("authenticated", { methodId: "probe" });

  const neu = await send("session/new", { cwd, mcpServers: [] });
  summarize("session/new", neu);
  sessionId = neu.result?.sessionId;
  if (!sessionId) {
    console.error("no sessionId");
    process.exit(2);
  }

  // Two cheap turns to create rewind points. Turn 1: just say hi.
  // Turn 2: ask to rewrite note.txt so a file snapshot exists.
  console.error("[rewind] turn 1…");
  summarize(
    "prompt-1",
    await prompt("Reply with exactly: ok. Do not use tools."),
  );

  console.error("[rewind] turn 2 (edit note.txt)…");
  summarize(
    "prompt-2",
    await prompt(
      "Overwrite note.txt with the single line 'v2'. Then reply with exactly: done. Use the write tool.",
    ),
  );

  // Dump rewind_points.jsonl from disk as ground truth.
  const grokHome = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  const enc = encodeURIComponent(cwd);
  const sessDir = path.join(grokHome, "sessions", enc, sessionId);
  const rpPath = path.join(sessDir, "rewind_points.jsonl");
  console.log(`\n## disk rewind_points.jsonl\npath: ${rpPath}`);
  if (fs.existsSync(rpPath)) {
    const lines = fs.readFileSync(rpPath, "utf8").trim().split(/\n+/);
    console.log(`lines: ${lines.length}`);
    for (const line of lines.slice(0, 5)) {
      try {
        const j = JSON.parse(line);
        // Drop huge file contents for readability
        const slim = { ...j };
        if (slim.file_snapshots) {
          slim.file_snapshots = Object.fromEntries(
            Object.entries(slim.file_snapshots).map(([k, v]) => [
              k,
              { path: v?.path, contentLen: String(v?.content ?? "").length, captured_at: v?.captured_at },
            ]),
          );
        }
        if (slim.after_snapshots) {
          slim.after_snapshots = Object.fromEntries(
            Object.entries(slim.after_snapshots).map(([k, v]) => [
              k,
              { path: v?.path, contentLen: String(v?.content ?? "").length, captured_at: v?.captured_at },
            ]),
          );
        }
        console.log(JSON.stringify(slim));
      } catch {
        console.log(line.slice(0, 200));
      }
    }
  } else {
    console.log("(missing)");
  }

  // Probe points methods.
  const pointShapes = [
    ["_x.ai/rewind/points", { sessionId }],
    ["_x.ai/rewind/points", { sessionId, cwd }],
    ["x.ai/rewind/points", { sessionId }],
    ["_x.ai/rewind/points", {}],
  ];
  let pointsResult = null;
  for (const [method, params] of pointShapes) {
    const r = await send(method, params);
    summarize(`${method} ${JSON.stringify(params)}`, r);
    if (!r.error && !pointsResult) pointsResult = r.result;
  }

  // Pull a target from the points result if present.
  const unwrap = (r) => (r && typeof r === "object" && "result" in r ? r.result : r);
  const pts = unwrap(pointsResult);
  console.log("\n## parsed points keys", pts && typeof pts === "object" ? Object.keys(pts) : typeof pts);
  let target = null;
  if (Array.isArray(pts)) target = pts[0];
  else if (pts?.points) target = pts.points[0];
  else if (pts?.result && Array.isArray(pts.result)) target = pts.result[0];
  else if (pts?.rewindPoints) target = pts.rewindPoints[0];
  console.log("## first point", JSON.stringify(target, null, 2)?.slice(0, 1500));

  // Probe execute / restore shapes. Prefer the earliest point (index 0) so we
  // leave something interesting, but don't actually care about success vs not
  // for shape discovery — -32602 tells us the method exists.
  const promptIndex =
    target?.promptIndex ??
    target?.prompt_index ??
    target?.index ??
    target?.id ??
    0;
  const executeShapes = [
    ["_x.ai/rewind/execute", { sessionId, promptIndex }],
    ["_x.ai/rewind/execute", { sessionId, prompt_index: promptIndex }],
    ["_x.ai/rewind/execute", { sessionId, targetPromptIndex: promptIndex }],
    ["_x.ai/rewind/execute", { sessionId, index: promptIndex }],
    ["_x.ai/rewind/execute", { sessionId, point: target }],
    ["_x.ai/rewind/execute", { sessionId, restoreCode: true, promptIndex }],
    ["_x.ai/rewind/rewind", { sessionId, promptIndex }],
    ["_x.ai/rewind/restore_code", { sessionId, promptIndex }],
    ["_x.ai/rewind/restore_code", { sessionId, prompt_index: promptIndex }],
    ["x.ai/rewind/execute", { sessionId, promptIndex }],
  ];
  for (const [method, params] of executeShapes) {
    const r = await send(method, params);
    summarize(`${method} ${JSON.stringify(params)}`, r);
    if (!r.error) {
      console.log("## note.txt after successful call:", fs.readFileSync(path.join(cwd, "note.txt"), "utf8"));
      break; // one success is enough; further rewinds may no-op
    }
  }

  console.log("\n## inbound methods", inbound);
  const kinds = notifications
    .filter((n) => /session_notification|session\/update/.test(n.method))
    .map((n) => n.params?.update?.sessionUpdate || n.params?.sessionUpdate || n.params?.type || Object.keys(n.params || {}))
    .slice(0, 40);
  console.log("## notification kinds sample", JSON.stringify(kinds, null, 2));

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
