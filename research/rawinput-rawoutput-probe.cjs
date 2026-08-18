#!/usr/bin/env node
// Probe B — on the GROK provider, which tool_call / tool_call_update
// updates actually populate `rawInput` and `rawOutput`?
//
// Drives one turn that asks for several tool kinds (file read, search,
// shell command, and an MCP tool if `grok mcp list` shows any). Dumps
// keys + a truncated value per update so the answer is concrete per kind.
//
// If no MCP server is configured, that is reported — not invented.
//
// SAFETY: throwaway mkdtemp cwd. Writes and terminal cwd are refused
// outside it. ~/.grok/sessions/ is never deleted or written. Temp dir
// is removed at the end.
//
// Usage:
//   node research/rawinput-rawoutput-probe.cjs
//   GROK_BIN=… node research/rawinput-rawoutput-probe.cjs

const { spawn, execFileSync } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const READ_BODY = "HELLO_FILE_BODY_7c21aa90";
const SEARCH_NEEDLE = "SEARCH_NEEDLE_44f0b1c8";
const SHELL_MARKER = "GROK_B_SHELL_MARKER_a91c33e7";

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
const CAPS = { fs: { readTextFile: true, writeTextFile: true }, terminal: true };
const LOG_PATH = path.join(__dirname, "rawinput-rawoutput-probe.log");

const lines = [];
function log(s) {
  const t = String(s);
  lines.push(t);
  process.stderr.write("[rawio] " + t + "\n");
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

function listMcp() {
  try {
    const out = execFileSync(GROK, ["mcp", "list"], { encoding: "utf8", timeout: 20000 });
    return { ok: true, text: String(out).trim() };
  } catch (e) {
    return { ok: false, text: String((e && e.stdout) || "") + String((e && e.stderr) || e.message) };
  }
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
      throw new Error("terminal cwd outside probe dir: " + cwd);
    }
    const command = String((params && params.command) || "");
    const env = { ...process.env };
    if (Array.isArray(params && params.env)) {
      for (const e of params.env) env[e.name] = e.value;
    }
    const proc = spawn(command, { cwd, env, shell: this.spawnShell });
    const entry = { buf: "", exitCode: null, waiters: [], command };
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
      truncated: false,
    };
  }
  waitForExit(id) {
    const t = this.map.get(id);
    if (!t) return Promise.resolve({ exitCode: -1 });
    if (t.entry.exitCode != null) return Promise.resolve({ exitCode: t.entry.exitCode });
    return new Promise((res) => t.entry.waiters.push(res));
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
      hasMarker: t.entry.buf.includes(SHELL_MARKER),
    });
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

function classifyTool(u) {
  const meta = (u._meta && (u._meta["x.ai/tool"] || u._meta["xai/tool"])) || {};
  const title = String(u.title || "");
  const name = String(meta.name || "");
  const variant = u.rawInput && typeof u.rawInput === "object" ? String(u.rawInput.variant || "") : "";
  const kind = String(u.kind || "");
  const blob = (name + " " + title + " " + variant + " " + kind).toLowerCase();
  if (/\bmcp\./.test(name) || /\bmcp\./.test(title) || kind === "mcp" || /mcp server|mcp__/i.test(blob)) return "mcp";
  if (kind === "execute" || /bash|shell|terminal|run_terminal|command/i.test(blob)) return "shell";
  if (kind === "search" || /grep|search|glob|ripgrep|find/i.test(blob)) return "search";
  if (kind === "read" || /read_file|read_text|read file|^read$/i.test(blob)) return "read";
  if (kind === "edit" || /write|edit|strreplace/i.test(blob)) return "edit";
  return "other:" + (name || title || kind || "?");
}

function summarizeUpdate(u) {
  const meta = (u && u._meta && u._meta["x.ai/tool"]) || {};
  return {
    sessionUpdate: u.sessionUpdate,
    toolCallId: u.toolCallId,
    kind: u.kind,
    status: u.status,
    title: u.title,
    toolName: meta.name,
    variant: u.rawInput && typeof u.rawInput === "object" ? u.rawInput.variant : undefined,
    classified: classifyTool(u),
    keys: Object.keys(u || {}),
    rawInputKeys: u.rawInput && typeof u.rawInput === "object" ? Object.keys(u.rawInput) : (u.rawInput === undefined ? null : typeof u.rawInput),
    rawOutputKeys: u.rawOutput && typeof u.rawOutput === "object" ? Object.keys(u.rawOutput) : (u.rawOutput === undefined ? null : typeof u.rawOutput),
    contentTypes: Array.isArray(u.content) ? u.content.map((c) => c && c.type) : (u.content === undefined ? null : typeof u.content),
    rawInput: u.rawInput,
    rawOutput: u.rawOutput,
    content: u.content,
    _meta: u._meta,
  };
}

