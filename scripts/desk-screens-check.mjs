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
import { assertPinnedAfterZoomedExpandedTurn, hostMsg } from "./desk-stick-to-bottom.mjs";

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

  const zoomFactor = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? win.webContents.getZoomFactor() : null;
  });
  assert.ok(
    typeof zoomFactor === "number" && Math.abs(zoomFactor - 1) < 0.001,
    `desk: Chromium zoomFactor must stay 1 (got ${zoomFactor})`,
  );
  const bootLayout = await page.evaluate(() => ({
    top: document.documentElement.scrollTop,
    left: document.documentElement.scrollLeft,
  }));
  assert.equal(bootLayout.top, 0, `desk: documentElement.scrollTop must stay 0 after boot (got ${bootLayout.top})`);
  assert.equal(bootLayout.left, 0, `desk: documentElement.scrollLeft must stay 0 after boot (got ${bootLayout.left})`);
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

  const measureStrip = () =>
    page.evaluate(() => {
      const strip = document.querySelector(".gfp-header");
      const tabs = document.querySelector(".gfp-tabs");
      const panel = document.querySelector(".gfp-panel");
      const sr = strip?.getBoundingClientRect();
      const visibleTabs = [...(tabs?.querySelectorAll(".gfp-tab:not([hidden])") || [])];
      const iconOf = (root, sel) => [...(root?.querySelectorAll(sel) || [])].map((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height) };
      });
      const close = document.querySelector(".gfp-tab-active:not([hidden]) .gfp-tab-close");
      const cr = close?.getBoundingClientRect();
      const cs = close ? getComputedStyle(close) : null;
      return {
        state: panel?.dataset.stripState || "",
        titleIcons: iconOf(strip, ".gfp-title-icon img, .gfp-title-icon .gfp-file-icon-mono, .gfp-title-icon svg"),
        tabIcons: visibleTabs.flatMap((tab) => iconOf(tab, ".gfp-tab-icon img, .gfp-tab-icon .gfp-file-icon-mono, .gfp-tab-icon svg")),
        tabCount: visibleTabs.length,
        overflow: strip ? strip.scrollWidth > strip.clientWidth + 1 : true,
        scrollW: strip ? strip.scrollWidth : 0,
        clientW: strip ? strip.clientWidth : 0,
        tabsScroll: tabs ? tabs.scrollWidth > tabs.clientWidth + 1 : true,
        tabsOverflowX: tabs ? getComputedStyle(tabs).overflowX : "",
        closeVisible: !!close && !!cs && cs.display !== "none" && cs.visibility !== "hidden",
        closeLeft: cr ? cr.left : null,
        closeRight: cr ? cr.right : null,
        stripLeft: sr ? sr.left : null,
        stripRight: sr ? sr.right : null,
        chip: !!document.querySelector(".gfp-overflow-chip"),
      };
    });

  const assertStripGeometry = async (where, opts = {}) => {
    const strip = await measureStrip();
    assert.ok(strip.titleIcons.length >= 1, `${where}: title strip must paint a folder icon — ${JSON.stringify(strip)}`);
    if (strip.tabCount > 0) {
      assert.equal(strip.tabIcons.length, strip.tabCount, `${where}: every rendered tab must have an icon — ${JSON.stringify(strip)}`);
    }
    const blank = [...strip.titleIcons, ...strip.tabIcons].filter((icon) => icon.w < 6 || icon.h < 6);
    assert.deepEqual(blank, [], `${where}: title-strip icons rendered with no size — ${JSON.stringify(strip)}`);
    assert.equal(strip.overflow, false, `${where}: title strip overflowed horizontally (${strip.scrollW} > ${strip.clientW})`);
    assert.ok(strip.scrollW <= strip.clientW + 1, `${where}: strip scrollWidth ${strip.scrollW} > clientWidth ${strip.clientW}`);
    assert.equal(strip.tabsScroll, false, `${where}: tab row scrolled (${strip.tabsOverflowX})`);
    assert.ok(
      strip.tabsOverflowX !== "auto" && strip.tabsOverflowX !== "scroll",
      `${where}: .gfp-tabs must not scroll (overflow-x ${strip.tabsOverflowX})`,
    );
    if (strip.closeVisible) {
      assert.ok(
        strip.closeLeft >= strip.stripLeft - 1 && strip.closeRight <= strip.stripRight + 1,
        `${where}: active tab X is clipped by the strip — ${JSON.stringify(strip)}`,
      );
    }
    if (opts.expectChip) {
      assert.equal(strip.chip, true, `${where}: expected the overflow chip — ${JSON.stringify(strip)}`);
    }
    return strip;
  };

  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll(".gfp-header img")];
    return imgs.length > 0 && imgs.every((img) => img.complete);
  }, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(200);
  await assertStripGeometry("desk 1440 title strip");

  const beforeMax = await page.evaluate(() => {
    const panel = document.querySelector(".gfp-panel");
    const chat = document.querySelector(".desk-ft-chat");
    return {
      panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      chatVisible: !!chat && getComputedStyle(chat).display !== "none",
      stored: localStorage.getItem("desk-ft-width"),
    };
  });
  assert.ok(beforeMax.panelW >= 200, `desk: panel has no width before maximize (${beforeMax.panelW})`);
  const maximizeBtn = page.locator("#desk-ft-maximize");
  assert.ok(await maximizeBtn.isVisible().catch(() => false), "desk: maximize control must be visible on the desktop panel");
  await maximizeBtn.click();
  await page.waitForFunction(() => document.body.classList.contains("desk-ft-maximized"), { timeout: 5000 });
  await page.waitForTimeout(250);
  await shot("desk-3b-maximized");
  await assertNoBlankIcons("desk maximized");
  const maximized = await page.evaluate(() => {
    const panel = document.querySelector(".gfp-panel");
    const chat = document.querySelector(".desk-ft-chat");
    const shell = document.getElementById("desk-ft-shell");
    const pr = panel?.getBoundingClientRect();
    const sr = shell?.getBoundingClientRect();
    const chatCs = chat ? getComputedStyle(chat) : null;
    return {
      panelW: pr ? Math.round(pr.width) : 0,
      shellW: sr ? Math.round(sr.width) : 0,
      chatDisplay: chatCs?.display || "missing",
      stored: localStorage.getItem("desk-ft-width"),
    };
  });
  assert.equal(maximized.chatDisplay, "none", `desk: chat must hide while the panel is maximized — ${JSON.stringify(maximized)}`);
  assert.ok(
    maximized.panelW >= maximized.shellW - 20 && maximized.panelW <= maximized.shellW + 4,
    `desk: maximized panel must fill the content area (panel ${maximized.panelW} vs shell ${maximized.shellW})`,
  );
  assert.equal(
    maximized.stored,
    beforeMax.stored,
    `desk: maximize must not persist a width (stored ${maximized.stored}, was ${beforeMax.stored})`,
  );
  await assertStripGeometry("desk maximized title strip");
  await maximizeBtn.click();
  await page.waitForFunction(() => !document.body.classList.contains("desk-ft-maximized"), { timeout: 5000 });
  await page.waitForTimeout(250);
  const restored = await page.evaluate(() => {
    const panel = document.querySelector(".gfp-panel");
    const chat = document.querySelector(".desk-ft-chat");
    return {
      panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      chatVisible: !!chat && getComputedStyle(chat).display !== "none",
    };
  });
  assert.equal(restored.chatVisible, true, "desk: chat must return after restore");
  assert.ok(
    Math.abs(restored.panelW - beforeMax.panelW) <= 8,
    `desk: restore must return the prior split width (was ${beforeMax.panelW}, now ${restored.panelW})`,
  );
  await shot("desk-3c-restored");

  // Three-state strip: open several files, then walk widths until A/B/C each
  // appear. The old scroll model hid later tabs; this is the replacement.
  const showTree = async () => {
    if (await page.locator(".gfp-viewer:not([hidden])").isVisible().catch(() => false)) {
      await page.locator("#desk-ft-title").click();
      await page.waitForSelector(".gfp-tree:not([hidden])", { timeout: 10000 });
      await page.waitForTimeout(150);
    }
  };
  const openTreeRow = async (label) => {
    await showTree();
    await page.locator(".gfp-row", { hasText: label }).first().click();
    await page.waitForTimeout(200);
  };
  const setPanelWidth = async (px) => {
    await page.evaluate((w) => {
      const panel = document.querySelector(".gfp-panel");
      if (panel) panel.style.setProperty("--gfp-width", `${w}px`);
    }, px);
    await page.waitForTimeout(280);
  };
  await openTreeRow("package.json");
  await openTreeRow("src");
  await openTreeRow("index.ts");
  await openTreeRow("util.ts");
  await openTreeRow("docs");
  await openTreeRow("notes.md");
  const openTabCount = await page.evaluate(() => document.querySelectorAll(".gfp-tab").length);
  assert.ok(openTabCount >= 3, `desk: need 3+ open files to reach B/C (got ${openTabCount})`);

  const seenStates = new Set();
  const recordState = async (name) => {
    const strip = await assertStripGeometry(name);
    seenStates.add(strip.state);
    await shot(name);
    return strip;
  };

  await maximizeBtn.click();
  await page.waitForFunction(() => document.body.classList.contains("desk-ft-maximized"), { timeout: 5000 });
  await page.waitForTimeout(250);
  await recordState("desk-strip-a");
  await maximizeBtn.click();
  await page.waitForFunction(() => !document.body.classList.contains("desk-ft-maximized"), { timeout: 5000 });
  await page.waitForTimeout(250);

  let stateC = null;
  for (const width of [400, 320, 280, 240, 220, 200]) {
    await setPanelWidth(width);
    const strip = await assertStripGeometry(`desk strip @${width}`);
    if (strip.state && !seenStates.has(strip.state)) {
      seenStates.add(strip.state);
      await shot(`desk-strip-${strip.state}`);
    }
    if (strip.state === "c") stateC = strip;
    if (seenStates.has("b") && seenStates.has("c")) break;
  }
  assert.ok(seenStates.has("a"), `desk: never reached strip state A — saw ${[...seenStates]}`);
  assert.ok(seenStates.has("b"), `desk: never reached strip state B — saw ${[...seenStates]}`);
  assert.ok(seenStates.has("c"), `desk: never reached strip state C — saw ${[...seenStates]}`);
  assert.equal(stateC?.chip, true, `desk: state C must show the overflow chip — ${JSON.stringify(stateC)}`);

  await page.locator(".gfp-overflow-chip").click();
  await page.waitForSelector(".gfp-overflow-menu", { timeout: 5000 });
  const overflowMenu = await page.evaluate(() => {
    const menu = document.querySelector(".gfp-overflow-menu");
    const rows = [...(menu?.querySelectorAll(".gfp-overflow-item") || [])].map((row) => ({
      name: row.querySelector(".gfp-overflow-name")?.textContent || "",
      icon: !!row.querySelector(".gfp-tab-icon img, .gfp-tab-icon .gfp-file-icon-mono, .gfp-tab-icon svg"),
      dirty: !!row.querySelector(".gfp-overflow-dirty"),
    }));
    return { open: !!menu, rows };
  });
  assert.equal(overflowMenu.open, true, "desk: overflow chip must open a dropdown");
  assert.ok(overflowMenu.rows.length >= 2, `desk: overflow menu should list the other files — ${JSON.stringify(overflowMenu)}`);
  assert.ok(
    overflowMenu.rows.every((row) => row.icon && row.name),
    `desk: every overflow row needs an icon and a name — ${JSON.stringify(overflowMenu)}`,
  );
  await shot("desk-strip-c-menu");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".gfp-overflow-menu"), { timeout: 5000 });
  await setPanelWidth(280);

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.waitForTimeout(300);
  await assertStripGeometry("desk 1024 title strip");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

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

  // View-all overlay: a long command must open INSIDE the main window with
  // highlighted tokens (not a second BrowserWindow of bare monospace).
  {
    const windowsBefore = app.windows().length;
    const longCmd = [
      "function Get-Status {",
      '  Write-Output "probe"',
      "  Get-ChildItem -Path C:\\work",
      "  if ($true) { return }",
      "}",
      'Write-Output "line 6"',
      'Write-Output "line 7"',
      'Write-Output "line 8"',
    ].join("\n");
    await hostMsg(page, { type: "appPurpose", value: "coding" });
    await hostMsg(page, { type: "expandCommandOutputs", value: true });
    await hostMsg(page, {
      type: "toolCall",
      call: {
        toolCallId: "desk-preview-cmd",
        kind: "execute",
        title: "Run Get-Status",
        rawInput: { variant: "Bash", command: longCmd, is_background: false },
      },
    });
    await hostMsg(page, { type: "messageChunk", text: "done" });
    await hostMsg(page, {
      type: "commandOutput",
      command: longCmd,
      output: "ok\n".repeat(8),
      exitCode: 0,
      truncated: false,
    });
    await page.waitForSelector(".command-view-all", { timeout: 15000 });
    await page.locator(".command-view-all").first().click();
    await page.waitForSelector("#preview-overlay", { timeout: 15000 });
    await page.waitForTimeout(300);
    await shot("desk-6-preview-overlay");
    assert.equal(
      app.windows().length,
      windowsBefore,
      "desk: View all must not open a new BrowserWindow",
    );
    const overlay = await page.evaluate(() => {
      const el = document.getElementById("preview-overlay");
      const token = el?.querySelector(".hl-kw, .hl-str, .hl-fn");
      const r = el?.getBoundingClientRect();
      const tr = token?.getBoundingClientRect();
      const cs = token ? getComputedStyle(token) : null;
      return {
        inside: !!el && el.getRootNode() === document,
        title: el?.querySelector(".preview-title")?.textContent || "",
        tokenTag: token?.tagName || "",
        tokenClass: token?.className || "",
        tokenColor: cs?.color || "",
        tokenW: tr ? Math.round(tr.width) : 0,
        tokenH: tr ? Math.round(tr.height) : 0,
        left: r ? Math.round(r.left) : null,
        right: r ? Math.round(r.right) : null,
        viewport: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
      };
    });
    assert.equal(overlay.inside, true, "desk: overlay must live in the main document");
    assert.ok(overlay.tokenTag, `desk: overlay has no highlighted token — ${JSON.stringify(overlay)}`);
    assert.ok(
      overlay.tokenW >= 4 && overlay.tokenH >= 6,
      `desk: highlighted token is unstyled/0x0 — ${JSON.stringify(overlay)}`,
    );
    assert.ok(
      overlay.tokenColor && overlay.tokenColor !== "rgba(0, 0, 0, 0)",
      `desk: highlighted token has no color — ${JSON.stringify(overlay)}`,
    );
    assert.ok(
      overlay.left >= 0 && overlay.right <= overlay.viewport + 1,
      `desk: overlay must stay inside the main window (${overlay.left}–${overlay.right} vs ${overlay.viewport})`,
    );
    assert.ok(
      overlay.pageWidth <= overlay.viewport + 1,
      `desk: View all must not make the page scroll horizontally (${overlay.pageWidth} > ${overlay.viewport})`,
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("preview-overlay"), { timeout: 5000 });
    log("preview overlay opened inside the main window with highlighted tokens");
  }

  // #92 — zoomed sidebar + expanded tool details + permission resolve.
  // After the visual frames so a rail collapse / resize cannot invalidate them.
  await assertPinnedAfterZoomedExpandedTurn(page, {
    log: (m) => log(m),
    shot: async (name) => {
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      log(`captured ${name}.png`);
    },
  });

  log(`ALL CHECKS PASSED — frames in ${OUT}/`);
} finally {
  await app.close().catch(() => {});
  qa.cleanup();
  fs.rmSync(userData, { recursive: true, force: true });
}
