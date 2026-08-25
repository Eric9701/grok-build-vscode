/**
 * Empty-state advice, in the real webview.
 *
 * The pure half is covered in welcome-tips.test.ts. What only a DOM run can
 * show is that the slot is SHARED — with the move-view hint, with the status
 * line's busy state and with the onboarding card — and that the actionable span
 * reaches the destination it names. happy-dom has no layout, so this suite
 * proves wiring; the screenshot gate in scripts/desk-screens-check.mjs proves
 * the line actually fits on screen.
 *
 * Every test drives the real status cycle rather than poking the DOM: the host
 * posts `initialized` (welcome goes "Starting", busy) and then `setBusy:false`
 * (welcome goes "Connected", idle), which is the exact moment the advice slot
 * becomes available. That cycle repeats per session, which is what gives the
 * rotation somewhere to happen.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

const INITIAL_STATE = {
  type: "initialState",
  effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "3.17.2",
  showThinking: false, expandCommandOutputs: false, steerByDefault: false,
  soundNotifications: false, processingSound: false, readRepliesAloud: false,
};

type TipFacts = Partial<{ routineCount: number; connectorCount: number; dismissed: string[] }>;

/** The host frame carrying the two counts and the retired list. */
function tips(h: Harness, over: TipFacts = {}) {
  dispatch(h.window, {
    type: "welcomeTips", routineCount: 0, connectorCount: 0, dismissed: [], ...over,
  });
}

/** Take the welcome from "Starting" to "Connected" the way the host does. */
function connect(h: Harness) {
  dispatch(h.window, { type: "initialized", info: { provider: "grok", version: "1.0.5" } });
  dispatch(h.window, { type: "setBusy", value: false });
}

/** A settled empty screen: agents known, device answered, counts delivered. */
function settle(h: Harness, over: TipFacts & { providers?: unknown[]; linked?: boolean } = {}) {
  dispatch(h.window, {
    type: "providerState",
    providers: over.providers ?? [{ id: "grok", connected: true }],
  });
  dispatch(h.window, { type: "remoteStatus", linked: over.linked ?? false });
  tips(h, over);
  connect(h);
}

const tipEl = (h: Harness) => h.doc.getElementById("welcome-tip");
const tipId = (h: Harness) => tipEl(h)?.getAttribute("data-tip") ?? null;
const tipText = (h: Harness) => (tipEl(h)?.textContent || "").replace(/\s+/g, " ").trim();
const action = (h: Harness) => h.doc.querySelector("#welcome-tip .muted-link") as HTMLElement | null;
const dismiss = (h: Harness) =>
  h.doc.querySelector("#welcome-tip .welcome-tip-dismiss") as HTMLElement | null;

/** Walk the whole pool by dismissing, and report what was offered. */
function offeredTips(h: Harness, limit = 14): string[] {
  const seen: string[] = [];
  for (let i = 0; i < limit; i++) {
    const id = tipId(h);
    if (!id) break;
    seen.push(id);
    click(h.window, dismiss(h)!);
  }
  return seen;
}

