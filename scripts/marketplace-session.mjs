// Opens the VS Code Marketplace publisher page in a PERSISTENT browser profile,
// so signing in once is remembered for every later publish.
//
// The profile lives outside every repository on purpose: once signed in it
// holds an authenticated Microsoft session, which is a credential in all but
// name. Nothing here reads, stores or transmits a password — the window is
// yours, you type into it, and this only decides where the profile lives.
//
// Run: npm run marketplace:login
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MANAGE_URL = "https://marketplace.visualstudio.com/manage";

export function profileDir(env = process.env, platform = process.platform) {
  const base = platform === "win32"
    ? env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : path.join(os.homedir(), ".local", "share");
  return path.join(base, "GrokBuildRelease", "marketplace-profile");
}

const dir = profileDir();
fs.mkdirSync(dir, { recursive: true });
console.log(`[marketplace] profile: ${dir}`);
console.log("[marketplace] this holds a signed-in Microsoft session — never copy it into a repo.\n");

const context = await chromium.launchPersistentContext(dir, {
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});
const page = context.pages()[0] || (await context.newPage());
await page.goto(MANAGE_URL, { waitUntil: "domcontentloaded" });

console.log("[marketplace] Sign in in the window that opened, wait for your extension list,");
console.log("[marketplace] then close the window. The session is saved.\n");

await new Promise((resolve) => {
  context.on("close", resolve);
  page.on("close", () => setTimeout(() => context.close().then(resolve, resolve), 250));
});
console.log("[marketplace] window closed, session saved.");
