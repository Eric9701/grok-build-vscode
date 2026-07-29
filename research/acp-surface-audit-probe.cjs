#!/usr/bin/env node
// ACP surface audit — what does the CURRENT binary expose that docs/ACP-feedback.md
// doesn't yet know about?  Written 2026-07-29 for the 0.2.112 re-verification pass.
//
// Every other probe in this directory asks "does the specific thing we already
// know about still behave?".  This one asks the complementary question: **what is
// on the wire that we have never looked at?**  It is a DIAGNOSTIC — it asserts
// nothing, exits 0, and prints evidence for a human.
//
// Four scenarios, all ≈free (no model turns unless noted):
//
//   rails    — Dump the FULL payload of every inbound server→client method for a
//              plain session lifecycle.  The sessionrpc scenario of
//              oss-surfaces-probe.cjs counts method NAMES and surfaced three we
//              have never documented (_x.ai/settings/update,
//              _x.ai/announcements/update, _x.ai/mcp/servers_updated) plus two
//              unknown session_notification kinds (session_summary_generated,
//              hook_execution).  Counting names isn't enough — §2.7 asks for the
//              effective permission mode over ACP, and a rail literally called
//              "settings/update" is exactly where it would live.  So: print
//              payloads, not tallies.
//
//   methods  — Method-existence sweep.  ACP has no introspection, so we probe:
//              send each candidate with deliberately-minimal params and read the
//              error code.  -32601 = method absent.  -32602 (invalid params) or a
//              success = method EXISTS.  Known-good methods are included as
//              controls so a mis-shaped probe is distinguishable from a dead one.
//              Targets the two open asks with no known RPC: §2.13's queryable
//              quota and §2.2's `x.ai/compact_conversation` (spotted in the OSS
//              ext-method router on 2026-07-16, noted as "we will probe it",
//              never probed).
//
//   tokens   — §2.3.  Does the prompt result's `_meta.totalTokens` still report a
//              placeholder 0 for /session-info (context untouched)?  The OSS tree
//              showed the true value is already in scope at that point, making the
//              fix ~2 lines, so this is the cheapest possible check for whether it
//              landed.  Uses /session-info, which runs NO inference turn.
//
//   binread  — §2.5 / #79.  Ask the model to Read a real binary (.png) and capture
//              what comes back.  The open ask is that read_file should route an
//              image path through the vision pipeline that demonstrably already
//              works, instead of a hardcoded decode failure.  Costs one short turn.
//
// SAFETY: cwd is a throwaway mkdtemp, never the real repo.  terminal/create is
// ACKed with a fake terminal and empty output — no command ever executes.  Writes
// are refused outside the temp cwd.  Sessions created here are deleted at the end
// where the scenario allows it.
//
// Usage:
//   node research/acp-surface-audit-probe.cjs --scenario=rails
//   node research/acp-surface-audit-probe.cjs --scenario=methods
//   node research/acp-surface-audit-probe.cjs --scenario=tokens
//   node research/acp-surface-audit-probe.cjs --scenario=binread
//   GROK_BIN=… node research/acp-surface-audit-probe.cjs --scenario=rails

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const SCENARIO = arg("scenario", "rails");
// Payload dumps are truncated by default so the output stays readable; raise it
// when a specific rail's full shape is the thing under investigation.
const MAXLEN = Number(arg("maxlen", "1400"));
const VALID = ["rails", "methods", "tokens", "binread", "livetokens", "usageresume"];
// usageresume runs in two phases across two PROCESSES; phase 2 is handed the ids.
const RESUME_SID = arg("sid", "");
const RESUME_CWD = arg("reuse-cwd", "");
if (!VALID.includes(SCENARIO)) {
  console.error(`unknown --scenario=${SCENARIO}; expected one of ${VALID.join(", ")}`);
  process.exit(2);
}

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");

const cwd = RESUME_CWD
  ? fs.realpathSync(RESUME_CWD)
  : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `grok-audit-${SCENARIO}-`)));
const tag = `[audit:${SCENARIO}]`;
const log = (s) => process.stderr.write(`${tag} ${s}\n`);
const j = (v) => JSON.stringify(v);

const proc = spawn(GROK, ["agent", "stdio"], { cwd, env: process.env });
proc.on("error", (e) => { log("spawn failed: " + e.message); process.exit(2); });

