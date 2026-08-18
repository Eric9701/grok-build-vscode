#!/usr/bin/env node
// Probe A — issue #44. Does `session/load` on grok 1.0.5 replay terminal
// OUTPUT, or only the command itself?
//
// Measured on 0.2.x: the CLI did not replay terminal data, so a reopened
// session showed the command with no stdout. This re-measures that on the
// current binary with a genuine client-owned terminal (we advertise
// `terminal: true` and actually run the command).
//
// Two processes: session/new + one shell turn, then kill, then a FRESH
// process `session/load`s the same id and dumps every replayed session/update.
//
// SAFETY: throwaway mkdtemp cwd. Writes and terminal cwd are refused outside
// it. Session files under ~/.grok/sessions/ are read-only (never deleted or
// written). The temp workspace is removed at the end.
//
// Usage:
//   node research/session-load-terminal-replay-probe.cjs
//   GROK_BIN=… node research/session-load-terminal-replay-probe.cjs

const { spawn, execFileSync } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const MARKER = "GROK44_STDOUT_MARKER_c8e1a7b4d2f0";
const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const CAPS = { fs: { readTextFile: true, writeTextFile: true }, terminal: true };
const LOG_PATH = path.join(__dirname, "session-load-terminal-replay-probe.log");

const lines = [];
function log(s) {
  const t = String(s);
  lines.push(t);
  process.stderr.write("[loadterm] " + t + "\n");
}
function j(v, n) {
  const s = JSON.stringify(v);
  if (n && s.length > n) return s.slice(0, n) + `… (+${s.length - n} chars)`;
  return s;
}
function isInside(candidate, root) {
  try {
    const rel = path.relative(root, path.resolve(candidate));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}
function whichOnPath(name) {
  try {
    const out = execFileSync("where", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p && !/[\\/]WindowsApps[\\/]/i.test(p) && fs.existsSync(p)) return p;
    }
  } catch { /* miss */ }
  return undefined;
}
function resolveShell() {
  if (process.platform !== "win32") return { spawnShell: true, grokShell: undefined };
  const pwsh = whichOnPath("pwsh");
  if (pwsh) return { spawnShell: pwsh, grokShell: "pwsh" };
  const ps = whichOnPath("powershell");
  if (ps) return { spawnShell: ps, grokShell: "powershell" };
  return { spawnShell: true, grokShell: "cmd" };
}

class ProbeTerminals {
  constructor(allowedCwd, spawnShell) {
    this.allowedCwd = allowedCwd;
    this.spawnShell = spawnShell;
    this.map = new Map();
    this.next = 1;
    this.creates = [];
    this.snapshots = [];
  }
  create(params) {
    const id = "t-" + this.next++;
    const cwd = params && params.cwd ? path.resolve(params.cwd) : this.allowedCwd;
    if (!isInside(cwd, this.allowedCwd)) {
      const err = new Error("terminal cwd outside probe dir: " + cwd);
      this.creates.push({ terminalId: id, command: params && params.command, refused: String(err.message) });
      throw err;
    }
    const command = String((params && params.command) || "");
    const env = { ...process.env };
    if (Array.isArray(params && params.env)) {
      for (const e of params.env) env[e.name] = e.value;
    }
    const proc = spawn(command, { cwd, env, shell: this.spawnShell });
    const entry = { buf: "", exitCode: null, waiters: [], truncated: false, command, cwd };
    const onChunk = (d) => { entry.buf += d.toString("utf8"); };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("error", (e) => {
      entry.buf += "\n[spawn error] " + e.message;
      entry.exitCode = -1;
      for (const w of entry.waiters) w({ exitCode: -1 });
      entry.waiters = [];
    });
    proc.on("exit", (code, signal) => {
      if (entry.exitCode != null) return;
      entry.exitCode = code != null ? code : signal ? 1 : 0;
      for (const w of entry.waiters) w({ exitCode: entry.exitCode });
      entry.waiters = [];
    });
    this.map.set(id, { proc, entry });
    this.creates.push({ terminalId: id, command, cwd });
    return { terminalId: id };
  }
  output(id) {
    const t = this.map.get(id);
    if (!t) return { output: "", exitStatus: null, truncated: false };
    return {
      output: t.entry.buf,
      exitStatus: t.entry.exitCode != null ? { exitCode: t.entry.exitCode } : null,
      truncated: t.entry.truncated,
    };
  }
  waitForExit(id) {
    const t = this.map.get(id);
    if (!t) return Promise.resolve({ exitCode: -1 });
    if (t.entry.exitCode != null) return Promise.resolve({ exitCode: t.entry.exitCode });
    return new Promise((res) => t.entry.waiters.push(res));
  }
  kill(id) {
    const t = this.map.get(id);
    if (!t || !t.proc) return;
    try {
      if (process.platform === "win32" && t.proc.pid) {
        spawn("taskkill", ["/pid", String(t.proc.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        t.proc.kill("SIGTERM");
      }
    } catch { /* */ }
  }
  snapshot(id, at) {
    const t = this.map.get(id);
    if (!t) return;
    this.snapshots.push({
      at,
      terminalId: id,
      command: t.entry.command,
      output: t.entry.buf,
      exitCode: t.entry.exitCode,
      hasMarker: t.entry.buf.includes(MARKER),
    });
  }
  release(id) {
    this.snapshot(id, "release");
    this.kill(id);
    this.map.delete(id);
  }
  dispose() {
    for (const id of Array.from(this.map.keys())) this.release(id);
  }
}

function killTree(proc) {
  try {
    if (process.platform === "win32" && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill();
    }
  } catch { /* */ }
}

function withTimeout(p, ms, name) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + ms + "ms: " + name)), ms)),
  ]);
}

