/**
 * One history listing per PROVIDER, not one per project.
 *
 * Codex takes no cwd on `session/list`: every folder's listing read the whole
 * catalog and kept its own rows. With a rail of sixty projects that was sixty
 * full reads back to back, and each finished listing rebuilt Recent, which
 * asked for its folders again. These pin the replacement: one catalog read
 * serves every folder with exactly the rows its own listing gave, a burst of
 * asks (the rail opening, Recent rebuilding) costs one listing, and the
 * rebuild a listing causes cannot arm another.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { AcpClient } from "../src/acp";
import { CodexBackend, listAllCodexSessions } from "../src/codex-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { agySessionsFor, listAgyCatalog, listAgySessions } from "../src/agy-backend";
import { projectProviderKey } from "../src/provider-ui";
import type { AcpProvider } from "../src/acp-backend";

const SESSION_META_KEY = "grok.sessionMeta";
const NOW = Date.UTC(2026, 9, 1);
const day = 24 * 60 * 60 * 1000;

const FOLDERS = ["/work/alpha", "/work/beta", "/work/gamma", "/work/alpha/sub", "/work/Delta"];

// Three pages, folders interleaved; one id repeated across pages, one row
// with no folder, one with a trailing separator, one in a different case.
const PAGES = [
  [
    { sessionId: "a1", cwd: "/work/alpha", title: "first alpha", updatedAt: new Date(NOW - 1 * day).toISOString() },
    { sessionId: "b1", cwd: "/work/beta", title: "beta", updatedAt: new Date(NOW - 2 * day).toISOString() },
    { sessionId: "s1", cwd: "/work/alpha/sub", title: "nested", updatedAt: new Date(NOW - 3 * day).toISOString() },
    { sessionId: "x1", title: "no folder", updatedAt: new Date(NOW - 1 * day).toISOString() },
  ],
  [
    { sessionId: "a2", cwd: "/work/alpha/", title: "trailing", updatedAt: new Date(NOW - 4 * day).toISOString() },
    { sessionId: "a1", cwd: "/work/alpha", title: "first alpha again", updatedAt: new Date(NOW - 1 * day).toISOString() },
    { sessionId: "old", cwd: "/work/beta", title: "past the horizon", updatedAt: new Date(NOW - 90 * day).toISOString() },
  ],
  [
    { sessionId: "d1", cwd: "/work/delta", title: "lower case", updatedAt: new Date(NOW - 5 * day).toISOString() },
    { sessionId: "o1", cwd: "/elsewhere", title: "never asked about", updatedAt: new Date(NOW - 1 * day).toISOString() },
  ],
];

function codexRequest(calls: { pages: number }) {
  return async (method: string, params: any) => {
    expect(method).toBe("session/list");
    calls.pages += 1;
    const page = params?.cursor ? Number(params.cursor) : 0;
    return { sessions: PAGES[page], nextCursor: page + 1 < PAGES.length ? String(page + 1) : null };
  };
}

function client(backend: any, request: (method: string, params: any) => Promise<any>): AcpClient {
  const c = new AcpClient({ cliPath: "/bin/agent", cwd: "/home", backend, log: () => {} } as any);
  (c as any).request = request;
  return c;
}

function makeSidebar(provider: AcpProvider, history: AcpClient, folders: string[] = FOLDERS): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar._memento = memento;
  sidebar.state = {
    get: (key: string, fallback: unknown) => (Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback),
    update: async (key: string, value: unknown) => { memento[key] = value; },
  };
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.codexSessionCache = new Map();
  sidebar.claudeSessionCache = new Map();
  sidebar.connectedProviders = () => [provider];
  sidebar.locateProvider = () => "/bin/agent";
  sidebar.authorizedSessionCwds = () => folders;
  sidebar.providerRunSignal = () => new AbortController().signal;
  sidebar.adapterHistoryClient = vi.fn(async () => history);
  sidebar.createProviderBackend = () => (provider === "codex" ? new CodexBackend() : new ClaudeBackend());
  sidebar.host = { appendLine: vi.fn() };
  sidebar.postSessionsList = vi.fn();
  sidebar.sendLocalRepoSessionsPreview = vi.fn();
  return sidebar;
}

/** Let every queued listing, and anything it schedules, run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => { vi.restoreAllMocks(); });

describe("codex: one catalog read serves every project", () => {
  it("gives every project exactly the rows its own listing gave, from one read", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    // Before: one listing per project, each paging the whole catalog -- the
    // backend's per-folder listing, unchanged.
    const perFolder = { pages: 0 };
    const expected = new Map<string, unknown>();
    for (const cwd of FOLDERS) {
      const { sessions } = await listAllCodexSessions((cursor) => codexRequest(perFolder)("session/list", cursor ? { cursor } : {}), cwd, process.platform);
      expected.set(projectProviderKey(cwd), sessions.map((s) => s.sessionId));
    }
    expect(perFolder.pages).toBe(PAGES.length * FOLDERS.length);

    // After: every project asked for at once, as the rail opening does.
    const calls = { pages: 0 };
    const sidebar = makeSidebar("codex", client(new CodexBackend(), codexRequest(calls)));
    for (const cwd of FOLDERS) sidebar.scheduleAdapterHistoryRefresh("codex", cwd);
    await settle();

    expect(calls.pages).toBe(PAGES.length);
    for (const cwd of FOLDERS) {
      const key = projectProviderKey(cwd);
      expect(sidebar.codexSessionCache.get(key)?.map((e: any) => e.id), cwd).toEqual(expected.get(key));
    }
    // A folder nobody asked about stays unlisted and unstamped.
    const meta = sidebar._memento[SESSION_META_KEY] as Record<string, any>;
    expect(meta.o1).toBeUndefined();
    // The horizon still keeps an old row from being stamped.
    expect(meta.old).toBeUndefined();
    expect(meta.a1).toMatchObject({ provider: "codex", providerCwd: "/work/alpha" });
  });

  it("the Recent rebuild a listing causes does not arm another listing", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const calls = { pages: 0 };
    const sidebar = makeSidebar("codex", client(new CodexBackend(), codexRequest(calls)));
    // What postSessionsList does through buildRecentSessions / the remote tabs:
    // ask again for every folder it shows.
    sidebar.postSessionsList = vi.fn(() => {
      for (const cwd of FOLDERS) sidebar.scheduleAdapterHistoryRefresh("codex", cwd);
    });

    for (const cwd of FOLDERS) sidebar.scheduleAdapterHistoryRefresh("codex", cwd);
    await settle();
    expect(calls.pages).toBe(PAGES.length);
    expect(sidebar.postSessionsList).toHaveBeenCalledTimes(1);

    // Inside the throttle window the same asks are answered from the cache.
    now += 5_000;
    for (const cwd of FOLDERS) sidebar.scheduleAdapterHistoryRefresh("codex", cwd);
    await settle();
    expect(calls.pages).toBe(PAGES.length);

    // After it, one more listing for all of them, and still only one rebuild each.
    now += 10_000;
    for (const cwd of FOLDERS) sidebar.scheduleAdapterHistoryRefresh("codex", cwd);
    await settle();
    expect(calls.pages).toBe(2 * PAGES.length);
    expect(sidebar.postSessionsList).toHaveBeenCalledTimes(2);
  });

  it("lists a project opened inside the throttle window at once, and one asked for mid-listing in that listing", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const calls = { pages: 0 };
    const sidebar = makeSidebar("codex", client(new CodexBackend(), codexRequest(calls)));

    sidebar.scheduleAdapterHistoryRefresh("codex", "/work/alpha");
    // Arrives while that listing is reading.
    sidebar.scheduleAdapterHistoryRefresh("codex", "/work/beta");
    await settle();
    expect(calls.pages).toBe(PAGES.length);
    expect(sidebar.codexSessionCache.get(projectProviderKey("/work/beta"))?.map((e: any) => e.id)).toEqual(["b1", "old"]);

    // Never listed, two seconds later: no waiting out the ten seconds.
    now += 2_000;
    sidebar.scheduleAdapterHistoryRefresh("codex", "/work/gamma");
    await settle();
    expect(calls.pages).toBe(2 * PAGES.length);
    expect(sidebar.codexSessionCache.get(projectProviderKey("/work/gamma"))).toEqual([]);
  });

  it("backs off for the provider after a credential refusal", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let reads = 0;
    const refusing = async () => { reads += 1; throw new Error("Not logged in"); };
    const sidebar = makeSidebar("codex", client(new CodexBackend(), refusing));
    sidebar.setProviderNeedsLogin = vi.fn();
    for (const cwd of FOLDERS) sidebar.scheduleAdapterHistoryRefresh("codex", cwd);
    await settle();
    expect(reads).toBe(1);
    expect(sidebar.setProviderNeedsLogin).toHaveBeenCalledWith("codex", true);
    // A repaint asking again for folders that were never listed stays backed off.
    now += 1_000;
    for (const cwd of FOLDERS) sidebar.scheduleAdapterHistoryRefresh("codex", cwd);
    await settle();
    expect(reads).toBe(1);
  });
});

describe("claude: still asked per folder, but inside one listing", () => {
  it("lists every project in one pass and posts once", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const asked: string[] = [];
    const request = async (method: string, params: any) => {
      expect(method).toBe("session/list");
      asked.push(params.cwd);
      return { sessions: [{ sessionId: `c-${params.cwd}`, cwd: params.cwd, title: "t", updatedAt: new Date(NOW).toISOString() }] };
    };
    const sidebar = makeSidebar("claude", client(new ClaudeBackend(), request));
    for (const cwd of FOLDERS) sidebar.scheduleAdapterHistoryRefresh("claude", cwd);
    await settle();
    expect(asked).toEqual(FOLDERS);
    expect(sidebar.postSessionsList).toHaveBeenCalledTimes(1);
    for (const cwd of FOLDERS) {
      expect(sidebar.claudeSessionCache.get(projectProviderKey(cwd))?.map((e: any) => e.id)).toEqual([`c-${cwd}`]);
    }
  });
});

describe("antigravity: one directory read, split by folder", () => {
  it("each folder's rows out of the catalog are what its own listing returns", () => {
    const files: Record<string, string> = {};
    const mtimes: Record<string, number> = {};
    const add = (id: string, cwd: string, mtime: number) => {
      files[`${id}.meta`] = JSON.stringify({ cwd });
      mtimes[`${id}.db`] = mtime;
    };
    add("g1", "/work/alpha", NOW - day);
    add("g2", "/work/ALPHA", NOW - 2 * day);
    add("g3", "/work/beta", NOW - 40 * day);
    add("g4", "/work/beta", NOW - 40 * day);
    add("g5", "/work/alpha/sub", NOW - day);
    const fs = {
      readDir: () => [...Object.keys(mtimes), ...Object.keys(files), "notes.txt"],
      readFile: (file: string) => {
        const name = file.split(/[\\/]/).pop()!;
        if (!(name in files)) throw new Error("missing");
        return files[name];
      },
      modifiedAt: (file: string) => mtimes[file.split(/[\\/]/).pop()!],
    };
    for (const platform of ["win32", "linux"] as const) {
      const options = { env: {}, home: "/home/me", fs, since: NOW - 30 * day, keepIds: new Set(["g4"]) };
      const catalog = listAgyCatalog(platform, options);
      for (const cwd of FOLDERS) {
        expect(agySessionsFor(catalog, cwd, platform), `${platform} ${cwd}`).toEqual(listAgySessions(cwd, platform, options));
      }
    }
  });
});
