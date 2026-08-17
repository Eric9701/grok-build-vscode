/**
 * Desktop with no open folder must not hang on the baked "Starting" welcome.
 * startSession used to return without setBusy:false / onboarding; the HTML
 * default is a busy spinner, so the panel never left loading (#116).
 */
import { describe, expect, it, vi } from "vitest";
import { RemoteClientState } from "../src/remote-client-state";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";
import { GrokSidebar } from "../src/sidebar";

function makeDesktopSidebar(opts?: { cwd?: string; folders?: string[] }): any {
  const cwd = opts?.cwd ?? "";
  const folders = opts?.folders ?? [];
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar.providerConnectionState = { grok: true, codex: false };
  sidebar.providerConnections = vi.fn(() => sidebar.providerConnectionState);
  sidebar.connectedProviders = vi.fn(() => ["grok"]);
  sidebar.usableProviders = vi.fn(() => ["grok"]);
  sidebar.remoteClients = new RemoteClientState<Session>(cwd || "/unused");
  sidebar.pool = new Set<Session>();
  sidebar.focused = new Session();
  sidebar.focused.provider = "grok";
  sidebar.focused.cwd = cwd || undefined;
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.sessionCache = new Map();
  sidebar.state = {
    get: vi.fn((key: string, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback),
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  sidebar.host = {
    canSwitchWorkspaceFolder: true,
    appendLine: vi.fn(),
    workspaceFolders: vi.fn(() => folders),
    workspaceRoot: vi.fn(() => folders[0] ?? ""),
    getConfiguration: vi.fn(() => ({
      get: (_key: string, fallback: unknown) => fallback,
      inspect: () => undefined,
      update: vi.fn(async () => {}),
    })),
  };
  sidebar.workspaceRoot = vi.fn(() => folders[0] ?? "");
  sidebar.openWorkspaceFolders = vi.fn(() => folders);
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd || cwd);
  sidebar.isAuthorizedCwd = vi.fn((p: string) => folders.some((f) => f === p));
  sidebar.postRepoCatalog = vi.fn();
  sidebar.postSessionsList = vi.fn();
  sidebar.sendRemoteSession = vi.fn();
  sidebar.mirrorToProjectsRail = vi.fn();
  sidebar.localizeHistoryMessage = (message: HostMsg) => message;
  sidebar.posted = [] as HostMsg[];
  sidebar.view = { webview: { postMessage: (message: HostMsg) => sidebar.posted.push(message) } };
  return sidebar;
}

describe("desktop empty-folder startSession", () => {
  it("unlocks Starting and paints no-project instead of hanging", async () => {
    const sidebar = makeDesktopSidebar();
    const client = await sidebar.startSession(undefined, sidebar.focused);
    expect(client).toBeUndefined();
    expect(sidebar.focused.priming).toBe(false);
    expect(sidebar.posted).toEqual(expect.arrayContaining([
      { type: "setBusy", value: false },
      { type: "onboarding", state: "no-project", platform: process.platform },
    ]));
    // The hang: returning here used to post only catalog/list, leaving the
    // baked welcome-status-busy "Starting" spinner up forever.
    expect(sidebar.posted.some((m: HostMsg) => m.type === "setBusy" && m.value === true)).toBe(false);
    expect(sidebar.postRepoCatalog).toHaveBeenCalled();
    expect(sidebar.postSessionsList).toHaveBeenCalled();
  });

  it("does not spawn when a held cwd is unauthorized and nothing is open", async () => {
    const sidebar = makeDesktopSidebar({ cwd: "/closed/project", folders: [] });
    sidebar.focused.cwd = "/closed/project";
    const client = await sidebar.startSession(undefined, sidebar.focused);
    expect(client).toBeUndefined();
    expect(sidebar.posted).toEqual(expect.arrayContaining([
      { type: "onboarding", state: "no-project", platform: process.platform },
    ]));
    expect(sidebar.host.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("refused startSession (cwd not authorized)"),
    );
  });

  it("does not paint no-project when folders exist — that path is a real start", async () => {
    const sidebar = makeDesktopSidebar({ cwd: "/work/app", folders: ["/work/app"] });
    sidebar.focused.cwd = "/work/app";
    // No locateProvider / AcpClient: the empty-folder guard must not fire, so
    // we only assert we did not take the empty-state branch.
    sidebar.locateProvider = vi.fn(() => undefined);
    sidebar.confirmRepoForcedAutoApprove = vi.fn(async () => true);
    sidebar.defaultProviderForProject = vi.fn(() => "grok");
    sidebar.configForcesAutoApprove = vi.fn(() => false);
    sidebar.noticeAlwaysApproveOnce = vi.fn();
    sidebar.stopVoiceInput = vi.fn();
    sidebar.queueInFlightPlanCommentsOnExit = vi.fn();
    sidebar.maybeUpdateCliOnUpgrade = vi.fn(async () => {});
    sidebar.maybePinBrokenCli = vi.fn(async () => {});
    sidebar.planModeCompatibility = vi.fn(async () => ({
      planModeAvailable: true,
      planModeVersionVerified: true,
      usedCache: true,
    }));
    sidebar.applyPlanModeCompatibility = vi.fn();
    const client = await sidebar.startSession(undefined, sidebar.focused);
    expect(client).toBeUndefined();
    expect(sidebar.posted.some((m: HostMsg) => m.type === "onboarding" && (m as { state?: string }).state === "no-project"))
      .toBe(false);
    expect(sidebar.posted).toEqual(expect.arrayContaining([
      { type: "setBusy", value: false },
    ]));
  });
});
