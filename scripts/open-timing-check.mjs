// Does the real app actually EMIT the open-timing line, and does the line
// account for its own total?
//
// The unit tests prove the formatter. They cannot prove that `sidebar.ts` wires
// the clock to phases that tile a real open, or that the line survives the
// route to `desktop.log` — which is precisely the failure #131/#133 already hit
// once: "Show logs" was a menu item that did nothing, so nobody could send one.
//
// So: launch the real Electron build against the deterministic QA fixture, open
// two conversations through the rail (the SECOND one is the session switch that
// #133 and #138 describe), then read the log the app wrote and check the
// arithmetic on every line it produced.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.REPO || process.cwd();
const { buildQaFixture } = await import(pathToFileURL(path.join(root, "scripts", "qa-fixture.mjs")).href);
const mainJs = path.join(root, "out", "desktop", "main.js");
const electronExe = await resolveElectronExe(root);
const fixtureCli = path.join(root, "test", "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh");
const log = (m) => console.log(`[open-timing] ${m}`);

/** Electron's own binary, which is NOT `dist/electron` everywhere: macOS keeps
 *  it inside `Electron.app`. The `electron` package exports the resolved path
 *  for exactly this reason, so ask it rather than rebuilding the path here. */
async function resolveElectronExe(root) {
  try {
    const mod = await import("electron");
    const exe = typeof mod.default === "string" ? mod.default : undefined;
    if (exe && fs.existsSync(exe)) return exe;
  } catch {
    // fall through to the layout-based guess
  }
  const dist = path.join(root, "node_modules", "electron", "dist");
  if (process.platform === "win32") return path.join(dist, "electron.exe");
  if (process.platform === "darwin") return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  return path.join(dist, "electron");
}


assert.ok(fs.existsSync(mainJs), `Missing ${mainJs} — run \`npm run compile\` first`);
assert.ok(fs.existsSync(electronExe), `Missing Electron at ${electronExe}`);

const qa = buildQaFixture();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-timing-ud-"));
fs.writeFileSync(path.join(userData, "test-config.json"), JSON.stringify({ "grok.cliPath": fixtureCli }), "utf8");
const logPath = path.join(userData, "logs", "desktop.log");

// A heavy `session-meta.json`, on demand. This machine's real one is 1.47 MB
// and `PersistedState.get` re-reads and re-parses the whole file whenever its
// stamp has moved — and the cold-open path reads that key before it starts the
// clock. BIG_META=1 reproduces the size (never the contents; synthesised here,
// never copied from a real store).
if (process.env.BIG_META) {
  const dir = path.join(qa.grokHome, "client-state");
  fs.mkdirSync(dir, { recursive: true });
  const target = Number(process.env.BIG_META_BYTES || 1468603);
  const meta = {};
  let i = 0;
  while (JSON.stringify(meta).length < target) {
    meta[`0000fill${String(i).padStart(4, "0")}-0000-4000-8000-0000000000${(i % 100).toString().padStart(2, "0")}`] = {
      provider: "grok",
      providerCwd: `C:/Users/someone/projects/filler-project-${i}/nested/deeper/still`,
      autoName: `A synthesised conversation title number ${i}, long enough to weigh what a real one weighs`,
    };
    i++;
  }
  const file = path.join(dir, "session-meta.json");
  fs.writeFileSync(file, JSON.stringify(meta), "utf8");
  log(`BIG_META: wrote ${fs.statSync(file).size} bytes (${i} entries) to ${file}`);
}

const env = { ...process.env, GROK_HOME: qa.grokHome };
delete env.ELECTRON_RUN_AS_NODE;

/** Every `session open:` line the app has written so far. */
function openLines() {
  try {
    return fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter((l) => l.includes("session open:"));
  } catch {
    return [];
  }
}

async function waitForOpenLines(page, atLeast, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (openLines().length >= atLeast) return openLines();
    await page.waitForTimeout(250);
  }
  return openLines();
}

/** Split one line back into its phases, so the arithmetic can be checked. */
function parse(line) {
  const body = line.slice(line.indexOf("session open:") + "session open:".length).trim();
  const parts = body.split(" · ").map((s) => s.trim());
  const totalPart = parts.pop();
  const total = /^total (\d+)ms \(events: (\d+)\)$/.exec(totalPart);
  assert.ok(total, `no total on the line: ${JSON.stringify(totalPart)}`);
  const phases = parts.map((p) => {
    const m = /^(.+?) (\d+)ms(?: \((.*)\))?$/.exec(p);
    assert.ok(m, `unparsable phase ${JSON.stringify(p)}`);
    return { name: m[1], ms: Number(m[2]), note: m[3] };
  });
  return { phases, totalMs: Number(total[1]), events: Number(total[2]) };
}

const app = await electron.launch({
  executablePath: electronExe,
  args: [
    mainJs,
    `--workspace=${qa.project}`,
    `--user-data-dir=${userData}`,
    `--config-json=${path.join(userData, "test-config.json")}`,
  ],
  env,
  timeout: 60000,
});