(async () => {
  let cwd;
  try {
    log("grok binary: " + GROK);
    try { log("grok --version: " + String(execFileSync(GROK, ["--version"], { encoding: "utf8" })).trim()); }
    catch (e) { log("grok --version failed: " + e.message); }
    log("clientCapabilities: " + j(CAPS));

    const mcp = listMcp();
    log("grok mcp list ok=" + mcp.ok);
    log("grok mcp list output:\n" + mcp.text);
    const mcpConfigured = mcp.ok && !/no mcp servers configured/i.test(mcp.text) && mcp.text.trim() !== "";

    const shell = resolveShell();
    log("shell spawn=" + String(shell.spawnShell) + " GROK_SHELL=" + String(shell.grokShell));

    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-rawio-")));
    log("cwd: " + cwd);
    fs.writeFileSync(path.join(cwd, "hello.txt"), READ_BODY + "\nthis is the file to read with the file-read tool\n");
    fs.writeFileSync(path.join(cwd, "notes.md"), "# notes\n\nThe unique token to find is:\n" + SEARCH_NEEDLE + "\n");

    const env = { ...process.env };
    if (shell.grokShell) env.GROK_SHELL = shell.grokShell;
    const proc = spawn(GROK, ["agent", "--no-leader", "stdio"], { cwd, env });
    const terminals = new ProbeTerminals(cwd, shell.spawnShell);
    const updates = [];
    const requests = [];
    let text = "";
    let nextId = 1;
    const waiters = new Map();

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

    proc.on("error", (e) => log("spawn error: " + e.message));
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      if (msg.method && msg.id != null) {
        requests.push({ method: msg.method, params: msg.params });
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
          try { return reply(msg.id, terminals.create(msg.params || {})); }
          catch (e) { return replyErr(msg.id, -32603, e.message); }
        }
        if (m === "terminal/output") {
          const id = msg.params && msg.params.terminalId;
          const out = terminals.output(id);
          terminals.snapshot(id, "output");
          return reply(msg.id, out);
        }
        if (m === "terminal/wait_for_exit") {
          const id = msg.params && msg.params.terminalId;
          terminals.waitForExit(id).then((r) => {
            terminals.snapshot(id, "wait_for_exit");
            reply(msg.id, r);
          });
          return;
        }
        if (m === "terminal/kill") { terminals.kill(msg.params && msg.params.terminalId); return reply(msg.id, {}); }
        if (m === "terminal/release") { terminals.release(msg.params && msg.params.terminalId); return reply(msg.id, {}); }
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
        if (u) updates.push(u);
        if (u && u.sessionUpdate === "agent_message_chunk" && u.content && u.content.type === "text") {
          text += u.content.text || "";
        }
        return;
      }

      if (msg.id != null && waiters.has(msg.id)) {
        const w = waiters.get(msg.id);
        waiters.delete(msg.id);
        w(msg);
      }
    });

    const init = await withTimeout(send("initialize", {
      protocolVersion: 1,
      clientCapabilities: CAPS,
      clientInfo: { name: "rawinput-rawoutput-probe", version: "0" },
    }), 60000, "initialize");
    if (init.error) throw new Error("initialize: " + j(init.error));
    log("initialize.agentCapabilities keys: " + j(init.result && Object.keys(init.result.agentCapabilities || init.result || {})));

    const ns = await withTimeout(send("session/new", { cwd, mcpServers: [] }), 120000, "session/new");
    if (ns.error) throw new Error("session/new: " + j(ns.error));
    const sessionId = ns.result.sessionId;
    log("sessionId: " + sessionId);

    const mcpLine = mcpConfigured
      ? "4. You have MCP tools available. Call exactly one MCP tool once (any cheap read-only one). If the call needs arguments, use the simplest valid ones."
      : "4. Do not try to use MCP — none is configured. Skip this step.";

    const prompt = [
      "Do these steps in this workspace, then stop. Do not create or edit files. Do not spawn subagents.",
      "",
      "1. Use the built-in file-read tool (NOT the shell) to read hello.txt.",
      "2. Use the built-in search/grep tool (NOT the shell) to find the string " + SEARCH_NEEDLE + ".",
      "3. Use the shell only for this exact command: echo " + SHELL_MARKER,
      mcpLine,
      "",
      "After the tools finish, reply with a short list of what you did.",
    ].join("\n");

    const p = await withTimeout(send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    }), 300000, "session/prompt");
    log("prompt result: " + j(p.error || p.result, 500));
    log("agent text (trunc): " + j(text, 500));
    log("terminal/create: " + j(terminals.creates, 500));
    log("terminal snapshots: " + j(terminals.snapshots, 600));
    log("server→client requests: " + j(requests.map((r) => r.method)));

    const toolUpdates = [];
    const classById = new Map();
    for (const u of updates) {
      if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") continue;
      const t = summarizeUpdate(u);
      if (t.classified && !String(t.classified).startsWith("other:")) classById.set(t.toolCallId, t.classified);
      else if (classById.has(t.toolCallId)) t.classified = classById.get(t.toolCallId);
      toolUpdates.push(t);
    }

    log("");
    log("======== PER-UPDATE DUMP ========  (" + toolUpdates.length + " tool updates)");
    toolUpdates.forEach((t, i) => {
      log("");
      log("-- [" + i + "] " + t.sessionUpdate + " classified=" + t.classified);
      log("   toolCallId=" + t.toolCallId);
      log("   kind=" + j(t.kind) + " status=" + j(t.status) + " title=" + j(t.title));
      log("   toolName=" + j(t.toolName) + " variant=" + j(t.variant));
      log("   keys=" + j(t.keys));
      log("   rawInput keys=" + j(t.rawInputKeys));
      log("   rawOutput keys=" + j(t.rawOutputKeys));
      log("   content types=" + j(t.contentTypes));
      if (t.rawInput !== undefined) log("   rawInput=" + j(t.rawInput, 700));
      if (t.rawOutput !== undefined) log("   rawOutput=" + j(t.rawOutput, 700));
      if (t.content !== undefined) log("   content=" + j(t.content, 900));
      if (t._meta !== undefined) log("   _meta=" + j(t._meta, 500));
    });

    const byClass = new Map();
    for (const t of toolUpdates) {
      if (!byClass.has(t.classified)) byClass.set(t.classified, []);
      byClass.get(t.classified).push(t);
    }

    log("");
    log("================= PER KIND =================");
    log("MCP configured: " + mcpConfigured);
    if (!mcpConfigured) log("MCP: none — grok mcp list said no servers. Not probed.");
    const wanted = ["read", "search", "shell", "mcp"];
    const seen = new Set(byClass.keys());
    for (const k of [...wanted, ...[...seen].filter((x) => !wanted.includes(x))]) {
      const evs = byClass.get(k) || [];
      log("");
      log("kind " + k + "  updates=" + evs.length);
      if (!evs.length) {
        if (k === "mcp" && !mcpConfigured) log("  (skipped — no MCP server)");
        else log("  INCONCLUSIVE for this kind: the model did not emit a matching tool_call.");
        continue;
      }
      const anyIn = evs.filter((e) => e.rawInput !== undefined);
      const anyOut = evs.filter((e) => e.rawOutput !== undefined);
      log("  rawInput present on " + anyIn.length + "/" + evs.length
        + "  (on types: " + j([...new Set(anyIn.map((e) => e.sessionUpdate))]) + ")");
      log("  rawOutput present on " + anyOut.length + "/" + evs.length
        + "  (on types: " + j([...new Set(anyOut.map((e) => e.sessionUpdate))]) + ")");
      for (const e of evs) {
        log("  - " + e.sessionUpdate + " status=" + e.status
          + " rawInput=" + (e.rawInput !== undefined ? j(e.rawInputKeys) : "ABSENT")
          + " rawOutput=" + (e.rawOutput !== undefined ? j(e.rawOutputKeys) : "ABSENT")
          + " content=" + (e.content !== undefined ? j(e.contentTypes) : "ABSENT"));
        if (e.rawInput !== undefined) log("    rawInput value: " + j(e.rawInput, 400));
        if (e.rawOutput !== undefined) log("    rawOutput value: " + j(e.rawOutput, 400));
      }
    }
    log("===========================================");

    const report = {
      sessionId,
      cwd,
      mcp,
      mcpConfigured,
      shell,
      promptResult: p.error || p.result,
      text,
      creates: terminals.creates,
      snapshots: terminals.snapshots,
      requestMethods: requests.map((r) => r.method),
      toolUpdates,
      allUpdateTypes: updates.map((u) => u.sessionUpdate),
    };
    fs.writeFileSync(LOG_PATH, lines.join("\n") + "\n\n----- RAW -----\n" + JSON.stringify(report, null, 2) + "\n");
    log("wrote " + LOG_PATH);

    try { terminals.dispose(); } catch { /* */ }
    killTree(proc);
    await new Promise((r) => setTimeout(r, 400));
  } catch (e) {
    log("EXC " + (e && e.stack || e && e.message || e));
  } finally {
    if (cwd) {
      try { fs.rmSync(cwd, { recursive: true, force: true }); log("cleaned cwd"); }
      catch (e) { log("cwd cleanup failed (left in place): " + e.message); }
    }
  }
})();
