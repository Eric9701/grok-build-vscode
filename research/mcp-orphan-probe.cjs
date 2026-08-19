/**
 * Does `proc.kill()` actually stop the mcp-remote the extension spawned?
 *
 * src/mcp-connector-auth.ts spawns `npx.cmd` with `shell: true` on Windows,
 * so the child is `cmd.exe`, and its own children are npx -> node mcp-remote.
 * `kill()` targets the handle it holds. This measures what survives.
 *
 * Only ever kills PIDs this file itself spawned.
 */
const { spawn, execSync } = require("node:child_process");

const ENDPOINT = process.argv[2] || "https://mcp.linear.app/mcp";
const isWin = process.platform === "win32";

function descendants(root) {
  if (!isWin) return [];
  const out = execSync(
    "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress\"",
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const all = JSON.parse(out);
  const kids = new Map();
  for (const p of all) {
    if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []);
    kids.get(p.ParentProcessId).push(p);
  }
  const found = [];
  const walk = (pid) => {
    for (const c of kids.get(pid) || []) { found.push(c); walk(c.ProcessId); }
  };
  walk(root);
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const plan = isWin ? { command: "npx.cmd", shell: true } : { command: "npx", shell: false };
  console.log(`[probe] spawning ${plan.command} -y mcp-remote ${ENDPOINT} (shell=${plan.shell})`);
  const proc = spawn(plan.command, ["-y", "mcp-remote", ENDPOINT], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: plan.shell,
    windowsHide: true,
  });
  const seen = [];
  proc.stdout.on("data", (b) => seen.push(String(b)));
  proc.stderr.on("data", (b) => seen.push(String(b)));

  console.log(`[probe] shell pid ${proc.pid}`);
  // Let npx download + boot mcp-remote and open its callback listener.
  await sleep(25_000);

  const before = descendants(proc.pid);
  console.log(`[probe] descendants BEFORE kill: ${before.length}`);
  for (const p of before) console.log(`         ${p.ProcessId}\t${p.Name}`);

  const ports = isWin
    ? execSync("powershell -NoProfile -Command \"Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 3330 -and $_.LocalPort -le 3340 } | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress\"", { encoding: "utf8" }).trim()
    : "";
  console.log(`[probe] listeners on 3330-3340 while running: ${ports || "(none)"}`);

  console.log("[probe] calling proc.kill() — exactly what mcp-connector-auth.ts does");
  proc.kill();
  await sleep(6000);

  const alive = before.filter((p) => {
    try { process.kill(p.ProcessId, 0); return true; } catch { return false; }
  });
  console.log(`[probe] SURVIVORS after proc.kill(): ${alive.length}`);
  for (const p of alive) console.log(`         ${p.ProcessId}\t${p.Name}  <-- ORPHAN`);

  const portsAfter = isWin
    ? execSync("powershell -NoProfile -Command \"Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 3330 -and $_.LocalPort -le 3340 } | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress\"", { encoding: "utf8" }).trim()
    : "";
  console.log(`[probe] listeners on 3330-3340 AFTER kill: ${portsAfter || "(none)"}`);

  console.log(`[probe] output tail: ${seen.join("").slice(-600).replace(/\s+/g, " ")}`);

  // Clean up only what this probe started.
  for (const p of alive) {
    try { execSync(`taskkill /pid ${p.ProcessId} /T /F`, { stdio: "ignore" }); } catch {}
  }
  console.log(`[probe] cleaned up ${alive.length} process(es) this probe spawned`);
  process.exit(0);
})();
