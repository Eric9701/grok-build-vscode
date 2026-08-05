import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { isPrimerText, isPrimerSummary } from "./grok-primer";
import type { PromptUsage } from "./acp-dispatch";

/** A session with at most this many recorded messages is cheap to confirm as empty
 *  (a primer-only session has ~4). The sweep only reads `chat_history.jsonl` for
 *  sessions under this bound, so it never touches large real sessions. */
export const EMPTY_PRIMER_MAX_MESSAGES = 20;

export interface SessionListEntry {
  id: string;
  cwd: string;
  displayName: string;
  rawSummary: string;
  customName?: string;
  updatedAt: number;
  createdAt: number;
  numMessages: number;
  modelId?: string;
  /** grok's `session_kind` when it marks a non-user session — a `spawn_subagent`
   *  delegation persists its child as a top-level session dir with
   *  `session_kind: "subagent"`; the history list hides those. */
  kind?: "subagent";
  /** Worktree label when this session's cwd is an isolated git worktree (P2-8). */
  worktreeLabel?: string;
  /** When the user pinned this conversation, from `SessionMetaOverride`. Drives
   *  the projects rail's Pinned group; absent means unpinned. */
  pinnedAt?: number;
}

export interface SessionMetaOverride {
  customName?: string;
  /** The extension's own title, taken from the first user message when a session's
   *  first turn completes. Deliberately NOT stored as `customName`: a name the
   *  user typed and a name we guessed are different claims, and writing the guess
   *  into the same field made it permanent — grok's own `session_summary` for that
   *  session could never surface, so history read as half-sentences of the opening
   *  prompt while `grok sessions list` showed a clean topic (#96). Ranks BELOW the
   *  CLI's title, so it only fills the gap before grok writes one. */
  autoName?: string;
  pinnedAt?: number;
  /** The checkout this pinned session lives in, captured when it was pinned. The
   *  Pinned group spans repos, so it must know where to read each session from —
   *  without this it would have to scan every repo in the catalog to find one
   *  conversation. Written and cleared together with `pinnedAt`. */
  pinnedCwd?: string;
  /** Isolated worktree this session is bound to (P2-8). Lets history reopen the
   *  right cwd and show a worktree badge without re-querying the CLI. */
  worktreePath?: string;
  worktreeLabel?: string;
  sourceGitRoot?: string;
  /** Session-cumulative billing (#53). Ours, not grok's: the CLI reports usage
   *  per prompt and persists only context size in `signals.json`, so this is the
   *  only thing that survives a reload. Absent = never measured (an old session,
   *  or a pre-usage CLI) — the popover then shows no breakdown rather than 0s. */
  usage?: PromptUsage;
  /** Per-turn billing, positioned like `plans`/`permissions`. `usage` above is
   *  just the sum of these. Kept separately because a rewind has to be able to
   *  SUBTRACT the discarded turns, and a single running total can't be undone —
   *  the extension is the only place per-turn usage exists at all (grok reports
   *  it per prompt and never persists it). Sessions predating this field keep
   *  their total uncorrected rather than losing it. */
  usageLog?: { afterUserMessage: number; afterHistoryEvent?: number; usage?: PromptUsage }[];
  /** Last verdict the user gave to an exit_plan_mode card in this session, for the restore-card label. */
  lastPlanVerdict?: "approved" | "rejected" | "abandoned";
  /** Every plan the user resolved in this session, in chronological order. grok's plan.md only
   *  retains the latest plan content on disk; saving each one here lets the resume view replay
   *  rejected/cancelled plans that grok overwrote later in the conversation. `afterUserMessage`
   *  plus `afterInterjection` positions repeated native revisions inside one prompt. */
  plans?: {
    text: string;
    verdict: "approved" | "rejected" | "abandoned";
    afterUserMessage?: number;
    afterInterjection?: number;
    afterHistoryEvent?: number;
  }[];
  /** Every permission card the user answered in this session, in order. The CLI
   *  doesn't replay `session/request_permission` on `session/load` (it's a server
   *  request, not a session update), so we persist the title + outcome here and
   *  replay each as a collapsed card. `afterUserMessage` positions it inline, like
   *  `plans`. */
  permissions?: { title: string; outcome: "allowed" | "rejected"; toolCallId?: string; afterUserMessage?: number; afterHistoryEvent?: number }[];
  /** Dashboard "unread" badge: a turn finished while this session wasn't focused and
   *  hasn't been opened since. Drives the green/red dot; cleared on open. Persisted
   *  (not tied to the live process) so the badge survives reaping and a reload. */
  unread?: boolean;
  /** The unread turn ended in an error (red dot instead of green). */
  unreadError?: boolean;
  /** Documents uploaded from a remote browser and staged in extension storage.
   *  Retained until the last session/fork referencing each path is deleted. */
  uploadedFiles?: string[];
}
export type SessionMetaOverrides = Record<string, SessionMetaOverride>;

