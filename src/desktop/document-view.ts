/**
 * Pure helpers for desktop file/diff/text viewers.
 * No Electron import — unit-testable; electron-host opens the windows.
 */
import type { HostTextDocumentContentProvider, Uri } from "../host";

/** Escape text for safe embedding in HTML (text content / attributes). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Resolve document text for a portable URI from a file reader or registered
 * content provider (e.g. grok-diff virtual sides).
 */
export function resolveDocumentText(
  uri: Uri,
  providers: ReadonlyMap<string, HostTextDocumentContentProvider>,
  readFileSync: (fsPath: string) => string,
): string {
  if (uri.scheme === "file") {
    return readFileSync(uri.fsPath);
  }
  const provider = providers.get(uri.scheme);
  if (provider) {
    return provider.provideTextDocumentContent(uri);
  }
  throw new Error(`No content provider for scheme "${uri.scheme}"`);
}

/** Result of handing a path to the OS default handler (`shell.openPath`). */
export type OpenPathResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Interpret `shell.openPath`'s return value: empty string = success, else error.
 */
export function interpretOpenPathResult(errorMessage: string): OpenPathResult {
  if (!errorMessage) return { ok: true };
  return { ok: false, error: errorMessage };
}

/** Read-only single-document HTML (openText / untitled). */
export function buildTextViewerHtml(title: string, content: string, language?: string): string {
  const lang = language ? escapeHtml(language) : "plaintext";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1e1e1e; color: #d4d4d4;
    font-family: Consolas, "Courier New", monospace; font-size: 13px; }
  .bar { padding: 6px 12px; background: #252526; border-bottom: 1px solid #3c3c3c;
    color: #9d9d9d; font-family: system-ui, sans-serif; font-size: 12px; }
  pre { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-word;
    overflow: auto; height: calc(100% - 32px); box-sizing: border-box; }
</style>
</head>
<body>
  <div class="bar">${escapeHtml(title)}${language ? ` · ${lang}` : ""} · read-only</div>
  <pre>${escapeHtml(content)}</pre>
</body>
</html>`;
}

/** Read-only side-by-side diff HTML (not a full editor; no apply/write). */
export function buildDiffViewerHtml(
  title: string,
  leftLabel: string,
  leftText: string,
  rightLabel: string,
  rightText: string,
  scrollToLine?: number,
): string {
  const leftLines = leftText.split(/\r?\n/);
  const rightLines = rightText.split(/\r?\n/);
  const max = Math.max(leftLines.length, rightLines.length, 1);
  const rows: string[] = [];
  for (let i = 0; i < max; i++) {
    const n = i + 1;
    const L = leftLines[i] ?? "";
    const R = rightLines[i] ?? "";
    const same = L === R;
    const cls = same ? "same" : "diff";
    const id = scrollToLine !== undefined && n === scrollToLine + 1 ? ' id="focus-line"' : "";
    rows.push(
      `<div class="row ${cls}"${id}>` +
        `<div class="gutter">${n}</div>` +
        `<div class="cell left">${escapeHtml(L)}</div>` +
        `<div class="cell right">${escapeHtml(R)}</div>` +
        `</div>`,
    );
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1e1e1e; color: #d4d4d4;
    font-family: Consolas, "Courier New", monospace; font-size: 12px; }
  .bar { padding: 6px 12px; background: #252526; border-bottom: 1px solid #3c3c3c;
    color: #9d9d9d; font-family: system-ui, sans-serif; font-size: 12px; }
  .heads { display: grid; grid-template-columns: 3.5em 1fr 1fr; gap: 0;
    background: #2d2d2d; border-bottom: 1px solid #3c3c3c; font-family: system-ui, sans-serif;
    font-size: 11px; color: #9d9d9d; position: sticky; top: 0; }
  .heads span { padding: 4px 8px; border-right: 1px solid #3c3c3c; }
  .scroll { overflow: auto; height: calc(100% - 56px); }
  .row { display: grid; grid-template-columns: 3.5em 1fr 1fr; }
  .gutter { color: #858585; text-align: right; padding: 0 6px; border-right: 1px solid #3c3c3c;
    user-select: none; background: #1e1e1e; }
  .cell { padding: 0 8px; white-space: pre-wrap; word-break: break-all; border-right: 1px solid #3c3c3c;
    min-height: 1.2em; }
  .row.diff .left { background: rgba(250, 66, 62, 0.12); }
  .row.diff .right { background: rgba(64, 201, 119, 0.12); }
  #focus-line { outline: 1px solid #007fd4; }
</style>
</head>
<body>
  <div class="bar">${escapeHtml(title)} · read-only preview (not an editor)</div>
  <div class="heads"><span>#</span><span>${escapeHtml(leftLabel)}</span><span>${escapeHtml(rightLabel)}</span></div>
  <div class="scroll">${rows.join("\n")}</div>
  <script>
    const el = document.getElementById("focus-line");
    if (el) el.scrollIntoView({ block: "center" });
  </script>
</body>
</html>`;
}