let nextId = 1;
const waiters = new Map();
// Every inbound server→client notification, captured whole.
const inbound = [];

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => waiters.set(id, resolve));
}
function reply(id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyErr(id, code, message) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }

  // Response to one of ours.
  if (m.id !== undefined && waiters.has(m.id) && (m.result !== undefined || m.error !== undefined)) {
    const w = waiters.get(m.id);
    waiters.delete(m.id);
    w(m);
    return;
  }

  // Server→client request: satisfy the mandatory handlers so the agent doesn't crash.
  if (m.id !== undefined && m.method) {
    inbound.push({ method: m.method, params: m.params, request: true });
    if (m.method === "fs/read_text_file") {
      try {
        const p = m.params?.path;
        if (!p || !path.resolve(p).startsWith(cwd)) return replyErr(m.id, -32602, "outside probe cwd");
        return reply(m.id, { content: fs.readFileSync(p, "utf8") });
      } catch (e) { return replyErr(m.id, -32603, e.message); }
    }
    if (m.method === "fs/write_text_file") {
      const p = m.params?.path || "";
      if (!path.resolve(p).startsWith(cwd)) return replyErr(m.id, -32602, "probe refuses writes outside cwd");
      try { fs.writeFileSync(p, m.params.content ?? ""); return reply(m.id, {}); }
      catch (e) { return replyErr(m.id, -32603, e.message); }
    }
    if (m.method === "terminal/create") return reply(m.id, { terminalId: "probe-fake-term" });
    if (m.method === "terminal/output") return reply(m.id, { output: "", truncated: false });
    if (m.method === "terminal/wait_for_exit") return reply(m.id, { exitStatus: { exitCode: 0 } });
    if (m.method === "terminal/kill" || m.method === "terminal/release") return reply(m.id, {});
    if (m.method === "session/request_permission") {
      return reply(m.id, { outcome: { outcome: "selected", optionId: "reject-once" } });
    }
    return reply(m.id, {});
  }

  // Server→client notification.
  if (m.method) inbound.push({ method: m.method, params: m.params });
});

// ── shared helpers ───────────────────────────────────────────────────────────
async function initialize() {
  const r = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });
  return r.result;
}
async function newSession() {
  const r = await send("session/new", { cwd, mcpServers: [] });
  return r.result;
}
async function promptText(sessionId, text) {
  const r = await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
  });
  return r;
}
function dumpInbound(label) {
  log("");
  log(`================ ${label} ================`);
  const byMethod = new Map();
  for (const ev of inbound) {
    if (!byMethod.has(ev.method)) byMethod.set(ev.method, []);
    byMethod.get(ev.method).push(ev);
  }
  for (const [method, evs] of byMethod) {
    log(`--- ${method}  (${evs.length}×)${evs[0].request ? "  [server→client REQUEST]" : ""}`);
    // Print each DISTINCT payload shape once; repeats of an identical shape are noise.
    const seen = new Set();
    for (const ev of evs) {
      const p = ev.params;
      const kind = p?.update?.sessionUpdate || p?.notification?.kind || p?.kind || "";
      const key = method + "|" + kind;
      if (seen.has(key)) continue;
      seen.add(key);
      let s = j(p);
      if (s && s.length > MAXLEN) s = s.slice(0, MAXLEN) + `… (+${s.length - MAXLEN} chars)`;
      log(`    ${kind ? `kind=${kind}  ` : ""}${s}`);
    }
  }
  log("=".repeat(56 + label.length));
}

// ── scenario: rails ──────────────────────────────────────────────────────────
async function runRails() {
  const init = await initialize();
  log("initialize result (full):");
  log("  " + j(init));
  log("");
  log("agentCapabilities keys: " + j(Object.keys(init?.agentCapabilities ?? init ?? {})));
  if (init?._meta) log("initialize._meta: " + j(init._meta));

  const s = await newSession();
  const sid = s.sessionId;
  log(`session ${sid}`);
  log("session/new result keys: " + j(Object.keys(s)));
  if (s._meta) {
    const meta = j(s._meta);
    log("session/new._meta: " + (meta.length > 2000 ? meta.slice(0, 2000) + "…" : meta));
  }

  // Give the async rails (settings/announcements/mcp) time to fire.
  await new Promise((r) => setTimeout(r, 3000));

  // A no-inference slash command produces a turn without burning credits, which is
  // enough to shake out any per-turn rail.
  await promptText(sid, "/session-info");
  await new Promise((r) => setTimeout(r, 1500));

  dumpInbound("FULL INBOUND PAYLOADS");
  await send("_x.ai/session/delete", { sessionId: sid, cwd });
}

