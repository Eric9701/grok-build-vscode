// DOM regression for session Markdown export + dimmed message actions.
// Drives the real media/chat.js path: the ⋯ menu records the same host events
// the renderer consumes, then posts openText (desk) or triggers an <a download>
// (remote).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bootWebview, click, dispatch } from "./webview-harness";

const css = readFileSync(new URL("../media/chat.css", import.meta.url), "utf8");

function playTurn(window: Window, user: string, agent: string) {
  dispatch(window, { type: "userMessage", text: user, chips: [] });
  dispatch(window, { type: "agentStart" });
  dispatch(window, { type: "thoughtChunk", text: "hidden reasoning" });
  dispatch(window, { type: "messageChunk", text: agent });
  dispatch(window, { type: "agentEnd" });
}

function exportMenuItem(doc: Document): HTMLButtonElement | undefined {
  return [...doc.querySelectorAll(".rail-menu-item")].find((el) =>
    (el.textContent || "").includes("Export as Markdown"),
  ) as HTMLButtonElement | undefined;
}

function exportViaOverflow(window: Window, doc: Document): void {
  const slot = doc.getElementById("session-head-actions");
  const btn = slot?.querySelector(".rail-menu-btn") as HTMLButtonElement | null;
  expect(btn, "session ⋯ menu").toBeTruthy();
  if (doc.querySelector(".rail-menu")) {
    doc.dispatchEvent(new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
  }
  click(window, btn!);
  const item = exportMenuItem(doc);
  expect(item, "Export as Markdown in ⋯").toBeTruthy();
  click(window, item!);
}

function stubRemoteDownload(window: Window): {
  blobs: Blob[];
  downloads: { href: string; name: string }[];
  restore: () => void;
} {
  const blobs: Blob[] = [];
  const urlApi = window.URL as unknown as {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
  };
  const origCreate = urlApi.createObjectURL;
  const origRevoke = urlApi.revokeObjectURL;
  urlApi.createObjectURL = (blob: Blob) => {
    blobs.push(blob);
    return "blob:export-session";
  };
  urlApi.revokeObjectURL = () => {};
  const downloads: { href: string; name: string }[] = [];
  const proto = (window as unknown as { HTMLAnchorElement: { prototype: HTMLAnchorElement } }).HTMLAnchorElement.prototype;
  const origClick = proto.click;
  proto.click = function (this: HTMLAnchorElement) {
    if (this.download) downloads.push({ href: this.href, name: this.download });
  };
  return {
    blobs,
    downloads,
    restore: () => {
      urlApi.createObjectURL = origCreate;
      urlApi.revokeObjectURL = origRevoke;
      proto.click = origClick;
    },
  };
}

describe("export conversation lives in the session overflow", () => {
  it("has no standalone toolbar button", () => {
    const { doc } = bootWebview();
    expect(doc.getElementById("export-session-btn")).toBeNull();
    expect(css).not.toMatch(/export-session-btn/);
  });

  it("offers Export as Markdown in the ⋯ menu and opens markdown via openText", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Rewind map", cwd: "/work/repo" });
    playTurn(window, "explain the footer", "It waits for agentEnd.");

    exportViaOverflow(window, doc);
    const sent = posted.filter((m) => m.type === "openText");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "openText",
      language: "markdown",
      filename: "Rewind map.md",
    });
    const content = String(sent[0].content);
    expect(content).toContain("# Rewind map");
    expect(content).toContain("## User");
    expect(content).toContain("explain the footer");
    expect(content).toContain("## Assistant");
    expect(content).toContain("It waits for agentEnd.");
    expect(content).not.toContain("hidden reasoning");
  });

  it("downloads a named markdown file on the remote client", async () => {
    const { window, doc, posted } = bootWebview({ remote: true });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Phone chat", cwd: "/work/repo" });
    playTurn(window, "hello from the phone", "hi there");

    const stub = stubRemoteDownload(window);
    try {
      exportViaOverflow(window, doc);
      expect(posted.filter((m) => m.type === "openText")).toHaveLength(0);
      expect(stub.downloads).toEqual([{ href: "blob:export-session", name: "Phone chat.md" }]);
      expect(stub.blobs).toHaveLength(1);
      const text = await stub.blobs[0].text();
      expect(text).toContain("# Phone chat");
      expect(text).toContain("hello from the phone");
      expect(text).toContain("hi there");
    } finally {
      stub.restore();
    }
  });

  it("says last N turns after a remote historyReplay window", async () => {
    const { window, doc, posted } = bootWebview({ remote: true });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Windowed", cwd: "/work/repo" });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "older kept turn" });
    dispatch(window, { type: "messageChunk", text: "kept answer" });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "historyReplay", active: false });

    const stub = stubRemoteDownload(window);
    try {
      exportViaOverflow(window, doc);
      expect(posted.filter((m) => m.type === "openText")).toHaveLength(0);
      const text = await stub.blobs[0].text();
      expect(text).toMatch(/Last 1 turn\./);
      expect(text).toContain("older kept turn");
    } finally {
      stub.restore();
    }
  });

  it("clears the export log when the session is wiped", () => {
    const { window, doc, posted } = bootWebview();
    playTurn(window, "first conversation", "first answer");
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "sessionName", sessionId: "s2", name: "Fresh", cwd: "/work/repo" });
    playTurn(window, "second conversation", "second answer");

    exportViaOverflow(window, doc);
    const content = String(posted.find((m) => m.type === "openText")?.content);
    expect(content).toContain("second conversation");
    expect(content).not.toContain("first conversation");
  });

  function lastExportedMarkdown(window: Window, doc: Document, posted: { type: string; content?: unknown }[]): string {
    exportViaOverflow(window, doc);
    const sent = posted.filter((m) => m.type === "openText");
    return String(sent[sent.length - 1]?.content ?? "");
  }

  it("drops discarded rewind turns from the export and appends later ones", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Rewound", cwd: "/work/repo" });
    playTurn(window, "one", "reply-alpha");
    playTurn(window, "two", "reply-bravo");
    playTurn(window, "three", "reply-charlie");
    dispatch(window, { type: "truncateMessages", surviving: 2 });

    const afterRewind = lastExportedMarkdown(window, doc, posted);
    expect(afterRewind).toContain("one");
    expect(afterRewind).toContain("reply-alpha");
    expect(afterRewind).toContain("two");
    expect(afterRewind).toContain("reply-bravo");
    expect(afterRewind).not.toContain("three");
    expect(afterRewind).not.toContain("reply-charlie");

    playTurn(window, "four", "reply-delta");
    const afterContinue = lastExportedMarkdown(window, doc, posted);
    expect(afterContinue).toContain("one");
    expect(afterContinue).toContain("two");
    expect(afterContinue).toContain("four");
    expect(afterContinue).toContain("reply-delta");
    expect(afterContinue).not.toContain("three");
    expect(afterContinue).not.toContain("reply-charlie");
  });

  it("prunes a replayed transcript the same way as a live one", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Replayed rewind", cwd: "/work/repo" });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "one" });
    dispatch(window, { type: "messageChunk", text: "reply-alpha" });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "userMessageChunk", text: "two" });
    dispatch(window, { type: "messageChunk", text: "reply-bravo" });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "userMessageChunk", text: "three" });
    dispatch(window, { type: "messageChunk", text: "reply-charlie" });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "historyReplay", active: false });
    dispatch(window, { type: "truncateMessages", surviving: 2 });

    const content = lastExportedMarkdown(window, doc, posted);
    expect(content).toContain("one");
    expect(content).toContain("two");
    expect(content).not.toContain("three");
    expect(content).not.toContain("reply-charlie");
  });

  it("does not let a steer interjection shift the rewind export cut", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Steer cut", cwd: "/work/repo" });
    playTurn(window, "one", "reply-alpha");
    dispatch(window, { type: "userMessage", text: "(read only)", chips: [], steer: true });
    playTurn(window, "two", "reply-bravo");
    dispatch(window, { type: "truncateMessages", surviving: 1 });

    const content = lastExportedMarkdown(window, doc, posted);
    expect(content).toContain("one");
    expect(content).toContain("reply-alpha");
    expect(content).toContain("(read only)");
    expect(content).not.toContain("two");
    expect(content).not.toContain("reply-bravo");
  });

  it("omits hidden user turns from the export and the windowed turn count", async () => {
    const { window, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Windowed hide", cwd: "/work/repo" });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "visible one" });
    dispatch(window, { type: "messageChunk", text: "answer one" });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "userMessageChunk", text: "<system-reminder>background task finished</system-reminder>" });
    dispatch(window, { type: "messageChunk", text: "ack reminder" });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "userMessageChunk", text: "[Plan cancelled]" });
    dispatch(window, { type: "messageChunk", text: "still planning" });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "userMessageChunk", text: "visible two" });
    dispatch(window, { type: "messageChunk", text: "answer two" });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "historyReplay", active: false });

    const stub = stubRemoteDownload(window);
    try {
      exportViaOverflow(window, doc);
      const text = await stub.blobs[0].text();
      expect(text).toMatch(/Last 2 turns\./);
      expect(text).toContain("visible one");
      expect(text).toContain("visible two");
      expect(text).toContain("ack reminder");
      expect(text).toContain("still planning");
      expect(text).not.toContain("system-reminder");
      expect(text).not.toContain("background task finished");
      expect(text).not.toContain("[Plan cancelled]");
      expect(text).not.toMatch(/## User[\s\S]*background task/);
    } finally {
      stub.restore();
    }
  });

  function replayMarkerOnlyTail(window: Window) {
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "visible one" });
    dispatch(window, { type: "messageChunk", text: "answer one" });
    dispatch(window, { type: "agentEnd" });
    // Marker-only last user event with no following agent chunk — the hole
    // the older tests never covered (they always sent a chunk after).
    dispatch(window, { type: "userMessageChunk", text: "[Plan cancelled]" });
    dispatch(window, { type: "historyReplay", active: false });
  }

  it("records a live prompt after a marker-only restore with no trailing agent chunk", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Tail marker", cwd: "/work/repo" });
    replayMarkerOnlyTail(window);

    dispatch(window, { type: "userMessage", text: "please continue", chips: [] });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "continuing" });
    dispatch(window, { type: "agentEnd" });

    const users = [...doc.querySelectorAll(".msg.user")].map((el) => el.textContent || "");
    expect(users.some((t) => t.includes("please continue"))).toBe(true);
    expect(users.some((t) => t.includes("[Plan cancelled]"))).toBe(false);

    const content = lastExportedMarkdown(window, doc, posted);
    expect(content).toContain("visible one");
    expect(content).toContain("please continue");
    expect(content).toContain("continuing");
    expect(content).not.toContain("[Plan cancelled]");
  });

  it("records a userMessage that follows a marker-only tail inside the same historyReplay", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Rebuild tail", cwd: "/work/repo" });
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessageChunk", text: "visible one" });
    dispatch(window, { type: "messageChunk", text: "answer one" });
    dispatch(window, { type: "agentEnd" });
    dispatch(window, { type: "userMessageChunk", text: "[Plan cancelled]" });
    dispatch(window, { type: "userMessage", text: "please continue", chips: [] });
    dispatch(window, { type: "historyReplay", active: false });

    const users = [...doc.querySelectorAll(".msg.user")].map((el) => el.textContent || "");
    expect(users.some((t) => t.includes("please continue"))).toBe(true);
    expect(users.some((t) => t.includes("[Plan cancelled]"))).toBe(false);

    const content = lastExportedMarkdown(window, doc, posted);
    expect(content).toContain("visible one");
    expect(content).toContain("please continue");
    expect(content).not.toContain("[Plan cancelled]");
  });

  it("a focus-swap replay of the same tail still records the next live prompt", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Tail marker", cwd: "/work/repo" });
    replayMarkerOnlyTail(window);

    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Tail marker", cwd: "/work/repo" });
    replayMarkerOnlyTail(window);

    dispatch(window, { type: "userMessage", text: "please continue", chips: [] });
    dispatch(window, { type: "agentStart" });
    dispatch(window, { type: "messageChunk", text: "continuing" });
    dispatch(window, { type: "agentEnd" });

    const users = [...doc.querySelectorAll(".msg.user")].map((el) => el.textContent || "");
    expect(users.some((t) => t.includes("please continue"))).toBe(true);

    const content = lastExportedMarkdown(window, doc, posted);
    expect(content).toContain("please continue");
    expect(content).toContain("continuing");
    expect(content).not.toContain("[Plan cancelled]");
  });
});

