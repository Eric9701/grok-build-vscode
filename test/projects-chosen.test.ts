/**
 * Projects are folders the person chose (part 1). On a VS Code host the rail
 * used to list every folder an agent's history mentioned; benchmark harnesses
 * and a Codex app run had filled it with folders nobody worked in. Now:
 *
 *  - always a project: the open folder, folders created/cloned/added here, and
 *    any folder pinned, coloured, given an icon or archived;
 *  - once, for existing users: the folders the person SENT a message in through
 *    this host in the last 30 days (our own record, never a listing);
 *  - afterwards only the prompt, Recent's menu and the explicit adds.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import { foldersWithRecentSends, PROJECT_INIT_WINDOW_MS } from "../src/project-init";
import type { SessionMetaOverrides } from "../src/sessions";
import type { HostMsg, RepoListEntry } from "../src/protocol";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 15, 12);

// A machine like the owner's: two real projects, benchmark harness folders and a
// Codex app run that the agents' histories know about, and a smoke test in temp.
function fixtureMeta(t: number): SessionMetaOverrides {
  return {
    // Sent through this host in the last 30 days.
    "app-1": { provider: "grok", providerCwd: "/work/app", sentAt: t - 2 * DAY },
    "app-2": { provider: "codex", providerCwd: "/work/app/", usageLog: [{}] as any, activeAt: t - 3 * DAY },
    // From before sentAt existed: Grok's activeAt is written only at a send.
    "lib-1": { provider: "grok", providerCwd: "/work/lib", activeAt: t - 10 * DAY },
    // A worktree conversation counts for the project it came from.
    "lib-wt": { provider: "grok", providerCwd: "/home/me/.grok/worktrees/lib-x", worktreePath: "/home/me/.grok/worktrees/lib-x", sourceGitRoot: "/work/lib", sentAt: t - DAY },
    // Benchmark folders the adapters LISTED: provider/providerCwd/activeAt/autoName
    // are stamped by the listing, never by a send. Not candidates.
    "bench-1": { provider: "codex", providerCwd: "/GitHub/bench-runs-a/grok45", activeAt: t - DAY, autoName: "Solve task 17" },
    "bench-2": { provider: "claude", providerCwd: "/GitHub/bench-runs-b/opus", activeAt: t - DAY },
    // A Codex app run that started Grok in each folder never went through us, so
    // it has no meta at all (and so nothing to find).
    // Sent long ago.
    "old-1": { provider: "grok", providerCwd: "/work/attic", sentAt: t - 45 * DAY },
    // A routine's run is the host's automation, not the person.
    "routine-1": { provider: "grok", providerCwd: "/work/nightly", sentAt: t - DAY, customName: "[Routine] Nightly" },
    // A smoke test in the temp folder.
    "smoke-1": { provider: "grok", providerCwd: "/tmp/grok-render-smoke-abc/workspace", sentAt: t - DAY },
    // Opened only, never sent in.
    "opened-1": { provider: "grok", providerCwd: "/work/peek", openedAt: t - DAY },
  };
}

describe("foldersWithRecentSends: the one-time initialization's rule", () => {
  it("keeps only folders the person sent in through this host in the last 30 days", () => {
    expect(PROJECT_INIT_WINDOW_MS).toBe(30 * DAY);
    const folders = foldersWithRecentSends(fixtureMeta(now), now, {
      platform: "linux",
      excludeRoots: ["/tmp", "/home/me/.grok/worktrees"],
    });
    // One row per folder (a second conversation in /work/app folds in), newest send
    // first; benchmark, routine, temp, opened-only and old folders are absent.
    expect(folders).toEqual(["/work/lib", "/work/app"]);
  });
});

function tempFolders(names: string[]): Record<string, string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chosen-projects-"));
  const out: Record<string, string> = {};
  for (const name of names) {
    out[name] = path.join(root, name);
    fs.mkdirSync(out[name], { recursive: true });
  }
  out.root = root;
  return out;
}

function makeSidebar(memento: Record<string, unknown>, opts: { desktop?: boolean; workspace?: string } = {}): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.state = {
    get: vi.fn((key: string, fallback?: unknown) => (key in memento ? memento[key] : fallback)),
    update: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) delete memento[key];
      else memento[key] = value;
    }),
  };
  sidebar.memento = memento;
  sidebar.logs = [] as string[];
  sidebar.config = { askToAddProjects: true } as Record<string, unknown>;
  sidebar.host = {
    canSwitchWorkspaceFolder: !!opts.desktop,
    workspaceFolders: () => (opts.workspace ? [opts.workspace] : []),
    workspaceRoot: () => opts.workspace,
    appendLine: vi.fn((line: string) => sidebar.logs.push(line)),
    showInformationMessage: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => (key in sidebar.config ? sidebar.config[key] : fallback) }),
  };
  sidebar.workspaceRoot = () => opts.workspace;
  sidebar.postRepoCatalog = vi.fn();
  sidebar.postSessionsList = vi.fn();
  sidebar.pool = new Set<Session>();
  sidebar.remoteClients = new RemoteClientState<Session>("/");
  sidebar.focused = new Session();
  sidebar.emitted = [] as Array<{ session: Session; msg: HostMsg }>;
  sidebar.emit = vi.fn((session: Session, msg: HostMsg) => sidebar.emitted.push({ session, msg }));
  sidebar.sessionCwd = (session: Session) => session.cwd;
  sidebar.resolveLocalRepoTarget = (cwd: string) => ({ cwd, available: true });
  sidebar.selectRepo = vi.fn(async () => {});
  // The fixtures live in the temp dir, which the real rule excludes.
  sidebar.projectInitExcludeRoots = () => [];
  return sidebar;
}

describe("the initialization and Rebuild Projects on a VS Code host", () => {
  it("adds the recent-send folders once, after what the person already chose, and never a removed one", async () => {
    const f = tempFolders(["app", "lib", "workspace", "pinned", "removed"]);
    try {
      const t = Date.now();
      const memento: Record<string, unknown> = {
        "grok.sessionMeta": {
          a: { provider: "grok", providerCwd: f.app, sentAt: t - DAY },
          l: { provider: "grok", providerCwd: f.lib, sentAt: t - 2 * DAY },
          w: { provider: "grok", providerCwd: f.workspace, sentAt: t - DAY },
          r: { provider: "grok", providerCwd: f.removed, sentAt: t - DAY },
          b: { provider: "codex", providerCwd: path.join(f.root, "bench"), activeAt: t - DAY },
        },
        "grok.repoPins": { [f.pinned.toLowerCase().replace(/\\/g, "/")]: { cwd: f.pinned, pinnedAt: 1 } },
        "grok.removedProjectFolders": [f.removed],
      };
      const sidebar = makeSidebar(memento, { workspace: f.workspace });
      await sidebar.initializeProjects();
      expect(memento["grok.autoProjectFolders"]).toEqual([f.app, f.lib]);
      expect(memento["grok.projectsInit"]).toMatchObject({ added: 2 });
      expect(sidebar.logs.join("\n")).toMatch(/initialized from recent activity: kept 2 chosen project\(s\), added 2 folder\(s\)/);
      // Once: a second boot changes nothing even with new sends.
      (memento["grok.sessionMeta"] as any).n = { provider: "grok", providerCwd: f.pinned, sentAt: t };
      memento["grok.autoProjectFolders"] = [f.app];
      await sidebar.initializeProjects();
      expect(memento["grok.autoProjectFolders"]).toEqual([f.app]);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rebuild redoes only what the initialization did, leaves every choice alone, and is idempotent", async () => {
    const f = tempFolders(["app", "lib", "added", "stale"]);
    try {
      const t = Date.now();
      const key = (cwd: string) => cwd.toLowerCase().replace(/\\/g, "/");
      const choices = {
        "grok.extraProjectFolders": [f.added],
        "grok.repoPins": { [key(f.added)]: { cwd: f.added, pinnedAt: 1 } },
        "grok.repoColors": { [key(f.lib)]: { cwd: f.lib, color: "blue" } },
        "grok.repoIcons": { [key(f.added)]: { cwd: f.added, icon: "rocket" } },
        "grok.repoArchives": { [key(f.stale)]: { cwd: f.stale, at: 1, archived: true } },
        "grok.projectPromptNever": { [key(f.root)]: { cwd: f.root, at: 1 } },
      };
      const memento: Record<string, unknown> = {
        "grok.sessionMeta": {
          a: { provider: "grok", providerCwd: f.app, sentAt: t - DAY },
          l: { provider: "grok", providerCwd: f.lib, sentAt: t - DAY },
        },
        "grok.autoProjectFolders": [path.join(f.root, "gone-since")],
        "grok.projectsInit": { at: 1, added: 1 },
        ...structuredClone(choices),
      };
      const sidebar = makeSidebar(memento);
      await sidebar.rebuildProjects();
      // Kept: added (hand-added, pinned, marked), lib (coloured), stale (archived).
      // lib is already chosen, so app is the only folder it adds.
      expect(memento["grok.autoProjectFolders"]).toEqual([f.app]);
      for (const [k, v] of Object.entries(choices)) expect(memento[k]).toEqual(v);
      expect(sidebar.logs.at(-1)).toMatch(/rebuilt from recent activity: kept 3 chosen project\(s\), added 1 folder\(s\)/);
      await sidebar.rebuildProjects();
      expect(memento["grok.autoProjectFolders"]).toEqual([f.app]);
      for (const [k, v] of Object.entries(choices)) expect(memento[k]).toEqual(v);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("is a logged no-op on a desktop or cloud host, whose list is the folders it opens", async () => {
    const memento: Record<string, unknown> = { "grok.sessionMeta": { a: { provider: "grok", providerCwd: "/x", sentAt: Date.now() } } };
    const sidebar = makeSidebar(memento, { desktop: true, workspace: "/x" });
    await sidebar.initializeProjects();
    await sidebar.rebuildProjects();
    expect(memento["grok.autoProjectFolders"]).toBeUndefined();
    expect(memento["grok.projectsInit"]).toBeUndefined();
    expect(sidebar.logs.join("\n")).toContain("nothing from history to rebuild, nothing changed");
  });
});

describe("Add project undoes Hide", () => {
  // A coloured, marked or archived folder still counts as chosen after Hide, so
  // Add used to take the "already listed" return before it cleared the
  // tombstone: the folder stayed hidden and the picker appeared to do nothing.
  it.each([
    ["coloured", "grok.repoColors", { color: "blue" }],
    ["marked", "grok.repoIcons", { icon: "rocket" }],
    ["archived", "grok.repoArchives", { at: 1, archived: true }],
  ])("brings back a hidden %s project", async (_label, key, choice) => {
    const f = tempFolders(["lib"]);
    try {
      const norm = (cwd: string) => cwd.toLowerCase().replace(/\\/g, "/");
      const memento: Record<string, unknown> = {
        [key]: { [norm(f.lib)]: { cwd: f.lib, ...choice } },
        "grok.removedProjectFolders": [f.lib],
      };
      const sidebar = makeSidebar(memento);
      await sidebar.rememberExtraProjectFolder(f.lib);
      expect(memento["grok.removedProjectFolders"]).toEqual([]);
      expect(sidebar.selectRepo).toHaveBeenCalledWith(f.lib);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("the rail lists the chosen folders, not the history catalog", () => {
  it("keeps chosen rows (and the folder in use), marks them removable, and drops history-only rows", () => {
    const memento: Record<string, unknown> = {
      "grok.extraProjectFolders": ["/work/added"],
      "grok.autoProjectFolders": ["/work/app"],
      "grok.repoArchives": { "/github/old": { cwd: "/GitHub/old", at: 1, archived: true } },
    };
    const sidebar = makeSidebar(memento, { workspace: "/work/open" });
    sidebar.selectedRepoCwd = "/work/current";
    const row = (cwd: string): RepoListEntry => ({ cwd, label: path.basename(cwd), available: true, pinned: false, updatedAt: 0 } as RepoListEntry);
    const catalog = ["/work/open", "/work/added", "/work/app", "/GitHub/old", "/work/current", "/GitHub/bench-runs-a/grok45", "/Documents/Codex/sessions/19"].map(row);
    const shown = sidebar.displayedRepoEntries(catalog);
    expect(shown.map((r: RepoListEntry) => [r.cwd, !!r.added])).toEqual([
      ["/work/open", false],
      ["/work/added", true],
      ["/work/app", true],
      ["/GitHub/old", true],
      ["/work/current", false],
    ]);
    // The desktop list is its open folders already.
    sidebar.host.canSwitchWorkspaceFolder = true;
    expect(sidebar.displayedRepoEntries(catalog)).toHaveLength(catalog.length);
  });
});

describe("Add <folder> to Projects?", () => {
  function sendIn(sidebar: any, id: string, cwd: string): Session {
    const session = new Session();
    session.activeSessionId = id;
    session.cwd = cwd;
    sidebar.maybeAskToAddProject(session);
    return session;
  }
  const prompts = (sidebar: any) => sidebar.emitted.map((e: any) => e.msg).filter((m: HostMsg) => m.type === "projectPrompt");

  it("asks once per conversation, only for a folder that is not a project, and not for a routine", () => {
    const memento: Record<string, unknown> = {
      "grok.extraProjectFolders": ["/work/added"],
      "grok.sessionMeta": { run: { customName: "[Routine] Nightly" } },
    };
    const sidebar = makeSidebar(memento, { workspace: "/work/open" });
    sendIn(sidebar, "c1", "/scratch/notes");
    sendIn(sidebar, "c1", "/scratch/notes");
    sendIn(sidebar, "c2", "/work/added");
    sendIn(sidebar, "run", "/scratch/notes");
    expect(prompts(sidebar)).toEqual([{ type: "projectPrompt", sessionId: "c1", cwd: "/scratch/notes", label: "notes" }]);
  });

  it("Add writes the host's list (and only for a folder it offered); Never is remembered; the setting stops it", async () => {
    const memento: Record<string, unknown> = {};
    const sidebar = makeSidebar(memento, { workspace: "/work/open" });
    sidebar.rememberExtraProjectFolder = vi.fn(async (cwd: string) => {
      memento["grok.extraProjectFolders"] = [...((memento["grok.extraProjectFolders"] as string[]) ?? []), cwd];
    });
    // A phone naming a folder nobody offered is refused.
    await sidebar.addToProjects("/etc", "remote");
    expect(sidebar.rememberExtraProjectFolder).not.toHaveBeenCalled();

    sendIn(sidebar, "c1", path.resolve("/scratch/notes"));
    await sidebar.addToProjects(path.resolve("/scratch/notes"), "remote");
    expect(sidebar.rememberExtraProjectFolder).toHaveBeenCalledWith(path.resolve("/scratch/notes"), { select: false });
    expect(prompts(sidebar).at(-1)).toMatchObject({ done: true, cwd: path.resolve("/scratch/notes") });

    sendIn(sidebar, "c2", "/scratch/other");
    await sidebar.answerProjectPrompt("/scratch/other", "never");
    expect(Object.values(memento["grok.projectPromptNever"] as object)).toEqual([{ cwd: "/scratch/other", at: expect.any(Number) }]);
    sendIn(sidebar, "c3", "/scratch/other");
    expect(prompts(sidebar).filter((m: any) => m.sessionId === "c3")).toEqual([]);

    sidebar.config.askToAddProjects = false;
    sendIn(sidebar, "c4", "/scratch/third");
    expect(prompts(sidebar).filter((m: any) => m.sessionId === "c4")).toEqual([]);
  });

  it("never asks on a desktop or cloud host", () => {
    const sidebar = makeSidebar({}, { desktop: true, workspace: "/work/open" });
    sendIn(sidebar, "c1", "/scratch/notes");
    expect(prompts(sidebar)).toEqual([]);
  });
});
