// Screens check for the IDE webview's Read rows (#122) — real Chromium layout,
// screenshots left behind for a person to look at.
//
// WHY A THIRD HARNESS. `e2e:screens` here drives the DESKTOP app and the relay's
// drives the BROWSER client — and the linked Read row is deliberately OFF on
// both (the desktop cannot open a file at a line; a remote cannot send openFile
// at all). Neither existing harness can photograph the thing this change does,
// so this one boots the same shipped media/ scripts in the IDE configuration:
// no window.grokRemoteClient, no previewInApp capability.
//
// happy-dom proves the DOM; this proves it has a size and a colour.
// Run: npm run e2e:read-link   (frames land in .screens/, gitignored)
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const OUT = process.env.SCREENS_DIR || ".screens";
const media = path.join(root, "media");
const log = (m) => console.log(`[read-link] ${m}`);

// Both borrowed rather than copied, so neither can drift from what ships:
// the body skeleton the DOM tests already mirror getHtml() with, and the
// desktop shell's own VS Code dark palette.
const harness = fs.readFileSync(path.join(root, "test", "webview-harness.ts"), "utf8");
const BODY = harness.match(/export const BODY = `([\s\S]*?)`;/)[1];
const shell = fs.readFileSync(path.join(root, "src", "desktop", "electron-webview.ts"), "utf8");
const PALETTE = shell.match(/:root \{[\s\S]*?\n\}/)[0];

fs.mkdirSync(OUT, { recursive: true });
// Inside the repo, not os.tmpdir(): the scaffold's main.js does
// require("electron"), which only resolves from a path under this node_modules.
const tmp = fs.mkdtempSync(path.join(root, OUT, "run-"));
const page = path.join(tmp, "chat.html");
fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(media, "chat.css")}">
<style>${PALETTE}
body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground);
       font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }</style>
</head><body>
<script>
  const __posted = [];
  window.__posted = __posted;
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => __posted.push(m), setState: () => {}, getState: () => undefined,
  });
</script>
${BODY}
<script src="${path.join(media, "webview-helpers.js")}"></script>
<script src="${path.join(media, "settings.js")}"></script>
<script src="${path.join(media, "file-panel.js")}"></script>
<script src="${path.join(media, "chat.js")}"></script>
</body></html>`);

const mainJs = path.join(tmp, "main.js");
fs.writeFileSync(mainJs, `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 900, height: 720, show: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false } });
  w.loadFile(${JSON.stringify(page)});
});
app.on("window-all-closed", () => app.quit());
`);

const readCall = (id, file, offset, limit) => ({
  type: "toolCall",
  call: { toolCallId: id, kind: "read", title: "read_file",
          rawInput: { target_file: file, offset, limit } },
});
const readDone = (id, lines) => ({
  type: "toolCallUpdate",
  call: { toolCallId: id, status: "completed",
          content: [{ type: "content", content: { type: "text", text: lines } }] },
});
const body = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1} of the file`).join("\n");

// Resolve the binary through the package rather than guessing a path: on macOS
// it lives inside Electron.app, not at dist/electron.
const electronExe = createRequire(path.join(root, "x.js"))("electron");
// ELECTRON_RUN_AS_NODE=1 is set inside a VS Code extension host, and a session
// driving this from there inherits it — Electron then runs as plain Node, never
// opens a window, and Playwright reports only "Process failed to launch!".
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const el = await electron.launch({
  executablePath: electronExe,
  args: [mainJs, `--user-data-dir=${path.join(tmp, "udata")}`],
  env,
  timeout: 60000,
});
const win = await el.firstWindow();
await win.waitForSelector("#messages");

const send = (msg) => win.evaluate((m) => {
  window.dispatchEvent(new MessageEvent("message", { data: m }));
}, msg);

await send({ type: "initialState", effort: "", cwd: "/w", useCtrlEnter: false,
             extVersion: "3.14.1", showThinking: false, expandCommandOutputs: true,
             appPurpose: "coding" });
await send({ type: "userMessage", text: "read the three files and tell me what they do" });

// The batch padixa described: several reads in one group.
await send(readCall("a", "src/extension.ts", 1, 150));
await send(readCall("b", "src/sidebar.ts", 20, 31));
await send(readCall("c", "media/chat.js", 8400, 60));
await win.waitForTimeout(150);

// MID-RUN. The group must already be open — this is the frame his 15:55 report
// says never existed, because the group used to settle only at close.
const midOpen = await win.evaluate(() =>
  !document.querySelector(".tool-group-body").hidden);
await win.screenshot({ path: path.join(OUT, "read-link-1-midrun.png") });
assert.ok(midOpen, "the read group must be expanded WHILE it runs (#122)");

await send(readDone("a", body(150)));
await send(readDone("b", body(31)));
await send(readDone("c", body(60)));
await send({ type: "messageChunk", text: "All three read." });
await win.waitForTimeout(200);
await win.screenshot({ path: path.join(OUT, "read-link-2-done.png") });

// A command row in the same transcript: the old behaviour must survive intact.
await send({ type: "toolCall", call: { toolCallId: "x1", kind: "execute",
  title: "Run npm test", rawInput: { variant: "Bash", command: "npm test", is_background: false } } });
await send({ type: "commandOutput", command: "npm test",
  output: Array.from({ length: 14 }, (_, i) => `  ok ${i + 1} - passing assertion`).join("\n"),
  exitCode: 0, truncated: false, cancelled: false });
await send({ type: "messageChunk", text: "Suite is green." });
await win.waitForTimeout(200);
await win.screenshot({ path: path.join(OUT, "read-link-3-with-command.png") });

// What the frames must show, asserted so a green run means something.
const seen = await win.evaluate(() => ({
  links: [...document.querySelectorAll(".tool-label-ref")].map((e) => e.textContent),
  linkBoxes: [...document.querySelectorAll(".tool-label-ref")]
    .map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }),
  visibleExcerpts: [...document.querySelectorAll(".tool-cmd-output")]
    .filter((e) => e.getBoundingClientRect().height > 0).length,
  commandViewAll: document.querySelectorAll(".command-view-all").length,
  bodyScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
}));
log(JSON.stringify(seen));

// Basenames: prettyPath renders the leaf, which is pre-existing and is the
// shape padixa asked for. The link's own title carries the full path.
assert.deepEqual(seen.links,
  ["extension.ts lines 1-150", "sidebar.ts lines 20-50", "chat.js lines 8400-8459"],
  "each Read row's path + range is the link");
for (const b of seen.linkBoxes) {
  assert.ok(b.w > 40 && b.h > 6, `a link rendered with no size: ${JSON.stringify(b)} — the 0x0 class of bug`);
}
assert.equal(seen.commandViewAll, 1, "the COMMAND row keeps its View all — old behaviour intact");
// The one visible excerpt is the command's. No Read row spends space on one.
assert.equal(seen.visibleExcerpts, 1, "only the command row shows an excerpt");
assert.ok(!seen.bodyScrollsSideways, "the transcript must not scroll sideways");

// Clicking the link asks the host for the FILE at those lines, nothing else.
await win.evaluate(() => document.querySelectorAll(".tool-label-ref")[2].click());
const posted = await win.evaluate(() => window.__posted.filter((m) => m.type === "openFile"));
assert.deepEqual(posted, [{ type: "openFile", path: "media/chat.js#L8400-L8459" }],
  "the link opens the real file at its lines");

log(`frames in ${OUT}/`);
await el.close();
fs.rmSync(tmp, { recursive: true, force: true });
log("PASS");
