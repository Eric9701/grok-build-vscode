import { describe, it, expect } from "vitest";
import {
  INBOUND_DISPOSITION,
  OUTBOUND_DISPOSITION,
  allowFromRemote,
  allowRemoteRepoTarget,
  bracketRemoteSnapshot,
  repoScopeFor,
  sessionForRequest,
  sessionCwdBelongsToRepo,
  inlineMediaForRemote,
  mediaMimeFromPath,
  transformHostMsgForRemote,
  MAX_REMOTE_MEDIA_BYTES,
  type MediaInlineDeps,
} from "../src/remote-policy";
import { HOST_MESSAGE_TYPES, WEBVIEW_MESSAGE_TYPES, type HostMsg } from "../src/protocol";

const sorted = (a: readonly string[]) => [...a].sort();

describe("remote-policy classification tables", () => {
  // tsc already forces this via Record<Union["type"], …>; the runtime assert
  // guards the compiled-JS path the same way protocol.test.ts does.
  it("classifies every WebviewMsg type (no drift behind the protocol)", () => {
    expect(sorted(Object.keys(INBOUND_DISPOSITION))).toEqual(sorted(WEBVIEW_MESSAGE_TYPES));
  });

  it("classifies every HostMsg type", () => {
    expect(sorted(Object.keys(OUTBOUND_DISPOSITION))).toEqual(sorted(HOST_MESSAGE_TYPES));
  });

  it("keeps the load-bearing classifications from the design doc", () => {
    expect(INBOUND_DISPOSITION.ready).toBe("control");
    expect(INBOUND_DISPOSITION.send).toBe("propose");
    expect(INBOUND_DISPOSITION.steerSend).toBe("propose");
    expect(INBOUND_DISPOSITION.uploadFile).toBe("propose");
    expect(INBOUND_DISPOSITION.permissionAnswer).toBe("full");
    expect(INBOUND_DISPOSITION.exitPlanAnswer).toBe("full");
    expect(INBOUND_DISPOSITION.logout).toBe("full");
    expect(INBOUND_DISPOSITION.clearAllSessions).toBe("full");
    expect(INBOUND_DISPOSITION.remotePreferences).toBe("view");
    expect(INBOUND_DISPOSITION.listSessions).toBe("view");
    expect(INBOUND_DISPOSITION.selectRepo).toBe("view");
    expect(INBOUND_DISPOSITION.toggleRepoPin).toBe("full");
    // native pickers/editors/mic act on the LOCAL VS Code — never remote-drivable
    expect(INBOUND_DISPOSITION.openFile).toBe("host-local");
    expect(INBOUND_DISPOSITION.openText).toBe("host-local");
    expect(INBOUND_DISPOSITION.pickFile).toBe("host-local");
    expect(INBOUND_DISPOSITION.voiceStart).toBe("host-local");
    expect(INBOUND_DISPOSITION.remoteVoiceStart).toBe("propose");
    expect(INBOUND_DISPOSITION.remoteVoiceChunk).toBe("propose");
    expect(INBOUND_DISPOSITION.remoteVoiceStop).toBe("propose");
    expect(INBOUND_DISPOSITION.moveView).toBe("host-local");
    // config writers mutate the HOST user's settings — blocked until a
    // per-connection view pref exists
    expect(INBOUND_DISPOSITION.setShowThinking).toBe("host-local");
    expect(INBOUND_DISPOSITION.setReadRepliesAloud).toBe("host-local");
    expect(INBOUND_DISPOSITION.setSummarizeRepliesAloud).toBe("host-local");
    expect(INBOUND_DISPOSITION.summarizeSpeech).toBe("host-local");
    // worktree/rewind flows run native host dialogs (input box / QuickPick) —
    // desktop-only until they get remote-capable UI (2026-07-24)
    expect(INBOUND_DISPOSITION.newWorktreeSession).toBe("host-local");
    expect(INBOUND_DISPOSITION.applyWorktree).toBe("host-local");
    expect(INBOUND_DISPOSITION.removeWorktree).toBe("host-local");
    expect(INBOUND_DISPOSITION.rewindSession).toBe("host-local");
    // relay account actions manage THIS machine's device token
    expect(INBOUND_DISPOSITION.remoteSignIn).toBe("host-local");
    expect(INBOUND_DISPOSITION.remoteSignOut).toBe("host-local");
    expect(INBOUND_DISPOSITION.openRemotePortal).toBe("host-local");
    expect(OUTBOUND_DISPOSITION.remoteStatus).toBe("host-local");
    expect(OUTBOUND_DISPOSITION.readRepliesAloud).toBe("host-local");
    expect(OUTBOUND_DISPOSITION.summarizeRepliesAloud).toBe("host-local");
    expect(OUTBOUND_DISPOSITION.speechSummary).toBe("host-local");
    // Local call sites stay local-only; the same output shapes carry remote STT.
    expect(OUTBOUND_DISPOSITION.voiceState).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.voiceConfigured).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.media).toBe("media");
    expect(OUTBOUND_DISPOSITION.messageChunk).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.permissionRequest).toBe("mirror");
    expect(OUTBOUND_DISPOSITION.permissionOptions).toBe("mirror");
  });
});

