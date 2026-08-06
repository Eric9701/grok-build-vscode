/**
 * Pure HTML builders for desktop in-app dialogs (quick pick + input box).
 * No Electron — unit-testable; electron-host opens the windows.
 *
 * Native message boxes cap at a handful of buttons, which made model selection
 * (often 10–20 items) impossible. These dialogs scale to arbitrary lists.
 */
import { escapeHtml } from "./document-view";

export interface DialogQuickPickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface BuildQuickPickHtmlOptions {
  title?: string;
  placeHolder?: string;
  items: readonly DialogQuickPickItem[];
}

export interface BuildInputBoxHtmlOptions {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password?: boolean;
}

const DIALOG_CSS = `
:root { color-scheme: dark; }
html, body {
  margin: 0; height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  background: #252526; color: #cccccc;
}
.wrap { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.hdr {
  padding: 12px 14px 8px; border-bottom: 1px solid #3c3c3c; flex-shrink: 0;
}
.hdr h1 { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: #e0e0e0; }
.hdr p { margin: 0; font-size: 12px; color: #9d9d9d; }
.list {
  flex: 1 1 auto; min-height: 0; overflow: auto; padding: 6px 0;
}
.item {
  display: block; width: 100%; text-align: left;
  border: none; background: transparent; color: inherit;
  font: inherit; padding: 8px 14px; cursor: pointer;
  box-sizing: border-box;
}
.item:hover, .item:focus { background: #094771; color: #fff; outline: none; }
.item .lab { font-weight: 500; }
.item .desc { font-size: 11px; color: #9d9d9d; margin-top: 2px; }
.item:hover .desc, .item:focus .desc { color: #c0c0c0; }
.foot {
  flex-shrink: 0; padding: 10px 14px; border-top: 1px solid #3c3c3c;
  display: flex; gap: 8px; justify-content: flex-end; align-items: center;
}
input[type="text"], input[type="password"] {
  width: 100%; box-sizing: border-box;
  margin: 12px 14px 0; padding: 8px 10px;
  border: 1px solid #3c3c3c; border-radius: 4px;
  background: #3c3c3c; color: #ccc; font: inherit; outline: none;
}
input:focus { border-color: #007fd4; }
button.btn {
  border: none; border-radius: 4px; padding: 6px 14px; font: inherit; cursor: pointer;
}
button.primary { background: #0e639c; color: #fff; }
button.primary:hover { background: #1177bb; }
button.secondary { background: #3a3d41; color: #ccc; }
button.secondary:hover { background: #454545; }
.empty { padding: 24px 14px; color: #9d9d9d; text-align: center; }
`;

function shell(title: string, body: string, boot: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>${DIALOG_CSS}</style>
</head>
<body>
${body}
<script>
${boot}
</script>
</body>
</html>`;
}

/**
 * Map a dialog selection index to an item. Returns undefined for cancel /
 * out-of-range — shared by the host and tests so a 20-item pick is not
 * special-cased away.
 */
export function selectQuickPickIndex<T>(
  items: readonly T[],
  index: unknown,
): T | undefined {
  if (typeof index !== "number" || !Number.isInteger(index)) return undefined;
  if (index < 0 || index >= items.length) return undefined;
  return items[index];
}

/** Build the quick-pick HTML document (items rendered by index). */
export function buildQuickPickHtml(options: BuildQuickPickHtmlOptions): string {
  const title = options.title || "Choose";
  const placeHolder = options.placeHolder || "Select an item";
  const items = options.items;
  const rows = items.length
    ? items
        .map((it, i) => {
          const desc = it.description
            ? `<div class="desc">${escapeHtml(it.description)}${
                it.detail ? ` · ${escapeHtml(it.detail)}` : ""
              }</div>`
            : it.detail
              ? `<div class="desc">${escapeHtml(it.detail)}</div>`
              : "";
          return `<button type="button" class="item" data-index="${i}" autofocus="${
            i === 0 ? "true" : "false"
          }"><div class="lab">${escapeHtml(it.label)}</div>${desc}</button>`;
        })
        .join("\n")
    : `<div class="empty">No items</div>`;

  const body = `<div class="wrap">
  <div class="hdr"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(placeHolder)}</p></div>
  <div class="list" role="listbox">${rows}</div>
  <div class="foot"><button type="button" class="btn secondary" id="cancel">Cancel</button></div>
</div>`;

  const boot = `
(function () {
  var api = window.deskDialog;
  function cancel() { if (api) api.cancel(); }
  function pick(i) { if (api) api.submit({ kind: "quickpick", index: i }); }
  document.getElementById("cancel").onclick = cancel;
  document.querySelectorAll(".item").forEach(function (el) {
    el.addEventListener("click", function () {
      pick(parseInt(el.getAttribute("data-index"), 10));
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  var first = document.querySelector(".item");
  if (first) first.focus();
})();`;

  return shell(title, body, boot);
}

/** Build the input-box HTML document. */
export function buildInputBoxHtml(options: BuildInputBoxHtmlOptions = {}): string {
  const title = options.title || "Input";
  const prompt = options.prompt || "";
  const placeHolder = options.placeHolder || "";
  const value = options.value || "";
  const inputType = options.password ? "password" : "text";

  const body = `<div class="wrap">
  <div class="hdr">
    <h1>${escapeHtml(title)}</h1>
    ${prompt ? `<p>${escapeHtml(prompt)}</p>` : ""}
  </div>
  <input id="val" type="${inputType}" placeholder="${escapeHtml(placeHolder)}" value="${escapeHtml(value)}" />
  <div class="foot" style="margin-top:auto">
    <button type="button" class="btn secondary" id="cancel">Cancel</button>
    <button type="button" class="btn primary" id="ok">OK</button>
  </div>
</div>`;

  const boot = `
(function () {
  var api = window.deskDialog;
  var input = document.getElementById("val");
  function cancel() { if (api) api.cancel(); }
  function ok() { if (api) api.submit({ kind: "input", value: input.value }); }
  document.getElementById("cancel").onclick = cancel;
  document.getElementById("ok").onclick = ok;
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); ok(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.focus();
  input.select();
})();`;

  return shell(title, body, boot);
}

/** Parse a dialog submit payload from the dialog preload bridge. */
export function parseDialogSubmit(raw: unknown):
  | { kind: "quickpick"; index: number }
  | { kind: "input"; value: string }
  | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "quickpick" && typeof o.index === "number" && Number.isInteger(o.index)) {
    return { kind: "quickpick", index: o.index };
  }
  if (o.kind === "input" && typeof o.value === "string") {
    return { kind: "input", value: o.value };
  }
  return null;
}

/** Public repo linked from the Help menu — this repo only. */
export const DESKTOP_PUBLIC_REPO_URL = "https://github.com/phuryn/grok-build-vscode";

export const DESKTOP_APP_FULL_NAME = "Grok Build Desktop (Community)";
export const DESKTOP_APP_SHORT_NAME = "Grok Build Desktop";
