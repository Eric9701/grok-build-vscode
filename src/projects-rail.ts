/**
 * Pure helpers for the VS Code projects rail (primary side bar).
 *
 * Kept free of DOM / vscode so section ordering can be unit-tested without a
 * webview. The renderer in `media/projects-rail.js` mirrors this partition.
 */

/**
 * Identity key for a catalog cwd. Mirrors `cwdKey` in `media/chat.js` — the
 * shared rail has had the right rule all along and this one did not.
 *
 * An absolute POSIX path keeps its case and its characters: `/work/App` and
 * `/work/app` are two directories on Linux, and a backslash is a legal filename
 * character there, so folding either merged real projects into one. Only a
 * Windows-shaped path is lowercased and slash-normalised, where `C:\Repo` and
 * `c:/repo` genuinely are the same place.
 */
export function railRepoKey(cwd: string | undefined): string {
  const raw = String(cwd || "");
  if (raw.charAt(0) === "/") return raw.replace(/\/+$/, "");
  return raw.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

/** Path equality for catalog cwds. See {@link railRepoKey}. */
export function sameRepoCwd(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return railRepoKey(a) === railRepoKey(b);
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
 * Split the catalog into the project you are working in first, then the rest.
 *
 * `currentCwd` is the host's `repos.selectedCwd`, which is no longer a synonym
 * for VS Code's workspace root. It starts there, but the rail can move it —
 * "Open project", a per-project "+", or opening a conversation that belongs to
 * another project — and history, New Session and the chat header all follow.
 * The open FOLDER does not move; VS Code's Explorer is the one view that stays
 * put, which is the known and accepted gap.
 *
 * So "current" here means *the project Grok is working in*, not *the folder VS
 * Code has open*. They agree until you deliberately point the rail elsewhere.
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

/** Rows shown before and after expanding a per-project rail preview. */
export const RAIL_PREVIEW = 3;
export const RAIL_EXPANDED = 20;

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
 * The renderer assigns each returned id to one visible group at a time; this
 * helper only decides which ids qualify for RECENT and in what order.
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
