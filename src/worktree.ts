/**
 * Pure helpers for Grok's git-worktree surface (`_x.ai/git/worktree/*`).
 *
 * Wire format (probe-confirmed on CLI 0.2.111 — see research/worktree.md):
 *   create  { sessionId, sourcePath, label? } → { status:"creating", worktreePath, sourceGitRoot, sessionId }
 *           + async `_x.ai/git/worktree/status` { status:"progress"|"created", … }
 *   list    {} | filters → { result: WorktreeRecord[] }  (snake_case fields)
 *   show    { idOrPath } → WorktreeRecord | null
 *   apply   { sessionId, worktreePath } → { status:"success", files[], gitRoot }
 *   remove  { worktreePath } → { removed:true, resolvedPath }
 *
 * Methods are `_`-prefixed on the wire; bare `x.ai/...` is -32601.
 */

import * as path from "node:path";

/** Leading history/toolbar tag for a worktree-isolated session. */
export const WORKTREE_NAME_TAG = "(WT)";

export interface WorktreeRecord {
  id: string;
  path: string;
  sourceRepo: string;
  repoName: string;
  kind: string;
  creationMode: string;
  gitRef: string;
  headCommit: string;
  sessionId?: string;
  status: string;
  label: string;
  userProvidedLabel: boolean;
  createdAt?: number;
}

export interface WorktreeCreateResult {
  status: string;
  sessionId?: string;
  worktreePath: string;
  sourceGitRoot: string;
}

export interface WorktreeApplyFile {
  path: string;
  type: string;
  additions: number;
  deletions: number;
}

export interface WorktreeApplyResult {
  status: string;
  files: WorktreeApplyFile[];
  gitRoot: string;
}

export interface WorktreeRemoveResult {
  removed: boolean;
  resolvedPath: string;
}

export interface WorktreeStatusUpdate {
  status: string;
  sessionId?: string;
  worktreePath?: string;
  sourceGitRoot?: string;
  message?: string;
  commit?: string;
}

/**
 * Grok double-wraps many extension results as `{ result: T }` inside the
 * JSON-RPC `result` field. Unwrap one layer when present so callers see T.
 * Pure — accepts any unknown payload.
 */
export function unwrapExtResult<T = unknown>(payload: unknown): T {
  if (payload && typeof payload === "object" && "result" in (payload as object)) {
    return (payload as { result: T }).result;
  }
  return payload as T;
}