describe("remote repo target gate", () => {
  // A predicate, not a set: the host resolves the catalog from disk, and this
  // gate runs on every inbound message including per-keystroke mentionQuery.
  const known = new Set(["/work/a", "/work/b"]);
  const discovered = (cwd: string) => known.has(cwd);

  it("is consulted lazily — a message with no cwd never resolves the catalog", () => {
    let calls = 0;
    const counting = (cwd: string) => { calls++; return known.has(cwd); };
    expect(allowRemoteRepoTarget({ type: "send", text: "hi" }, counting)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "mentionQuery", query: "a" }, counting)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "resumeSession", id: "s" }, counting)).toBe(true);
    expect(calls).toBe(0);
  });

  it("accepts only discovered cwd values for switching, pinning, and explicit resume", () => {
    expect(allowRemoteRepoTarget({ type: "selectRepo", cwd: "/work/a" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "toggleRepoPin", cwd: "/work/b", pinned: true }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "resumeSession", id: "s", cwd: "/work/a" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "clearAllSessions", cwd: "/work/a" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "selectRepo", cwd: "/etc" }, discovered)).toBe(false);
    expect(allowRemoteRepoTarget({ type: "toggleRepoPin", cwd: "/etc", pinned: true }, discovered)).toBe(false);
    expect(allowRemoteRepoTarget({ type: "resumeSession", id: "s", cwd: "/etc" }, discovered)).toBe(false);
    expect(allowRemoteRepoTarget({ type: "clearAllSessions", cwd: "/etc" }, discovered)).toBe(false);
  });

  it("allows cwd-less resume to use the host's already-bounded resolution", () => {
    expect(allowRemoteRepoTarget({ type: "resumeSession", id: "s" }, discovered)).toBe(true);
    expect(allowRemoteRepoTarget({ type: "send", text: "hi" }, discovered)).toBe(true);
  });
});

describe("allowFromRemote tier gating", () => {
  it("view ops pass at every tier", () => {
    for (const tier of ["read-only", "propose", "full"] as const) {
      expect(allowFromRemote("listSessions", tier)).toBe(true);
      expect(allowFromRemote("resumeSession", tier)).toBe(true);
      expect(allowFromRemote("remotePreferences", tier)).toBe(true);
    }
  });

  it("propose ops need propose or full", () => {
    expect(allowFromRemote("send", "read-only")).toBe(false);
    expect(allowFromRemote("send", "propose")).toBe(true);
    expect(allowFromRemote("send", "full")).toBe(true);
  });

  it("approvals and destructive ops need full", () => {
    for (const t of ["permissionAnswer", "exitPlanAnswer", "logout", "deleteSession", "clearAllSessions", "updateGrok"] as const) {
      expect(allowFromRemote(t, "propose")).toBe(false);
      expect(allowFromRemote(t, "full")).toBe(true);
    }
  });

  it("host-local and control are never routed, even at full", () => {
    for (const t of ["openFile", "pickFile", "voiceStart", "moveView", "dropFile", "exportExpr", "ready"] as const) {
      expect(allowFromRemote(t, "full")).toBe(false);
    }
  });
});