// ── scenario: methods ────────────────────────────────────────────────────────
async function runMethods() {
  await initialize();
  const s = await newSession();
  const sid = s.sessionId;

  // Controls first (known to exist / known to be absent), then the real targets.
  const candidates = [
    // -- controls --------------------------------------------------------------
    ["_x.ai/session/list", { cwd }, "control: known present"],
    ["_x.ai/session/info", { sessionId: sid }, "control: known present"],
    ["_x.ai/rewind/points", { sessionId: sid }, "control: known present (§2.15)"],
    ["_x.ai/definitely/not/a/method", {}, "control: known ABSENT"],
    ["x.ai/session/list", { cwd }, "control: bare prefix must be -32601 (decoder)"],
    // -- §2.2: the compact RPC we spotted in the router and never probed ---------
    ["_x.ai/compact_conversation", { sessionId: sid }, "§2.2 position-independent compact?"],
    // -- §2.13: a queryable quota surface ---------------------------------------
    ["_x.ai/usage", {}, "§2.13 quota"],
    ["_x.ai/usage/get", {}, "§2.13 quota"],
    ["_x.ai/account/usage", {}, "§2.13 quota"],
    ["_x.ai/user/usage", {}, "§2.13 quota"],
    ["_x.ai/billing/usage", {}, "§2.13 quota"],
    ["_x.ai/quota", {}, "§2.13 quota"],
    ["_x.ai/limits", {}, "§2.13 quota"],
    ["_x.ai/rate_limits", {}, "§2.13 quota"],
    ["_x.ai/session/usage", { sessionId: sid }, "§2.13 quota (session-scoped)"],
    // -- §2.7 / §2.11: effective permission policy over ACP ----------------------
    ["_x.ai/settings/get", {}, "§2.7 effective settings"],
    ["_x.ai/settings/list", {}, "§2.7 effective settings"],
    ["_x.ai/settings", {}, "§2.7 effective settings"],
    ["_x.ai/permissions/get", { sessionId: sid }, "§2.11 effective permission policy"],
    ["_x.ai/permission/mode", { sessionId: sid }, "§2.11 effective permission policy"],
    ["_x.ai/session/config", { sessionId: sid }, "§2.7 sessionConfig"],
    // -- session portability: source-only surfaces reported in the OSS tree ------
    ["_x.ai/session/state", { sessionId: sid }, "session portability (source-only per OSS review)"],
    ["_x.ai/session/import", {}, "session portability (source-only per OSS review)"],
    ["_x.ai/session/updates", { sessionId: sid }, "session portability (source-only per OSS review)"],
    // -- misc surfaces seen on the inbound rails ---------------------------------
    ["_x.ai/announcements/list", {}, "seen as an inbound rail — is there a getter?"],
    ["_x.ai/hooks/list", {}, "hook_execution notification implies a hooks surface"],
    ["_x.ai/models/list", {}, "model catalog"],
  ];

  log("code -32601 = ABSENT · -32602/other/success = EXISTS");
  log("");
  const present = [];
  for (const [method, params, why] of candidates) {
    const r = await send(method, params);
    const code = r.error?.code;
    const absent = code === -32601;
    let detail;
    if (r.error) {
      detail = `error ${code} ${JSON.stringify(r.error.message ?? "").slice(0, 120)}`;
    } else {
      let s = j(r.result);
      if (s && s.length > 300) s = s.slice(0, 300) + "…";
      detail = "OK " + s;
    }
    log(`${absent ? "ABSENT " : "EXISTS "} ${method.padEnd(34)} ${detail}`);
    log(`         ${" ".repeat(34)} (${why})`);
    if (!absent) present.push(method);
  }
  log("");
  log("EXISTS: " + j(present));
  await send("_x.ai/session/delete", { sessionId: sid, cwd });
}

