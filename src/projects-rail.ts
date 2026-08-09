/**
 * Pure helpers for the VS Code projects rail (primary side bar).
 *
 * Kept free of DOM / vscode so section ordering can be unit-tested without a
 * webview. The renderer in `media/projects-rail.js` mirrors this partition.
 */

/** Path equality for catalog cwds — case-insensitive on Windows, slash-normalised. */
export function sameRepoCwd(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export interface RailRepoRow {
  cwd: string;
  label?: string;
  available?: boolean;
  archived?: boolean;
  color?: string;
  updatedAt?: number;
}

/**
 * Split the catalog into the open folder first, then everything else.
 *
 * `currentCwd` is VS Code's workspace root (the host's `repos.selectedCwd` for
 * the extension). Multi-root is out of scope — one open folder, one "current".
 */
export function partitionRailRepos<T extends RailRepoRow>(
  entries: readonly T[],
  currentCwd: string,
): { current: T | undefined; other: T[] } {
  const current = entries.find((r) => sameRepoCwd(r.cwd, currentCwd));
  const other = entries
    .filter((r) => !sameRepoCwd(r.cwd, currentCwd))
    // By name only — activity reordering moves the row under the cursor.
    .slice()
    .sort((a, b) => {
      const la = (a.label || leaf(a.cwd)).toLowerCase();
      const lb = (b.label || leaf(b.cwd)).toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
  return { current, other };
}

function leaf(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}
