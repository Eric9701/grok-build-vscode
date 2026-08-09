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

/**
 * Cap for the cross-project RECENT list. Deliberately lower than the per-project
 * preview depth (20) — Recent is a shortcut across every project, not a second
 * history page. Owner decision; do not reuse PREVIEW_LIMIT.
 */
export const RAIL_RECENT_CAP = 10;

/** Minimal session shape the rail needs to rank and open a conversation. */
export interface RailSessionRow {
  id: string;
  cwd?: string;
  displayName?: string;
  updatedAt?: number;
  pinnedAt?: number;
}

/**
 * Most-recent conversations across every loaded project list, plus pinned rows
 * that may not sit in those previews. Newest first; ids unique within the
 * result. Cap defaults to {@link RAIL_RECENT_CAP}.
 *
 * Overlap with PINNED / per-project lists is intentional — a shortcut, not a
 * partition.
 */
export function collectRecentSessions(
  lists: readonly (readonly RailSessionRow[])[],
  pinned: readonly RailSessionRow[] = [],
  cap: number = RAIL_RECENT_CAP,
): RailSessionRow[] {
  const byId = new Map<string, RailSessionRow>();
  for (const list of lists) {
    for (const s of list) {
      if (s && s.id) byId.set(s.id, s);
    }
  }
  for (const s of pinned) {
    if (!s || !s.id) continue;
    // Prefer the pinned record when both exist (carries pinnedAt).
    const prev = byId.get(s.id);
    byId.set(s.id, prev ? { ...prev, ...s } : s);
  }
  const limit = Math.max(0, cap);
  return [...byId.values()]
    .sort(
      (a, b) =>
        (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) ||
        String(b.id || "").localeCompare(String(a.id || "")),
    )
    .slice(0, limit);
}

function leaf(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}
