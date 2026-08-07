/**
 * One-shot / rebuild helper: regenerate README.marketplace.md from README.md
 * by taking the extension-facing body and wrapping an extension-only header.
 * Run: node scripts/gen-marketplace-readme.cjs
 *
 * Packaging always uses --readme-path README.marketplace.md; this script is
 * only for regenerating content after large README edits.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const github = fs.readFileSync(path.join(root, "README.md"), "utf8");

const featIdx = github.indexOf("### Features");
if (featIdx < 0) throw new Error("README.md missing ### Features section");

let body = github.slice(featIdx);

// Drop repo Development section (marketplace listing is usage-focused).
const dev = body.indexOf("## Development");
const known = body.indexOf("## Known limits");
if (dev >= 0 && known > dev) {
  body = body.slice(0, dev) + body.slice(known);
}

// Strip dual-host install / quick-start wording if present in the body.
body = body.replace(
  /\n### Grok Build Desktop[\s\S]*?(?=\n### |\n## )/m,
  "\n",
);
body = body.replace(/\n### VS Code \/ Cursor extension\n\n/m, "\n");
body = body.replace(
  /1\. \*\*Open\*\* Grok — in VS Code: `Ctrl\/Cmd\+;` \(Secondary Side Bar by default\); in Desktop: launch the app and add a project folder\./,
  "1. **Open** the Grok view (`Ctrl/Cmd+;`, or **Grok: Open** from the command palette) — it lives in the Secondary Side Bar by default.",
);
body = body.replace(
  /preview an edit \(native diff in VS Code; in-app viewer on Desktop\)/,
  "preview an edit in the native **diff editor**, with full-file context focused on the first changed line",
);

// Marketplace prefers absolute image/doc URLs (no local repo tree in the store).
body = body.replace(
  /\((docs\/screenshots\/[^)]+)\)/g,
  "(https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/$1)",
);
body = body.replace(
  /\]\((docs\/[^)]+)\)/g,
  "](https://github.com/phuryn/grok-build-vscode/blob/main/$1)",
);
body = body.replace(
  /\]\(LICENSE\)/g,
  "](https://github.com/phuryn/grok-build-vscode/blob/main/LICENSE)",
);

const header = `# Grok Build for VS Code (Community)

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](https://github.com/phuryn/grok-build-vscode/blob/main/LICENSE) [![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com) [![Cursor](https://badgen.net/badge/Cursor/Extension/007ACC)](https://cursor.com) [![The Product Compass](https://img.shields.io/badge/The%20Product%20Compass-productcompass.pm-FF6B35)](https://www.productcompass.pm)

> **GUI for Grok Build CLI (incl. Grok 4.5)** — not affiliated with or endorsed by xAI. *Grok*, *Grok Build*, and *xAI* are trademarks of xAI; this project uses those names only to describe what it's compatible with.

The GUI for **Grok Build CLI** (incl. **Grok 4.5**), right in your editor — with **Remote Control**: pair **[AFK Pilot](https://afkpilot.com)** once and watch, approve, and steer your agent from your phone or any browser while away from your desk. Drop open files in as \`@\`-context, run **multiple sessions** at once, keep **resumable chat history**, generate **images & video inline**, and dictate by **voice**. If you'd rather stay in VS Code than a terminal, this brings Grok Build's agent into your sidebar.

No manual setup: the extension **walks you through installing the \`grok\` CLI and signing in** — with a **SuperGrok or X Premium+ subscription**, or an **xAI API key** — right from the sidebar, one click per step.

![Grok Build in the VS Code sidebar, running Grok 4.5](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/grok_4.5.png)

![Generated image rendered inline from /imagine](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/imagine.webp)

---

## Why use this?

If you live in your editor, this puts Grok Build right next to your code — a graphical workflow on top of the CLI: the **native diff editor** on every proposed edit, your **open files and selection as context**, **parallel sessions** with status dots, **resumable history**, **inline images & video**, and **voice dictation**. The CLI does the heavy lifting; this is the GUI for when you'd rather not be in a terminal.

`;

// Install section for marketplace (extension only) — replace dual-host Install if body still has it.
const installBlock = `## Install

**1. Install the extension.** In VS Code or Cursor, open **Extensions** (\`Ctrl/Cmd+Shift+X\`) and search **"Grok Build for VS Code (Community)"**.

**2. Open Grok and sign in.** Press \`Ctrl/Cmd+;\`. The sidebar **walks you through installing the \`grok\` CLI and signing in** — one click per step, with your SuperGrok / X Premium+ subscription or an xAI API key. That's the whole setup.

Grok opens in the **Secondary Side Bar** (right side, next to other AI tools). Prefer it elsewhere? Gear → **Config & debug** → **Move view** relocates it to the Panel or Primary Side Bar in one click.

> Prefer the terminal, building from source, or installing into several IDEs at once? See the project [INSTALL docs](https://github.com/phuryn/grok-build-vscode/blob/main/docs/INSTALL.md).

---

## Quick start

1. **Open** the Grok view (\`Ctrl/Cmd+;\`, or **Grok: Open** from the command palette) — it lives in the Secondary Side Bar by default.
2. **Type a prompt** and press **Enter**. Grok streams its answer, showing a *Thinking…* line while it reasons. Want the full reasoning inline? Turn on **Show thinking traces** in the gear menu → *Config & debug*.
3. **Approve actions.** When Grok wants to write a file or run a command it may raise a permission card — preview an edit in the native **diff editor**, with full-file context focused on the first changed line, then *Allow once / always / Reject*.
4. **Pick your mode** (Agent / Plan / Auto accept), **model**, and **reasoning effort** from the bottom toolbar and gear menu.
5. **Resume anytime** — the clock icon lists past sessions for this project.

---

`;

// Drop Install..Quick start from body if present — we inject a clean extension-only pair.
const reqIdx = body.indexOf("## Requirements");
if (reqIdx < 0) throw new Error("README.md missing ## Requirements");
// Features sit before Requirements in the github file; keep Features only from body head.
const featuresOnly = body.slice(0, body.indexOf("## Requirements"));
const afterQuick = body.slice(reqIdx);

const out = header + featuresOnly + installBlock + afterQuick;

const banned = [
  /Grok Build Desktop/i,
  /desktop app/i,
  /standalone Electron/i,
  /npm run dist/i,
  /dist-desktop/i,
  /electron-builder/i,
];
for (const re of banned) {
  if (re.test(out)) {
    throw new Error(`marketplace README still matches ${re}`);
  }
}

fs.writeFileSync(path.join(root, "README.marketplace.md"), out, "utf8");
console.log("Wrote README.marketplace.md (%d bytes)", Buffer.byteLength(out, "utf8"));
