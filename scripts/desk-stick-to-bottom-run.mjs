// Standalone runner for the #92 layout repro. Same Electron launch as
// desk-screens-check.mjs; used to get the check RED before fixing, then the
// same assert is imported into the screens harness.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildQaFixture } from "./qa-fixture.mjs";
import { assertPinnedAfterZoomedExpandedTurn } from "./desk-stick-to-bottom.mjs";

const root = process.cwd();
const OUT = process.env.SCREENS_DIR || ".screens";
const mainJs = path.join(root, "out", "desktop", "main.js");
const electronExe = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const fixtureCli = path.join(root, "test", "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh");
const log = (m) => console.log(`[stick-repro] ${m}`);

assert.ok(fs.existsSync(mainJs), `Missing ${mainJs} — run \`npm run compile\` first`);
assert.ok(fs.existsSync(electronExe), `Missing Electron at ${electronExe}`);

fs.mkdirSync(OUT, { recursive: true });

const qa = buildQaFixture();
const workspace = qa.project;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-stick-ud-"));
fs.writeFileSync(path.join(userData, "test-config.json"), JSON.stringify({ "grok.cliPath": fixtureCli }), "utf8");

const env = { ...process.env, GROK_HOME: qa.grokHome };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: electronExe,
  args: [
    mainJs,
    `--workspace=${workspace}`,
    `--user-data-dir=${userData}`,
    `--config-json=${path.join(userData, "test-config.json")}`,
  ],
  env,
  timeout: 60000,
});

try {
  const page = await app.firstWindow({ timeout: 60000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  const bw = await app.browserWindow(page);
  await bw.evaluate((win) => { try { win.webContents.setZoomFactor(1.5); } catch { /* */ } });
  await page.waitForSelector("#input", { timeout: 45000 });
  await page.waitForTimeout(400);

  await assertPinnedAfterZoomedExpandedTurn(page, {
    log,
    shot: async (name) => {
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      log(`captured ${name}.png`);
    },
  });
  log("REPRO CHECK PASSED");
} catch (e) {
  log(`REPRO CHECK FAILED: ${e && e.message || e}`);
  throw e;
} finally {
  await app.close().catch(() => {});
  qa.cleanup();
  fs.rmSync(userData, { recursive: true, force: true });
}
