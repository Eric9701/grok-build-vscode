import { _electron as electron } from "playwright";
import * as path from "node:path"; import * as fs from "node:fs";

const root = process.cwd();
const out = path.join(root, ".tmp-shots");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Real profile: the owner's actual projects and session history.
const app = await electron.launch({
  args: [path.join(root, "out", "desktop", "main.js")],
  env,
});
const page = await app.firstWindow();
await page.waitForSelector("#input", { timeout: 60000 });
await page.setViewportSize({ width: 1500, height: 950 });
await page.waitForTimeout(6000);

const shot = async (n) => { await page.screenshot({ path: path.join(out, n) }); console.log("shot", n); };
await shot("01-app.png");

await page.click("#input");
await page.fill("#input", "analyze this solution");
await page.keyboard.press("Enter");
// Real agent: give it room to explore and answer.
await page.waitForTimeout(90000);
await shot("02-analyze.png");

const t = await page.$("#desk-ft-top-toggle");
if (t) { await t.click(); await page.waitForTimeout(1800); await shot("03-with-tree.png"); }

await app.close();
console.log("DONE");
