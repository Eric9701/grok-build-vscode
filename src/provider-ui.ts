import type { ModelInfo } from "./acp";
import type { AcpProvider, BackendSessionListEntry } from "./acp-backend";
import { normalizeWorkspaceFsPath } from "./host";
import type { SessionListEntry, SessionMetaOverrides } from "./sessions";

export const PROVIDER_ORDER: readonly AcpProvider[] = ["grok", "codex"];

export interface ProviderConnections {
  grok?: boolean;
  codex?: boolean;
}

export interface ProviderModelCacheEntry {
  models: ModelInfo[];
  currentModelId?: string;
  seenAt: number;
}

export type ProviderModelCache = Partial<Record<AcpProvider, ProviderModelCacheEntry>>;

export interface ProjectProviderDefault {
  provider: AcpProvider;
  modelId?: string;
}

export type ProjectProviderDefaults = Record<string, ProjectProviderDefault>;

export interface CodexHistoryHighWater {
  updatedAt: number;
  id: string;
}

export interface ProviderHistoryCursor {
  grokOffset: number;
  codexHighWater?: CodexHistoryHighWater;
}

export interface GrokHistoryPage {
  entries: readonly SessionListEntry[];
  nextOffset: number;
  total: number;
}

export interface ProviderModelInfo extends ModelInfo {
  provider: AcpProvider;
  defaultImplied?: boolean;
}

export function projectProviderKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return normalizeWorkspaceFsPath(cwd, platform);
}

/** A provider session id is globally unique. Any collection crossing provider,
 * cache, or live/disk boundaries must collapse on id alone before it reaches a
 * renderer. The newest record wins because it carries the freshest title/cwd. */
