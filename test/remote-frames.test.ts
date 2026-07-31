import { describe, it, expect } from "vitest";
import {
  REMOTE_PROTO_VERSION,
  helloFrame,
  hostFrame,
  hostToFrame,
  snapshotFrame,
  parseRelayFrame,
  buildUplinkUrl,
  httpBaseFromRelayUrl,
  deviceDisplayName,
  nextBackoffMs,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from "../src/remote-frames";

describe("uplink frame builders", () => {
  it("hello carries the protocol version and optional device name", () => {
    expect(helloFrame("dev-box")).toEqual({ t: "hello", proto: REMOTE_PROTO_VERSION, device: { name: "dev-box" } });
    expect(helloFrame()).toEqual({ t: "hello", proto: REMOTE_PROTO_VERSION });
  });

  it("host/snapshot wrap protocol messages verbatim", () => {
    const msg = { type: "messageChunk", text: "hi" } as const;
    expect(hostFrame(msg)).toEqual({ t: "host", msg });
    expect(snapshotFrame("c1", [msg])).toEqual({ t: "snapshot", clientId: "c1", msgs: [msg] });
    expect(hostToFrame(["c1", "c2"], msg)).toEqual({ t: "host-to", clientIds: ["c1", "c2"], msg });
  });
});

describe("parseRelayFrame", () => {
  it("round-trips the relay frames", () => {
    expect(parseRelayFrame(JSON.stringify({ t: "client-ready", clientId: "c1" }))).toEqual({ t: "client-ready", clientId: "c1" });
    expect(parseRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: "c2",
      tabToken: "0123456789abcdef01234567",
    }))).toEqual({
      t: "client-ready",
      clientId: "c2",
      tabToken: "0123456789abcdef01234567",
    });
    expect(parseRelayFrame(JSON.stringify({ t: "client-left", clientId: "c1" }))).toEqual({ t: "client-left", clientId: "c1" });
    expect(parseRelayFrame(JSON.stringify({ t: "msg", clientId: "c1", msg: { type: "send", text: "x" } }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: { type: "send", text: "x" },
    });
    expect(parseRelayFrame(JSON.stringify({ t: "clients", count: 2 }))).toEqual({ t: "clients", count: 2 });
  });

  it("accepts an absent legacy token but drops malformed client-ready tokens", () => {
    expect(parseRelayFrame(JSON.stringify({
      t: "client-ready",
      clientId: "c1",
    }))).toEqual({ t: "client-ready", clientId: "c1" });
    for (const tabToken of [null, 42, {}, [], "short", "x".repeat(129), "not/url/safe".repeat(2)]) {
      expect(parseRelayFrame(JSON.stringify({
        t: "client-ready",
        clientId: "c1",
        tabToken,
      }))).toBeNull();
    }
  });

  it("drops malformed input instead of throwing", () => {
    expect(parseRelayFrame("not json")).toBeNull();
    expect(parseRelayFrame("42")).toBeNull();
    expect(parseRelayFrame(JSON.stringify({ t: "nope" }))).toBeNull();
    expect(parseRelayFrame(JSON.stringify({ t: "client-ready" }))).toBeNull(); // no clientId
    expect(parseRelayFrame(JSON.stringify({ t: "client-left" }))).toBeNull(); // no clientId
    expect(parseRelayFrame(JSON.stringify({ t: "msg", clientId: "c1" }))).toBeNull(); // no msg
    expect(parseRelayFrame(JSON.stringify({ t: "msg", clientId: "c1", msg: { text: "x" } }))).toBeNull(); // msg w/o type
    expect(parseRelayFrame(JSON.stringify({ t: "clients", count: "2" }))).toBeNull();
  });

  const traversalMessages = [
    ["selectRepo cwd", { type: "selectRepo", cwd: "../.." }],
    ["toggleRepoPin cwd", { type: "toggleRepoPin", cwd: "..\\..", pinned: true }],
    ["resumeSession id", { type: "resumeSession", id: "../.." }],
    ["resumeSession cwd", { type: "resumeSession", id: "safe-session", cwd: "/work/../escape" }],
    ["renameSession id", { type: "renameSession", id: "..\\..", name: "renamed" }],
    ["deleteSession id", { type: "deleteSession", id: "../.." }],
    ["clearAllSessions cwd", { type: "clearAllSessions", cwd: "../.." }],
    ["addMentionFile relPath", { type: "addMentionFile", relPath: "../../secret.txt" }],
    ["uploadFile name", { type: "uploadFile", name: "../../secret.md", data: "YQ==" }],
  ] as const;

  it.each(traversalMessages)(
    "drops traversal in remote-reachable %s at the wire boundary",
    (_name, msg) => {
      const wrap = (value: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg: value });
      expect(parseRelayFrame(wrap(msg))).toBeNull();
    },
  );

  it("drops unknown message types", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({ type: "notAWebviewMessage" }))).toBeNull();
  });

  it("validates queued-send identity on remote send frames", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({
      type: "send",
      text: "queued",
      queuedSendId: "01234567-89ab-cdef-0123-456789abcdef",
    }))).not.toBeNull();
    for (const queuedSendId of [null, 42, "short", "not/a/submission/id"]) {
      expect(parseRelayFrame(wrap({ type: "send", text: "queued", queuedSendId }))).toBeNull();
    }
  });

  it("validates and reconstructs ordinary remote send frames", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    const submissionId = "0123456789abcdef".repeat(3);
    expect(parseRelayFrame(wrap({
      type: "send",
      text: "from the phone",
      bare: false,
      submissionId,
      chips: [{ id: "unchecked-legacy-render-copy" }],
      futureUncheckedField: { large: "payload" },
    }))).toEqual({
      t: "msg",
      clientId: "c1",
      msg: {
        type: "send",
        text: "from the phone",
        bare: false,
        submissionId,
      },
    });

    for (const malformed of [
      { type: "send", text: 42 },
      { type: "send", text: "x", bare: "false" },
      { type: "send", text: "x", submissionId: null },
      { type: "send", text: "x", submissionId: {} },
      { type: "send", text: "x", submissionId: "short" },
      { type: "send", text: "x", submissionId: "x".repeat(129) },
      { type: "send", text: "x", submissionId: "not/a/submission/token" },
    ]) {
      expect(parseRelayFrame(wrap(malformed)), JSON.stringify(malformed)).toBeNull();
    }
  });

  it("accepts canonical filesystem-bearing remote payloads", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    for (const msg of [
      { type: "selectRepo", cwd: "/work/repo" },
      { type: "toggleRepoPin", cwd: "C:\\work\\repo", pinned: true },
      { type: "resumeSession", id: "019f-session_1", cwd: "\\\\server\\share\\repo" },
      { type: "renameSession", id: "019f-session_1", name: "renamed" },
      { type: "deleteSession", id: "019f-session_1" },
      { type: "clearAllSessions", cwd: "/work/repo" },
      { type: "addMentionFile", relPath: "src/file.ts" },
      { type: "uploadFile", name: "Quarterly Notes.pdf", data: "YQ==" },
    ]) {
      expect(parseRelayFrame(wrap(msg)), JSON.stringify(msg)).not.toBeNull();
    }
  });

  it("drops malformed filesystem selectors and accepts a valid ready token", () => {
    const wrap = (msg: unknown) => JSON.stringify({ t: "msg", clientId: "c1", msg });
    expect(parseRelayFrame(wrap({ type: "selectRepo", cwd: {} }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "toggleRepoPin", cwd: "/a", pinned: "yes" }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "resumeSession", id: "s", cwd: [] }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "clearAllSessions", cwd: 42 }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "ready", tabToken: "short" }))).toBeNull();
    expect(parseRelayFrame(wrap({ type: "ready", tabToken: "0123456789abcdef01234567" }))).not.toBeNull();
  });
});

