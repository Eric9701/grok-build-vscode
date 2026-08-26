// The unauthenticated GitHub clone, end to end, against the real app.
//
// WHY THIS EXISTS. You cannot test this path by signing out of `gh`. On Windows
// — and on any machine where git authenticates through a credential helper —
// `gh auth logout` changes nothing, because git never asks gh: it asks the
// helper, which has its own stored token. The owner tried exactly that on
// 2026-08-26, cloned a private repo successfully, and reasonably asked why.
//
// So this launches the real desktop app with git's credential helper cleared
// FOR THAT PROCESS ONLY — GIT_CONFIG_COUNT/KEY/VALUE override config without
// touching a single file — and drives the real Add project -> Clone from GitHub
// flow. Git really fails, the host really classifies it, and the screenshot is
// what someone who has never signed in actually sees.
//
// Any private OR nonexistent GitHub URL produces the same failure, because git
// must authenticate before it can learn which one it is. Override the target
// with GH_UNAUTH_REPO.
//
// Run: npm run e2e:gh-unauth   (frames land in .screens/, gitignored)
import { _electron as electron } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const root = "C:/GitHub/grok-build-vscode";
const OUT = path.join(root, ".screens");
const log = (m) => console.log(`[gh-unauth] ${m}`);
// A private repository of the owner's. Any private or nonexistent GitHub URL
// behaves identically here: credentials are demanded before existence is known.
const REPO = process.env.GH_UNAUTH_REPO || "https://github.com/phuryn/client-connect.git";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-unauth-"));
const fixtureCli = path.join(root, "test", "fixtures", "fake-grok-acp.cmd");
fs.writeFileSync(path.join(tmp, "test-config.json"), JSON.stringify({ "grok.cliPath": fixtureCli }), "utf8");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// The whole point. `credential.helper=` with an empty value CLEARS the list, so
// git has no way to obtain a username — precisely the state of a machine where
// nobody has ever authenticated. Process-scoped: nothing on disk changes.
env.GIT_CONFIG_COUNT = "1";
env.GIT_CONFIG_KEY_0 = "credential.helper";
env.GIT_CONFIG_VALUE_0 = "";
// And make sure a stray gh token cannot stand in either.
env.GH_TOKEN = "";
env.GITHUB_TOKEN = "";

const electronExe = createRequire(path.join(root, "x.js"))("electron");
const app = await electron.launch({
  executablePath: electronExe,
  args: [
    path.join(root, "out", "desktop", "main.js"),
    `--user-data-dir=${path.join(tmp, "udata")}`,
    `--config-json=${path.join(tmp, "test-config.json")}`,
    `--workspace=${root}`,
  ],
  env,
  timeout: 60000,
});

try {
  const page = await app.firstWindow({ timeout: 60000 });
  await page.setViewportSize({ width: 1100, height: 820 });
  await page.waitForSelector("#input", { timeout: 45000 });
  await page.waitForTimeout(1500);

  // Coding mode, so Clone from GitHub is on the menu.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
    data: { type: "appPurpose", value: "coding" },
  })));
  await page.waitForTimeout(300);

  // Dispatch rather than page.click: the rail rebuilds on every catalog frame
  // and detaches the button mid-click.
  await page.evaluate(() => {
    document.querySelector(".rail-add-project")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector(".rail-menu", { timeout: 8000 });
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".rail-menu-item")];
    const row = rows.find((r) => (r.querySelector(".rail-menu-label")?.textContent || "").includes("Clone"));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForSelector(".add-project-form", { timeout: 8000 });

  // A real private repository. Nothing can read it without credentials.
  await page.fill(".add-project-input", REPO);
  await page.screenshot({ path: path.join(OUT, "gh-unauth-1-before.png") });
  log("captured gh-unauth-1-before.png");

  await page.evaluate(() => {
    document.querySelector(".add-project-primary")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  log("cloning for real, with no credentials available…");
  // Poll with evaluate rather than waitForFunction: the webview's CSP has no
  // 'unsafe-eval', which is what waitForFunction needs.
  for (let i = 0; i < 240; i++) {
    const ready = await page.evaluate(() => {
      const e = document.querySelector(".add-project-error");
      return !!(e && !e.hidden && e.textContent.trim().length > 0);
    });
    if (ready) break;
    await page.waitForTimeout(500);
  }

  const shown = await page.evaluate(() => {
    const fix = document.querySelector(".add-project-fix");
    return {
      error: document.querySelector(".add-project-error").textContent.trim(),
      fix: fix && !fix.hidden ? fix.textContent.trim() : null,
      formStillOpen: !!document.querySelector(".add-project-form"),
      inputKept: document.querySelector(".add-project-input")?.value || "",
      submitLabel: document.querySelector(".add-project-primary")?.textContent.trim(),
    };
  });
  log("WHAT THE USER SEES: " + JSON.stringify(shown, null, 2));
  assert.match(
    shown.error,
    /couldn't authenticate|wasn't found/,
    `the failure must be reported in words a person can act on — ${JSON.stringify(shown)}`,
  );
  assert.ok(shown.formStillOpen, "a failed clone must keep the form open");
  assert.equal(shown.inputKept, REPO, "the URL must survive the failure, so a retry is one click");
  assert.ok(
    shown.fix === "Sign in to GitHub" || /Install the GitHub CLI/.test(shown.fix || ""),
    `a credential failure must offer a next step — ${JSON.stringify(shown)}`,
  );
  await page.screenshot({ path: path.join(OUT, "gh-unauth-2-failure.png") });
  log("captured gh-unauth-2-failure.png");
  log("ALL CHECKS PASSED — frames in .screens/");
} finally {
  await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
