// Opens the VS Code Marketplace publisher page in a PERSISTENT browser profile,
// so signing in once is remembered for later runs.
//
// The profile lives outside every repository on purpose: once you sign in it
// holds an authenticated Microsoft session, which is a credential in all but
// name. Nothing here reads, stores or transmits a password — the browser window
// is yours, you type into it, and this script only decides where the profile
// directory lives and when the window closes.
//
// Run: npm run marketplace:login
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MANAGE_URL = "https://marketplace.visualstudio.com/manage";

/** Durable, per-user, and deliberately not inside a repo or a temp directory. */
export function profileDir(env = process.env, platform = process.platform) {
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
      : path.join(os.homedir(), ".local", "share");
  return path.join(base, "GrokBuildRelease", "marketplace-profile");
}

const dir = profileDir();
fs.mkdirSync(dir, { recursive: true });
console.log(`[marketplace] profile: ${dir}`);
console.log("[marketplace] this directory will hold a signed-in Microsoft session.");
console.log("[marketplace] it is outside every repo — never copy it into one.\n");

const context = await chromium.launchPersistentContext(dir, {
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(MANAGE_URL, { waitUntil: "domcontentloaded" });

console.log("[marketplace] Sign in in the window that just opened.");
console.log("[marketplace] Leave it open until you see your publisher's extension list,");
console.log("[marketplace] then close the window — the session is saved.\n");

// Report what we can see, without touching anything, until the window closes.
let lastState = "";
const tick = setInterval(async () => {
  if (page.isClosed()) return;
  try {
    const state = await page.evaluate(() => {
      const url = location.href;
      const signedIn = !!document.querySelector('[role="grid"], .publisher-table, table');
      return `${signedIn ? "publisher page visible" : "not signed in yet"} — ${url.slice(0, 70)}`;
    });
    if (state !== lastState) {
      lastState = state;
      console.log(`[marketplace] ${state}`);
    }
  } catch {
    /* navigating */
  }
}, 3000);

await new Promise((resolve) => {
  context.on("close", resolve);
  page.on("close", () => setTimeout(() => context.close().then(resolve, resolve), 250));
});
clearInterval(tick);
console.log("\n[marketplace] window closed. Session saved to the profile above.");