let failure;
try {
  const page = await app.firstWindow({ timeout: 60000 });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.waitForSelector(".rail-session", { timeout: 60000 });
  const titles = await page.evaluate(
    () => [...document.querySelectorAll(".rail-session")].map((n) => (n.textContent || "").trim()),
  );
  log(`rail: ${titles.length} conversations — ${JSON.stringify(titles.slice(0, 4))}`);

  // Address conversations BY NAME. Clicking `.rail-session` by index looks like
  // it works and does not: the rail reorders by recency, so "click index 1
  // again" lands on a different conversation and the return trip below is never
  // actually taken. The first run of this check passed indices and reported a
  // dispose of 0ms for that reason alone.
  // The line's total starts when `startSessionBody` constructs its clock. The
  // user's open starts when they click. Everything between the two — parking
  // the old session, resolving the catalog, and the `session-meta.json` read —
  // is outside the line entirely, not even inside `other`. Measure it.
  const preludes = [];
  // Wait until the app stops opening things of its own accord. Without this the
  // click lands while a startup open is still in flight, the next line to appear
  // belongs to THAT open, and its clock legitimately started before the click —
  // which is how the first version of this check produced negative preludes.
  const settle = async (quietMs = 1200) => {
    let count = openLines().length;
    let quietSince = Date.now();
    while (Date.now() - quietSince < quietMs) {
      await page.waitForTimeout(150);
      const now = openLines().length;
      if (now !== count) {
        count = now;
        quietSince = Date.now();
      }
    }
  };

  const openByName = async (name) => {
    await settle();
    // Count FIRST. The app opens a conversation of its own on startup, so the
    // log already has a line in it whose clock started before this click — and
    // measuring against that one produces a negative prelude, which is how this
    // bug announced itself.
    const before = openLines().length;
    const clickedAt = Date.now();
    await page.locator(".rail-session", { hasText: name }).first().click();
    const got = await waitForOpenLines(page, before + 1);
    const line = got[before];
    if (!line) {
      // Not a probe failure. Returning to a conversation whose client is still
      // alive takes the `focusSession` branch — a pure re-focus, no reopen, and
      // so NO TIMING LINE AT ALL. Worth stating plainly: a user who freezes on
      // that path has nothing to send us.
      log(`opened "${name}" — no timing line: the app re-focused a live conversation instead of reopening it`);
      return got;
    }
    const stamp = /\[desktop ([^\]]+)\]/.exec(line);
    const emittedAt = stamp ? Date.parse(stamp[1]) : NaN;
    const { totalMs } = parse(line);
    const prelude = Math.round(emittedAt - totalMs - clickedAt);
    const resolveMs = parse(line).phases.find((x) => x.name === "resolve")?.ms ?? 0;
    preludes.push({ name, totalMs, prelude, resolveMs });
    log(`opened "${name}" — total ${totalMs}ms (resolve ${resolveMs}ms); still unmeasured before the clock: ${prelude}ms`);
    return got;
  };

  const first = qa.expectedOrder[0];
  const second = qa.expectedOrder[1];

  let lines = await openByName(first);
  assert.ok(lines.length >= 1, "the app opened a conversation and logged no timing line at all");

  lines = await openByName(second);

  // Back to the first. This is #131 verbatim — "navigated to an existing chat,
  // started loading and then froze" — and it is the only open of the three with
  // a client already bound to the target, so it is the only one that can put a
  // non-zero number in `dispose`.
  lines = await openByName(first);

  console.log("\n----- lines the app actually wrote -----");
  for (const l of lines) console.log(l);
  console.log("----------------------------------------\n");

  // The claim being proved: the line names its own total. Whatever the phases
  // do not claim is printed, so a slow open cannot read as fast.
  for (const line of lines) {
    const { phases, totalMs, events } = parse(line);
    const named = phases.filter((p) => p.name !== "other");
    const other = phases.find((p) => p.name === "other");
    const sum = phases.reduce((a, p) => a + p.ms, 0);
    const drift = Math.abs(sum - totalMs);
    assert.ok(drift <= 1, `phases do not tile the total (sum ${sum}ms vs total ${totalMs}ms): ${line}`);
    for (const want of ["resolve", "dispose", "prep", "version", "client", "spawn+init", "load", "replay(post)"]) {
      assert.ok(named.some((p) => p.name === want), `phase "${want}" missing from: ${line}`);
    }
    log(
      `checked: ${named.length} named phases + ${other ? `other ${other.ms}ms` : "no residue"} ` +
        `= total ${totalMs}ms (drift ${drift}ms, events ${events})`,
    );
  }

  const parsed = lines.map(parse);
  // NOT an assertion, and deliberately so. Opening a conversation from the rail
  // runs `this.focused = this.newLocalSession()` first, so the target is a fresh
  // object with no client and `dispose` is structurally 0 on this path — the
  // outgoing conversation is parked by `parkFocused()`, before the clock exists.
  // `dispose` earns its number on the restart path (same Session object), which
  // this check does not drive. Reported so a future reader does not mistake a
  // row of zeroes for "teardown is free".
  const switched = parsed.find((p) => (p.phases.find((x) => x.name === "dispose")?.ms ?? 0) > 0);
  log(
    switched
      ? `dispose measured ${switched.phases.find((x) => x.name === "dispose").ms}ms`
      : "dispose was 0ms on every open — expected here: a rail open builds a fresh session object",
  );
  log(`PASS — ${lines.length} real lines, every one accounting for its own total`);
  console.log("\n----- what the line does NOT cover -----");
  for (const p of preludes) {
    const share = p.prelude + p.totalMs > 0 ? Math.round((100 * p.prelude) / (p.prelude + p.totalMs)) : 0;
    console.log(`  ${p.name}: click→clock ${p.prelude}ms, clock ${p.totalMs}ms of which resolve ${p.resolveMs}ms  (${share}% still unlogged)`);
  }
  console.log("----------------------------------------");
} catch (e) {
  failure = e;
  console.error(`[open-timing] FAIL ${e && e.message}`);
  console.error("log tail:");
  try {
    console.error(fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(-40).join("\n"));
  } catch {
    console.error(`  (no log file at ${logPath})`);
  }
} finally {
  await app.close().catch(() => {});
}
process.exit(failure ? 1 : 0);