function runProcess(label, cwd, shell, drive) {
  return new Promise((resolve) => {
    const rec = {
      label,
      inbound: [],
      updates: [],
      requests: [],
      terminals: new ProbeTerminals(cwd, shell.spawnShell),
      text: "",
      error: null,
    };
    const env = { ...process.env };
    if (shell.grokShell) env.GROK_SHELL = shell.grokShell;
    const proc = spawn(GROK, ["agent", "--no-leader", "stdio"], { cwd, env });
    let nextId = 1;
    const waiters = new Map();
    let settled = false;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      Object.assign(rec, extra || {});
      try { rec.terminals.dispose(); } catch { /* */ }
      killTree(proc);
      setTimeout(() => resolve(rec), 400);
    };

    proc.on("error", (e) => finish({ error: "spawn: " + e.message }));
    proc.on("exit", () => { if (!settled) finish({ error: rec.error || "grok exited" }); });

    function send(method, params) {
      const id = nextId++;
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((res) => waiters.set(id, res));
    }
    function reply(id, result) {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    }
    function replyErr(id, code, message) {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
    }

    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      if (msg.method && msg.id != null) {
        rec.requests.push({ method: msg.method, params: msg.params });
        rec.inbound.push({ dir: "request", method: msg.method, params: msg.params });
        const m = msg.method;
        if (m === "fs/read_text_file") {
          const p = msg.params && msg.params.path;
          if (!p || !isInside(p, cwd)) return replyErr(msg.id, -32602, "outside probe cwd");
          try { return reply(msg.id, { content: fs.readFileSync(p, "utf8") }); }
          catch (e) { return replyErr(msg.id, -32603, e.message); }
        }
        if (m === "fs/write_text_file") {
          const p = (msg.params && msg.params.path) || "";
          if (!isInside(p, cwd)) return replyErr(msg.id, -32602, "probe refuses writes outside cwd");
          try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, msg.params.content ?? "");
            return reply(msg.id, {});
          } catch (e) { return replyErr(msg.id, -32603, e.message); }
        }
        if (m === "terminal/create") {
          try { return reply(msg.id, rec.terminals.create(msg.params || {})); }
          catch (e) { return replyErr(msg.id, -32603, e.message); }
        }
        if (m === "terminal/output") {
          const id = msg.params && msg.params.terminalId;
          const out = rec.terminals.output(id);
          rec.terminals.snapshot(id, "output");
          return reply(msg.id, out);
        }
        if (m === "terminal/wait_for_exit") {
          const id = msg.params && msg.params.terminalId;
          rec.terminals.waitForExit(id).then((r) => {
            rec.terminals.snapshot(id, "wait_for_exit");
            reply(msg.id, r);
          });
          return;
        }
        if (m === "terminal/kill") { rec.terminals.kill(msg.params && msg.params.terminalId); return reply(msg.id, {}); }
        if (m === "terminal/release") { rec.terminals.release(msg.params && msg.params.terminalId); return reply(msg.id, {}); }
        if (m === "session/request_permission") {
          const opts = (msg.params && msg.params.options) || [];
          const allow = opts.find((o) => o.kind === "allow_once")
            || opts.find((o) => o.kind === "allow_always")
            || opts[0];
          return reply(msg.id, allow
            ? { outcome: { outcome: "selected", optionId: allow.optionId } }
            : { outcome: { outcome: "cancelled" } });
        }
        return reply(msg.id, {});
      }

      if (msg.method === "session/update") {
        const u = msg.params && msg.params.update;
        rec.updates.push(u || msg.params);
        rec.inbound.push({ dir: "notify", method: msg.method, params: msg.params });
        if (u && u.sessionUpdate === "agent_message_chunk" && u.content && u.content.type === "text") {
          rec.text += u.content.text || "";
        }
        return;
      }

      if (msg.method) {
        rec.inbound.push({ dir: "notify", method: msg.method, params: msg.params });
        return;
      }

      if (msg.id != null && waiters.has(msg.id)) {
        const w = waiters.get(msg.id);
        waiters.delete(msg.id);
        w(msg);
      }
    });

    (async () => {
      try {
        const init = await withTimeout(send("initialize", {
          protocolVersion: 1,
          clientCapabilities: CAPS,
          clientInfo: { name: "session-load-terminal-replay-probe", version: "0" },
        }), 60000, label + " initialize");
        if (init.error) return finish({ error: "initialize: " + j(init.error) });
        rec.init = init.result;
        await drive({ send, rec, withTimeout });
        finish();
      } catch (e) {
        finish({ error: e && e.message });
      }
    })();
  });
}

