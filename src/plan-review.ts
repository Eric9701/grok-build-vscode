import { createHash } from "node:crypto";

/**
 * Content-addressed snapshot filename: `<title>-<hash8>.md`.
 *
 * Snapshots are re-created on EVERY restore (`withPlanReviewPaths` walks the
 * saved plans each time), and the old always-pick-an-unused-name rule meant one
 * session accumulated 13 copies of the same plan — unbounded growth for as long
 * as a session is reopened. Keying the name on the content makes that write
 * idempotent: the same plan always resolves to the same file, so a restore
 * reuses it and only genuinely new plan text creates a file.
 *
 * 8 hex chars is ample — the namespace is one session's plans, not the world,
 * and a collision is still caught by the content check at the call site.
 */
export function planReviewFileName(plan: string): string {
  const content = plan && plan.trim() ? plan : "(empty plan)\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 8);
  return `${planReviewFileBaseName(content)}-${hash}.md`;
}

export function planReviewFileBaseName(plan: string): string {
  const firstLine = String(plan || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line && !/^status\s*:/i.test(line));
  if (!firstLine) return "plan";
  const namedPrefix = firstLine.match(/^([a-z0-9][a-z0-9._ -]{0,60})\s*:/i);
  return sanitizePlanReviewFilePart(namedPrefix ? namedPrefix[1] : firstLine).slice(0, 80) || "plan";
}

export function sanitizePlanReviewFilePart(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "plan";
}