// ── scenario: tokens ─────────────────────────────────────────────────────────
async function runTokens() {
  await initialize();
  const s = await newSession();
  const sid = s.sessionId;
  const model = s.models?.find?.((m) => m.modelId === s.currentModelId);
  log("currentModelId: " + j(s.currentModelId));
  log("model._meta: " + j(model?._meta));

  // /session-info runs no inference turn — the cheapest possible read of the
  // placeholder-zero behavior described in §2.3.
  const r = await promptText(sid, "/session-info");
  log("");
  log("/session-info prompt result _meta: " + j(r.result?._meta));
  log("  → totalTokens = " + j(r.result?._meta?.totalTokens) + "   (§2.3 claims a placeholder 0)");

  // The reply prose is what the extension scrapes today; capture it verbatim so we
  // can confirm the regex contract still holds.
  const texts = inbound
    .filter((e) => e.method === "session/update")
    .map((e) => e.params?.update)
    .filter((u) => u?.sessionUpdate === "agent_message_chunk")
    .map((u) => u?.content?.text ?? "")
    .join("");
  log("");
  log("/session-info reply prose:");
  log("  " + j(texts.slice(0, 900)));
  await send("_x.ai/session/delete", { sessionId: sid, cwd });
}

// ── scenario: binread ────────────────────────────────────────────────────────
async function runBinread() {
  // A real 1×1 red PNG — small but well above the 8×8/512px drop floors is NOT
  // required here, because we want read_file's behavior, not the vision path.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAM0lEQVR42u3OMQEAAAgDoK1/aM3g" +
      "4QcSkKZzVQEAAAAAAAAAAAAAAAAAAAAAAAAAAADwYQFXwAABlQpFEQAAAABJRU5ErkJggg==",
    "base64"
  );
  const img = path.join(cwd, "square.png");
  fs.writeFileSync(img, png);
  log(`wrote ${img} (${png.length} bytes)`);

  await initialize();
  const s = await newSession();
  const sid = s.sessionId;

  const r = await promptText(
    sid,
    `Use your Read tool on the file square.png in the current directory and tell me exactly what the tool returned. Do not use any other tool.`
  );
  log("stopReason: " + j(r.result?.stopReason));

  log("");
  log("--- tool calls + results ---");
  for (const ev of inbound) {
    const u = ev.params?.update;
    if (!u) continue;
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      const name = u._meta?.["x.ai/tool"]?.name;
      let s2 = j({ status: u.status, title: u.title, rawInput: u.rawInput, content: u.content, rawOutput: u.rawOutput });
      if (s2.length > 1200) s2 = s2.slice(0, 1200) + "…";
      log(`  ${u.sessionUpdate} ${name ? `[${name}] ` : ""}${s2}`);
    }
  }
  const texts = inbound
    .filter((e) => e.method === "session/update")
    .map((e) => e.params?.update)
    .filter((u) => u?.sessionUpdate === "agent_message_chunk")
    .map((u) => u?.content?.text ?? "")
    .join("");
  log("");
  log("model's account: " + j(texts.slice(0, 800)));
  await send("_x.ai/session/delete", { sessionId: sid, cwd });
}