function toolSummaries(updates) {
  return updates
    .filter((u) => u && (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update"))
    .map((u) => {
      const meta = (u._meta && u._meta["x.ai/tool"]) || {};
      return {
        sessionUpdate: u.sessionUpdate,
        toolCallId: u.toolCallId,
        kind: u.kind,
        status: u.status,
        title: u.title,
        toolName: meta.name,
        keys: Object.keys(u),
        hasRawInput: u.rawInput !== undefined,
        hasRawOutput: u.rawOutput !== undefined,
        hasContent: u.content !== undefined,
        rawInput: u.rawInput === undefined ? undefined : u.rawInput,
        rawOutput: u.rawOutput === undefined ? undefined : u.rawOutput,
        content: u.content === undefined ? undefined : u.content,
        jsonHasMarker: JSON.stringify(u).includes(MARKER),
      };
    });
}

function findSessionDir(sessionId) {
  const root = path.join(os.homedir(), ".grok", "sessions");
  let catalogs;
  try { catalogs = fs.readdirSync(root); } catch { return null; }
  for (const leaf of catalogs) {
    const candidate = path.join(root, leaf, sessionId);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* */ }
  }
  return null;
}

function scanSessionDir(dir) {
  if (!dir) return { found: false };
  const files = [];
  const hits = [];
  function walk(d, rel) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const nextRel = rel ? rel + "/" + e.name : e.name;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, nextRel);
      else if (e.isFile()) {
        let text = "";
        try { text = fs.readFileSync(p, "utf8"); } catch { text = ""; }
        files.push({ path: nextRel, bytes: text.length });
        if (text.includes(MARKER)) {
          const matching = text.split(/\r?\n/).filter((ln) => ln.includes(MARKER)).slice(0, 8);
          hits.push({ path: nextRel, matchingLines: matching.map((ln) => ln.length > 400 ? ln.slice(0, 400) + "…" : ln) });
        }
      }
    }
  }
  walk(dir, "");
  return { found: true, dir, files, hits };
}

