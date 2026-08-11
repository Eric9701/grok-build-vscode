// Screens check for the DESKTOP app — drives the real Electron build through a
// scripted session and asserts what a DOM test cannot, leaving screenshots
// behind for a person (or a model) to look at.
//
// WHY THIS EXISTS. `test/*.dom.test.ts` runs in happy-dom, which has no layout
// engine: rects are zeros and stylesheets never apply. So an icon with no size,
// a control pushed off-screen, or a panel overlapping the top bar all satisfy
// every assertion those suites can make. The file panel's action row shipped as
// three EMPTY BOXES — every icon 0x0 — through a green suite and three review
// rounds, and was found by a human looking at a screenshot.
//
// Its sibling is `npm run e2e:screens` in the relay repo, which does the same
// for the browser client. Between them they cover both surfaces of the one
// shared panel.
//
// Run: npm run e2e:screens   (frames land in .screens/, gitignored)
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = process.cwd();
const OUT = process.env.SCREENS_DIR || ".screens";
const mainJs = path.join(root, "out", "desktop", "main.js");
const electronExe = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const fixtureCli = path.join(root, "test", "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh");
const log = (m) => console.log(`[desk-screens] ${m}`);

assert.ok(fs.existsSync(mainJs), `Missing ${mainJs} — run \`npm run compile\` first`);
assert.ok(fs.existsSync(electronExe), `Missing Electron at ${electronExe}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const README = [
  "# grok-remote",
  "",
  "Relay server and web client for driving the desk machine from a phone.",
  "",
  "## What this is",
  "",
  "- a relay (`src/server.ts`)",
  "- a web client (`web/`)",
  "- one file panel, shared with the desktop",
  "",
].join("\n");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-screens-ws-"));
fs.writeFileSync(path.join(workspace, "README.md"), README);
fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
for (const d of ["docs", "src", "web"]) {
  fs.mkdirSync(path.join(workspace, d), { recursive: true });
  fs.writeFileSync(path.join(workspace, d, "server.ts"), "export const n = 1;\n");
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-screens-ud-"));
fs.writeFileSync(path.join(userData, "test-config.json"), JSON.stringify({ "grok.cliPath": fixtureCli }), "utf8");

/** Every icon meant to be painted must occupy space — see the header. */
const BLANK_ICONS = `() => {
  const bad = [];
  for (const svg of document.querySelectorAll("button svg, .gfp-action svg, .icon-btn svg")) {
    const host = svg.closest("button, .gfp-action, .icon-btn");
    if (!host || host.hidden || host.offsetParent === null) continue;
    if (getComputedStyle(svg).display === "none") continue;
    const r = svg.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) {
      bad.push((host.title || host.id || host.className || "?") + " " + Math.round(r.width) + "x" + Math.round(r.height));
    }
  }
  return bad;
}`;

const env = { ...process.env };
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
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message || e)));

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    log(`captured ${name}.png`);
  };
  const assertNoBlankIcons = async (where) => {
    const blank = await page.evaluate(`(${BLANK_ICONS})()`);
    assert.deepEqual(blank, [], `${where}: icons rendered with no size — ${JSON.stringify(blank)}`);
  };

  await page.waitForSelector("#input", { timeout: 45000 });
  await page.waitForSelector("#desk-ft-top-toggle", { timeout: 25000 });
  await page.waitForTimeout(500);
  await shot("desk-1-chat");
  await assertNoBlankIcons("desk chat");

  if (!(await page.locator("#desk-ft-panel").isVisible().catch(() => false))) {
    await page.locator("#desk-ft-top-toggle").click();
  }
  await page.waitForSelector("#desk-ft-panel", { state: "visible", timeout: 25000 });
  await page.waitForSelector(".gfp-row", { timeout: 25000 });
  await page.waitForTimeout(400);
  await shot("desk-2-tree");
  await assertNoBlankIcons("desk tree");

  await page.locator(".gfp-row", { hasText: "README.md" }).first().click();
  await page.waitForSelector(".gfp-viewer:not([hidden])", { timeout: 25000 });
  await page.waitForTimeout(500);
  await shot("desk-3-file");
  await assertNoBlankIcons("desk file open");
  assert.equal(
    await page.evaluate(() => { const f = document.querySelector(".gfp-filter"); return !!f && getComputedStyle(f).display !== "none"; }),
    false,
    "desk: the tree filter must hide once a file is open — it has no tree to search",
  );
  assert.deepEqual(
    await page.evaluate(() => [...document.querySelectorAll(".gfp-viewer .gfp-action")].map((b) => b.title)),
    ["Preview", "Edit source", "More actions"],
    "desk: Markdown shows the mode pair, plus the host-local actions menu",
  );

  await page.locator(".gfp-viewer .gfp-action[title='Edit source']").click();
  await page.waitForSelector(".gfp-editor", { timeout: 25000 });
  await page.waitForTimeout(400);
  await shot("desk-4-edit");
  await assertNoBlankIcons("desk editing");

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector(".gfp-panel");
    const bar = document.querySelector("#desk-ft-top-toggle")?.closest("header, .top-bar");
    const r = panel?.getBoundingClientRect();
    return {
      panelTop: r ? Math.round(r.top) : null,
      panelRight: r ? Math.round(r.right) : null,
      barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
      viewportWidth: window.innerWidth,
      docWidth: document.documentElement.scrollWidth,
    };
  });
  assert.ok(
    geometry.panelTop >= geometry.barBottom - 1,
    `desk: the panel must start below the bar holding its toggle (panel ${geometry.panelTop}, bar bottom ${geometry.barBottom})`,
  );
  assert.ok(
    geometry.panelRight <= geometry.viewportWidth + 1,
    `desk: the panel must not run off the right edge (${geometry.panelRight} > ${geometry.viewportWidth})`,
  );
  assert.ok(
    geometry.docWidth <= geometry.viewportWidth + 1,
    `desk: the window must not scroll horizontally (${geometry.docWidth} > ${geometry.viewportWidth})`,
  );

  assert.deepEqual(errors, [], `desk: the renderer logged errors — ${JSON.stringify(errors)}`);
  log(`ALL CHECKS PASSED — 4 frames in ${OUT}/`);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}