/** Pick the newest user-visible session from an already-scoped history list. */
export function mostRecentSession(entries: readonly SessionListEntry[]): SessionListEntry | undefined {
  return entries
    .filter((entry) => entry.kind !== "subagent")
    .reduce<SessionListEntry | undefined>(
      (recent, entry) => !recent || entry.updatedAt > recent.updatedAt ? entry : recent,
      undefined,
    );
}

export interface RepoPin {
  cwd: string;
  pinnedAt: number;
}
export type RepoPins = Record<string, RepoPin>;

/** The user's own last word on where a project belongs in the remote client's
 *  rail, and when they said it. A choice is only in force until the project is
 *  worked in again: any conversation newer than `at` overrides it, which is what
 *  makes "using an archived project brings it back" need no bookkeeping.
 *
 *  `archived: false` is a real, stored answer — "keep showing me this one" —
 *  not the absence of one. Without it, unarchiving a long-idle project would be
 *  undone by the age rule on the very next render. */
export interface RepoArchiveChoice {
  cwd: string;
  at: number;
  archived: boolean;
}
export type RepoArchives = Record<string, RepoArchiveChoice>;

export interface RepoListEntry {
  cwd: string;
  label: string;
  available: boolean;
  pinned: boolean;
  pinnedAt?: number;
  updatedAt: number;
  worktreeLabel?: string;
  /** The stored choice above, flattened for the wire. Always present — a host
   *  that knows about archiving says so on every row, which is how the browser
   *  client tells "nothing archived" from "this host cannot archive" without
   *  asking a version number. Ordering here deliberately ignores both: the VS
   *  Code repo picker reads this same list and must not change. */
  archived: boolean;
  archivedAt: number;
}

/** Move a renamed session's `customName` from one id to another and drop the source entry. Used when
 *  a primer-only session is discarded and restarted under a new grok id (a model/effort switch on an
 *  empty session): the user's rename should follow to the new session, and the abandoned id's
 *  override must not linger. Only `customName` carries — a fresh session has no plans/unread/etc.
 *  worth keeping. Pure: removing the on-disk dir is the caller's job. Returns a new map; the input is
 *  left untouched. No-op carry when the source has no `customName` or `toId` is undefined. */
export function carrySessionName(
  overrides: SessionMetaOverrides,
  fromId: string,
  toId: string | undefined,
): SessionMetaOverrides {
  const next: SessionMetaOverrides = { ...overrides };
  const carried = next[fromId]?.customName?.trim();
  delete next[fromId];
  if (carried && toId) next[toId] = { ...(next[toId] ?? {}), customName: carried };
  return next;
}

/** The `(Fork)` tag on a forked session's name (#48). */
export const FORK_NAME_TAG = "(Fork)";

/** Name a fork after its parent, tagged `(Fork)` so it's identifiable in history.
 *
 *  **Leading**, not trailing: history rows ellipsize at the panel edge (and
 *  `fallbackName` truncates at 60 chars), so a trailing tag is the first thing to
 *  disappear — exactly the marker you need to still see in a narrow sidebar.
 *
 *  Idempotent: forking a fork must not stack ("(Fork) (Fork) Foo"), so a name
 *  already carrying the tag is returned unchanged. Matching ignores case but the
 *  parent's own casing is preserved. A blank parent name yields just "(Fork)"
 *  rather than a stray separator. Pure — persisting it is the caller's job. */
export function forkDisplayName(parentName: string | undefined): string {
  const base = (parentName ?? "").trim();
  if (!base) return FORK_NAME_TAG;
  if (base.toLowerCase().startsWith(FORK_NAME_TAG.toLowerCase())) return base;
  return `${FORK_NAME_TAG} ${base}`;
}

