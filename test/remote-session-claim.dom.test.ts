import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
    expect(doc.body.classList.contains("session-superseded")).toBe(true);

    // The card is the ONLY message. It used to also print the host's sentence
    // into the transcript in red, so the same thing was said twice — once
    // calmly where the composer had been and once as a failure above it, which
    // reads as two separate things going wrong (owner, 2026-09-01).
    expect(doc.querySelector(`.msg.error[data-error-code="${SESSION_SUPERSEDED_CODE}"]`)).toBeNull();

    const banner = doc.getElementById("session-superseded-banner");
    expect(banner?.querySelector(".session-superseded-title")?.textContent)
      .toContain("moved to another tab");
    // Leads with the reassurance, because that is the first thing a person
    // wants to know when their composer has vanished.
    expect(banner?.querySelector(".session-superseded-body")?.textContent)
      .toContain("Nothing was lost");
    expect(banner?.querySelector(".session-superseded-btn")?.textContent).toBe("Continue here");

    // EVERY composer control, not just the textarea: a frozen conversation that
    // still offers Send or the mode picker is offering actions the host
    // refuses, and `disabled` is what makes them unclickable rather than faded.
    for (const id of ["input", "send-btn", "add-btn", "gear-btn", "mode-btn", "mic-btn"]) {
      const el = doc.getElementById(id) as HTMLButtonElement | HTMLTextAreaElement | null;
      expect(el && el.disabled, id).toBe(true);
    }

    // The microphone is the one control whose absence is dangerous rather than
    // merely inconvenient. The frozen card hides the composer, and the mic
    // button lives there, so a capture already running — or one still waiting
    // on the browser's permission prompt, which resumes and installs itself
    // afterwards — would keep recording with nothing on screen to stop it and
    // only a 120-second timer to end it. Found by review; both halves (voice
    // admitted without a bound session, and the composer hidden) were
    // introduced by this work.
    //
    // A source-shape guard, and honest about it: the capture lives behind
    // getUserMedia and cannot be driven in happy-dom, so this proves the
    // takeover path reaches the cancel, not that a real stream stops.
    const chatSource = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.js"),
      "utf8",
    );
    const enter = chatSource.slice(
      chatSource.indexOf("function enterSessionSuperseded("),
      chatSource.indexOf("function clearSessionSuperseded("),
    );
    expect(enter).toContain("remoteMicStart.cancelled = true");
    expect(enter).toContain("stopBrowserMic(true)");

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
