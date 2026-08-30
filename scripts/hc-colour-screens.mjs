// Do the effort dots and the check mark actually READ in High Contrast?
//
// #139 was fixed by reading VS Code's own theme data — `button.background` is
// literally black for hcDark — and that is strong evidence about the cause but
// it is not a look at a pixel. This renders the SHIPPED media/chat.css against
// the REAL palette values from VS Code's bundled workbench, at the old token and
// the new one, and measures the contrast of each mark against the surface behind
// it. Frames land in .screens/ for a person to look at.
//
// Honest about what it is: real CSS, real palette, real layout engine — not a
// live VS Code window. What it cannot catch is a theme that overrides something
// we did not model.
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const OUT = process.env.SCREENS_DIR || ".screens";
fs.mkdirSync(OUT, { recursive: true });
const css = fs.readFileSync(path.join(root, "media", "chat.css"), "utf8");
const log = (m) => console.log(`[hc-colour] ${m}`);

// Straight from vs/workbench/workbench.desktop.main.js (VS Code 1.131.0).
// descriptionForeground is foreground at 70% alpha in every dark theme.
const THEMES = {
  "dark-modern": {
    "editorWidget-background": "#252526",
    foreground: "#CCCCCC",
    descriptionForeground: "rgba(204,204,204,0.7)",
    "button-background": "#0E639C",
    "textLink-foreground": "#3794FF",
    contrastBorder: "transparent",
  },
  "dark-high-contrast": {
    "editorWidget-background": "#0C141F",
    foreground: "#FFFFFF",
    descriptionForeground: "rgba(255,255,255,0.7)",
    "button-background": "#000000", // hcDark: Color.black — the whole bug
    "textLink-foreground": "#21A6FF",
    contrastBorder: "#6FC3DF",
  },
};

const page = async (browser, theme, token) => {
  const vars = Object.entries(THEMES[theme]).map(([k, v]) => `--vscode-${k}: ${v};`).join("\n");
  // The one line under test, applied as the old token or the new one.
  const override = token === "old"
    ? `.effort-dot.active::before { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
       .popover-check { color: var(--vscode-button-background); }`
    : "";
  const p = await browser.newPage({ viewport: { width: 320, height: 150 }, deviceScaleFactor: 2 });
  await p.setContent(`<!doctype html><html><head><style>
    :root { ${vars} }
    body { margin: 0; background: var(--vscode-editorWidget-background); color: var(--vscode-foreground);
           font: 13px system-ui; padding: 14px; }
    ${css}
    .gear-popover { background: var(--vscode-editorWidget-background); padding: 8px; }
    ${override}
  </style></head><body>
    <div class="gear-popover">
      <div class="model-effort-row">
        <span class="model-name-btn">grok-4-fast</span>
        <span class="effort-dots">
          <span class="effort-dot active"></span><span class="effort-dot active"></span><span class="effort-dot"></span>
        </span>
      </div>
      <div class="toolbar-popover-item"><span class="gear-lead"><span>Coding</span></span><span class="popover-check">&#10003;</span></div>
    </div>
  </body></html>`);
  return p;
};

// Relative luminance contrast, the WCAG ratio. 3:1 is the floor for a
// non-text graphical object; below ~1.5 a mark is effectively invisible.
const lum = (hex) => {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const browser = await chromium.launch();
for (const theme of Object.keys(THEMES)) {
  for (const token of ["old", "new"]) {
    const p = await page(browser, theme, token);
    const file = path.join(OUT, `hc-${theme}-${token}.png`);
    await p.screenshot({ path: file });
    const dot = await p.$eval(".effort-dot.active", (el) =>
      getComputedStyle(el, "::before").backgroundColor);
    const check = await p.$eval(".popover-check", (el) => getComputedStyle(el).color);
    await p.close();
    const surface = THEMES[theme]["editorWidget-background"];
    const asHex = (rgb) => {
      const m = rgb.match(/\d+/g);
      return "#" + m.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, "0")).join("");
    };
    log(`${theme.padEnd(20)} ${token.padEnd(4)} dot=${asHex(dot)} check=${asHex(check)} ` +
      `contrast dot ${ratio(asHex(dot), surface).toFixed(2)}:1  check ${ratio(asHex(check), surface).toFixed(2)}:1  -> ${file}`);
  }
}
await browser.close();
log("frames in .screens/ — look at hc-dark-high-contrast-old.png next to -new.png");