export interface FsLike {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, encoding: "utf8"): string;
  statSync(p: string): { isDirectory(): boolean; mtimeMs: number };
  rmSync?(p: string, opts?: { recursive?: boolean; force?: boolean }): void;
  rmdirSync(p: string, opts?: { recursive?: boolean }): void;
}

export interface ListDeps {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  overrides: SessionMetaOverrides;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface DeleteDeps {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  id: string;
}

/** Build the directory grok uses for sessions rooted at `cwd`. Mirrors grok's URL-encoded layout. */
export function sessionsDirFor(grokHome: string, cwd: string): string {
  const encoded = encodeURIComponent(cwd);
  const safeCatalog = encoded === "" ? "%00" : encoded === "." ? "%2E" : encoded === ".." ? "%2E%2E" : encoded;
  return path.join(grokHome, "sessions", safeCatalog);
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Grok session ids are opaque safe path segments, never paths themselves. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" &&
    SESSION_ID_RE.test(id) &&
    id !== "__proto__" &&
    id !== "prototype" &&
    id !== "constructor";
}

/** Resolve one session directory and independently prove it is a direct child
 * of the cwd's sessions directory. Undefined means the caller must not touch
 * the filesystem for the supplied id. */
export function sessionDirFor(grokHome: string, cwd: string, id: unknown): string | undefined {
  if (!isValidSessionId(id)) return undefined;
  const base = path.normalize(sessionsDirFor(grokHome, cwd));
  const candidate = path.join(base, id);
  const same = process.platform === "win32"
    ? path.dirname(candidate).toLowerCase() === base.toLowerCase()
    : path.dirname(candidate) === base;
  return same ? candidate : undefined;
}

/** Stable repo identity for globalState and remote-policy comparisons. */
export function normalizeRepoPath(cwd: string, platform = process.platform): string {
  let normalized = path.normalize((cwd || "").trim());
  if (normalized !== path.parse(normalized).root) normalized = normalized.replace(/[\\/]+$/, "");
  if (platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

function pathSegments(cwd: string): string[] {
  return (cwd || "").replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
}

/** Leaf labels by default; parent/leaf only for duplicate leaves. */
export function repoLabels(cwds: string[]): Map<string, string> {
  const leaves = new Map<string, number>();
  for (const cwd of cwds) {
    const parts = pathSegments(cwd);
    const leaf = parts.at(-1) || cwd;
    leaves.set(leaf.toLowerCase(), (leaves.get(leaf.toLowerCase()) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const cwd of cwds) {
    const parts = pathSegments(cwd);
    const leaf = parts.at(-1) || cwd;
    const duplicate = (leaves.get(leaf.toLowerCase()) ?? 0) > 1;
    out.set(cwd, duplicate && parts.length > 1 ? `${parts.at(-2)}/${leaf}` : leaf);
  }
  return out;
}

function isInsideOrEqual(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const a = normalizeRepoPath(candidate, platform);
  const b = normalizeRepoPath(root, platform);
  if (!a || !b) return false;
  const rel = path.relative(b, a);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface DiscoverReposDeps {
  fs: FsLike;
  grokHome: string;
  pins: RepoPins;
  /** Remote-rail archive choices. Reported on every row and acted on by nobody
   *  here — see RepoListEntry.archived. */
  archives?: RepoArchives;
  tmpDir: string;
  platform?: NodeJS.Platform;
  /** Host-known roots that remain selectable before Grok creates a catalog.
   *  These BYPASS the managed-worktree exclusion: that rule exists to keep
   *  worktrees from cluttering the list as rows, but the folder the user
   *  deliberately opened is not clutter — if VS Code is open on a worktree,
   *  that worktree IS the project, and dropping it leaves the selection naming
   *  a row that doesn't exist (which silently no-ops clear-all and selectRepo). */
  trustedCwds?: string[];
  worktreeLabels?: Map<string, string>;
  log?: (msg: string) => void;
}

/**
 * Enumerate cwd catalogs from `<grokHome>/sessions` without reading session
 * summaries. Temp-root catalogs and Grok-managed worktrees are rejected before
 * any cwd stat; only the surviving candidates are checked for availability.
 */
export function discoverRepos(deps: DiscoverReposDeps): RepoListEntry[] {
  const platform = deps.platform ?? process.platform;
  const sessionsRoot = path.join(deps.grokHome, "sessions");
  const worktreesRoot = path.join(deps.grokHome, "worktrees");
  const isManagedWorktree = (cwd: string) => isInsideOrEqual(cwd, worktreesRoot, platform);
  let encoded: string[] = [];
  try {
    if (deps.fs.existsSync(sessionsRoot)) encoded = deps.fs.readdirSync(sessionsRoot);
  } catch (e) {
    deps.log?.(`[sessions] failed to discover repos: ${(e as Error).message}`);
  }

  const byKey = new Map<string, Omit<RepoListEntry, "label">>();
  const archiveOf = (key: string) => {
    const choice = deps.archives?.[key];
    return { archived: !!choice?.archived, archivedAt: choice?.at ?? 0 };
  };
  for (const name of encoded) {
    let cwd = "";
    try { cwd = decodeURIComponent(name).trim(); } catch { continue; }
    if (
      !cwd ||
      !path.isAbsolute(cwd) ||
      isInsideOrEqual(cwd, deps.tmpDir, platform) ||
      isManagedWorktree(cwd)
    ) continue;
    const key = normalizeRepoPath(cwd, platform);
    if (!key || byKey.has(key)) continue;
    let available = false;
    try { available = deps.fs.statSync(cwd).isDirectory(); } catch { /* unavailable */ }
    if (!available) continue;
    let updatedAt = 0;
    try { updatedAt = deps.fs.statSync(path.join(sessionsRoot, name)).mtimeMs; } catch { /* best effort */ }
    const pin = deps.pins[key];
    byKey.set(key, {
      cwd,
      available: true,
      pinned: !!pin,
      pinnedAt: pin?.pinnedAt,
      updatedAt,
      worktreeLabel: deps.worktreeLabels?.get(key),
      ...archiveOf(key),
    });
  }

  for (const cwd of deps.trustedCwds ?? []) {
    if (!cwd || !path.isAbsolute(cwd)) continue;
    const key = normalizeRepoPath(cwd, platform);
    if (!key || byKey.has(key)) continue;
    let available = false;
    try { available = deps.fs.statSync(cwd).isDirectory(); } catch { /* unavailable */ }
    if (!available) continue;
    const pin = deps.pins[key];
    byKey.set(key, {
      cwd,
      available: true,
      pinned: !!pin,
      pinnedAt: pin?.pinnedAt,
      updatedAt: 0,
      worktreeLabel: deps.worktreeLabels?.get(key),
      ...archiveOf(key),
    });
  }

  // A pin is durable intent: keep it visible even when the checkout or its
  // session catalog is temporarily unavailable.
  for (const [key, pin] of Object.entries(deps.pins)) {
    if (
      !key ||
      byKey.has(key) ||
      !pin?.cwd ||
      !path.isAbsolute(pin.cwd) ||
      isManagedWorktree(pin.cwd)
    ) continue;
    let available = false;
    try { available = deps.fs.statSync(pin.cwd).isDirectory(); } catch { /* unavailable */ }
    byKey.set(key, {
      cwd: pin.cwd,
      available,
      pinned: true,
      pinnedAt: pin.pinnedAt,
      updatedAt: 0,
      worktreeLabel: deps.worktreeLabels?.get(key),
      ...archiveOf(key),
    });
  }

  const values = [...byKey.values()];
  const labels = repoLabels(values.map((r) => r.cwd));
  return values
    .map((r) => ({ ...r, label: labels.get(r.cwd) || r.cwd }))
    .sort((a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) ||
      b.updatedAt - a.updatedAt ||
      a.label.localeCompare(b.label),
    );
}

/** grok's own title for a session — `session_summary`, else `generated_title` —
 *  or "" when it has not produced a usable one. This is the title the CLI shows in
 *  `grok sessions list`, so preferring it keeps the same conversation recognizable
 *  in both surfaces (#96).
 *
 *  Legacy primer-derived titles are rejected: grok summarizes from message #1, and
 *  for sessions older extension versions started that message was our hidden
 *  primer — "Grok VSCode Plan Mode Hidden Primer" is not what that conversation is
 *  about. Both the summarized form ({@link isPrimerSummary}) and the raw marker
 *  ({@link isPrimerText}, which grok sometimes copies verbatim) are filtered. Pure. */
export function cliSessionTitle(summary?: string, generatedTitle?: string): string {
  for (const candidate of [summary, generatedTitle]) {
    const title = (candidate ?? "").trim();
    if (title && !isPrimerSummary(title) && !isPrimerText(title)) return title;
  }
  return "";
}

/** Default friendly name when no `customName` or `session_summary` is available. */
export function fallbackName(summary: string, updatedAt: number): string {
  const s = (summary || "").trim();
  if (s) return s.length > 60 ? s.slice(0, 57) + "…" : s;
  const d = new Date(updatedAt || Date.now());
  if (isNaN(d.getTime())) return "Untitled";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `Untitled (${yyyy}-${mm}-${dd} ${hh}:${mi})`;
}

function parseTimestamp(s: unknown, fallback: number): number {
  if (typeof s !== "string") return fallback;
  const t = Date.parse(s);
  return isNaN(t) ? fallback : t;
}

/** Parse one already-read summary.json into a list entry, applying any customName override. */
function buildEntry(
  dirName: string,
  raw: any,
  cwd: string,
  overrides: SessionMetaOverrides,
  fallbackNow: number,
): SessionListEntry {
  const id = (raw?.info?.id as string) ?? dirName;
  const sessCwd = (raw?.info?.cwd as string) ?? cwd;
  const rawSummary = typeof raw?.session_summary === "string" ? raw.session_summary : "";
  const updatedAt = parseTimestamp(raw?.updated_at, fallbackNow);
  const createdAt = parseTimestamp(raw?.created_at, updatedAt);
  const numMessages = typeof raw?.num_messages === "number" ? raw.num_messages : 0;
  const modelId = typeof raw?.current_model_id === "string" ? raw.current_model_id : undefined;
  const override = overrides[id];
  const customName = override?.customName?.trim() || undefined;
  // Precedence (#96): what the user called it, then what grok calls it, then our
  // own first-message guess, then the date. The middle step is the point — it is
  // the only one of the three that describes the conversation rather than its
  // opening line, and it is what the CLI shows for the same session.
  const generatedTitle = typeof raw?.generated_title === "string" ? raw.generated_title : "";
  const autoName = override?.autoName?.trim() || "";
  const displayName = customName || fallbackName(cliSessionTitle(rawSummary, generatedTitle) || autoName, updatedAt);
  const kind = raw?.session_kind === "subagent" ? ("subagent" as const) : undefined;
  const pinnedAt = typeof override?.pinnedAt === "number" ? override.pinnedAt : undefined;
  return { id, cwd: sessCwd, displayName, rawSummary, customName, updatedAt, createdAt, numMessages, modelId, kind, pinnedAt };
}

export interface SessionIndexEntry {
  /** Directory name = grok session id. */
  id: string;
  /** Modification time of the session's `summary.json` (ms). A cheap proxy for last activity —
   *  grok rewrites that file (which also holds `updated_at`) on every turn. */
  mtimeMs: number;
}

export interface IndexDeps {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  log?: (msg: string) => void;
}

/** Cheap ordering pass: every session id newest-first by `summary.json` mtime, WITHOUT reading or
 *  parsing any summary content. One `stat` per dir instead of a `stat` + `read` + `JSON.parse`, so
 *  it stays fast even with thousands of sessions. The caller reads (via `readSessionEntries`) only
 *  the window it actually shows. mtime is an approximate sort key; the exact `updated_at` order is
 *  re-applied within the loaded page after reading. */
export function indexSessions(deps: IndexDeps): SessionIndexEntry[] {
  const { fs, grokHome, cwd, log } = deps;
  const dir = sessionsDirFor(grokHome, cwd);
  if (!fs.existsSync(dir)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    log?.(`[sessions] failed to read ${dir}: ${(e as Error).message}`);
    return [];
  }
  const out: SessionIndexEntry[] = [];
  for (const name of names) {
    const resolvedSessionDir = sessionDirFor(grokHome, cwd, name);
    if (!resolvedSessionDir) continue;
    const summaryPath = path.join(resolvedSessionDir, "summary.json");
    let st: { mtimeMs: number };
    try {
      // A stat on summary.json doubles as the "is this a real session dir?" check: a stray file
      // entry (or a dir without summary.json) makes the join non-existent and statSync throws.
      st = fs.statSync(summaryPath);
    } catch {
      continue;
    }
    out.push({ id: name, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export interface ReadEntriesDeps {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  ids: string[];
  overrides: SessionMetaOverrides;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Read + parse summary.json for exactly the given ids (a page), returning full list entries in the
 *  same order. Malformed or vanished entries are skipped. This is the only path that touches file
 *  content, so callers keep it to the visible window. */
export function readSessionEntries(deps: ReadEntriesDeps): SessionListEntry[] {
  const { fs, grokHome, cwd, ids, overrides, log } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const out: SessionListEntry[] = [];
  for (const id of ids) {
    const resolvedSessionDir = sessionDirFor(grokHome, cwd, id);
    if (!resolvedSessionDir) continue;
    const summaryPath = path.join(resolvedSessionDir, "summary.json");
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    } catch (e) {
      log?.(`[sessions] could not read summary.json for ${id}: ${(e as Error).message}`);
      continue;
    }
    out.push(buildEntry(id, raw, cwd, overrides, now));
  }
  return out;
}

export interface ContextUsage {
  used: number;
  window?: number;
}

/** Read grok's persisted context usage from a session's `signals.json`
 *  (`contextTokensUsed` / `contextWindowTokens`). grok rewrites the file at the
 *  end of every turn — including a `/compact` turn — so it carries the real
 *  post-compact size that the ACP result meta doesn't (grok reports
 *  `totalTokens: 0` there, which the host strips; see `gateZeroTokenMeta`).
 *  It's also the only source of a count before any live turn has run, i.e. on
 *  a cold restore. Null when the file is missing/unreadable or the count isn't
 *  a positive number. Pure. */
export function readContextUsage(deps: { fs: FsLike; grokHome: string; cwd: string; id: string }): ContextUsage | null {
  const { fs, grokHome, cwd, id } = deps;
  const resolvedSessionDir = sessionDirFor(grokHome, cwd, id);
  if (!resolvedSessionDir) return null;
  const signalsPath = path.join(resolvedSessionDir, "signals.json");
  try {
    const raw = JSON.parse(fs.readFileSync(signalsPath, "utf8"));
    const used = raw?.contextTokensUsed;
    if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) return null;
    const window = raw?.contextWindowTokens;
    const hasWindow = typeof window === "number" && Number.isFinite(window) && window > 0;
    return { used, window: hasWindow ? window : undefined };
  } catch {
    return null;
  }
}

/** Full session list sorted by last activity. Equivalent to `indexSessions` + `readSessionEntries`
 *  over every id; reads every summary.json, so prefer the paginated index/read primitives on hot
 *  paths. Kept for callers that genuinely need the whole list at once. */
export function listSessions(deps: ListDeps): SessionListEntry[] {
  const { fs, grokHome, cwd, overrides, log } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const index = indexSessions({ fs, grokHome, cwd, log });
  const out = readSessionEntries({
    fs,
    grokHome,
    cwd,
    ids: index.map((e) => e.id),
    overrides,
    now: () => now,
    log,
  });
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** Pull the user-visible queries out of a grok `chat_history.jsonl`. grok wraps the
 *  user's actual prompt in `<user_query>…</user_query>` inside a `role:"user"`
 *  message; the separate `role:"user"` `<user_info>` context block carries no
 *  `<user_query>` and is naturally skipped. Non-user roles (system/assistant/
 *  reasoning) are ignored. Unparseable lines are skipped. Pure. */
export function extractUserQueries(chatHistoryJsonl: string): string[] {
  const out: string[] = [];
  for (const line of (chatHistoryJsonl ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    // grok keys the role on `type` (string like "system"/"user"/"reasoning"); some
    // builds use `role`. Either way we want only user turns.
    const role = o?.type ?? o?.role;
    if (role !== "user") continue;
    // Synthetic user turns — injected <system-reminder> / project-instructions /
    // background-task results — are not real queries; grok tags them `synthetic_reason`.
    if (o?.synthetic_reason) continue;
    const content = o?.content;
    const text = (
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
          : ""
    ).trim();
    if (!text) continue;
    // Skip the environment-context block (carries no user prompt) and any stray
    // reminder that wasn't flagged synthetic.
    if (/^<user_info>/.test(text) || /^<system-reminder>/.test(text)) continue;
    // The prompt is usually wrapped in <user_query>…</user_query>, but NOT always —
    // grok/composer sends some prompts (notably slash commands like `/imagine`) as a
    // plain user message with no wrapper. Counting only wrapped queries made those
    // sessions look primer-only, so a real one could be swept. Unwrap when present,
    // otherwise take the message verbatim. (Tolerate a missing closing tag.)
    const m = text.match(/<user_query>([\s\S]*?)(?:<\/user_query>|$)/);
    out.push((m ? m[1] : text).trim());
  }
  return out;
}

/** True when a `chat_history.jsonl` is written in the shape {@link extractUserQueries}
 *  knows how to read: at least one line parses as JSON carrying a role.
 *
 *  This is a safety interlock, not a parser. "No real user queries" is only
 *  evidence of an empty session if we could read the file at all — and a reader
 *  that silently skips what it does not recognize cannot tell "nothing was said"
 *  from "grok changed the format". Without this, one CLI schema change would turn
 *  the sweep from a cleanup into a shredder that finds EVERY session empty. A
 *  truncated final line (a write in progress) still leaves the earlier ones
 *  parseable, so this refuses the catastrophic case without refusing the ordinary
 *  one. Pure. */
export function historyIsIntelligible(chatHistoryJsonl: string): boolean {
  for (const line of (chatHistoryJsonl ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    if (typeof (o?.type ?? o?.role) === "string") return true;
  }
  return false;
}

/** Split a session's user queries into primer vs. real. A session is "empty" when
 *  it received our hidden primer and never a real (non-primer) query. Pure. */
export function classifyUserQueries(chatHistoryJsonl: string): { primer: number; real: number } {
  let primer = 0;
  let real = 0;
  for (const q of extractUserQueries(chatHistoryJsonl)) {
    if (isPrimerText(q)) primer++;
    else real++;
  }
  return { primer, real };
}

export interface EmptySessionInput {
  /** A user rename means the session matters — never empty, whatever its content. */
  customName?: string;
  /** A pinned conversation is the same kind of deliberate intent as a rename. */
  pinnedAt?: number;
  /** A session bound to an isolated worktree backs a checkout the user asked for.
   *  `parkFocused` already refuses to auto-delete one; so does this. */
  worktreePath?: string;
  /** grok's `session_kind`. A `subagent` directory is a delegation's own
   *  transcript — never a conversation the user started, and not ours to remove. */
  kind?: string;
  /** `num_messages` from summary.json (the cheap gate; a primer-only session is ~4). */
  numMessages: number;
  /** `session_summary` from summary.json (fallback signal when no chat history). */
  summary?: string;
  /** `generated_title` from summary.json (fallback signal when no chat history). */
  generatedTitle?: string;
  /** `chat_history.jsonl` contents — the authoritative signal when provided.
   *  Undefined means the file is NOT THERE, which is itself evidence; a file that
   *  exists but could not be read must arrive as `historyUnreadable` instead. */
  chatHistory?: string;
  /** The history file exists but could not be read (locked, permissions). We
   *  cannot prove the session is empty, so we must not claim that it is. */
  historyUnreadable?: boolean;
}

/** Decide whether a session directory holds no conversation at all and is safe to
 *  delete.
 *
 *  Chat history is authoritative — but only when it can be read AND understood. A
 *  session is empty iff its history is in a shape we can parse and carries **zero
 *  real user queries**. That covers both shapes we have shipped — the legacy
 *  primer-only session (our hidden primer, no real turn) and today's primer-free
 *  one (a session grok created for a view that was never typed into). Requiring a
 *  primer, as this did until the primer was retired, made the check a no-op on
 *  every session created since: nothing was removing them, and they piled up in
 *  history as unloadable "Untitled" rows (#97).
 *
 *  `num_messages` deliberately does NOT veto the content signal. An agentic primer
 *  turn could balloon to dozens of tool/reasoning messages with no real user query
 *  (and grok re-primes on restore/compact), which once left such sessions — a real
 *  74-message one — in history forever.
 *
 *  Without any history file the honest signals are the message count and the
 *  title: nothing written at all is empty, and a low-message session wearing a
 *  primer-derived title is the legacy case. Pure. */
export function isEmptySession(
  inp: EmptySessionInput,
  maxMessages = EMPTY_PRIMER_MAX_MESSAGES,
): boolean {
  if (inp.customName?.trim()) return false;
  if (typeof inp.pinnedAt === "number") return false;
  if (inp.worktreePath?.trim()) return false;
  if (inp.kind === "subagent") return false;
  if (inp.historyUnreadable) return false;
  if ((inp.chatHistory ?? "").trim()) {
    // Read it, or refuse to judge it. A file we cannot parse is not an empty
    // conversation — see historyIsIntelligible.
    if (!historyIsIntelligible(inp.chatHistory!)) return false;
    return classifyUserQueries(inp.chatHistory!).real === 0;
  }
  // Either no history file, or one with nothing in it yet.
  if (inp.numMessages > maxMessages) return false;
  const title = `${inp.summary ?? ""} ${inp.generatedTitle ?? ""}`;
  // A directory holding nothing but summary.json: grok registered the session and
  // no turn ever reached it. The commonest producer is a window opened on a repo
  // and closed again without a prompt.
  if (inp.numMessages === 0 && !title.trim()) return true;
  return isPrimerSummary(title);
}

/** Remove the on-disk session directory. No-op if missing. */
export function deleteSessionDir(deps: DeleteDeps): void {
  const { fs, grokHome, cwd, id } = deps;
  const dir = sessionDirFor(grokHome, cwd, id);
  if (!dir) return;
  if (!fs.existsSync(dir)) return;
  if (fs.rmSync) {
    fs.rmSync(dir, { recursive: true, force: true });
  } else {
    fs.rmdirSync(dir, { recursive: true });
  }
}

export interface ClearDeps {
  fs: FsLike;
  grokHome: string;
  cwd: string;
  /** Session id to keep (the live/focused one — grok re-persists it, so deleting it wouldn't stick). */
  exceptId?: string;
  /** Session ids to keep when more than one live view owns history in this cwd. */
  exceptIds?: Iterable<string>;
}

/** Remove every session directory under `cwd`, optionally keeping selected ids. Returns the ids it removed.
 *  Best-effort: a directory that fails to remove is skipped, not thrown, so one locked dir doesn't
 *  abort the sweep. The directory name is the session id (mirrors `deleteSessionDir`). */
export function clearSessions(deps: ClearDeps): string[] {
  const { fs, grokHome, cwd, exceptId, exceptIds } = deps;
  const kept = new Set(exceptIds);
  if (exceptId) kept.add(exceptId);
  const dir = sessionsDirFor(grokHome, cwd);
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (kept.has(name)) continue;
    const full = sessionDirFor(grokHome, cwd, name);
    if (!full) continue;
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      if (fs.rmSync) fs.rmSync(full, { recursive: true, force: true });
      else fs.rmdirSync(full, { recursive: true });
      removed.push(name);
    } catch {
      continue;
    }
  }
  return removed;
}

/** Default node fs adapter for production use. */
export const defaultFs: FsLike = {
  existsSync: nodeFs.existsSync,
  readdirSync: (p) => nodeFs.readdirSync(p) as string[],
  readFileSync: (p, enc) => nodeFs.readFileSync(p, enc),
  statSync: (p) => nodeFs.statSync(p),
  rmSync: (nodeFs as any).rmSync
    ? (p, opts) => (nodeFs as any).rmSync(p, opts)
    : undefined,
  rmdirSync: (p, opts) => nodeFs.rmdirSync(p, opts as any),
};

/** Resolve the grok home directory the way the CLI does: `$GROK_HOME` override
 *  first, else `<home>/.grok` where home is USERPROFILE on Windows and HOME
 *  elsewhere (the CLI's Rust `std::env::home_dir()` ignores HOME on Windows) —
 *  now genuinely matching cli-locator's `effectiveHome()`. The old
 *  `HOME || USERPROFILE` read the wrong `.grok` on Windows boxes with HOME set
 *  (git-bash), splitting session history from where the CLI writes it. */
export function resolveGrokHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.GROK_HOME) return env.GROK_HOME;
  const fromEnv = platform === "win32" ? env.USERPROFILE : env.HOME;
  return path.join(fromEnv || homedir(), ".grok");
}

/** True when `p` resolves strictly inside directory `root` (never `root`
 *  itself). A path-segment boundary check, not a string-prefix one: `root/..foo`
 *  is inside (a legal dir name that merely starts with dots), `root/../x` and
 *  `root` are not, and a different-root path (other drive) is not. */
export function isPathInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}