function dumpUpdates(label, updates) {
  log("");
  log("======== " + label + " ========  (" + updates.length + " session/update)");
  const counts = new Map();
  for (const u of updates) {
    const t = (u && u.sessionUpdate) || "(no sessionUpdate)";
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  log("type counts: " + j(Object.fromEntries(counts)));
  const tools = toolSummaries(updates);
  log("tool_call / tool_call_update count: " + tools.length);
  tools.forEach((t, i) => {
    log("");
    log("-- tool[" + i + "] " + t.sessionUpdate + " id=" + t.toolCallId + " kind=" + t.kind + " status=" + t.status);
    log("   title=" + j(t.title));
    log("   toolName=" + j(t.toolName));
    log("   keys=" + j(t.keys));
    log("   has rawInput=" + t.hasRawInput + " rawOutput=" + t.hasRawOutput + " content=" + t.hasContent);
    log("   jsonHasMarker=" + t.jsonHasMarker);
    if (t.hasRawInput) log("   rawInput=" + j(t.rawInput, 800));
    if (t.hasRawOutput) log("   rawOutput=" + j(t.rawOutput, 800));
    if (t.hasContent) log("   content=" + j(t.content, 1200));
  });
  const markerUpdates = updates.filter((u) => JSON.stringify(u).includes(MARKER));
  log("");
  log("updates whose JSON contains MARKER: " + markerUpdates.length);
  markerUpdates.forEach((u, i) => {
    log("  marker-hit[" + i + "] sessionUpdate=" + (u && u.sessionUpdate) + " " + j(u, 2000));
  });
}

(async () => {
  let cwd;
  try {
    log("grok binary: " + GROK);
    try { log("grok --version: " + String(execFileSync(GROK, ["--version"], { encoding: "utf8" })).trim()); }
    catch (e) { log("grok --version failed: " + e.message); }
    const shell = resolveShell();
    log("shell spawn=" + String(shell.spawnShell) + " GROK_SHELL=" + String(shell.grokShell));
    log("clientCapabilities: " + j(CAPS));
    log("marker: " + MARKER);

    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-loadterm-")));
    log("cwd: " + cwd);
    fs.writeFileSync(path.join(cwd, "README.txt"), "probe workspace — do not write outside this directory\n");

    log("");
    log("===== PHASE 1: new session + one shell command =====");
    const phase1 = await runProcess("phase1", cwd, shell, async ({ send, rec, withTimeout }) => {
      const ns = await withTimeout(send("session/new", { cwd, mcpServers: [] }), 120000, "session/new");
      if (ns.error) throw new Error("session/new: " + j(ns.error));
      rec.sessionId = ns.result && ns.result.sessionId;
      log("sessionId: " + rec.sessionId);
      const prompt = [
        "Run exactly one shell command, then stop.",
        "Do not edit files. Do not search. Do not spawn subagents. Do not read files.",
        "Run this command verbatim (no extra flags, no wrapping unless your shell requires it):",
        "echo " + MARKER,
        "After the command finishes, reply with the single word DONE.",
      ].join("\n");
      const p = await withTimeout(send("session/prompt", {
        sessionId: rec.sessionId,
        prompt: [{ type: "text", text: prompt }],
      }), 240000, "session/prompt");
      rec.prompt = p.error ? { error: p.error } : p.result;
    });

    if (phase1.error) log("PHASE 1 error: " + phase1.error);
    log("prompt result: " + j(phase1.prompt, 500));
    log("agent text (trunc): " + j(phase1.text, 400));
    log("terminal/create count: " + phase1.terminals.creates.length);
    for (const c of phase1.terminals.creates) log("  create: " + j(c, 400));
    for (const req of phase1.requests) {
      if (req.method === "terminal/create") log("  request terminal/create params=" + j(req.params, 400));
    }
    log("live terminal snapshots (output/wait/release): " + phase1.terminals.snapshots.length);
    for (const s of phase1.terminals.snapshots) log("  snap: " + j(s, 600));
    const liveStdoutHadMarker = phase1.terminals.snapshots.some((s) => s.hasMarker);
    dumpUpdates("PHASE 1 live session/update", phase1.updates);

    const liveTools = toolSummaries(phase1.updates);
    const liveHadMarker = phase1.updates.some((u) => JSON.stringify(u).includes(MARKER))
      || phase1.text.includes(MARKER)
      || phase1.terminals.creates.some((c) => JSON.stringify(c).includes(MARKER));
    const ranCommand = phase1.requests.some((r) => r.method === "terminal/create");
    log("live turn ran terminal/create: " + ranCommand);
    log("live turn saw MARKER in updates/text/creates: " + liveHadMarker);

    const sessionId = phase1.sessionId;
    if (!sessionId) throw new Error("no sessionId — cannot load");

    log("");
    log("===== DISK (read-only scan of ~/.grok/sessions) =====");
    const sessionDir = findSessionDir(sessionId);
    const disk = scanSessionDir(sessionDir);
    log("session dir: " + (disk.dir || "(not found)"));
    if (disk.files) log("files: " + disk.files.map((f) => f.path + "(" + f.bytes + "B)").join(", "));
    log("files containing MARKER: " + ((disk.hits && disk.hits.length) || 0));
    if (disk.hits) {
      for (const h of disk.hits) {
        log("  " + h.path + ":");
        for (const ln of h.matchingLines) log("    " + ln);
      }
    }

    log("");
    log("===== PHASE 2: FRESH process session/load =====");
    const phase2 = await runProcess("phase2", cwd, shell, async ({ send, rec, withTimeout }) => {
      rec.sessionId = sessionId;
      const loaded = await withTimeout(send("session/load", {
        sessionId,
        cwd,
        mcpServers: [],
      }), 180000, "session/load");
      rec.load = loaded.error ? { error: loaded.error } : { ok: true, resultKeys: loaded.result && Object.keys(loaded.result), result: loaded.result };
    });
    if (phase2.error) log("PHASE 2 error: " + phase2.error);
    log("session/load: " + j(phase2.load, 800));
    log("phase2 inbound methods: " + j(phase2.inbound.map((e) => e.method)));
    dumpUpdates("PHASE 2 replayed session/update", phase2.updates);

    const replayTools = toolSummaries(phase2.updates);
    const replayJson = phase2.updates.map((u) => JSON.stringify(u));
    const replayHasMarker = replayJson.some((s) => s.includes(MARKER));
    const replayCommand = replayTools.some((t) => {
      const blob = JSON.stringify(t.rawInput || "") + JSON.stringify(t.title || "") + JSON.stringify(t.content || "");
      return /echo/i.test(blob) || blob.includes(MARKER);
    });
    const replayOutputFields = replayTools.filter((t) => t.jsonHasMarker);
    const contentHasMarker = replayTools.some((t) => JSON.stringify(t.content || "").includes(MARKER));
    const rawOutHasMarker = replayTools.some((t) => JSON.stringify(t.rawOutput || "").includes(MARKER));
    const rawInHasMarker = replayTools.some((t) => JSON.stringify(t.rawInput || "").includes(MARKER));

    log("");
    log("================= VERDICT =================");
    log("CLI: grok  (see --version line above)");
    log("sessionId: " + sessionId);
    log("live terminal/create: " + ranCommand + "  creates=" + j(phase1.terminals.creates));
    log("live executed stdout contained MARKER: " + liveStdoutHadMarker);
    log("disk files containing MARKER: " + ((disk.hits && disk.hits.length) || 0)
      + (disk.hits && disk.hits.length ? " [" + disk.hits.map((h) => h.path).join(", ") + "]" : ""));
    log("replayed tool_call/tool_call_update: " + replayTools.length);
    log("replay JSON contains MARKER (stdout token): " + replayHasMarker);
    log("  in content: " + contentHasMarker);
    log("  in rawOutput: " + rawOutHasMarker);
    log("  in rawInput: " + rawInHasMarker);
    log("replay appears to carry the command itself: " + replayCommand);
    if (!ranCommand) {
      log("INCONCLUSIVE: the live turn never issued terminal/create, so there is no genuine command transcript to replay.");
    } else if (!replayTools.length) {
      log("NEGATIVE: session/load replayed no tool_call / tool_call_update at all.");
    } else if (!replayHasMarker) {
      log("NEGATIVE: session/load replayed the tool row(s) but NONE of them carry the command stdout marker.");
      log("  That is the #44 premise still holding on this CLI: restore has the command, not the output.");
    } else {
      log("POSITIVE: session/load replay includes the stdout marker. See marker-hit dumps above for the exact field.");
    }
    log("replay tool shapes:");
    for (const t of replayTools) {
      log("  " + t.sessionUpdate + " kind=" + t.kind + " status=" + t.status
        + " keys=" + j(t.keys)
        + " rawInput=" + t.hasRawInput + " rawOutput=" + t.hasRawOutput + " content=" + t.hasContent);
    }
    log("==========================================");

    const report = {
      marker: MARKER,
      sessionId,
      cwd,
      shell,
      phase1: {
        error: phase1.error || null,
        prompt: phase1.prompt,
        creates: phase1.terminals.creates,
        snapshots: phase1.terminals.snapshots,
        requestMethods: phase1.requests.map((r) => r.method),
        tools: liveTools,
        text: phase1.text,
      },
      disk,
      phase2: {
        error: phase2.error || null,
        load: phase2.load,
        inboundMethods: phase2.inbound.map((e) => e.method),
        updates: phase2.updates,
        tools: replayTools,
      },
    };
    fs.writeFileSync(LOG_PATH, lines.join("\n") + "\n\n----- RAW -----\n" + JSON.stringify(report, null, 2) + "\n");
    log("wrote " + LOG_PATH);
  } catch (e) {
    log("EXC " + (e && e.stack || e && e.message || e));
  } finally {
    if (cwd) {
      try { fs.rmSync(cwd, { recursive: true, force: true }); log("cleaned cwd"); }
      catch (e) { log("cwd cleanup failed (left in place): " + e.message); }
    }
  }
})();