/** Case-fold + normalize separators for path equality on Windows/macOS/Linux. */
export function normalizeFsPath(p: string): string {
  if (!p) return "";
  const resolved = path.resolve(p);
  // Windows paths are case-insensitive; elsewhere keep the original case after resolve.
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pathsEqual(a: string, b: string): boolean {
  return normalizeFsPath(a) === normalizeFsPath(b);
}

/** True when `candidate` is the same path as `root` or lives under it. */
export function pathIsInside(candidate: string, root: string): boolean {
  const c = normalizeFsPath(candidate);
  const r = normalizeFsPath(root);
  if (!c || !r) return false;
  if (c === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(prefix);
}

/**
 * Best-effort "is this a git working tree?" without spawning git: a `.git`
 * file (worktree) or directory (main checkout) at `cwd` (or an ancestor).
 * Pure against an injected fs.
 */
export function isGitRepo(
  cwd: string,
  fs: { existsSync(p: string): boolean; statSync?(p: string): { isDirectory(): boolean; isFile(): boolean } },
): boolean {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    const git = path.join(dir, ".git");
    if (fs.existsSync(git)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** Parse one raw list/show row (snake_case from the CLI) into a WorktreeRecord. */
export function parseWorktreeRecord(raw: any): WorktreeRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const wtPath = typeof raw.path === "string" ? raw.path : typeof raw.worktreePath === "string" ? raw.worktreePath : "";
  if (!wtPath) return null;
  const id = typeof raw.id === "string" ? raw.id : wtPath;
  const meta = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
  const label =
    (typeof meta.label === "string" && meta.label) ||
    (typeof raw.label === "string" && raw.label) ||
    path.basename(wtPath);
  return {
    id,
    path: wtPath,
    sourceRepo: typeof raw.source_repo === "string" ? raw.source_repo : typeof raw.sourceRepo === "string" ? raw.sourceRepo : "",
    repoName: typeof raw.repo_name === "string" ? raw.repo_name : typeof raw.repoName === "string" ? raw.repoName : "",
    kind: typeof raw.kind === "string" ? raw.kind : "",
    creationMode: typeof raw.creation_mode === "string" ? raw.creation_mode : typeof raw.creationMode === "string" ? raw.creationMode : "",
    gitRef: typeof raw.git_ref === "string" ? raw.git_ref : typeof raw.gitRef === "string" ? raw.gitRef : "",
    headCommit: typeof raw.head_commit === "string" ? raw.head_commit : typeof raw.headCommit === "string" ? raw.headCommit : "",
    sessionId: typeof raw.session_id === "string" ? raw.session_id : typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    status: typeof raw.status === "string" ? raw.status : "alive",
    label,
    userProvidedLabel: meta.user_provided === true || meta.userProvided === true,
    createdAt: typeof raw.created_at === "number" ? raw.created_at : typeof raw.createdAt === "number" ? raw.createdAt : undefined,
  };
}

/** Parse a list RPC payload into WorktreeRecord[]. Handles double-wrapped `{result:[…]}`. */
export function parseWorktreeList(payload: unknown): WorktreeRecord[] {
  const unwrapped = unwrapExtResult(payload);
  const arr = Array.isArray(unwrapped)
    ? unwrapped
    : unwrapped && typeof unwrapped === "object" && Array.isArray((unwrapped as any).result)
      ? (unwrapped as any).result
      : [];
  const out: WorktreeRecord[] = [];
  for (const row of arr) {
    const rec = parseWorktreeRecord(row);
    if (rec) out.push(rec);
  }
  return out;
}

export function parseWorktreeCreate(payload: unknown): WorktreeCreateResult | null {
  const r = unwrapExtResult<any>(payload);
  if (!r || typeof r !== "object") return null;
  const worktreePath = typeof r.worktreePath === "string" ? r.worktreePath : "";
  if (!worktreePath) return null;
  return {
    status: typeof r.status === "string" ? r.status : "creating",
    sessionId: typeof r.sessionId === "string" ? r.sessionId : undefined,
    worktreePath,
    sourceGitRoot: typeof r.sourceGitRoot === "string" ? r.sourceGitRoot : "",
  };
}

export function parseWorktreeApply(payload: unknown): WorktreeApplyResult | null {
  const r = unwrapExtResult<any>(payload);
  if (!r || typeof r !== "object") return null;
  const filesRaw = Array.isArray(r.files) ? r.files : [];
  const files: WorktreeApplyFile[] = filesRaw.map((f: any) => ({
    path: typeof f?.path === "string" ? f.path : "",
    type: typeof f?.type === "string" ? f.type : "",
    additions: typeof f?.additions === "number" ? f.additions : 0,
    deletions: typeof f?.deletions === "number" ? f.deletions : 0,
  }));
  return {
    status: typeof r.status === "string" ? r.status : "success",
    files,
    gitRoot: typeof r.gitRoot === "string" ? r.gitRoot : "",
  };
}

export function parseWorktreeRemove(payload: unknown): WorktreeRemoveResult | null {
  const r = unwrapExtResult<any>(payload);
  if (!r || typeof r !== "object") return null;
  return {
    removed: r.removed === true || r.removed === "true",
    resolvedPath: typeof r.resolvedPath === "string" ? r.resolvedPath : typeof r.worktreePath === "string" ? r.worktreePath : "",
  };
}

/** Parse a `_x.ai/git/worktree/status` notification params blob. */
export function parseWorktreeStatus(params: unknown): WorktreeStatusUpdate | null {
  if (!params || typeof params !== "object") return null;
  const p = params as any;
  const status = typeof p.status === "string" ? p.status : "";
  if (!status) return null;
  return {
    status,
    sessionId: typeof p.sessionId === "string" ? p.sessionId : undefined,
    worktreePath: typeof p.worktreePath === "string" ? p.worktreePath : undefined,
    sourceGitRoot: typeof p.sourceGitRoot === "string" ? p.sourceGitRoot : undefined,
    message: typeof p.message === "string" ? p.message : undefined,
    commit: typeof p.commit === "string" ? p.commit : undefined,
  };
}

/**
 * Worktrees whose source repo is the given workspace (or live under it).
 * Alive-only by default so dead records don't open phantom session catalogs.
 */
export function worktreesForRepo(
  records: WorktreeRecord[],
  workspaceRoot: string,
  opts?: { includeDead?: boolean },
): WorktreeRecord[] {
  return records.filter((r) => {
    if (!opts?.includeDead && r.status && r.status !== "alive") return false;
    if (!r.sourceRepo) return pathsEqual(r.path, workspaceRoot) || pathIsInside(r.path, workspaceRoot);
    return pathsEqual(r.sourceRepo, workspaceRoot);
  });
}

/**
 * Name a worktree session for history: leading `(WT) <label>`.
 * Idempotent — already-tagged names are returned unchanged.
 */
export function worktreeDisplayName(label: string | undefined): string {
  const base = (label ?? "").trim();
  if (!base) return WORKTREE_NAME_TAG;
  if (base.toLowerCase().startsWith(WORKTREE_NAME_TAG.toLowerCase())) return base;
  return `${WORKTREE_NAME_TAG} ${base}`;
}

/** True when a session cwd is one of the given worktree paths. */
export function matchWorktreeForCwd(
  cwd: string,
  records: WorktreeRecord[],
): WorktreeRecord | undefined {
  return records.find((r) => pathsEqual(r.path, cwd));
}

/**
 * Merge session index entries from several cwds, de-duping by id
 * (first wins — caller should put the preferred catalog first).
 */
export function mergeSessionIndexes(
  indexes: Array<{ cwd: string; entries: Array<{ id: string; mtimeMs: number }> }>,
): Array<{ id: string; mtimeMs: number; cwd: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; mtimeMs: number; cwd: string }> = [];
  for (const { cwd, entries } of indexes) {
    for (const e of entries) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, mtimeMs: e.mtimeMs, cwd });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Sanitize a user-typed worktree label for the create RPC (no path separators). */
export function sanitizeWorktreeLabel(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "")
    .slice(0, 64);
}