describe("url helpers", () => {
  it("buildUplinkUrl appends /uplink with the encoded token", () => {
    expect(buildUplinkUrl("ws://localhost:8787", "a+b/c")).toBe("ws://localhost:8787/uplink?token=a%2Bb%2Fc");
    expect(buildUplinkUrl("wss://relay.example/", "t")).toBe("wss://relay.example/uplink?token=t");
  });

  it("httpBaseFromRelayUrl swaps ws->http / wss->https and trims the trailing slash", () => {
    expect(httpBaseFromRelayUrl("ws://localhost:8787")).toBe("http://localhost:8787");
    expect(httpBaseFromRelayUrl("wss://relay.example/")).toBe("https://relay.example");
    expect(httpBaseFromRelayUrl("WSS://relay.example")).toBe("https://relay.example");
  });
});

describe("deviceDisplayName", () => {
  it("labels Windows 11 by kernel build >= 22000", () => {
    expect(deviceDisplayName("Dell", "win32", "10.0.26200")).toBe("Dell (Windows 11)");
  });

  it("labels older Windows as Windows 10", () => {
    expect(deviceDisplayName("PC", "win32", "10.0.19045")).toBe("PC (Windows 10)");
  });

  it("maps darwin to macOS and linux to Linux", () => {
    expect(deviceDisplayName("Mac", "darwin", "23.5.0")).toBe("Mac (macOS)");
    expect(deviceDisplayName("box", "linux", "6.1.0")).toBe("box (Linux)");
  });

  it("passes an unknown platform through as-is", () => {
    expect(deviceDisplayName("host", "freebsd", "14.0")).toBe("host (freebsd)");
  });

  it("falls back to just the OS label when the hostname is empty", () => {
    expect(deviceDisplayName("", "win32", "10.0.26200")).toBe("Windows 11");
  });
});

describe("nextBackoffMs", () => {
  it("doubles from the initial value and caps", () => {
    expect(nextBackoffMs(INITIAL_BACKOFF_MS)).toBe(INITIAL_BACKOFF_MS * 2);
    expect(nextBackoffMs(MAX_BACKOFF_MS)).toBe(MAX_BACKOFF_MS);
    expect(nextBackoffMs(0)).toBe(INITIAL_BACKOFF_MS * 2); // floor below initial
  });
});
