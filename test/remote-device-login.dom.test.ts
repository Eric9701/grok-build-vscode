/**
 * Connecting an agent from a phone, in the real webview.
 *
 * The panel this replaces was a dead end: "accounts can only be connected on
 * the computer running this workspace." What a DOM run has to show is that the
 * dead end is gone in the ways that matter — a button that posts the SAME
 * message the desk posts (so there is one capability, not two), a code that
 * arrives mid-flow and is copyable, and a provider that genuinely cannot work
 * here saying so without offering a retry that would loop.
 *
 * The desk surface renders from the same function, so it is pinned here too:
 * nothing about this feature may change what someone at their computer sees.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

function boot(opts: { remote?: boolean; caps?: Record<string, unknown> } = {}) {
  const h = bootWebview({ remote: opts.remote });
  dispatch(h.window, {
    type: "initialState",
    effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "3.18.0",
    showThinking: false, expandCommandOutputs: false, steerByDefault: false,
    soundNotifications: false, processingSound: false, readRepliesAloud: false,
    appPurpose: "coding",
    capabilities: opts.caps ?? { remoteAgentSignIn: true },
  });
  h.posted.length = 0;
  return h;
}

const onb = (h: Harness) => h.doc.querySelector("#welcome-onboarding") as HTMLElement;
const text = (h: Harness) => (onb(h).textContent || "").replace(/\s+/g, " ").trim();
const actions = (h: Harness) =>
  [...onb(h).querySelectorAll(".onb-action")].map((el) => (el.textContent || "").trim());
const byAct = (h: Harness, act: string) =>
  onb(h).querySelector(`[data-act="${act}"]`) as HTMLElement | null;

function onboarding(h: Harness, extra: Record<string, unknown>) {
  dispatch(h.window, { type: "onboarding", state: "auth-required", platform: "linux", provider: "grok", ...extra });
}

describe("a phone with nothing connected", () => {
  it("offers to connect, instead of saying it cannot be done here", () => {
    const h = boot({ remote: true });
    onboarding(h, {});
    expect(text(h)).not.toMatch(/only be connected on the computer/i);
    expect(actions(h)).toContain("Connect Grok");
  });

  it("offers every agent when none is connected, rather than guessing", () => {
    const h = boot({ remote: true });
    dispatch(h.window, { type: "onboarding", state: "connect-agent", platform: "linux" });
    expect(actions(h)).toEqual(["Connect Grok", "Connect Codex", "Connect Claude"]);
  });

  it("posts the same message the desk posts — one capability, not two", () => {
    const h = boot({ remote: true });
    onboarding(h, {});
    click(h.window, byAct(h, "connectRemote")!);
    expect(h.posted).toEqual([{ type: "runGrokLogin", provider: "grok" }]);
  });

  it("promises no password is typed here, because that is the question being asked", () => {
    const h = boot({ remote: true });
    onboarding(h, {});
    expect(text(h)).toMatch(/no password is typed here/i);
  });
});

describe("while the flow runs", () => {
  it("says something between the tap and the code", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "starting" } });
    expect(text(h)).toMatch(/Connecting Grok/);
    expect(byAct(h, "cancelDeviceLogin")).toBeTruthy();
  });

  it("shows the URL as a real link and the code as copyable text", () => {
    const h = boot({ remote: true });
    onboarding(h, {
      device: { status: "waiting", url: "https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS", code: "SDCN-9XZS" },
    });
    const link = onb(h).querySelector("a.onb-action") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS");
    // A phone has to leave this page to authorise, and come back to it.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    const copy = onb(h).querySelector(".onb-copy") as HTMLElement;
    expect(copy.dataset.cmd).toBe("SDCN-9XZS");
    expect(onb(h).querySelector(".onb-cmd code")?.textContent).toBe("SDCN-9XZS");
  });

  it("tells the reader not to press anything else", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "waiting", url: "https://x.test/d", code: "AAAA-BBBB" } });
    expect(text(h)).toMatch(/finishes on its own/i);
  });

  it("still shows the link when the CLI printed no code", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "waiting", url: "https://x.test/d" } });
    expect(onb(h).querySelector("a.onb-action")).toBeTruthy();
    expect(onb(h).querySelector(".onb-cmd")).toBeNull();
  });

  it("cancels the flow rather than the whole panel", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "waiting", url: "https://x.test/d", code: "AAAA-BBBB" } });
    h.posted.length = 0;
    click(h.window, byAct(h, "cancelDeviceLogin")!);
    expect(h.posted).toEqual([{ type: "cancelDeviceLogin", provider: "grok" }]);
  });
});

describe("when it ends", () => {
  it("confirms success", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "done" } });
    expect(text(h)).toMatch(/Grok connected/);
  });

  it("offers a retry on a failure that retrying could fix", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "failed", message: "The code may have expired — try again." } });
    expect(text(h)).toMatch(/code may have expired/);
    click(h.window, byAct(h, "connectRemote")!);
    expect(h.posted).toEqual([{ type: "runGrokLogin", provider: "grok" }]);
  });

  it("offers NO retry for a provider that cannot work here — a dead end must not look like a loop", () => {
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "claude-login",
      provider: "claude",
      device: { status: "unavailable", message: "Claude's sign-in needs a real terminal, so it has to be done at your computer." },
    });
    expect(text(h)).toMatch(/needs a real terminal/);
    expect(byAct(h, "connectRemote")).toBeNull();
    expect(byAct(h, "cancelDeviceLogin")).toBeNull();
  });

  it("bolds the part of a preflight step people could not find, and still escapes", () => {
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "codex-login",
      provider: "codex",
      device: {
        status: "unavailable",
        message: "Codex needs one setting turned on.",
        preflight: {
          reason: "Codex needs one setting turned on.",
          steps: [
            "Turn on \"Device code authorization for Codex\" **at the very bottom**",
            "<img src=x onerror=alert(1)> **and this**",
          ],
          url: "https://chatgpt.com/#settings/Security",
        },
      },
    });
    const strong = [...onb(h).querySelectorAll("strong")].map((n) => n.textContent);
    expect(strong).toContain("at the very bottom");
    // Escape FIRST, then bold: the emphasis is re-admitted onto text that is
    // already inert, so a step string still cannot become markup.
    expect(onb(h).querySelector("img")).toBeNull();
    expect(text(h)).toContain("<img src=x onerror=alert(1)>");
    expect(strong).toContain("and this");
  });

  it("offers the connect button again on a preflight card, because the advice is not a gate", () => {
    // The host shows this card once and then attempts for real. If the panel
    // stopped offering the button, the person who fixed the setting would have
    // no way to say so.
    const h = boot({ remote: true });
    dispatch(h.window, {
      type: "onboarding",
      state: "codex-login",
      provider: "codex",
      device: {
        status: "unavailable",
        message: "Codex needs one setting turned on.",
        preflight: { reason: "Codex needs one setting turned on.", steps: ["Do the thing"] },
      },
    });
    expect(byAct(h, "connectRemote")).not.toBeNull();
  });

  it("escapes whatever the host put in the message", () => {
    const h = boot({ remote: true });
    onboarding(h, { device: { status: "failed", message: "<img src=x onerror=alert(1)>" } });
    expect(onb(h).querySelector("img")).toBeNull();
    expect(text(h)).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("a host that predates this feature", () => {
  // The relay serves this page, so after a deploy every 3.18.0 user's phone is
  // running THIS client against a host that classifies runGrokLogin as
  // host-local and drops it without a word. Offering Connect there is a button
  // that does nothing — strictly worse than the dead end it replaced, because a
  // dead end tells you where to go.
  it("falls back to the old guidance instead of offering a button that does nothing", () => {
    const h = boot({ remote: true, caps: {} });
    onboarding(h, {});
    expect(byAct(h, "connectRemote")).toBeNull();
    expect(text(h)).toContain("only be connected on the computer");
  });

  it("offers nothing on the connect-agent panel either", () => {
    const h = boot({ remote: true, caps: {} });
    dispatch(h.window, { type: "onboarding", state: "connect-agent", platform: "linux" });
    expect(onb(h).querySelectorAll("button")).toHaveLength(0);
  });

  it("an explicit false is treated the same as absent", () => {
    const h = boot({ remote: true, caps: { remoteAgentSignIn: false } });
    onboarding(h, {});
    expect(byAct(h, "connectRemote")).toBeNull();
  });
});

describe("the desk is untouched", () => {
  it("still offers the terminal, not a device code", () => {
    const h = boot();
    dispatch(h.window, { type: "onboarding", state: "auth-required", platform: "linux", provider: "grok" });
    expect(text(h)).toMatch(/Open terminal/);
    expect(byAct(h, "connectRemote")).toBeNull();
    expect(byAct(h, "runLogin")).toBeTruthy();
  });

  it("ignores a device payload if one ever reached it", () => {
    const h = boot();
    dispatch(h.window, {
      type: "onboarding", state: "auth-required", platform: "linux", provider: "grok",
      device: { status: "waiting", url: "https://x.test/d", code: "AAAA-BBBB" },
    });
    expect(text(h)).toMatch(/Open terminal/);
    expect(text(h)).not.toContain("AAAA-BBBB");
  });
});
