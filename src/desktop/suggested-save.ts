/**
 * Pure save-dialog delivery for an openText that carries a suggested filename.
 * Desktop honors it (OS Save As); a missing/empty name is a fallback so the
 * caller can keep the untitled / viewer path (command View all, old hosts).
 */
import type { HostSaveDialogOptions } from "../host";

export type SuggestedSaveOutcome = "saved" | "cancelled" | "fallback";

const SAVE_FILTER_LABELS: Record<string, string> = {
  md: "Markdown",
  diff: "Diff",
  patch: "Diff",
  ps1: "PowerShell",
  sh: "Shell",
  bash: "Shell",
  bat: "Batch",
  cmd: "Batch",
  ts: "TypeScript",
  js: "JavaScript",
  py: "Python",
  json: "JSON",
  txt: "Text",
};

/** Last path segment, slash-insensitive. */
function saveBasename(filename: string): string {
  const trimmed = filename.trim();
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Extension without the dot, or "" when the name has none. */
export function saveExtensionForFilename(filename: string): string {
  const base = saveBasename(filename);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Save-dialog filters derived from the suggested filename's extension. */
export function saveFiltersForFilename(filename: string): Record<string, string[]> {
  const ext = saveExtensionForFilename(filename);
  if (!ext) return { "All files": ["*"] };
  const label = SAVE_FILTER_LABELS[ext] || ext.toUpperCase();
  return { [label]: [ext] };
}

/** Markdown export keeps its conversation title; every other preview is Save as. */
export function saveDialogTitleForFilename(filename: string): string {
  return saveExtensionForFilename(filename) === "md" ? "Export conversation" : "Save as";
}

export function planSuggestedSaveDialog(
  suggestedFilename: string,
  opts?: { filters?: Record<string, string[]>; title?: string },
): HostSaveDialogOptions {
  return {
    defaultPath: suggestedFilename,
    filters: opts?.filters,
    title: opts?.title,
  };
}

/**
 * Write `content` to `target`. Cancel (`undefined`) writes nothing.
 * Returns whether a write happened.
 */
export function writeSuggestedFileOrCancel(
  content: string,
  target: string | undefined,
  writeFile: (filePath: string, data: string) => void,
): boolean {
  if (!target) return false;
  writeFile(target, content);
  return true;
}

export async function deliverSuggestedFileSave(opts: {
  suggestedFilename?: string;
  content: string;
  showSaveDialog: (options: HostSaveDialogOptions) => Promise<string | undefined>;
  writeFile: (filePath: string, data: string) => Promise<void> | void;
  filters?: Record<string, string[]>;
  title?: string;
}): Promise<SuggestedSaveOutcome> {
  const suggested = typeof opts.suggestedFilename === "string" ? opts.suggestedFilename.trim() : "";
  if (!suggested) return "fallback";
  const target = await opts.showSaveDialog(
    planSuggestedSaveDialog(suggested, { filters: opts.filters, title: opts.title }),
  );
  if (!target) return "cancelled";
  await opts.writeFile(target, opts.content);
  return "saved";
}
