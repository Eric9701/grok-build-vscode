/**
 * Desktop e2e: real Electron window + real DOM + fake grok ACP CLI.
 *
 * Asserts:
 *   1. Window opens and chat.js boots without console errors
 *   2. A typed prompt reaches the agent and the streamed reply renders
 *   3. Renderer reload rehydrates the live session (transcript survives)
 *   4. openText / openDiff open a read-only viewer window (visible surface)
 *   5. File-tree panel: list / expand / collapse / open (via open sink)
 *
 * Not covered here: live AFK Pilot relay, real grok binary, multi-window,
 * packaging. Link/unlink + safeStorage + path guard are unit-tested in
 * desktop-host-pure (no live relay).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainJs = path.join(root, "out", "desktop", "main.js");
const electronExe = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

function fixtureCli(): string {
  const dir = path.join(root, "test", "fixtures");
  return process.platform === "win32"
    ? path.join(dir, "fake-grok-acp.cmd")
    : path.join(dir, "fake-grok-acp.sh");
}

function stripElectronRunAsNode(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

describe("desktop Electron app (real window + fake CLI)", () => {
  let app: ElectronApplication;
  let page: Page;
  let workspace: string;
  let userData: string;
  let configJson: string;
  let openSink: string;
  const consoleErrors: string[] = [];

  beforeAll(async () => {
    if (!fs.existsSync(mainJs)) {
      throw new Error(
        `Missing ${mainJs} — run \`npm run compile\` before test:desktop`,
      );
    }
    if (!fs.existsSync(electronExe)) {
      throw new Error(`Missing Electron binary at ${electronExe}`);
    }
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(fixtureCli(), 0o755);
      } catch {
        /* best-effort */
      }
    }

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-desk-ws-"));
    // Known tree for the file-panel assertions.
    fs.writeFileSync(path.join(workspace, "readme.txt"), "desktop e2e readme\n");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "hello.ts"), "export const n = 1;\n");

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-desk-ud-"));
    configJson = path.join(userData, "test-config.json");
    openSink = path.join(userData, "open-sink.txt");
    fs.writeFileSync(
      configJson,
      JSON.stringify({ "grok.cliPath": fixtureCli() }),
      "utf8",
    );

    app = await electron.launch({
      executablePath: electronExe,
      args: [
        mainJs,
        `--workspace=${workspace}`,
        `--user-data-dir=${userData}`,
        `--config-json=${configJson}`,
      ],
      env: {
        ...stripElectronRunAsNode(process.env),
        GROK_DESKTOP_OPEN_SINK: openSink,
      },
      timeout: 60_000,
    });

    page = await app.firstWindow({ timeout: 60_000 });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(String(err));
    });

    // Wait until the composer exists (chat.js booted + HTML applied).
    await page.waitForSelector("#input", { timeout: 45_000 });
    // Session start: welcome "Starting" clears or composer unlocks after agent ready.
    await page.waitForFunction(
      () => {
        const input = document.querySelector("#input") as HTMLTextAreaElement | null;
        const send = document.querySelector("#send-btn") as HTMLButtonElement | null;
        if (!input || !send) return false;
        // Locked startup disables send / shows spinner; ready when not busy-locked.
        const body = document.body;
        return !body.classList.contains("busy-locked") && !input.disabled;
      },
      { timeout: 45_000 },
    ).catch(async () => {
      // Fallback: give the fake CLI a moment; some hosts never set busy-locked.
      await page.waitForTimeout(3000);
    });
  }, 90_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* already dead */
    }
    for (const p of [workspace, userData]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("opens a window and boots chat.js without console errors", async () => {
    expect(page).toBeTruthy();
    const title = await page.title();
    // data: documents often have empty title until set; body must still be the desk.
    const hasComposer = await page.locator("#input").count();
    expect(hasComposer).toBe(1);
    const hasMessages = await page.locator("#messages").count();
    expect(hasMessages).toBe(1);
    // Filter noise from optional extensions (MathJax/mermaid are fine if they warn).
    const fatal = consoleErrors.filter(
      (e) =>
        !/MathJax|mermaid|favicon|DevTools|Autofill|Download the React/i.test(e),
    );
    expect(fatal, `console errors: ${fatal.join("\n")}`).toEqual([]);
    void title;
  });

  it("sends a prompt and renders the streamed agent reply", async () => {
    const prompt = "hello from desktop e2e";
    await page.locator("#input").click();
    await page.locator("#input").fill(prompt);
    // Prefer Enter if send is enabled; click send as primary (matches desktop UX).
    await page.locator("#send-btn").click();

    // User bubble appears.
    await page.waitForFunction(
      (text) => {
        const users = [...document.querySelectorAll(".msg.user")];
        return users.some((el) => (el.textContent || "").includes(text));
      },
      prompt,
      { timeout: 30_000 },
    );

    // Fake CLI default scenario streams agent_message_chunk "ok".
    await page.waitForFunction(
      () => {
        const agents = [...document.querySelectorAll(".msg.agent, .msg.assistant, .message.agent")];
        // chat.js may use .msg with role markers — also accept any non-user bubble with "ok"
        const all = [...document.querySelectorAll("#messages .msg")];
        return all.some((el) => {
          if (el.classList.contains("user")) return false;
          const t = (el.textContent || "").trim();
          return t === "ok" || t.includes("ok");
        }) || agents.some((el) => (el.textContent || "").includes("ok"));
      },
      { timeout: 30_000 },
    );

    const transcript = await page.locator("#messages").innerText();
    expect(transcript).toContain(prompt);
    expect(transcript).toMatch(/\bok\b/);
  });

  it("survives a renderer reload without losing the session transcript", async () => {
    // Ensure prior conversation is still present before reload.
    const before = await page.locator("#messages").innerText();
    expect(before).toContain("hello from desktop e2e");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("#input", { timeout: 45_000 });

    // Rehydrate replays the buffer — user + agent text should return.
    await page.waitForFunction(
      () => {
        const text = document.querySelector("#messages")?.textContent || "";
        return text.includes("hello from desktop e2e");
      },
      { timeout: 45_000 },
    );

    const after = await page.locator("#messages").innerText();
    expect(after).toContain("hello from desktop e2e");
    // Agent reply from the same live session should reappear in the buffer.
    expect(after).toMatch(/\bok\b/);
  });

  it("openText opens a read-only viewer window with the given content", async () => {
    const marker = `desktop-openText-${Date.now()}`;
    const windowPromise = app.waitForEvent("window", { timeout: 15_000 });
    await page.evaluate((text) => {
      // Same path chat.js uses for "View all" command output.
      (window as unknown as { acquireVsCodeApi: () => { postMessage: (m: unknown) => void } })
        .acquireVsCodeApi()
        .postMessage({ type: "openText", content: text, language: "plaintext" });
    }, marker);
    const viewer = await windowPromise;
    await viewer.waitForLoadState("domcontentloaded");
    await viewer.waitForFunction(
      (t) => (document.body?.innerText || "").includes(t),
      marker,
      { timeout: 10_000 },
    );
    const body = await viewer.locator("body").innerText();
    expect(body).toContain(marker);
    expect(body.toLowerCase()).toMatch(/read-only|untitled/);
    await viewer.close();
  });

  it("openDiff opens a side-by-side read-only preview window", async () => {
    const leftMark = `diff-left-${Date.now()}`;
    const rightMark = `diff-right-${Date.now()}`;
    const windowPromise = app.waitForEvent("window", { timeout: 15_000 });
    await page.evaluate(
      ({ oldText, newText }) => {
        (window as unknown as { acquireVsCodeApi: () => { postMessage: (m: unknown) => void } })
          .acquireVsCodeApi()
          .postMessage({
            type: "openDiff",
            path: "src/example.ts",
            oldText,
            newText,
          });
      },
      { oldText: leftMark, newText: rightMark },
    );
    const viewer = await windowPromise;
    await viewer.waitForLoadState("domcontentloaded");
    await viewer.waitForFunction(
      ({ a, b }) => {
        const t = document.body?.innerText || "";
        return t.includes(a) && t.includes(b);
      },
      { a: leftMark, b: rightMark },
      { timeout: 10_000 },
    );
    const body = await viewer.locator("body").innerText();
    expect(body).toContain(leftMark);
    expect(body).toContain(rightMark);
    expect(body.toLowerCase()).toMatch(/read-only|proposed|preview/);
    await viewer.close();
  });

  it("file-tree panel renders the workspace root entries", async () => {
    // Ensure expanded (a prior test may have left localStorage collapsed).
    await page.evaluate(() => {
      try {
        localStorage.setItem("desk-ft-collapsed", "0");
      } catch {
        /* */
      }
    });
    // Re-inject if needed: collapse class is applied at boot from localStorage.
    // Toggle expand if currently collapsed.
    const collapsed = await page.evaluate(() =>
      document.body.classList.contains("desk-ft-collapsed"),
    );
    if (collapsed) {
      await page.locator("#desk-ft-toggle").click();
    }

    await page.waitForSelector("#desk-ft-panel", { timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const body = document.getElementById("desk-ft-body");
        if (!body) return false;
        const text = body.textContent || "";
        return text.includes("readme.txt") && text.includes("src");
      },
      { timeout: 15_000 },
    );
    const treeText = await page.locator("#desk-ft-body").innerText();
    expect(treeText).toContain("readme.txt");
    expect(treeText).toContain("src");
    // Chat chrome still present beside the panel.
    expect(await page.locator("#input").count()).toBe(1);
    expect(await page.locator(".desk-ft-chat #messages").count()).toBe(1);
  });

  it("file-tree expands and collapses a directory", async () => {
    // Ensure panel is expanded.
    if (await page.evaluate(() => document.body.classList.contains("desk-ft-collapsed"))) {
      await page.locator("#desk-ft-toggle").click();
    }
    // Root should list src as a directory node.
    const srcRow = page.locator('.desk-ft-node[data-rel="src"] > .desk-ft-row');
    await srcRow.waitFor({ timeout: 10_000 });
    // Before expand: hello.ts not under src children.
    const before = await page.locator('.desk-ft-node[data-rel="src/hello.ts"]').count();
    expect(before).toBe(0);

    await srcRow.click();
    await page.waitForSelector('.desk-ft-node[data-rel="src/hello.ts"]', {
      timeout: 10_000,
    });
    expect(
      await page.locator('.desk-ft-node[data-rel="src"].desk-ft-open').count(),
    ).toBe(1);

    // Collapse directory.
    await srcRow.click();
    await page.waitForFunction(
      () => !document.querySelector('.desk-ft-node[data-rel="src"].desk-ft-open'),
      { timeout: 5_000 },
    );
    // Children hidden via CSS when not open — node may still exist in DOM.
    const openAfter = await page.locator('.desk-ft-node[data-rel="src"].desk-ft-open').count();
    expect(openAfter).toBe(0);
  });

  it("file-tree panel collapses and restores", async () => {
    await page.waitForSelector("#desk-ft-toggle", { timeout: 10_000 });
    // Start expanded.
    if (await page.evaluate(() => document.body.classList.contains("desk-ft-collapsed"))) {
      await page.locator("#desk-ft-toggle").click();
    }
    expect(
      await page.evaluate(() => document.body.classList.contains("desk-ft-collapsed")),
    ).toBe(false);
    expect(await page.locator("#desk-ft-body").isVisible()).toBe(true);

    await page.locator("#desk-ft-toggle").click();
    await page.waitForFunction(
      () => document.body.classList.contains("desk-ft-collapsed"),
      { timeout: 5_000 },
    );
    // Body/filter hidden when collapsed.
    expect(await page.locator("#desk-ft-body").isVisible()).toBe(false);

    await page.locator("#desk-ft-toggle").click();
    await page.waitForFunction(
      () => !document.body.classList.contains("desk-ft-collapsed"),
      { timeout: 5_000 },
    );
    expect(await page.locator("#desk-ft-body").isVisible()).toBe(true);
  });

  it("clicking a file in the tree triggers the open path", async () => {
    // Clear prior sink lines.
    fs.writeFileSync(openSink, "", "utf8");
    if (await page.evaluate(() => document.body.classList.contains("desk-ft-collapsed"))) {
      await page.locator("#desk-ft-toggle").click();
    }
    const fileRow = page.locator('.desk-ft-node[data-rel="readme.txt"] > .desk-ft-row');
    await fileRow.waitFor({ timeout: 10_000 });
    await fileRow.click();

    // Open sink is written by main when GROK_DESKTOP_OPEN_SINK is set.
    await page.waitForFunction(
      async () => {
        // Poll via bridge lastOpen (works even if sink I/O is slightly delayed).
        const api = (window as unknown as {
          grokDesktopFileTree?: { lastOpen: () => Promise<{ path: string | null }> };
        }).grokDesktopFileTree;
        if (!api) return false;
        const r = await api.lastOpen();
        return !!(r && r.path && /readme\.txt$/i.test(r.path.replace(/\\/g, "/")));
      },
      { timeout: 10_000 },
    );

    // Also assert the sink file (mutation: if open skips the sink/openPath path,
    // lastOpen might still be set by a stub — require the sink line too).
    let sink = "";
    for (let i = 0; i < 20; i++) {
      if (fs.existsSync(openSink)) {
        sink = fs.readFileSync(openSink, "utf8");
        if (sink.includes("readme.txt")) break;
      }
      await page.waitForTimeout(100);
    }
    expect(sink.replace(/\\/g, "/")).toMatch(/readme\.txt/);
    // Contained under workspace.
    expect(path.resolve(sink.trim().split(/\r?\n/).filter(Boolean).pop()!)).toBe(
      path.resolve(workspace, "readme.txt"),
    );
  });

  it("file-tree IPC rejects path traversal from the renderer", async () => {
    const result = await page.evaluate(async () => {
      const api = (window as unknown as {
        grokDesktopFileTree: {
          list: (p: string) => Promise<{ ok: boolean; reason?: string }>;
          open: (p: string) => Promise<{ ok: boolean; error?: string }>;
        };
      }).grokDesktopFileTree;
      const list = await api.list("../");
      const open = await api.open("../outside.txt");
      const openDotDot = await api.open("src/../../outside.txt");
      return { list, open, openDotDot };
    });
    expect(result.list.ok).toBe(false);
    expect(result.open.ok).toBe(false);
    expect(result.openDotDot.ok).toBe(false);
  });
});
