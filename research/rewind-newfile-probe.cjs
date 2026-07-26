// Does rewind undo a NEWLY CREATED file, or only edits to existing ones?
//
// The live `rewind-files` test proves an edit to an EXISTING file is restored
// (revertedFiles=1). Creation is a different shape: a snapshot system that
// restores "previous content" has no previous content for a file that didn't
// exist, and deleting user files is a bigger hammer than restoring them.
//
// This also records `has_file_changes` for the creating turn — that flag is what
// the extension uses to decide whether to confirm at all, so if the CLI reports
// false for a pure creation, we skip the dialog AND nothing is reverted, which
// together look exactly like "rewind is broken".
//
// Real git repo in a temp dir; the harness performs writes for real.
//
// Usage: node research/rewind-newfile-probe.cjs
//        GROK_BIN=… node research/rewind-newfile-probe.cjs

const { spawn, execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const GROK =
  process.env.GROK_BIN ||
  path.join(os.homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-newfile-")));
const git = (args) => execFileSync("git", args, { cwd, stdio: "pipe" });
git(["init", "-q"]);
git(["config", "user.email", "t@t.t"]);
git(["config", "user.name", "t"]);
// One tracked file so the repo has a commit, plus a tracked file we ALSO ask
// grok to edit — the contrast case we already believe works.
fs.writeFileSync(path.join(cwd, "existing.txt"), "ORIGINAL\n");
git(["add", "-A"]);
git(["commit", "-qm", "seed"]);

const NEW_FILE = path.join(cwd, "created.txt");
const EXISTING = path.join(cwd, "existing.txt");

const proc = spawn(GROK, ["agent", "stdio"], { cwd });
let nextId = 1;
const waiters = new Map();
const writes = [];

function send(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => waiters.set(id, res));
}
function respond(id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

let buf = "";
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
      continue;
    }
    if (msg.id != null && msg.method) {
      const m = msg.method;
      if (m === "fs/write_text_file") {
        // Perform it for real, exactly as the extension does once the gate is down.
        try {
          fs.mkdirSync(path.dirname(msg.params.path), { recursive: true });
          fs.writeFileSync(msg.params.path, msg.params.content || "");
          writes.push(msg.params.path);
        } catch {}
        return respond(msg.id, {});
      }
      if (m === "fs/read_text_file") {
        let content = "";
        try { content = fs.readFileSync(msg.params.path, "utf8"); } catch {}
        return respond(msg.id, { content });
      }
      if (m === "terminal/create") return respond(msg.id, { terminalId: "t" + nextId });
      if (m === "terminal/output") return respond(msg.id, { output: "", exitStatus: { exitCode: 0 }, truncated: false });
      if (m === "terminal/wait_for_exit") return respond(msg.id, { exitCode: 0 });
      if (m === "session/request_permission") {
        const opts = (msg.params && msg.params.options) || [];
        const allow = opts.find((o) => /allow/.test(o.kind)) || opts[0];
        return respond(msg.id, { outcome: { outcome: "selected", optionId: allow && allow.optionId } });
      }
      return respond(msg.id, {});
    }
  }
});
proc.stderr.on("data", () => {});

const INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
};
const points = (r) => ((r && (r.rewind_points || r.rewindPoints)) || []).map((p) => ({
  idx: p.prompt_index ?? p.promptIndex,
  files: p.has_file_changes === true || p.hasFileChanges === true,
  snaps: p.num_file_snapshots ?? p.numFileSnapshots ?? 0,
  preview: String(p.prompt_preview ?? p.promptPreview ?? "").replace(/\s+/g, " ").slice(0, 44),
}));
const exists = (p) => fs.existsSync(p);

(async () => {
  await send("initialize", INIT);
  const s = await send("session/new", { cwd, mcpServers: [] });
  const sessionId = s.result.sessionId;
  console.log(`cwd ${cwd}\nsession ${sessionId}\n`);

  await send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Say only: READY. No tools." }] });

  console.log("asking grok to CREATE a new file and EDIT an existing one…");
  await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text:
      "Do exactly two things with your file tools, no commentary: " +
      "(1) create a new file created.txt containing the single line CREATED; " +
      "(2) change existing.txt so its only line is MODIFIED." }],
  });

  const createdBefore = exists(NEW_FILE);
  const existingBefore = fs.readFileSync(EXISTING, "utf8").trim();
  console.log(`\nafter the turn: created.txt exists=${createdBefore}, existing.txt="${existingBefore}"`);
  console.log(`harness performed ${writes.length} write(s): ${writes.map((w) => path.basename(w)).join(", ") || "(none)"}`);
  if (!createdBefore) {
    console.log("\n!! grok did not create the file — inconclusive, re-run.");
    proc.kill();
    return;
  }

  const before = points((await send("_x.ai/rewind/points", { sessionId })).result);
  console.log("\npoints:");
  for (const p of before) console.log(`  #${p.idx} files=${p.files} snapshots=${p.snaps}  "${p.preview}"`);

  // Undo the turn that did the work: rewind DISCARDS its target.
  const target = before[before.length - 1];
  console.log(`\nexecute mode=all force=true -> #${target.idx} (has_file_changes=${target.files})`);
  const ex = await send("_x.ai/rewind/execute", {
    sessionId, targetPromptIndex: target.idx, mode: "all", force: true,
  });
  console.log("result:", JSON.stringify(ex.result || ex.error));

  const createdAfter = exists(NEW_FILE);
  const existingAfter = fs.readFileSync(EXISTING, "utf8").trim();
  console.log(`\nafter rewind: created.txt exists=${createdAfter}, existing.txt="${existingAfter}"`);
  console.log("\n>>> VERDICT");
  console.log(`    NEW file  : ${createdAfter ? "SURVIVED the rewind (not deleted)" : "REMOVED by the rewind"}`);
  console.log(`    EDITED file: ${existingAfter === "ORIGINAL" ? "restored to ORIGINAL" : `NOT restored (still "${existingAfter}")`}`);
  console.log(`    has_file_changes on that turn: ${target.files}  <- drives whether we confirm at all`);
  proc.kill();
})().catch((e) => {
  console.error("probe error:", e);
  proc.kill();
  process.exit(1);
});
