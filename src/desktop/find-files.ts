/**
 * Minimal workspace file find for the desktop host (mention index).
 * Not a full VS Code glob engine — good enough for `**\/*` + common excludes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Uri } from "../host";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "out",
  "dist",
  ".vscode-test",
  "coverage",
]);

function matchesExclude(relPosix: string, exclude?: string): boolean {
  if (!exclude) return false;
  // VS Code exclude is a glob string; handle the shapes we actually emit.
  const patterns = exclude
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pat of patterns) {
    if (pat === "**/*" || pat === "*") return true;
    // `**/node_modules/**` style
    const bare = pat.replace(/^\*\*\//, "").replace(/\/\*\*$/, "").replace(/\*\*/g, "");
    if (bare && (relPosix === bare || relPosix.includes(`/${bare}/`) || relPosix.startsWith(`${bare}/`))) {
      return true;
    }
    if (pat.endsWith("/**") || pat.endsWith("/*")) {
      const prefix = pat.replace(/\/\*\*?$/, "").replace(/^\*\*\//, "");
      if (prefix && (relPosix === prefix || relPosix.startsWith(prefix + "/"))) return true;
    }
  }
  return false;
}

/**
 * Walk `base` and return file URIs under it, newest-not-sorted (order free).
 */
export async function findFilesUnder(
  base: string,
  exclude?: string,
  maxResults = 5000,
): Promise<Uri[]> {
  const root = path.resolve(base);
  if (!fs.existsSync(root)) return [];
  const out: Uri[] = [];

  const walk = (dir: string): void => {
    if (out.length >= maxResults) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxResults) return;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (matchesExclude(rel + "/", exclude) || matchesExclude(rel, exclude)) continue;
        walk(abs);
      } else if (ent.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (matchesExclude(rel, exclude)) continue;
        out.push(Uri.file(abs));
      }
    }
  };

  walk(root);
  return out;
}
