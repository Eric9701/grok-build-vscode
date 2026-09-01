import { describe, expect, it } from "vitest";
import { SESSION_SUPERSEDED_CODE } from "../src/protocol";
import { bootWebview, click, dispatch } from "./webview-harness";

describe("remote session claim (client)", () => {
  it("sets claim on a rail/history click and omits it on reconnect restore", () => {
    const remembered = {
      id: "remembered",
      repoCwd: "/work/repo",
      cwd: "/work/repo",
    };
    const restored = bootWebview({
      remote: true,
      beforeScripts: (w) => {
        w.sessionStorage.setItem("grok.remote.tabSession:default", JSON.stringify(remembered));
      },
    });
    dispatch(restored.window, { type: "initialState", cwd: "/work/repo" });
    expect(restored.posted.filter((p) => p.type === "resumeSession")).toEqual([
      { type: "resumeSession", id: "remembered", cwd: "/work/repo" },
    ]);

    const { window, posted, doc } = bootWebview({ remote: true });
    dispatch(window, {
      type: "sessions",
      entries: [
        { id: "s1", cwd: "/work/repo", displayName: "One" },
        { id: "s2", cwd: "/work/repo", displayName: "Two" },
      ],
      activeId: "s1",
      dots: {},
    });
    click(window, doc.getElementById("history-btn")!);
    posted.length = 0;
    click(window, doc.querySelectorAll(".history-row")[1] as HTMLElement);
    expect(posted.filter((p) => p.type === "resumeSession")).toEqual([
      { type: "resumeSession", id: "s2", cwd: "/work/repo", claim: true },
    ]);
  });

  it("freezes the transcript on session-superseded and Continue here claims it", () => {
    const { window, posted, doc } = bootWebview({ remote: true });
    dispatch(window, { type: "sessions", entries: [
      { id: "s1", cwd: "/work/repo", displayName: "One" },
    ], activeId: "s1", dots: {} });
    dispatch(window, { type: "userMessage", text: "keep this turn" });
    expect(doc.querySelector(".msg.user")?.textContent).toContain("keep this turn");

    dispatch(window, {
      type: "error",
      text: "This conversation is now open in another tab. Continue here to take it back.",
      resumeFailed: { id: "s1" },
      code: SESSION_SUPERSEDED_CODE,
    });

    expect(doc.querySelector(".msg.user")?.textContent).toContain("keep this turn");
    expect(doc.querySelector(".msg.error")?.getAttribute("data-error-code")).toBe(SESSION_SUPERSEDED_CODE);
    expect(doc.body.classList.contains("session-superseded")).toBe(true);
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    const banner = doc.getElementById("session-superseded-banner");
    expect(banner?.textContent).toContain("Continue here");

    posted.length = 0;
    click(window, banner!.querySelector("button") as HTMLElement);
    expect(posted).toContainEqual({
      type: "resumeSession",
      id: "s1",
      cwd: "/work/repo",
      claim: true,
    });
  });

  it("does not abort an unrelated rail transition when a different session is superseded", () => {
    const { window, posted, doc } = bootWebview({ remote: true });
    dispatch(window, {
      type: "sessions",
      entries: [
        { id: "s1", cwd: "/work/repo", displayName: "One" },
        { id: "s2", cwd: "/work/repo", displayName: "Two" },
      ],
      activeId: "s1",
      dots: {},
    });
    dispatch(window, { type: "userMessage", text: "old transcript" });
    click(window, doc.getElementById("history-btn")!);
    posted.length = 0;
    click(window, doc.querySelectorAll(".history-row")[1] as HTMLElement);
    expect(posted).toContainEqual({
      type: "resumeSession", id: "s2", cwd: "/work/repo", claim: true,
    });
    expect((doc.querySelector(".msg.user") as HTMLElement).hidden).toBe(true);

    dispatch(window, {
      type: "error",
      text: "This conversation is now open in another tab.",
      resumeFailed: { id: "s1" },
      code: SESSION_SUPERSEDED_CODE,
    });

    expect((doc.querySelector(".msg.user") as HTMLElement).hidden).toBe(true);
    expect(doc.body.classList.contains("session-superseded")).toBe(false);
    expect(doc.getElementById("session-superseded-banner")).toBeNull();
  });
});
