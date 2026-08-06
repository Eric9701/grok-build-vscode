/**
 * Pure project-discovery seeding for the desktop open-folder set.
 *
 * Seeding is a one-shot heuristic: open checkouts that look actively used, then
 * leave the set user-owned. It must never run as a live mirror of ~/.grok
 * (throwaway agent cwds would permanently pollute the rail) and must never be
 * triggered from the renderer.
 *
 * Threshold: ≥ {@link PROJECT_DISCOVERY_MIN_SESSIONS} sessions whose
 * summary.json mtime falls inside the last {@link PROJECT_DISCOVERY_WINDOW_MS}.
 */

/** Minimum sessions inside the window for a checkout to be auto-opened. */
export const PROJECT_DISCOVERY_MIN_SESSIONS = 10;

/** Look-back window for "recent" sessions (~3 months). */
export const PROJECT_DISCOVERY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Whether a checkout meets the auto-open bar given its session activity stamps
 * (typically summary.json mtimes from {@link indexSessions}).
 */
export function meetsProjectDiscoveryThreshold(
  sessionTimestampsMs: readonly number[],
  nowMs: number,
  opts?: { minSessions?: number; windowMs?: number },
): boolean {
  const min = opts?.minSessions ?? PROJECT_DISCOVERY_MIN_SESSIONS;
  const windowMs = opts?.windowMs ?? PROJECT_DISCOVERY_WINDOW_MS;
  if (min <= 0) return true;
  if (!Number.isFinite(nowMs) || windowMs < 0) return false;
  const floor = nowMs - windowMs;
  let count = 0;
  for (const t of sessionTimestampsMs) {
    if (typeof t !== "number" || !Number.isFinite(t)) continue;
    if (t >= floor) {
      count++;
      if (count >= min) return true;
    }
  }
  return false;
}

/**
 * Decide whether the host should run discovery seeding.
 *
 * **First run / never seeded:** `discoverySeedCompleted === false` and nothing
 * open → seed (even if discovery finds zero projects — the rail simply stays
 * empty and the user can Add Project Folder).
 *
 * **Already seeded:** never seed again. Closing every folder later is a
 * deliberate empty set; re-opening throwaways would undo that choice.
 *
 * **Non-empty open set:** never seed — the user (or a prior seed / prefs
 * restore) already owns the list. A first launch with `--workspace=` or a
 * restored prefs file falls here.
 *
 * Note: "first run" and "list is empty" are not independent after the seed
 * flag is set — empty + completed does **not** re-seed. That is intentional
 * and is what makes "close everything" stick across restarts.
 */
export function shouldSeedProjectDiscovery(opts: {
  discoverySeedCompleted: boolean;
  openFolderCount: number;
}): boolean {
  if (opts.discoverySeedCompleted) return false;
  return opts.openFolderCount <= 0;
}

/**
 * Pick absolute cwd paths that meet the threshold, preserving input order.
 * Does not open folders — callers feed the result into addWorkspaceFolder.
 */
export function selectProjectsToSeed(
  candidates: readonly { cwd: string; sessionTimestampsMs: readonly number[] }[],
  nowMs: number,
  opts?: { minSessions?: number; windowMs?: number },
): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    if (!c?.cwd || typeof c.cwd !== "string") continue;
    if (meetsProjectDiscoveryThreshold(c.sessionTimestampsMs ?? [], nowMs, opts)) {
      out.push(c.cwd);
    }
  }
  return out;
}

/**
 * Strip archive fields so the webview's capability probe
 * (`typeof repo.archived === "boolean"`) reports "host cannot archive".
 * Used when {@link Host.canArchiveRepos} is false (desktop curated rail).
 */
export function withoutArchiveFields<T extends { archived?: boolean; archivedAt?: number }>(
  entry: T,
): Omit<T, "archived" | "archivedAt"> {
  const { archived: _a, archivedAt: _b, ...rest } = entry;
  return rest;
}