// ── scenario: livetokens ─────────────────────────────────────────────────────
// Two questions the `tokens` scenario can't answer with a no-inference command:
//   (a) §2.3 — the prompt RESULT's totalTokens is a placeholder 0, but the
//       session/update NOTIFICATION envelope carries a real one. Does that hold
//       across a genuine inference turn, i.e. is the truthful context size
//       already streaming to every client that reads the right envelope?
//   (b) #53 — is _x.ai/session/usage session-CUMULATIVE?  The extension maintains
//       its own per-turn usage log and derives the total because grok was
//       believed to report per-prompt only.  If this RPC accumulates, that whole
//       mechanism is redundant.
// Costs two short inference turns.
async function runLiveTokens() {
  await initialize();
  const s = await newSession();
  const sid = s.sessionId;

  const usage = async (label) => {
    const r = await send("_x.ai/session/usage", { sessionId: sid });
    log(`_x.ai/session/usage ${label}: ${j(r.result ?? r.error)}`);
  };
  await usage("before any turn");

  for (const [n, text] of [[1, "Reply with exactly: ONE"], [2, "Reply with exactly: TWO"]]) {
    const before = inbound.length;
    const r = await promptText(sid, text);
    log("");
    log(`--- turn ${n} ---`);
    log(`prompt result _meta: ${j(r.result?._meta)}`);

    // Every session/update envelope _meta for this turn, deduped by value.
    const seen = new Set();
    for (const ev of inbound.slice(before)) {
      if (ev.method !== "session/update") continue;
      const tt = ev.params?._meta?.totalTokens;
      if (tt === undefined) continue;
      const kind = ev.params?.update?.sessionUpdate;
      const key = `${kind}:${tt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      log(`  envelope _meta.totalTokens=${tt}  (on ${kind})`);
    }
    await usage(`after turn ${n}`);
  }

  log("");
  log("turn_completed payloads (the live rail's own usage view):");
  for (const ev of inbound) {
    if (ev.method !== "_x.ai/session_notification") continue;
    if (ev.params?.update?.sessionUpdate !== "turn_completed") continue;
    log("  " + j(ev.params).slice(0, 1200));
  }
  await send("_x.ai/session/delete", { sessionId: sid, cwd });
}

// ── scenario: usageresume ────────────────────────────────────────────────────
// The one fact that decides whether the extension's hand-rolled usage ledger can
// be retired in favour of _x.ai/session/usage: does that RPC's total SURVIVE the
// session being resumed in a fresh agent process?  A cumulative figure that
// silently resets to zero on resume is worse than no figure at all, because the
// number keeps looking authoritative while under-reporting.
//
// Two phases, two PROCESSES (a `session/load` in the same process would prove
// nothing — the in-memory ledger would still be warm):
//   phase 1: node …--scenario=usageresume                    → prints sid + cwd
//   phase 2: node …--scenario=usageresume --sid=<id> --reuse-cwd=<dir>
async function runUsageResume() {
  await initialize();
  const usage = async (label) => {
    const r = await send("_x.ai/session/usage", { sessionId: RESUME_SID || phase1Sid });
    log(`_x.ai/session/usage ${label}: ${j(r.result?.usage ?? r.error)}`);
    return r.result?.usage;
  };

  let phase1Sid = RESUME_SID;
  if (!RESUME_SID) {
    const s = await newSession();
    phase1Sid = s.sessionId;
    log(`PHASE 1 — fresh session ${phase1Sid}`);
    for (const t of ["Reply with exactly: ONE", "Reply with exactly: TWO"]) await promptText(phase1Sid, t);
    const u = await usage("after 2 turns, ORIGINAL process");
    log("");
    log("now run phase 2 in a NEW process:");
    log(`  node research/acp-surface-audit-probe.cjs --scenario=usageresume --sid=${phase1Sid} --reuse-cwd="${cwd}"`);
    log(`PHASE1_TOTAL=${u?.totalTokens} PHASE1_TURNS=${u?.numTurns} PHASE1_COST=${u?.costUsdTicks}`);
    return;
  }

  log(`PHASE 2 — resuming ${RESUME_SID} in a FRESH process`);
  const loaded = await send("session/load", { sessionId: RESUME_SID, cwd, mcpServers: [] });
  log("session/load: " + (loaded.error ? j(loaded.error) : "ok"));
  const after = await usage("immediately after session/load, NEW process");
  log("");
  log(after && after.totalTokens > 0
    ? ">>> SURVIVES resume — the RPC is a true session-lifetime total."
    : ">>> RESETS on resume — the RPC is per-PROCESS, so a client that shows it as the session total under-reports after any reload.");
  await promptText(RESUME_SID, "Reply with exactly: THREE");
  await usage("after one more turn in the new process");
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  log("grok: " + GROK);
  log("cwd:  " + cwd);
  const runners = {
    rails: runRails, methods: runMethods, tokens: runTokens,
    binread: runBinread, livetokens: runLiveTokens, usageresume: runUsageResume,
  };
  try {
    await runners[SCENARIO]();
  } catch (e) {
    log("SCENARIO THREW: " + (e?.stack || e?.message || String(e)));
  }
  proc.stdin.end();
  proc.kill();
  setTimeout(() => process.exit(0), 300);
})();
