// Live smoke — the desktop app driven against the REAL grok CLI.
//
// Everything else we run fakes the host. `test:desktop` and `e2e:screens` use
// `test/fixtures/fake-grok-acp`, and the relay's checks use a scripted uplink.
// That is the right trade for a gate: deterministic, offline, fast. But it means
// nothing we run has ever proved that a real agent starts, answers, and writes a
// session the rail can then read.
//
// This does. It is DELIBERATELY NOT in `npm test` and never should be: it needs
// a real CLI, a real key and the network, so it can fail for reasons that are
// not the product's fault. That is fine — this is an instrument to read before
// a release, not a gate that blocks a build. It prints what it saw and leaves
// frames behind; a person interprets the result.
//
// Run: npm run smoke:live
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildQaFixture } from "./qa-fixture.mjs";

const root = process.cwd();
const OUT = process.env.SCREENS_DIR || ".screens-live";
const mainJs = path.join(root, "out", "desktop", "main.js");
const electronExe = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const PROMPT = process.env.SMOKE_PROMPT
  || "Reply with exactly the word READY and nothing else. Do not use any tools.";
const TURN_TIMEOUT_MS = Number(process.env.SMOKE_TURN_TIMEOUT_MS || 180_000);

const notes = [];
const say = (m) => { console.log(`[live] ${m}`); notes.push(m); };

/** Locate a real CLI. No fixture fallback — a silent fake would defeat the point. */
function resolveCli() {
  const explicit = process.env.GROK_CLI_PATH;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const found = execFileSync(probe, ["grok"], { encoding: "utf8" }).split(/\r?\n/).find(Boolean);
    return found && fs.existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

const cli = resolveCli();
if (!cli) {
  console.error([
    "[live] No real grok CLI found.",
    "",
    "This check exists to exercise the REAL agent, so it will not fall back to",
    "the test fixture — a green run against a fake would be worse than no run.",
    "",
    "Put `grok` on PATH, or set GROK_CLI_PATH to it, and make sure whatever key",
    "it needs is already in your environment or its own config.",
  ].join("\n"));
  process.exit(2);
}
say(`CLI: ${cli}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const qa = buildQaFixture();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-live-ud-"));
fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({ "grok.cliPath": cli }), "utf8");

// The REAL grok home, deliberately — no GROK_HOME override here.
//
// The deterministic checks relocate it so the rail reads fixture history. Doing
// that in a LIVE run hides the CLI's own credentials from it, and the agent then
// sits on "Starting" forever waiting to authenticate against a home that has
// never been logged in to. Which is what happened the first time this ran.
//
// So the fixture supplies the WORKSPACE (a known tree for the file panel) and
// the machine supplies the session store. History is therefore whatever is
// really on this machine — correct for a smoke test, whose whole point is
// reality rather than reproducibility.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let exitCode = 0;
const app = await electron.launch({
  executablePath: electronExe,
  args: [
    mainJs,
    `--workspace=${qa.project}`,
    `--user-data-dir=${userData}`,
    `--config-json=${path.join(userData, "config.json")}`,
  ],
  env,
  timeout: 90_000,
});

try {
  const page = await app.firstWindow({ timeout: 90_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message || e)));
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    say(`frame: ${name}.png`);
  };

  await page.waitForSelector("#input", { timeout: 90_000 });
  // A real CLI takes real time to come up — and typing into a composer that is
  // still starting sends nothing. Wait for the send button to be usable, not
  // merely present.
  await page.waitForSelector("#send-btn:not(.stop):not([disabled])", { timeout: 120_000 });
  await shot("live-1-boot");

  // --- a real turn --------------------------------------------------------
  say(`sending: ${JSON.stringify(PROMPT)}`);
  const started = Date.now();
  await page.locator("#input").fill(PROMPT);
  await page.locator("#send-btn").click();
  // Selector waits, not `waitForFunction`: Playwright polls a predicate through
  // `eval`, and this webview's CSP is `script-src 'nonce-…'` with no
  // `unsafe-eval`, so every waitForFunction throws EvalError here regardless of
  // what it is waiting for. `waitForSelector` and `evaluate` are unaffected.
  await page.waitForSelector(".msg.agent .body", { timeout: TURN_TIMEOUT_MS });
  // Let the reply finish streaming rather than screenshotting the first token.
  await page
    .waitForSelector("#send-btn:not(.stop)", { timeout: TURN_TIMEOUT_MS })
    .catch(() => say("note: send button never left its busy state — screenshotting anyway"));
  const elapsed = Math.round((Date.now() - started) / 1000);
  const reply = (await page.locator(".msg.agent .body").last().innerText().catch(() => "")).trim();
  say(`agent replied in ${elapsed}s: ${JSON.stringify(reply.slice(0, 160))}`);
  await shot("live-2-turn");

  // --- the file panel, against real files ---------------------------------
  await page.waitForSelector("#desk-ft-top-toggle", { timeout: 30_000 });
  if (!(await page.locator("#desk-ft-panel").isVisible().catch(() => false))) {
    await page.locator("#desk-ft-top-toggle").click();
  }
  await page.waitForSelector(".gfp-row", { timeout: 30_000 });
  await page.locator(".gfp-row", { hasText: "README.md" }).first().click();
  await page.waitForSelector(".gfp-viewer:not([hidden])", { timeout: 30_000 });
  await page.waitForTimeout(500);
  await shot("live-3-file");

  // --- did the real CLI leave a session the rail can read? ----------------
  // The MACHINE's store, not the fixture's — this run deliberately does not
  // relocate GROK_HOME (see above), so a real turn writes where the CLI always
  // writes. Scoped to the fixture project, so a busy machine's other history
  // cannot make this look like a pass.
  const { resolveGrokHome, encodeSessionCatalogLeaf } = await import("../out/sessions.js");
  const store = path.join(resolveGrokHome(process.env), "sessions", encodeSessionCatalogLeaf(qa.project));
  const dirs = (fs.existsSync(store) ? fs.readdirSync(store) : [])
    .map((d) => path.join(store, d))
    .filter((d) => fs.statSync(d).isDirectory());
  const withTranscript = dirs.filter((d) => fs.existsSync(path.join(d, "events.jsonl")));
  say(`session store: ${dirs.length} session dirs, ${withTranscript.length} with a transcript`);
  const fresh = withTranscript.filter((d) => fs.statSync(path.join(d, "events.jsonl")).mtimeMs > started);
  say(fresh.length
    ? `the turn wrote a transcript (${fresh.length} updated during this run)`
    : "NOTE: no transcript was written during this run — the turn may not have reached the CLI");

  if (errors.length) {
    say(`renderer errors: ${JSON.stringify(errors)}`);
    exitCode = 1;
  }
  if (!reply) {
    say("NOTE: no agent reply captured");
    exitCode = 1;
  }
} catch (e) {
  say(`FAILED: ${String(e && e.message || e)}`);
  exitCode = 1;
} finally {
  await app.close().catch(() => {});
  qa.cleanup();
  fs.rmSync(userData, { recursive: true, force: true });
}

console.log("\n===== live smoke report =====");
for (const n of notes) console.log(` - ${n}`);
console.log(`frames: ${OUT}/`);
console.log(exitCode === 0
  ? "read the frames before releasing; nothing above looked wrong to the script"
  : "something above needs a human — see the notes");
process.exit(exitCode);
