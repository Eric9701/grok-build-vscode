// Open-path history window (#102). A long replay renders only the last N
// counted user turns; earlier turns prepend on demand. Live sessions stay whole.
import { describe, it, expect } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

function setHistoryWindow(window: Window, n: number) {
  (window as unknown as { __grokHistoryWindow: number }).__grokHistoryWindow = n;
}

function api(window: Window) {
  return (window as unknown as {
    __grokHistory: {
      prefixRemaining: () => number;
      prefixLength: () => number;
      expandMore: () => boolean;
      expandAll: () => void;
    };
    __grokFind: {
      open: () => void;
      setQuery: (q: string) => void;
      matchCount: () => number;
    };
  });
}

function playLiveTurn(window: Window, user: string, agent: string) {
  dispatch(window, { type: "userMessage", text: user, chips: [] });
  dispatch(window, { type: "agentStart" });
  dispatch(window, { type: "messageChunk", text: agent });
  dispatch(window, { type: "agentEnd" });
}

function replayTurns(window: Window, n: number, label: (i: number) => { user: string; agent: string }) {
  dispatch(window, { type: "historyReplay", active: true });
  for (let i = 0; i < n; i++) {
    const t = label(i);
    dispatch(window, { type: "userMessage", text: t.user, chips: [] });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: t.agent });
    dispatch(window, { type: "agentEnd" });
  }
  dispatch(window, { type: "historyReplay", active: false });
}

function userBodies(doc: Document) {
  return [...doc.querySelectorAll(".msg.user:not(.queued) .body")].map((el) => (el.textContent || "").trim());
}

describe("history window on open (#102)", () => {
  it("renders a short replay in full", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 5);
    replayTurns(window, 4, (i) => ({ user: `short-user-${i}`, agent: `short-agent-${i}` }));
    expect(userBodies(doc)).toEqual([
      "short-user-0", "short-user-1", "short-user-2", "short-user-3",
    ]);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
  });

  it("renders only the last window of a long replay", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 5);
    replayTurns(window, 12, (i) => ({ user: `user-${i}`, agent: `agent-${i}` }));
    expect(userBodies(doc)).toEqual([
      "user-7", "user-8", "user-9", "user-10", "user-11",
    ]);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(7);
    expect(doc.body.textContent).not.toContain("user-0");
    const last = doc.querySelectorAll(".msg.user:not(.queued)")[4] as HTMLElement;
    expect(last.dataset.userBubbleIndex).toBe("11");
  });

  it("prepends earlier turns without dropping the live tail", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 4);
    replayTurns(window, 10, (i) => ({ user: `u${i}`, agent: `a${i}` }));
    expect(userBodies(doc)).toEqual(["u6", "u7", "u8", "u9"]);
    api(window).__grokHistory.expandMore();
    const users = userBodies(doc);
    expect(users[0]).toBe("u0");
    expect(users.slice(-4)).toEqual(["u6", "u7", "u8", "u9"]);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
  });

  it("prepends older chunks from the top without unloading later ones", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 5);
    replayTurns(window, 50, (i) => ({ user: `u${i}`, agent: `a${i}` }));
    expect(userBodies(doc)).toEqual(["u45", "u46", "u47", "u48", "u49"]);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(45);
    expect(api(window).__grokHistory.expandMore()).toBe(true);
    const afterFirst = userBodies(doc);
    expect(afterFirst.slice(-5)).toEqual(["u45", "u46", "u47", "u48", "u49"]);
    expect(afterFirst[0]).toBe("u5");
    expect(api(window).__grokHistory.prefixRemaining()).toBe(5);
    expect(api(window).__grokHistory.expandMore()).toBe(true);
    const afterSecond = userBodies(doc);
    expect(afterSecond[0]).toBe("u0");
    expect(afterSecond.slice(-5)).toEqual(["u45", "u46", "u47", "u48", "u49"]);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
  });

  it("does not window a live session that grows one turn at a time", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 3);
    for (let i = 0; i < 8; i++) playLiveTurn(window, `live-${i}`, `reply-${i}`);
    expect(userBodies(doc)).toHaveLength(8);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
  });

  it("find expands unrendered history before searching", () => {
    const { window, doc } = bootWebview();
    setHistoryWindow(window, 4);
    replayTurns(window, 10, (i) => ({
      user: i === 0 ? "EARLY_NEEDLE_TOKEN hello" : `user-${i}`,
      agent: `agent-${i}`,
    }));
    expect(doc.body.textContent).not.toContain("EARLY_NEEDLE_TOKEN");
    const find = api(window).__grokFind;
    find.open();
    find.setQuery("EARLY_NEEDLE_TOKEN");
    expect(find.matchCount()).toBe(1);
    expect(api(window).__grokHistory.prefixRemaining()).toBe(0);
    expect(userBodies(doc)[0]).toContain("EARLY_NEEDLE_TOKEN");
  });

  it("export includes unrendered prefix turns", () => {
    const { window, posted } = bootWebview();
    setHistoryWindow(window, 3);
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Long", cwd: "/w" });
    replayTurns(window, 6, (i) => ({ user: i === 0 ? "export-early-token" : `user-${i}`, agent: `agent-${i}` }));
    expect(api(window).__grokHistory.prefixRemaining()).toBe(3);
    const slot = window.document.getElementById("session-head-actions");
    const btn = slot?.querySelector(".rail-menu-btn") as HTMLButtonElement;
    click(window, btn);
    const item = [...window.document.querySelectorAll(".rail-menu-item")]
      .find((el) => (el.textContent || "").includes("Export as Markdown")) as HTMLButtonElement;
    click(window, item);
    const sent = posted.filter((m) => m.type === "openText");
    expect(sent).toHaveLength(1);
    expect(String(sent[0].content)).toContain("export-early-token");
  });
});