const deps = (bytes: Uint8Array | null): MediaInlineDeps => ({
  readFile: () => bytes,
  toBase64: (b) => Buffer.from(b).toString("base64"),
});

const mediaMsg = (over: Partial<Extract<HostMsg, { type: "media" }>> = {}): Extract<HostMsg, { type: "media" }> => ({
  type: "media",
  media: "image",
  ...over,
});

describe("inlineMediaForRemote", () => {
  it("passes an already-inlined data: src through unchanged", () => {
    const msg = mediaMsg({ src: "data:image/png;base64,AAAA" });
    expect(inlineMediaForRemote(msg, deps(null))).toBe(msg);
  });

  it("passes a remote-url-only message through (the browser can load it)", () => {
    const msg = mediaMsg({ url: "https://example.com/x.png" });
    expect(inlineMediaForRemote(msg, deps(null))).toBe(msg);
  });

  it("inlines a webview-uri src from the file path, inferring mime", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = inlineMediaForRemote(
      mediaMsg({ src: "https://file%2B.vscode-resource.example/x.png", path: "C:\\media\\shot.png" }),
      deps(bytes),
    );
    expect(out?.src).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    expect(out?.mimeType).toBe("image/png");
    expect(out?.path).toBe("C:\\media\\shot.png"); // copy-path action survives
  });

  it("prefers the message's own mimeType over the extension guess", () => {
    const out = inlineMediaForRemote(
      mediaMsg({ src: "x", path: "/a/pic.bin", mimeType: "image/jpeg" }),
      deps(new Uint8Array([9])),
    );
    expect(out?.src?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("never transfers video to a remote — by media kind, mime, or extension", () => {
    const bytes = deps(new Uint8Array([1]));
    expect(inlineMediaForRemote(mediaMsg({ media: "video", src: "x", path: "/a/clip.mp4" }), bytes)).toBeNull();
    // even an already-inlined or url-only video is dropped
    expect(inlineMediaForRemote(mediaMsg({ media: "video", src: "data:video/mp4;base64,AAAA" }), bytes)).toBeNull();
    expect(inlineMediaForRemote(mediaMsg({ media: "video", url: "https://example.com/x.mp4" }), bytes)).toBeNull();
    // mis-tagged media field still caught by the mime belt
    expect(inlineMediaForRemote(mediaMsg({ src: "x", path: "/a/clip.mp4" }), bytes)).toBeNull();
    expect(inlineMediaForRemote(mediaMsg({ src: "x", path: "/a/clip.bin", mimeType: "video/webm" }), bytes)).toBeNull();
  });

  it("drops (null) when the file is unreadable, oversized, or pathless", () => {
    expect(inlineMediaForRemote(mediaMsg({ src: "x", path: "/gone.png" }), deps(null))).toBeNull();
    const big = { ...deps(new Uint8Array(10)), maxBytes: 5 };
    expect(inlineMediaForRemote(mediaMsg({ src: "x", path: "/big.png" }), big)).toBeNull();
    expect(inlineMediaForRemote(mediaMsg({ src: "vscode-webview://x" }), deps(new Uint8Array(1)))).toBeNull();
  });

  it("default size cap is the documented constant", () => {
    expect(MAX_REMOTE_MEDIA_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("transformHostMsgForRemote", () => {
  it("mirror types pass through by reference", () => {
    const msg: HostMsg = { type: "messageChunk", text: "hi" };
    expect(transformHostMsgForRemote(msg, deps(null))).toBe(msg);
  });

  it("reused remote voice output types are mirrored", () => {
    expect(transformHostMsgForRemote({ type: "voiceState", status: "idle" }, deps(null)))
      .toEqual({ type: "voiceState", status: "idle" });
    expect(transformHostMsgForRemote({ type: "voiceConfigured", value: true }, deps(null)))
      .toEqual({ type: "voiceConfigured", value: true });
  });

  it("media is inlined via the injected reader", () => {
    const out = transformHostMsgForRemote(mediaMsg({ src: "x", path: "/img.webp" }), deps(new Uint8Array([7])));
    expect((out as { src?: string })?.src?.startsWith("data:image/webp;base64,")).toBe(true);
  });
});

describe("mediaMimeFromPath", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(mediaMimeFromPath("/a/b.PNG")).toBe("image/png");
    expect(mediaMimeFromPath("clip.mp4")).toBe("video/mp4");
    expect(mediaMimeFromPath("noext")).toBe("application/octet-stream");
  });
});

describe("repo scope — global for remote, workspace-local in VS Code", () => {
  const WS = "/work/current";
  const PICKED = "/work/other";

  // The selection is global ON PURPOSE: that is the remote feature, one phone
  // driving whichever project you pick, with every remote client agreeing.
  it("gives every remote client the global selection", () => {
    expect(repoScopeFor("remote", { selectedCwd: PICKED, workspaceRoot: WS })).toBe(PICKED);
  });

  // ...but VS Code hides the switcher, so following the selection there is
  // strictly harmful: it would re-scope a history list the user cannot re-aim,
  // and point New session at a checkout they are not looking at — where Grok
  // would then write files.
  it("keeps VS Code on its own workspace no matter what a phone picked", () => {
    expect(repoScopeFor("local", { selectedCwd: PICKED, workspaceRoot: WS })).toBe(WS);
  });

  it("agrees on the workspace when nothing has been picked", () => {
    for (const origin of ["local", "remote"] as const) {
      expect(repoScopeFor(origin, { selectedCwd: "", workspaceRoot: WS })).toBe(WS);
    }
  });
});

describe("requesting session and repo boundary", () => {
  it("uses the remote group's active session for a remote destructive action", () => {
    const local = { id: "local" };
    const remote = { id: "remote" };
    expect(sessionForRequest("local", local, remote)).toBe(local);
    expect(sessionForRequest("remote", local, remote)).toBe(remote);
    expect(sessionForRequest("remote", local, undefined)).toBeUndefined();
  });

  it("accepts only session cwds owned by the selected repo group", () => {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    expect(sessionCwdBelongsToRepo("C:/Repo/B", ["c:/repo/b", "c:/repo/b-worktree"], same)).toBe(true);
    expect(sessionCwdBelongsToRepo("C:/Repo/A", ["c:/repo/b", "c:/repo/b-worktree"], same)).toBe(false);
  });
});

describe("remote reconnect snapshot replay", () => {
  const batched = (buffer: HostMsg[]) => {
    const snapshot = bracketRemoteSnapshot(buffer);
    expect(snapshot[0]).toEqual({ type: "historyReplay", active: true });
    expect(snapshot[2]).toEqual({ type: "historyReplay", active: false });
    expect(snapshot[1].type).toBe("historyBatch");
    return (snapshot[1] as Extract<HostMsg, { type: "historyBatch" }>).messages;
  };

  it("batches a below-limit transcript without changing its contents", () => {
    const buffer: HostMsg[] = [
      { type: "agentStart" },
      { type: "messageChunk", text: "already finished" },
      { type: "agentEnd" },
    ];
    expect(bracketRemoteSnapshot(buffer)).toEqual([
      { type: "historyReplay", active: true },
      { type: "historyBatch", messages: buffer },
      { type: "historyReplay", active: false },
    ]);
  });

  it("uses only the outer replay brackets when the buffered load had its own", () => {
    const messages = batched([
      { type: "historyReplay", active: true },
      { type: "userMessageChunk", text: "loaded prompt" },
      { type: "messageChunk", text: "loaded answer" },
      { type: "historyReplay", active: false },
    ]);
    expect(messages).toEqual([
      { type: "userMessageChunk", text: "loaded prompt" },
      { type: "messageChunk", text: "loaded answer" },
    ]);
  });

  it("starts the last-ten-user window at a user boundary, not mid-tool-group", () => {
    const buffer: HostMsg[] = [];
    for (let n = 1; n <= 12; n++) {
      buffer.push({ type: "userMessage", text: `user ${n}` });
      buffer.push({ type: "agentStart" });
      buffer.push({ type: "toolCall", call: { toolCallId: `tool-${n}`, title: `tool ${n}` } });
      buffer.push({ type: "toolCallUpdate", call: { toolCallId: `tool-${n}`, status: "completed" } });
      buffer.push({ type: "agentEnd" });
    }

    const messages = batched(buffer);
    expect(messages[0]).toEqual({ type: "userMessage", text: "user 3" });
    expect(messages.filter((m) => m.type === "userMessage")).toHaveLength(10);
    expect(messages.some((m) => m.type === "toolCall" && m.call.toolCallId === "tool-2")).toBe(false);
    expect(messages.some((m) => m.type === "toolCall" && m.call.toolCallId === "tool-3")).toBe(true);
  });

  it("counts a chunked replay prompt once and cuts at its first chunk", () => {
    const buffer: HostMsg[] = [];
    for (let n = 1; n <= 12; n++) {
      buffer.push({ type: "userMessageChunk", text: `user ${n} part A ` });
      buffer.push({ type: "userMessageChunk", text: "part B" });
      buffer.push({ type: "messageChunk", text: `answer ${n}` });
    }

    const messages = batched(buffer);
    expect(messages[0]).toEqual({ type: "userMessageChunk", text: "user 3 part A " });
    expect(messages.filter((m) => m.type === "userMessageChunk")).toHaveLength(20);
  });

  it("drops cards before the cut and renumbers cards that straddle it", () => {
    const buffer: HostMsg[] = [
      {
        type: "permissionHistoryQueue",
        permissions: [
          { title: "before", outcome: "allowed", afterUserMessage: 2, afterHistoryEvent: 2 },
          { title: "first kept", outcome: "allowed", afterUserMessage: 3, afterHistoryEvent: 3 },
          { title: "last kept", outcome: "rejected", afterUserMessage: 12, afterHistoryEvent: 12 },
        ],
      },
      {
        type: "planHistoryQueue",
        plans: [
          { text: "before", verdict: "rejected", afterUserMessage: 1, afterHistoryEvent: 1 },
          { text: "first kept", verdict: "rejected", afterUserMessage: 3, afterHistoryEvent: 3 },
          { text: "last kept", verdict: "approved", afterUserMessage: 12, afterHistoryEvent: 12 },
        ],
      },
      ...Array.from({ length: 12 }, (_, i): HostMsg[] => [
        { type: "userMessage", text: `user ${i + 1}` },
        { type: "messageChunk", text: `answer ${i + 1}` },
        { type: "usage", session: { inputTokens: i + 1 }, afterUserMessage: i + 1, afterHistoryEvent: i + 1 },
      ]).flat(),
    ];

    const messages = batched(buffer);
    const permissions = messages.find((m) => m.type === "permissionHistoryQueue");
    const plans = messages.find((m) => m.type === "planHistoryQueue");
    const usage = messages.filter((m) => m.type === "usage");
    expect(permissions).toEqual({
      type: "permissionHistoryQueue",
      permissions: [
        { title: "first kept", outcome: "allowed", afterUserMessage: 1, afterHistoryEvent: 1 },
        { title: "last kept", outcome: "rejected", afterUserMessage: 10, afterHistoryEvent: 10 },
      ],
    });
    expect(plans).toEqual({
      type: "planHistoryQueue",
      plans: [
        { text: "first kept", verdict: "rejected", afterUserMessage: 1, afterHistoryEvent: 1 },
        { text: "last kept", verdict: "approved", afterUserMessage: 10, afterHistoryEvent: 10 },
      ],
    });
    expect(usage).toHaveLength(10);
    expect(usage[0]).toMatchObject({ afterUserMessage: 1, afterHistoryEvent: 1, session: { inputTokens: 3 } });
    expect(usage[9]).toMatchObject({ afterUserMessage: 10, afterHistoryEvent: 10, session: { inputTokens: 12 } });
    const transcript = messages.filter((m) => m.type !== "permissionHistoryQueue" && m.type !== "planHistoryQueue");
    expect(transcript[0]).toEqual({ type: "userMessage", text: "user 3" });
  });
});
