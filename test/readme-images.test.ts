import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every image referenced by either README must exist in the repo.
 *
 * There are TWO READMEs and it is easy to forget: `README.md` is the GitHub
 * page and uses repo-relative paths; `README.marketplace.md` is what
 * `vsce package --readme-path` ships, so it is the VS Code Marketplace and
 * Open VSX listing, and it uses absolute raw.githubusercontent URLs. Deleting a
 * screenshot after updating only the first one leaves the STORE page showing
 * alt text and a broken-image icon — which is exactly what 3.2.1 shipped with,
 * and nothing else in the suite noticed.
 *
 * Offline by construction: the raw URLs are mapped back to repo paths rather
 * than fetched, so this is deterministic and runs in CI without network.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW_PREFIX = "https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/";

/** Markdown image targets, `![alt](target)`. */
function imageTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

/** Repo-relative path for a target, or null when it points somewhere else. */
function repoPath(target: string): string | null {
  const raw = target.startsWith(RAW_PREFIX) ? target.slice(RAW_PREFIX.length) : target;
  if (/^https?:\/\//i.test(raw)) return null; // badge / third-party image
  return decodeURIComponent(raw);
}

describe("README images", () => {
  for (const file of ["README.md", "README.marketplace.md"]) {
    it(`${file} references only files that exist`, () => {
      const targets = imageTargets(readFileSync(path.join(root, file), "utf8"));
      // Guard the guard: a regex that matched nothing would pass silently.
      expect(targets.length).toBeGreaterThan(5);
      const missing = targets
        .map(repoPath)
        .filter((p): p is string => p !== null)
        .filter((p) => !existsSync(path.join(root, p)));
      expect(missing).toEqual([]);
    });
  }

  it("the marketplace listing uses absolute URLs — a store page has no repo root", () => {
    const targets = imageTargets(readFileSync(path.join(root, "README.marketplace.md"), "utf8"));
    const relative = targets.filter((t) => !/^https?:\/\//i.test(t));
    expect(relative).toEqual([]);
  });
});
