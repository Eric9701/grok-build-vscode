// Repeatable layout-cost probe for a long conversation (#102).
//
// Drives the REAL media/chat.js + chat.css in Chromium (Playwright), not
// happy-dom. happy-dom has no layout engine, so it cannot speak to the freeze
// on width change.
//
// Mix: ~N user/agent turns of prose, fenced code, collapsed diffs, a couple of
// generated images. Counts are printed so a later run with CSS/JS changes is
// comparable.
//
//   node research/long-conversation-perf.mjs
//   node research/long-conversation-perf.mjs --turns 1500
//
// Not part of npm test / CI.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function argValue(name, fallback) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return fallback;
}
const TURNS = Math.max(1, Math.floor(Number(argValue("turns", 1500)) || 1500));
const VIEW = { width: 420, height: 800 };

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = path.join(root, rel || "index.html");
      if (!file.startsWith(root)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>long-conversation-perf</title>
<style>
  :root {
    --vscode-font-family: "Segoe UI", system-ui, sans-serif;
    --vscode-font-size: 13px;
    --vscode-foreground: #cccccc;
    --vscode-sideBar-background: #181818;
    --vscode-editor-background: #1e1e1e;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-editorWidget-border: #454545;
    --vscode-input-border: #3c3c3c;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-charts-green: #4ec9b0;
    --vscode-charts-blue: #3794ff;
    --vscode-errorForeground: #f14c4c;
    --vscode-scrollbarSlider-background: rgba(121,121,121,0.4);
    --vscode-scrollbarSlider-hoverBackground: rgba(100,100,100,0.7);
    --vscode-scrollbarSlider-activeBackground: rgba(191,191,191,0.4);
    --vscode-textLink-foreground: #4daafc;
  }
</style>
<link rel="stylesheet" href="/media/chat.css" />
</head>
<body class="desk thinking-hidden" style="--chat-zoom: 1">
  <header class="top-bar">
    <div id="session-name-chip" class="session-name-chip" hidden>
      <button id="session-name-label" class="session-name-label" type="button"></button>
      <span id="session-name-repo" class="session-name-repo" hidden></span>
      <button id="session-name-edit" class="session-name-edit icon-btn" type="button" hidden></button>
    </div>
    <button id="repo-btn" type="button"></button>
    <button id="remote-btn" hidden></button>
    <button id="history-btn"></button>
    <button id="new-btn"></button>
    <div id="session-head-actions"></div>
    <div id="repo-popover" hidden></div>
    <div id="history-popover" hidden></div>
  </header>
  <div id="session-head">
    <div id="session-head-main"><span id="session-head-title"></span><span id="session-head-sub"></span></div>
  </div>
  <main id="messages" class="messages">
    <div class="welcome" id="welcome">
      <p id="welcome-version" class="muted"><span>Starting</span></p>
      <div id="welcome-onboarding"></div>
    </div>
  </main>
  <footer class="composer">
    <button id="scroll-bottom-btn" class="scroll-bottom-btn"></button>
    <div class="composer-card">
      <div id="attachments"></div>
      <div class="composer-input-wrap">
        <div id="input-highlight"></div>
        <textarea id="input"></textarea>
        <button id="mic-btn"></button>
      </div>
      <button id="add-btn"></button>
      <button id="gear-btn"></button>
      <div id="donut"><svg><circle id="donut-arc"/></svg><span id="donut-label"></span></div>
      <div id="chips"></div>
      <button id="mode-btn"></button>
      <button id="send-btn"></button>
    </div>
    <div id="mode-popover" hidden></div>
    <div id="gear-popover" hidden></div>
    <div id="add-popover" hidden></div>
    <div id="context-popover" hidden></div>
    <div id="slash-popover" hidden></div>
    <div id="mention-popover" hidden></div>
  </footer>
  <script>
    window.acquireVsCodeApi = () => ({
      postMessage() {},
      setState() {},
      getState() { return undefined; },
    });
  </script>
  <script src="/media/webview-helpers.js"></script>
  <script src="/media/settings.js"></script>
  <script src="/media/chat.js"></script>
</body>
</html>`;

function dispatchInit(page) {
  return page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "initialState",
        effort: "",
        cwd: "/work/repo",
        useCtrlEnter: false,
        extVersion: "0",
        showThinking: false,
        expandCommandOutputs: false,
        capabilities: {},
      },
    }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "setBusy", value: false } }));
  });
}

function paint() {
  return `() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`;
}

async function main() {
  const { server, origin } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.route("**/perf.html", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: PAGE_HTML });
  });
  await page.goto(`${origin}/perf.html`, { waitUntil: "domcontentloaded" });
  await dispatchInit(page);
  await page.evaluate(new Function("return " + paint())());

  const open = await page.evaluate(async (turns) => {
    const post = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
    const code = Array.from({ length: 28 }, (_, i) =>
      `export function step${i}(input: number): number {\n  return input + ${i} * 2;\n}`
    ).join("\n");
    const prose = (n) =>
      `Turn ${n}: the session pool keeps live backends behind the focused chat. ` +
      `Re-focus replays the buffer without a process restart. ` +
      `A long conversation still has to build every node and then lay them out ` +
      `whenever the panel width changes. Unique token T${String(n).padStart(4, "0")}.`;
    const oldText = Array.from({ length: 24 }, (_, i) => `  const value${i} = ${i};`).join("\n");
    const newText = Array.from({ length: 30 }, (_, i) => `  const value${i} = ${i + 1};`).join("\n");
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAADICAYAAABS39xVAAAAhUlEQVR4nO3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOBuGQABfwABH4y2GAAAAABJRU5ErkJggg==";

    const t0 = performance.now();
    post({ type: "historyReplay", active: true });
    for (let i = 0; i < turns; i++) {
      const userText = i === 0
        ? `EARLY_NEEDLE_TOKEN start the long conversation.\n${prose(i)}`
        : prose(i);
      post({ type: "userMessage", text: userText, chips: [] });
      post({ type: "agentStart" });
      if (i % 5 === 0) {
        post({
          type: "messageChunk",
          text: `${prose(i)}\n\nHere is the implementation:\n\n\`\`\`ts\n${code}\n\`\`\`\n`,
        });
      } else {
        post({ type: "messageChunk", text: prose(i) + "\n\n- keep the live tail\n- skip off-screen layout\n- find still has to reach this." });
      }
      if (i % 7 === 0) {
        const id = `edit-${i}`;
        post({
          type: "toolCall",
          call: { toolCallId: id, kind: "edit", title: `Edit src/file-${i}.ts` },
        });
        post({
          type: "toolCallUpdate",
          call: {
            toolCallId: id,
            content: [{ type: "diff", path: `src/file-${i}.ts`, oldText, newText }],
          },
        });
      }
      if (i % 11 === 0) {
        const cmd = `node research/probe-${i}.cjs`;
        post({
          type: "toolCall",
          call: {
            toolCallId: `cmd-${i}`,
            kind: "execute",
            title: `Run ${cmd}`,
            rawInput: { command: cmd },
          },
        });
        post({
          type: "commandOutput",
          command: cmd,
          output: `ok ${i}\n` + Array.from({ length: 8 }, (_, k) => `line ${k} of output`).join("\n"),
          exitCode: 0,
          truncated: false,
        });
      }
      if (i === 40 || i === turns - 20) {
        post({ type: "media", media: "image", src: png, path: `/generated/img-${i}.png` });
      }
      post({ type: "agentEnd" });
      post({ type: "promptComplete", meta: {} });
    }
    post({ type: "historyReplay", active: false });
    const tDispatch = performance.now();

    const messages = document.getElementById("messages");
    void messages.offsetHeight;
    const tLayout = performance.now();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    void messages.offsetHeight;
    const tPaint = performance.now();

    const items = [...messages.children].filter((el) => el.id !== "welcome");
    const kinds = {};
    for (const el of items) {
      const key = [...el.classList].join(".") || el.tagName;
      kinds[key] = (kinds[key] || 0) + 1;
    }
    const hist = window.__grokHistory;
    return {
      turns,
      dispatchMs: tDispatch - t0,
      layoutMs: tLayout - tDispatch,
      paintMs: tPaint - tLayout,
      openMs: tPaint - t0,
      itemCount: items.length,
      nodeCount: messages.querySelectorAll("*").length,
      documentNodes: document.querySelectorAll("*").length,
      scrollHeight: messages.scrollHeight,
      clientHeight: messages.clientHeight,
      scrollTop: messages.scrollTop,
      prefixRemaining: hist && hist.prefixRemaining ? hist.prefixRemaining() : 0,
      kinds,
    };
  }, TURNS);

  const resize = await page.evaluate(async () => {
    const messages = document.getElementById("messages");
    const body = document.body;
    const runs = [];
    const widths = [420, 280, 520, 360];
    for (const w of widths) {
      const t0 = performance.now();
      body.style.width = w + "px";
      void messages.offsetHeight;
      const tForce = performance.now();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      void messages.offsetHeight;
      const tSettle = performance.now();
      runs.push({
        width: w,
        forceLayoutMs: tForce - t0,
        settleMs: tSettle - t0,
        scrollHeight: messages.scrollHeight,
      });
    }
    body.style.width = "";
    void messages.offsetHeight;
    return runs;
  });

  // Viewport resize: closer to "change the view width" in VS Code.
  const viewportResize = [];
  for (const w of [420, 280, 520, 360]) {
    const t0 = Date.now();
    await page.setViewportSize({ width: w, height: 800 });
    const settled = await page.evaluate(async () => {
      const messages = document.getElementById("messages");
      const t0 = performance.now();
      void messages.offsetHeight;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      void messages.offsetHeight;
      return { ms: performance.now() - t0, scrollHeight: messages.scrollHeight };
    });
    viewportResize.push({ width: w, wallMs: Date.now() - t0, ...settled });
  }
  await page.setViewportSize(VIEW);

  const scroll = await page.evaluate(async () => {
    const messages = document.getElementById("messages");
    const hist = window.__grokHistory;
    const wait = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const firstVisible = () => {
      const box = messages.getBoundingClientRect();
      for (const el of messages.children) {
        if (el.id === "welcome" || el.id === "history-head") continue;
        const r = el.getBoundingClientRect();
        if (r.bottom > box.top + 8 && r.top < box.bottom) return el;
      }
      return null;
    };

    const unpinNearTop = () => {
      messages.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
      const maxTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
      // Stay above the auto-load threshold so this call owns the prepend.
      messages.scrollTop = Math.min(800, maxTop);
    };

    const measurePrepend = async (label) => {
      if (!hist || !hist.prefixRemaining || !hist.prefixRemaining()) {
        return { label, skipped: true, prefixRemaining: 0 };
      }
      unpinNearTop();
      void messages.offsetHeight;
      await wait();
      const sentinel = firstVisible();
      const beforeTop = sentinel ? sentinel.getBoundingClientRect().top : null;
      const beforeST = messages.scrollTop;
      const beforeSH = messages.scrollHeight;
      const prefixBefore = hist.prefixRemaining();
      const t0 = performance.now();
      hist.expandMore();
      void messages.offsetHeight;
      await wait();
      const afterTop = sentinel && sentinel.isConnected ? sentinel.getBoundingClientRect().top : null;
      return {
        label,
        ms: Math.round(performance.now() - t0),
        prefixBefore,
        prefixAfter: hist.prefixRemaining(),
        heightDelta: messages.scrollHeight - beforeSH,
        scrollTopDelta: Math.round(messages.scrollTop - beforeST),
        sentinelJump: beforeTop == null || afterTop == null ? null : Math.round((afterTop - beforeTop) * 10) / 10,
        itemCount: [...messages.children].filter((el) => el.id !== "welcome").length,
      };
    };

    const first = await measurePrepend("first-40");
    const second = await measurePrepend("second-40");
    return { first, second, prefixRemaining: hist && hist.prefixRemaining ? hist.prefixRemaining() : 0 };
  });

  const heights = await page.evaluate(() => {
    const messages = document.getElementById("messages");
    const byKind = {};
    function kindOf(el) {
      if (el.id === "welcome" || el.id === "history-head") return null;
      if (el.classList.contains("msg") && el.classList.contains("user")) return "msg.user";
      if (el.classList.contains("msg") && el.classList.contains("agent")) {
        return el.querySelector("pre, .code-block") ? "msg.agent.code" : "msg.agent.prose";
      }
      if (el.classList.contains("tool-group")) {
        return el.classList.contains("expanded") ? "tool-group.expanded" : "tool-group";
      }
      if (el.classList.contains("tool-flat")) return "tool-flat";
      if (el.classList.contains("generated-image")) return "generated-image";
      return el.classList[0] || el.tagName;
    }
    for (const el of messages.children) {
      const kind = kindOf(el);
      if (!kind) continue;
      const h = el.getBoundingClientRect().height;
      const slot = byKind[kind] || (byKind[kind] = { n: 0, h: [] });
      slot.n += 1;
      slot.h.push(h);
    }
    const summarize = (arr) => {
      const s = arr.slice().sort((a, b) => a - b);
      const at = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
      return {
        min: Math.round(s[0]),
        p50: Math.round(at(0.5)),
        p90: Math.round(at(0.9)),
        max: Math.round(s[s.length - 1]),
      };
    };
    const out = {};
    for (const [k, v] of Object.entries(byKind)) {
      out[k] = { n: v.n, height: summarize(v.h) };
    }
    return out;
  });

  const result = {
    turns: TURNS,
    viewport: VIEW,
    open,
    resizeForced: resize,
    viewportResize,
    scroll,
    heights,
    pageErrors,
  };

  console.log(JSON.stringify(result, null, 2));

  await browser.close();
  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
