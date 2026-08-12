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
import { buildQaFixture } from "./qa-fixture.mjs";

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

// The shared grok-qa fixture: a fixed project AND a fixed session store, so the
// rail has real history in it and the frames are comparable between runs.
const qa = buildQaFixture();
const workspace = qa.project;
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

// GROK_HOME is the supported override for the session store (`resolveGrokHome`),
// so the app reads the fixture's history instead of this machine's.
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
  // Proves the host actually READ the fixture store. Without this the check
  // passes just as happily against an empty rail, which is exactly what a wrong
  // session-directory encoding produces — silently.
  const railTitles = await page.evaluate(
    () => [...document.querySelectorAll(".rail-session .rail-session-name, .rail-session")]
      .map((n) => (n.textContent || "").trim()).filter(Boolean),
  );
  // The rail previews only the newest few per project, so this asserts ORDER
  // rather than presence of all four: whichever fixture conversations are shown
  // must be the newest ones, newest first. That is the property worth pinning —
  // ordering by transcript mtime is what a merely-opened session used to break.
  const shown = [];
  for (const text of railTitles) {
    const hit = qa.expectedOrder.find((t) => text.startsWith(t));
    if (hit && !shown.includes(hit)) shown.push(hit);
  }
  assert.ok(shown.length >= 2, `desk: the rail showed no fixture history — saw ${JSON.stringify(railTitles.slice(0, 8))}`);
  assert.deepEqual(
    shown,
    qa.expectedOrder.slice(0, shown.length),
    "desk: the rail must list the fixture conversations newest first",
  );
  log(`rail shows ${shown.length} fixture conversations, newest first`);

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

  // RENAME MUST NOT RESIZE THE BAR. Clicking the conversation name swaps a
  // label for an input, and if the two boxes measure differently the whole row
  // moves and the separator under it follows. This is measurable only with a
  // layout engine, which is why it went unnoticed: happy-dom reports zeros for
  // both boxes and agrees they match.
  //
  // Verified sensitive by mutation: giving `.session-name-input` 9px of vertical
  // padding instead of 3px moves the bar 35→42 and the chip 30→38 and fails
  // here. Note the fixture opens a conversation with no project line, so
  // `repoTop` is 0 in both samples — it is carried for the day the chip's second
  // row is populated (a height pinned on the wrong box would hold the bar steady
  // while shoving that line around), and proves nothing on its own today.
  const renameBoxes = () =>
    page.evaluate(() => {
      const bar = document.querySelector("#desk-ft-top-toggle")?.closest("header, .top-bar");
      const chip = document.querySelector(".session-name-chip");
      const repo = document.querySelector(".session-name-repo");
      const px = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
      return { bar: px(bar), chip: px(chip), repoTop: repo ? Math.round(repo.getBoundingClientRect().top) : null };
    });

  const nameLabel = page.locator(".session-name-label").first();
  assert.ok(
    await nameLabel.isVisible().catch(() => false),
    "desk: no conversation name to rename — the check cannot be skipped silently, so this is a failure",
  );
  const beforeRename = await renameBoxes();
  // Every member of that object degrades to null when its selector misses, and
  // `{bar:null, chip:null}` compares equal to itself — so a renamed selector
  // would leave this gate printing ALL CHECKS PASSED while measuring nothing.
  // Prove there are real heights before the comparison can mean anything.
  for (const key of ["bar", "chip"]) {
    assert.ok(
      typeof beforeRename[key] === "number" && beforeRename[key] > 0,
      `desk: rename gate measured nothing for '${key}' (selector renamed?) — ${JSON.stringify(beforeRename)}`,
    );
  }
  await nameLabel.click();
  await page.waitForSelector(".session-name-input", { timeout: 15000 });
  await page.waitForTimeout(250);
  const duringRename = await renameBoxes();
  await shot("desk-5-rename");
  await assertNoBlankIcons("desk renaming");
  assert.deepEqual(
    duringRename,
    beforeRename,
    `desk: renaming must not resize the top bar — before ${JSON.stringify(beforeRename)}, during ${JSON.stringify(duringRename)}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  assert.deepEqual(
    await renameBoxes(),
    beforeRename,
    "desk: leaving rename must restore the bar's geometry",
  );

  assert.deepEqual(errors, [], `desk: the renderer logged errors — ${JSON.stringify(errors)}`);
  log(`ALL CHECKS PASSED — 5 frames in ${OUT}/`);
} finally {
  await app.close().catch(() => {});
  qa.cleanup();
  fs.rmSync(userData, { recursive: true, force: true });
}