describe("VS Code session overflow", () => {
  function openGear(window: Window, doc: Document) {
    const btn = doc.getElementById("gear-btn") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    click(window, btn);
    expect(doc.getElementById("gear-popover")!.hidden).toBe(false);
  }

  function openVsCodeOverflow(window: Window, doc: Document): HTMLButtonElement[] {
    const btn = doc.querySelector("#vscode-session-actions .rail-menu-btn") as HTMLButtonElement | null;
    expect(btn, "VS Code session ⋯ menu").toBeTruthy();
    click(window, btn!);
    return [...doc.querySelectorAll(".rail-menu-item")] as HTMLButtonElement[];
  }

  it("contains exactly the two moved actions and removes them from the gear", () => {
    const { window, doc } = bootWebview({ vscode: true });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Has overflow", cwd: "/work/repo" });
    playTurn(window, "hello", "hi");
    openGear(window, doc);
    expect(doc.getElementById("gear-popover")!.textContent).not.toContain("Continue in a new chat");
    expect(doc.getElementById("gear-popover")!.textContent).not.toContain("Export conversation as Markdown");
    const items = openVsCodeOverflow(window, doc);
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Continue in a new chat",
      "Export conversation as Markdown",
    ]);
  });

  it("hides the overflow until a conversation is open", () => {
    const { window, doc } = bootWebview({ vscode: true });
    expect(doc.querySelector("#vscode-session-actions .rail-menu-btn")).toBeNull();
    openGear(window, doc);
    expect(doc.getElementById("gear-popover")!.textContent).not.toContain("Continue in a new chat");
    expect(doc.getElementById("gear-popover")!.textContent).not.toContain("Export conversation as Markdown");
  });

  it("offers Export conversation as Markdown in the overflow and posts openText", () => {
    const { window, doc, posted } = bootWebview({ vscode: true });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Rewind map", cwd: "/work/repo" });
    playTurn(window, "explain the footer", "It waits for agentEnd.");
    const item = openVsCodeOverflow(window, doc).find((el) =>
      (el.textContent || "").includes("Export conversation as Markdown"),
    );
    expect(item, "Export conversation as Markdown in VS Code overflow").toBeTruthy();
    click(window, item!);
    const sent = posted.filter((m) => m.type === "openText");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "openText",
      language: "markdown",
      filename: "Rewind map.md",
    });
    expect(String(sent[0].content)).toContain("explain the footer");
  });

  it("closes on Escape and outside click", () => {
    const { window, doc } = bootWebview({ vscode: true });
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "Dismiss menu", cwd: "/work/repo" });
    openVsCodeOverflow(window, doc);
    doc.dispatchEvent(new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    expect(doc.querySelector(".rail-menu")).toBeNull();

    openVsCodeOverflow(window, doc);
    click(window, doc.body);
    expect(doc.querySelector(".rail-menu")).toBeNull();
  });
});

describe("message actions stay dimmed until hover or focus", () => {
  it("defaults .msg-actions to a dim opacity, not hidden", () => {
    const rule = css.slice(css.indexOf(".msg-actions {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toMatch(/opacity:\s*0\.4/);
    expect(body).not.toMatch(/opacity:\s*0\s*;/);
  });

  it("raises them to full opacity on hover and :focus-visible", () => {
    expect(css).toMatch(
      /\.msg\.user:hover \.msg-actions,\s*\.msg\.agent:hover \.msg-actions,\s*\.msg-actions:focus-within,\s*\.msg-actions:focus-visible\s*\{[^}]*opacity:\s*1/,
    );
  });

  it("keeps the dimmed row as the touch resting state", () => {
    expect(css).toMatch(
      /@media \(hover: none\)\s*\{\s*\.msg\.user \.msg-actions,\s*\.msg\.agent \.msg-actions\s*\{[^}]*opacity:\s*0\.4/,
    );
  });
});
