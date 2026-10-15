/**
 * Recent is strict: conversations the person sent something in through this
 * host, or opened here in the last three days, minus automation, newest first.
 * Being in a CLI's history is never enough.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { RemoteClientState } from "../src/remote-client-state";
import {
  RECENT_OPENED_MS,
  isRecentConversation,
  readSessionEntries,
  sessionsDirFor,
  defaultFs,
  type SessionListEntry,
  type SessionMetaOverrides,
} from "../src/sessions";
import { claudeEntrypoint, claudeProjectDirName, codexOriginators, type MarkerFs } from "../src/automated-sessions";
import { ROUTINE_SESSION_TAG } from "../src/routines";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 15, 12);

describe("isRecentConversation", () => {
  it("is our own record of a send or a deliberate open, never a listing", () => {
    expect(RECENT_OPENED_MS).toBe(3 * DAY);
    expect(isRecentConversation({ sentAt: now - 20 * DAY }, now)).toBe(true);
    // Conversations from before sentAt existed: the marks a send already left.
    expect(isRecentConversation({ usageLog: [{ afterUserMessage: 1, usage: {} }] as any }, now)).toBe(true);
    expect(isRecentConversation({ provider: "grok", activeAt: now - DAY }, now)).toBe(true);
    expect(isRecentConversation({ activeAt: now - DAY }, now)).toBe(true);
    // An adapter row's activeAt is stamped by its listing: not a send.
    expect(isRecentConversation({ provider: "codex", providerCwd: "/r", activeAt: now - DAY, autoName: "x" }, now)).toBe(false);
    expect(isRecentConversation({ provider: "claude", providerCwd: "/r" }, now)).toBe(false);
    // Opened on purpose: three days.
    expect(isRecentConversation({ provider: "codex", openedAt: now - 2 * DAY }, now)).toBe(true);
    expect(isRecentConversation({ provider: "codex", openedAt: now - 4 * DAY }, now)).toBe(false);
    // A routine's run is the host's own automation.
    expect(isRecentConversation({ sentAt: now, customName: `${ROUTINE_SESSION_TAG} Nightly` }, now)).toBe(false);
    expect(isRecentConversation(undefined, now)).toBe(false);
  });
});

describe("automation markers", () => {
  it("reads Grok's headless session_kind where the summary is already parsed", () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-headless-"));
    try {
      const cwd = path.join(grokHome, "repo");
      const dir = sessionsDirFor(grokHome, cwd);
      for (const [id, kind] of [["01a0f5ae-e280-7e03-a0be-f7732d081be5", "headless"], ["01a0f5c6-8aec-7f43-962f-9c007f2929d6", undefined]] as const) {
        fs.mkdirSync(path.join(dir, id), { recursive: true });
        fs.writeFileSync(path.join(dir, id, "summary.json"), JSON.stringify({ session_summary: "t", ...(kind ? { session_kind: kind } : {}) }));
      }
      const entries = readSessionEntries({ fs: defaultFs, grokHome, cwd, ids: ["01a0f5ae-e280-7e03-a0be-f7732d081be5", "01a0f5c6-8aec-7f43-962f-9c007f2929d6"], overrides: {} });
      expect(Object.fromEntries(entries.map((e) => [e.id, !!e.automated]))).toEqual({
        "01a0f5ae-e280-7e03-a0be-f7732d081be5": true,
        "01a0f5c6-8aec-7f43-962f-9c007f2929d6": false,
      });
    } finally {
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });

  it("reads codex exec's originator from the rollout's first line, in the horizon's day folders only", () => {
    const day = new Date(now - 2 * DAY);
    const pad = (n: number) => String(n).padStart(2, "0");
    const dayDir = path.join("/codex", "sessions", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    const files: Record<string, string> = {
      [path.join(dayDir, "rollout-2026-10-13T10-00-00-exec-1.jsonl")]: JSON.stringify({ type: "session_meta", payload: { originator: "codex_exec" } }) + "\n{}",
      [path.join(dayDir, "rollout-2026-10-13T11-00-00-ours-1.jsonl")]: JSON.stringify({ type: "session_meta", payload: { originator: "@agentclientprotocol/codex-acp" } }),
    };
    const reads: string[] = [];
    const io: MarkerFs = {
      readdirSync: (dir) => {
        if (dir === dayDir) return Object.keys(files).map((f) => path.basename(f));
        throw new Error("ENOENT");
      },
      readHead: (file) => { reads.push(path.basename(file)); return files[file]; },
    };
    const found = codexOriginators("/codex", new Set(["exec-1", "ours-1", "missing-1"]), now, 30, io);
    expect(Object.fromEntries(found)).toEqual({ "exec-1": "codex_exec", "ours-1": "@agentclientprotocol/codex-acp" });
    expect(reads.length).toBe(2);
  });

  it("reads Claude's entrypoint from the transcript's first records, past the queue lines", () => {
    const cwd = "C:\\GitHub\\bench";
    const file = path.join("/claude", "projects", claudeProjectDirName(cwd), "abc.jsonl");
    expect(claudeProjectDirName(cwd)).toBe("C--GitHub-bench");
    const io: MarkerFs = {
      readdirSync: () => [],
      readHead: (target) => {
        if (target !== file) throw new Error("ENOENT");
        return [JSON.stringify({ type: "queue-operation" }), JSON.stringify({ type: "queue-operation" }), JSON.stringify({ type: "user", entrypoint: "sdk-cli" })].join("\n");
      },
    };
    expect(claudeEntrypoint("/claude", cwd, "abc", io)).toBe("sdk-cli");
    expect(claudeEntrypoint("/claude", cwd, "nope", io)).toBeUndefined();
  });
});

function makeSidebar(overrides: SessionMetaOverrides, rowsByFolder: Record<string, SessionListEntry[]>): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = { "grok.sessionMeta": overrides };
  sidebar.state = {
    get: vi.fn((key: string, fallback: unknown) => (key in memento ? memento[key] : fallback)),
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  sidebar.memento = memento;
  sidebar.sessionMetaWrites = Promise.resolve();
  sidebar.pool = new Set<Session>();
  sidebar.remoteClients = new RemoteClientState<Session>("/a");
  sidebar.authorizedSessionCwds = vi.fn(() => Object.keys(rowsByFolder));
  sidebar.sessionCwd = vi.fn((session: Session) => session.cwd);
  sidebar.dotForId = vi.fn(() => "none");
  sidebar.buildSessionsList = vi.fn((cwd: string) => ({ entries: rowsByFolder[cwd] ?? [] }));
  sidebar.automatedSessionCache = new Map();
  sidebar.postSessionsList = vi.fn();
  sidebar.sendLocalRepoSessionsPreview = vi.fn();
  sidebar.refreshRemoteRepoPreview = vi.fn();
  sidebar.adapterHistory = vi.fn(() => undefined);
  return sidebar;
}

const row = (id: string, cwd: string, updatedAt: number, extra: Partial<SessionListEntry> = {}): SessionListEntry => ({
  id, cwd, displayName: id, rawSummary: "", updatedAt, createdAt: 1, numMessages: 1, ...extra,
});

describe("buildRecentSessions", () => {
  it("lists what was sent in or opened here, across folders, newest first, without automation", () => {
    const t = Date.now();
    const overrides: SessionMetaOverrides = {
      sent: { provider: "grok", providerCwd: "/a", sentAt: t - DAY },
      legacy: { provider: "grok", providerCwd: "/b", activeAt: t - 2 * DAY },
      opened: { provider: "codex", providerCwd: "/b", openedAt: t - DAY },
      openedLongAgo: { provider: "codex", providerCwd: "/b", openedAt: t - 5 * DAY },
      listedOnly: { provider: "claude", providerCwd: "/a", activeAt: t - DAY, autoName: "bench" },
      headless: { provider: "grok", providerCwd: "/a", sentAt: t },
      routine: { provider: "grok", providerCwd: "/a", sentAt: t, customName: `${ROUTINE_SESSION_TAG} nightly` },
      unplaced: { usageLog: [{}] as any },
      // Sent in, but our last word on it is outside the horizon: its folder is
      // not even listed.
      ancient: { provider: "grok", providerCwd: "/c", sentAt: t - 40 * DAY },
    };
    const sidebar = makeSidebar(overrides, {
      "/a": [row("headless", "/a", t, { automated: true }), row("sent", "/a", t - DAY), row("listedOnly", "/a", t - 10), row("routine", "/a", t)],
      "/b": [row("opened", "/b", t - 3 * DAY, { provider: "codex" }), row("legacy", "/b", t - 2 * DAY), row("openedLongAgo", "/b", t - 4 * DAY, { provider: "codex" })],
      "/c": [row("ancient", "/c", t - 40 * DAY)],
    });
    sidebar.isAutomatedSession = vi.fn((entry: SessionListEntry) => !!entry.automated);
    const { entries } = sidebar.buildRecentSessions();
    expect(entries.map((e: SessionListEntry) => e.id)).toEqual(["sent", "legacy", "opened"]);
    // Each folder is listed once.
    expect(sidebar.buildSessionsList).toHaveBeenCalledTimes(2);
  });

  it("stamps sentAt at send (never for a routine's run) and openedAt on a deliberate open", async () => {
    const sidebar = makeSidebar({ chat: { provider: "grok" }, run: { customName: `${ROUTINE_SESSION_TAG} nightly` } }, {});
    const session = new Session();
    session.activeSessionId = "chat";
    sidebar.noteSessionActivity(session, true);
    expect(sidebar.memento["grok.sessionMeta"].chat.sentAt).toEqual(expect.any(Number));
    // Turn end: activity, not a send.
    const turnEnd = new Session();
    turnEnd.activeSessionId = "other";
    sidebar.noteSessionActivity(turnEnd);
    expect(sidebar.memento["grok.sessionMeta"].other.sentAt).toBeUndefined();
    const routine = new Session();
    routine.activeSessionId = "run";
    sidebar.noteSessionActivity(routine, true);
    expect(sidebar.memento["grok.sessionMeta"].run.sentAt).toBeUndefined();
    await sidebar.noteSessionOpened("chat");
    expect(sidebar.memento["grok.sessionMeta"].chat.openedAt).toEqual(expect.any(Number));
  });
});

describe("where the stamps are written", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8").replace(/\r\n/g, "\n");
  it("stamps openedAt only for a person's open: a desk click or a tab's claim, not a reconnect restore", () => {
    const start = source.indexOf('      case "resumeSession":');
    const body = source.slice(start, source.indexOf("        break;", start));
    expect(body).toContain('if (msg.claim === true && this.remoteClients.active(clientId)?.activeSessionId === msg.id)');
    expect(body).toContain("if (this.focused.activeSessionId === msg.id) void this.noteSessionOpened(msg.id);");
    // No listing path writes either stamp.
    const listing = source.slice(source.indexOf("private async listAdapterHistory("), source.indexOf("private async listAdapterHistory(") + 6000);
    expect(listing).not.toMatch(/sentAt|openedAt/);
  });
});