describe("empty-state advice", () => {
  it("shows one tip once the screen has settled", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    expect(tipEl(h)).toBeTruthy();
    expect(tipText(h)).toContain("Grok isn");
    expect(action(h)?.textContent).toBe("Connect Codex or Claude Code");
  });

  it("stays silent while the status line is busy", () => {
    // A tip under a spinner competes with the one line the reader is waiting for.
    const h = bootWebview({ ready: false });
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
    dispatch(h.window, { type: "remoteStatus", linked: false });
    tips(h);
    dispatch(h.window, { type: "initialized", info: { provider: "grok", version: "1.0.5" } });
    expect(h.doc.getElementById("welcome-version")!.classList.contains("welcome-status-busy")).toBe(true);
    expect(tipEl(h)).toBeNull();
    // …and appears the moment the wait ends.
    dispatch(h.window, { type: "setBusy", value: false });
    expect(tipEl(h)).toBeTruthy();
  });

  it("stays silent while an onboarding card owns the empty state", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    expect(tipEl(h)).toBeTruthy();
    dispatch(h.window, { type: "onboarding", state: "connect-agent", platform: "win32" });
    expect(h.doc.getElementById("welcome-onboarding")!.childNodes.length).toBeGreaterThan(0);
    tips(h);
    expect(tipEl(h)).toBeNull();
  });

  it("yields the slot to the move-view hint while the host still offers it", () => {
    const h = bootWebview({ ready: false, vscode: true });
    dispatch(h.window, {
      ...INITIAL_STATE,
      capabilities: { uploadFile: true, remoteVoice: true, moveViewHint: true },
    });
    settle(h);
    expect(tipId(h)).toBe("moveView");
    expect(tipText(h)).toContain("To move Grok to the right");
    // Retracted → the slot falls through to advice without a reload.
    dispatch(h.window, { type: "moveViewHint", value: false });
    expect(tipId(h)).toBe("providers");
  });

  it("opens the named settings category and retires the tip", () => {
    const h = bootWebview({ ready: false, vscode: true });
    // VS Code hosts the settings surface as an editor tab, so the client posts
    // rather than mounting an overlay — which is what makes the target visible
    // to this test. Desktop and remote open the same category in an overlay.
    dispatch(h.window, {
      ...INITIAL_STATE,
      capabilities: { uploadFile: true, remoteVoice: true, settingsEditor: true },
    });
    settle(h);
    expect(tipId(h)).toBe("providers");
    click(h.window, action(h)!);
    expect(h.posted).toContainEqual({ type: "openSettingsSurface", category: "providers" });
    expect(h.posted).toContainEqual({ type: "dismissWelcomeTip", id: "providers" });
    // Retired locally too, so the slot moves on this click rather than waiting
    // for the host's answering frame.
    expect(tipId(h)).not.toBe("providers");
  });

  it("routes every settings-backed tip to its own category", () => {
    const seen: Record<string, string | undefined> = {};
    for (const start of [[], ["providers"], ["providers", "routines"], ["providers", "routines", "connectors"]]) {
      const h = bootWebview({ ready: false, vscode: true });
      dispatch(h.window, {
        ...INITIAL_STATE,
        capabilities: { uploadFile: true, remoteVoice: true, settingsEditor: true },
      });
      settle(h, { dismissed: start });
      const id = tipId(h)!;
      click(h.window, action(h)!);
      seen[id] = h.posted.find((m) => m.type === "openSettingsSurface")?.category as string;
    }
    expect(seen).toEqual({
      providers: "providers",
      routines: "routines",
      connectors: "connectors",
      remote: "account",
    });
  });

  it("dismisses without opening anything", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    const first = tipId(h);
    click(h.window, dismiss(h)!);
    expect(h.posted).toContainEqual({ type: "dismissWelcomeTip", id: first });
    expect(h.posted.some((m) => m.type === "openSettingsSurface")).toBe(false);
    expect(tipId(h)).not.toBe(first);
  });

  it("empties the slot when every tip is retired", () => {
    const h = bootWebview({ ready: false });
    settle(h, {
      routineCount: 4,
      connectorCount: 2,
      linked: true,
      dismissed: ["providers", "readAloud", "voice", "plan", "mentions"],
    });
    expect(tipEl(h)).toBeNull();
  });

  it("suppresses the count tips until the host has sent counts", () => {
    // No welcomeTips frame at all — an older host. Advice still appears, but
    // never advice that would be wrong for someone already running routines.
    const h = bootWebview({ ready: false });
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: true }] });
    dispatch(h.window, { type: "remoteStatus", linked: false });
    connect(h);
    const offered = offeredTips(h);
    expect(offered).toContain("providers");
    expect(offered).not.toContain("routines");
    expect(offered).not.toContain("connectors");
  });

  it("drops the agents tip as soon as one of Codex or Claude is connected", () => {
    const h = bootWebview({ ready: false });
    settle(h, { providers: [{ id: "grok", connected: true }, { id: "codex", connected: true }] });
    expect(offeredTips(h)).not.toContain("providers");
  });

  it("never offers desk-only advice to a phone", () => {
    const h = bootWebview({ ready: false, remote: true });
    settle(h);
    const offered = offeredTips(h);
    for (const deskOnly of ["providers", "connectors", "remote", "worktrees", "moveView"]) {
      expect(offered, deskOnly).not.toContain(deskOnly);
    }
    // `voiceConfigured` starts optimistically true and only the host says
    // otherwise, so a phone whose desk has a voice key is not told to set one up.
    expect(offered).toEqual(["routines", "readAloud", "plan", "mentions"]);
  });

  it("offers voice setup only once the host says voice is unconfigured", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    expect(offeredTips(h)).not.toContain("voice");
    const fresh = bootWebview({ ready: false });
    dispatch(fresh.window, { type: "voiceConfigured", value: false });
    settle(fresh);
    expect(offeredTips(fresh)).toContain("voice");
  });

  it("puts an @ in the composer and opens the mention popover", () => {
    const h = bootWebview({ ready: false });
    settle(h, {
      dismissed: ["providers", "routines", "connectors", "remote", "readAloud", "voice", "plan"],
    });
    expect(tipId(h)).toBe("mentions");
    click(h.window, action(h)!);
    expect((h.doc.getElementById("input") as HTMLTextAreaElement).value).toBe("@");
    expect(h.posted).toContainEqual({ type: "dismissWelcomeTip", id: "mentions" });
  });

  it("renders the worktree tip without a link, and only in Coding", () => {
    const h = bootWebview({ ready: false });
    const allButWorktrees = [
      "providers", "routines", "connectors", "remote", "readAloud", "voice", "plan", "mentions",
    ];
    settle(h, { dismissed: allButWorktrees });
    // Knowledge work is the default — nothing left to say.
    expect(tipEl(h)).toBeNull();
    dispatch(h.window, { type: "appPurpose", value: "coding" });
    tips(h, { dismissed: allButWorktrees });
    expect(tipId(h)).toBe("worktrees");
    // No destination an empty screen could reach, so emphasis rather than a
    // link that would open nothing.
    expect(action(h)).toBeNull();
    expect(h.doc.querySelector("#welcome-tip b")?.textContent).toBe("its own worktree");
  });

  it("rotates on a new empty screen, not on a repaint", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    const first = tipId(h);
    tips(h);
    tips(h);
    expect(tipId(h)).toBe(first);
    // clearMessages is the screen genuinely becoming empty; the next session's
    // own Starting → Connected cycle then reveals the rotated line.
    dispatch(h.window, { type: "clearMessages" });
    connect(h);
    expect(tipId(h)).not.toBe(first);
  });

  it("does not render tip copy as markup", () => {
    const h = bootWebview({ ready: false });
    settle(h);
    // Every tip is built from text nodes; the only elements in the body are the
    // one action span and (for an unlinked tip) a <b>.
    const body = h.doc.querySelector("#welcome-tip .welcome-tip-body")!;
    for (const child of Array.from(body.children)) {
      expect(["SPAN", "B"]).toContain(child.tagName);
    }
  });
});
