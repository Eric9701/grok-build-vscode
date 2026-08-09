import { createHash } from "node:crypto";
import * as path from "node:path";
import { keepsCanonicalDirectChildIdentity } from "./sessions";

export type PlanReviewPathExistsFn = (p: string) => boolean;
export type PlanReviewPathRealpathFn = (p: string) => string;

/** Directory segment shared by snapshot creation and desktop authorization. */
export function planReviewSessionDirectoryName(sessionId: string): string {
  return sanitizePlanReviewFilePart(sessionId).slice(0, 80);
}

/**
 * The only relative shape that may be resolved below `plan-reviews`:
 * `<session>/<file>.md`.
 */
export function isSafeRelativePlanReviewLink(relPath: string): boolean {
  if (!relPath || typeof relPath !== "string" || relPath.includes("\0")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relPath)) return false;
  if (relPath.startsWith("\\\\") || relPath.startsWith("//")) return false;

  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  const segments = normalized.split("/");
  if (segments.length !== 2 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return false;
  }
  const file = segments[1]!;
  return path.extname(file).toLowerCase() === ".md";
}

/** The only relative shape below one conversation's review directory. */
export function isSafePlanReviewFileName(fileName: string): boolean {
  if (!fileName || typeof fileName !== "string" || fileName.includes("\0")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(fileName)) return false;
  if (fileName.startsWith("\\\\") || fileName.startsWith("//")) return false;
  const normalized = fileName.replace(/\\/g, "/");
  if (normalized.includes("/") || normalized === "." || normalized === "..") return false;
  return path.extname(normalized).toLowerCase() === ".md";
}

/**
 * Pure plan-review provenance check. The caller supplies the filesystem seams
 * so the same decision can be unit-tested without creating symlinks.
 *
 * Both the link path and its canonical target must retain the exact
 * `<plan-reviews>/<this session>/<one .md file>` layout. The supplied root is
 * one conversation's directory, not the shared `plan-reviews` directory.
 * Direct-child identity additionally refuses a review-root, session-directory,
 * or file symlink that changes the named leaf, including a target elsewhere
 * inside the storage tree.
 */
export function isTrustedPlanReviewPath(
  fsPath: string,
  planReviewSessionRoot: string,
  deps: {
    exists: PlanReviewPathExistsFn;
    realpath: PlanReviewPathRealpathFn;
  },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!fsPath || !planReviewSessionRoot || fsPath.includes("\0")) return false;

  try {
    if (
      !(platform === "win32" ? path.win32.isAbsolute(fsPath) : path.isAbsolute(fsPath))
    ) {
      return false;
    }
    const root = path.resolve(planReviewSessionRoot);
    const candidate = path.resolve(fsPath);
    if (fsPath.replace(/\\/g, "/").split("/").includes("..")) return false;
    const relative = path.relative(root, candidate);
    if (!isSafePlanReviewFileName(relative)) return false;
    if (!deps.exists(candidate)) return false;

    const realRoot = path.normalize(deps.realpath(root));
    const realCandidate = path.normalize(deps.realpath(candidate));
    if (!deps.exists(realCandidate)) return false;
    const realRelative = path.relative(realRoot, realCandidate);
    if (!isSafePlanReviewFileName(realRelative)) return false;

    const planReviewsRoot = path.dirname(root);
    // Keep the named plan-reviews directory under global storage and the named
    // session directory under plan-reviews, while allowing the whole storage
    // ancestor to be symlinked as one unit.
    if (
      !keepsCanonicalDirectChildIdentity(
        planReviewsRoot,
        path.dirname(planReviewsRoot),
        deps.realpath,
        platform,
      )
    ) {
      return false;
    }
    if (!keepsCanonicalDirectChildIdentity(root, planReviewsRoot, deps.realpath, platform)) {
      return false;
    }
    return keepsCanonicalDirectChildIdentity(candidate, root, deps.realpath, platform);
  } catch {
    return false;
  }
}

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