export function dedupeSessionEntriesById(
  entries: readonly SessionListEntry[],
): SessionListEntry[] {
  const byId = new Map<string, SessionListEntry>();
  for (const entry of entries) {
    const previous = byId.get(entry.id);
    if (!previous || entry.updatedAt > previous.updatedAt) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export function connectedProviderIds(
  connections: ProviderConnections,
  located: Partial<Record<AcpProvider, boolean>>,
): AcpProvider[] {
  return PROVIDER_ORDER.filter((provider) => connections[provider] === true && located[provider] === true);
}

export function providerLoginState(provider: AcpProvider): "auth-required" | "codex-login" {
  return provider === "codex" ? "codex-login" : "auth-required";
}

export function findCachedCodexSession(
  catalogs: Iterable<readonly SessionListEntry[]>,
  id: string,
  allowedCwds: readonly string[],
  belongsToAllowedCwd: (cwd: string, allowedCwds: readonly string[]) => boolean,
): SessionListEntry | undefined {
  for (const entries of catalogs) {
    const found = entries.find((entry) =>
      entry.provider === "codex" && entry.id === id && belongsToAllowedCwd(entry.cwd, allowedCwds)
    );
    if (found) return found;
  }
  return undefined;
}

export function modelsForConnectedProviders(
  providers: readonly AcpProvider[],
  cache: ProviderModelCache,
  live?: { provider: AcpProvider; models: readonly ModelInfo[]; currentModelId?: string },
): ProviderModelInfo[] {
  const out: ProviderModelInfo[] = [];
  for (const provider of PROVIDER_ORDER) {
    if (!providers.includes(provider)) continue;
    const source = live?.provider === provider && live.models.length
      ? live.models
      : cache[provider]?.models ?? [];
    if (!source.length) {
      out.push({
        provider,
        modelId: "",
        name: provider === "grok" ? "Grok default" : "Codex default",
        description: "Uses this agent's default model",
        defaultImplied: true,
      });
      continue;
    }
    for (const model of source) out.push({ ...model, provider });
  }
  return out;
}

export function codexListEntry(
  raw: BackendSessionListEntry,
  overrides: SessionMetaOverrides,
  now = Date.now(),
): SessionListEntry {
  const meta = overrides[raw.sessionId];
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const parsed = typeof raw.updatedAt === "number"
    ? raw.updatedAt
    : Date.parse(String(raw.updatedAt ?? ""));
  // Codex currently restamps its listing timestamp when a conversation is
  // loaded. Once the host has observed a row, its own send-time clock is the
  // canonical activity time; opening alone must never promote it.
  const reportedAt = Number.isFinite(parsed) ? parsed : now;
  const updatedAt = typeof meta?.activeAt === "number" ? meta.activeAt : reportedAt;
  const customName = meta?.customName?.trim() || undefined;
  const autoName = meta?.autoName?.trim() || title;
  return {
    id: raw.sessionId,
    cwd: raw.cwd,
    displayName: customName || autoName || `Untitled (${new Date(updatedAt).toLocaleDateString()})`,
    rawSummary: title,
    customName,
    updatedAt,
    createdAt: updatedAt,
    numMessages: 0,
    provider: "codex",
    pinnedAt: meta?.pinnedAt,
  };
}

/** Normalize `codex --version` output (`codex-cli 0.147.0`, etc.) for display. */
export function parseCodexVersionOutput(output: string): string {
  return /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output.trim())?.[1] ?? "";
}

export function versionIsOlder(current: string, target: string): boolean {
  const parts = (value: string) => value.split(/[.-]/, 3).map((part) => Number.parseInt(part, 10));
  const a = parts(current);
  const b = parts(target);
  if (a.some((part) => !Number.isFinite(part)) || b.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return false;
}

export function mergeProviderSessionEntries(
  grokEntries: readonly SessionListEntry[],
  codexEntries: readonly SessionListEntry[],
  providers: readonly AcpProvider[],
  query = "",
): SessionListEntry[] {
  const q = query.trim().toLowerCase();
  const entries = [
    ...(providers.includes("grok") ? grokEntries : []),
    ...(providers.includes("codex") ? codexEntries : []),
  ];
  return dedupeSessionEntriesById(entries)
    .filter((entry) => !q || entry.displayName.toLowerCase().includes(q) || entry.worktreeLabel?.toLowerCase().includes(q))
    .sort(compareHistoryEntries);
}

export function compareHistoryEntries(a: SessionListEntry, b: SessionListEntry): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

function followsCodexHighWater(
  entry: SessionListEntry,
  highWater: CodexHistoryHighWater | undefined,
): boolean {
  if (!highWater) return true;
  return entry.updatedAt < highWater.updatedAt ||
    (entry.updatedAt === highWater.updatedAt && entry.id.localeCompare(highWater.id) > 0);
}

/** Grok owns page pacing and its cursor remains opaque to the combined path.
 * Codex is a complete, cheap in-memory catalog. While Grok has another page,
 * emit the not-yet-consumed Codex prefix down through this page's oldest Grok
 * timestamp. Once Grok is exhausted, drain the remaining Codex suffix. */
export function mergeProviderHistoryPage(
  grok: GrokHistoryPage | undefined,
  codexEntries: readonly SessionListEntry[],
  cursor: ProviderHistoryCursor,
  limit = Number.MAX_SAFE_INTEGER,
): { entries: SessionListEntry[]; providerCursor: ProviderHistoryCursor; hasMore: boolean } {
  const codexRemaining = dedupeSessionEntriesById(codexEntries)
    .sort(compareHistoryEntries)
    .filter((entry) => followsCodexHighWater(entry, cursor.codexHighWater));
  const grokHasMore = !!grok && grok.nextOffset < grok.total;
  const oldestGrokTimestamp = grok?.entries.length
    ? Math.min(...grok.entries.map((entry) => entry.updatedAt))
    : undefined;
  const codexPage = !grokHasMore
    ? codexRemaining.slice(0, Math.max(0, limit))
    : oldestGrokTimestamp === undefined
      ? []
      : codexRemaining.filter((entry) => entry.updatedAt >= oldestGrokTimestamp);
  const lastCodex = codexPage.at(-1);
  const providerCursor: ProviderHistoryCursor = {
    grokOffset: grok?.nextOffset ?? Math.max(0, cursor.grokOffset),
    ...(lastCodex
      ? { codexHighWater: { updatedAt: lastCodex.updatedAt, id: lastCodex.id } }
      : cursor.codexHighWater
        ? { codexHighWater: cursor.codexHighWater }
        : {}),
  };
  return {
    entries: dedupeSessionEntriesById([...(grok?.entries ?? []), ...codexPage]).sort(compareHistoryEntries),
    providerCursor,
    hasMore: grokHasMore || codexPage.length < codexRemaining.length,
  };
}
