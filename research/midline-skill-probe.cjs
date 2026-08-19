/**
 * Does an ACP session/prompt expand a skill referenced MID-LINE, or only at
 * position 0? The TUI expands mid-line (owner-measured). We are not the TUI.
 * The tell is a read_file tool call on a SKILL.md.
 *
 * node research/midline-skill-probe.cjs
 */
const { spawn } = require("node:child_process");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
const home = process.env.USERPROFILE || os.homedir();
const GROK = [path.join(home, ".grok", "bin", "grok.exe"), path.join(home, ".grok", "bin", "grok")]
  .find((p) => fs.existsSync(p)) || "grok";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(cwd) {
  const proc = spawn(GROK, ["agent", "stdio"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const st = { proc, id: 0, waiters: new Map(), updates: [], commands: [], buf: "" };
  proc.stdout.on("data", (d) => {
    st.buf += d.toString();
    let i;
    while ((i = st.buf.indexOf("\n")) >= 0) {
      const line = st.buf.slice(0, i).trim(); st.buf = st.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
        const w = st.waiters.get(m.id); if (w) { st.waiters.delete(m.id); w(m); }
      } else if (m.method === "session/update") {
        const u = m.params && m.params.update; if (u) st.updates.push(u);
        if (u && u.sessionUpdate === "available_commands_update") st.commands = u.availableCommands || u.available_commands || [];
      } else if (m.method === "session/request_permission") {
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } }) + "\n");
      } else if (m.id !== undefined) {
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n");
      }
    }
  });
  proc.stderr.on("data", () => {});
  st.req = (method, params) => new Promise((res) => {
    const id = ++st.id; st.waiters.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return st;
}

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "midline-skill-"));
  const c = client(cwd);
  await c.req("initialize", { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: true } });
  const s = await c.req("session/new", { cwd, mcpServers: [] });
  const sid = (s.result && (s.result.sessionId || s.result.session_id));
  await sleep(1500);
  const skills = c.commands.filter((x) => x && x._meta && x._meta.path && x._meta.scope);
  console.log(`advertised commands: ${c.commands.length}, of which skills: ${skills.length}`);
  if (!skills.length) { console.log("NO SKILLS ADVERTISED — cannot test"); c.proc.kill(); return; }
  const skill = skills.find((x) => /test/i.test(x.name)) || skills[0];
  console.log(`using skill: /${skill.name}  (scope=${skill._meta.scope})`);

  // A FRESH SESSION PER ARM. Running both in one session let arm A load the
  // skill and arm B inherit it from context — B then produced the skill's exact
  // output with no read_file, which reads like "loaded" and is not.
  const run = async (label, text) => {
    const s2 = await c.req("session/new", { cwd, mcpServers: [] });
    const sid2 = s2.result && (s2.result.sessionId || s2.result.session_id);
    await sleep(800);
    const before = c.updates.length;
    await c.req("session/prompt", { sessionId: sid2, prompt: [{ type: "text", text }] });
    const fresh = c.updates.slice(before);
    // Only a real tool_call reading a SKILL.md counts. available_commands_update
    // lists every skill's path, so a naive substring match says YES on both arms.
    const reads = fresh.filter((u) =>
      u.sessionUpdate !== "available_commands_update"
      && /tool_call/.test(String(u.sessionUpdate || ""))
      && JSON.stringify(u).includes("SKILL.md"));
    console.log(`\n${label}`);
    console.log(`  prompt: ${JSON.stringify(text)}`);
    console.log(`  SKILL.md referenced in updates: ${reads.length > 0 ? "YES — skill loaded" : "NO — not loaded"}`);
    if (reads.length) console.log(`  e.g. ${JSON.stringify(reads[0]).slice(0, 200)}`);
    const kinds = {};
    for (const u of fresh) kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] || 0) + 1;
    console.log(`  update kinds: ${JSON.stringify(kinds)}`);
    const txt = fresh.filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u.content && u.content.text) || "").join("");
    console.log(`  reply head: ${JSON.stringify(txt.slice(0, 140))}`);
  };

  await run("A) at position 0", `/${skill.name}`);
  await run("B) mid-line after prose", `hello there /${skill.name} thanks`);
  c.proc.kill();
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
})().catch((e) => { console.log("FAILED:", e.message); process.exit(1); });
