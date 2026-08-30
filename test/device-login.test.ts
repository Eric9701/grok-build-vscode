/**
 * Device-code sign-in — the pure half, and the runner over a fake process.
 *
 * The fixtures here are not invented. `GROK_REAL` is the exact bytes
 * `grok login --device-auth` wrote to stderr on 2026-08-26, escape codes
 * included, and the claude case is the one that produced nothing at all. Both
 * behaviours drove the design, so both are pinned: a change that makes the
 * parser stricter has to keep reading the real thing, and a change that makes
 * the runner more patient has to keep noticing a CLI that will never speak.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  classifyDeviceLoginFailure,
  deviceLoginEnv,
  deviceLoginFailureText,
  deviceLoginPlan,
  deviceLoginPreflight,
  deviceLoginUnavailable,
  noRemoteSignInMessage,
  DEVICE_LOGIN_PROMPT_TIMEOUT_MS,
  parseDeviceLoginPrompt,
  stripAnsi,
} from "../src/device-login";
import { runDeviceLogin, type DeviceLoginIo } from "../src/device-login-run";

const ESC = String.fromCharCode(27);

/** Verbatim from `grok login --device-auth`, stderr, piped stdio, grok 1.0.5. */
const GROK_REAL = [
  "",
  "To sign in, open this URL in your browser:",
  "",
  "  https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS",
  "",
  "Confirm this code in your browser:",
  "",
  "  SDCN-9XZS",
  "",
  `${ESC}[90mOnly continue with a code you requested. Don't share it with anyone.${ESC}[0m`,
  "",
  "Waiting for authorization...",
].join("\n");

describe("reading what the CLI printed", () => {
  it("finds the URL and code in real grok output", () => {
    expect(parseDeviceLoginPrompt(GROK_REAL)).toEqual({
      url: "https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS",
      code: "SDCN-9XZS",
    });
  });

  it("does not drag an escape sequence into the URL", () => {
    const coloured = `${ESC}[36mhttps://example.test/device?user_code=AAAA-BBBB${ESC}[0m`;
    expect(parseDeviceLoginPrompt(coloured)?.url).toBe("https://example.test/device?user_code=AAAA-BBBB");
  });

  it("strips OSC hyperlinks without swallowing the rest of the line", () => {
    const osc = `${ESC}]8;;https://hidden.test${ESC}\\link${ESC}]8;;${ESC}\\ https://real.test/d?code=ZZZZ-1111`;
    expect(parseDeviceLoginPrompt(osc)?.url).toBe("https://real.test/d?code=ZZZZ-1111");
  });

  it("prefers the code carried in the URL over a lookalike elsewhere", () => {
    const text = "SOME-THING went wrong earlier\nhttps://x.test/d?user_code=REAL-CODE";
    expect(parseDeviceLoginPrompt(text)?.code).toBe("REAL-CODE");
  });

  it("falls back to a bare code when the URL carries none", () => {
    const text = "Open https://x.test/device\nthen enter  WDJB-MJHT";
    expect(parseDeviceLoginPrompt(text)).toEqual({ url: "https://x.test/device", code: "WDJB-MJHT" });
  });

  it("does not mistake ordinary prose for a code", () => {
    const text = "Open https://x.test/device and wait\nWaiting for authorization...";
    expect(parseDeviceLoginPrompt(text)).toEqual({ url: "https://x.test/device" });
  });

  it("is undefined until a URL exists — a code with nowhere to type it is not a prompt", () => {
    expect(parseDeviceLoginPrompt("your code is WDJB-MJHT")).toBeUndefined();
    expect(parseDeviceLoginPrompt("")).toBeUndefined();
  });

  it("drops sentence punctuation that is not part of the URL", () => {
    expect(parseDeviceLoginPrompt("Go to https://x.test/device.")?.url).toBe("https://x.test/device");
  });

  it("survives being handed a partial first chunk", () => {
    // The runner parses on every chunk, so half a URL must not become a prompt
    // that is then never corrected.
    const half = "To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/dev";
    const prompt = parseDeviceLoginPrompt(half);
    // It does match — a URL prefix IS a URL shape — but it carries no code, and
    // the panel shows a code only when there is one. What must not happen is a
    // WRONG code.
    expect(prompt?.code).toBeUndefined();
  });

  it("strips ANSI without touching ordinary text", () => {
    expect(stripAnsi(`${ESC}[90mplain${ESC}[0m`)).toBe("plain");
    expect(stripAnsi("nothing to strip")).toBe("nothing to strip");
  });
});

describe("which providers have a headless flow", () => {
  it("offers one for grok and codex", () => {
    expect(deviceLoginPlan("grok")).toEqual({ args: ["login", "--device-auth"] });
    expect(deviceLoginPlan("codex")).toEqual({ args: ["login", "--device-auth"] });
  });

  it("offers none for claude, and says why rather than going quiet", () => {
    expect(deviceLoginPlan("claude")).toBeUndefined();
    const why = deviceLoginUnavailable("claude");
    expect(why).toMatch(/terminal/i);
    expect(why).toMatch(/computer/i);
  });

  it("has nothing to explain for the providers that work", () => {
    expect(deviceLoginUnavailable("grok")).toBeUndefined();
    expect(deviceLoginUnavailable("codex")).toBeUndefined();
  });
});

describe("classifying a failure", () => {
  it("reads clap's rejection of an unknown flag as an old CLI", () => {
    const out = "error: unexpected argument '--device-auth' found\n\nUsage: codex login [OPTIONS]";
    expect(classifyDeviceLoginFailure(out, false)).toBe("unsupported");
  });

  it("reads the workspace-admin refusal as a permission problem", () => {
    const out = "Please contact your workspace admin to enable device code authentication";
    expect(classifyDeviceLoginFailure(out, false)).toBe("not-permitted");
  });

  it("separates never-printed-a-prompt from printed-then-gave-up", () => {
    expect(classifyDeviceLoginFailure("", false)).toBe("no-prompt");
    expect(classifyDeviceLoginFailure("timed out waiting", true)).toBe("failed");
  });

  it("says something actionable for each failure", () => {
    for (const failure of ["unsupported", "not-permitted", "no-prompt", "failed"] as const) {
      const text = deviceLoginFailureText("codex", failure, "Codex");
      expect(text.length).toBeGreaterThan(20);
      expect(text).toContain("Codex");
    }
  });

  it("names the exact ChatGPT setting for codex, because that is the fix", () => {
    expect(deviceLoginFailureText("codex", "not-permitted", "Codex")).toContain("Allow device code login");
  });
});

describe("the environment a headless login runs in", () => {
  it("says in every dialect that nobody is here to answer", () => {
    const env = deviceLoginEnv({ PATH: "/usr/bin" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CI).toBe("1");
    expect(env.TERM).toBe("dumb");
    expect(env.NO_COLOR).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("refuses to open a browser on an unattended desk", () => {
    expect(deviceLoginEnv({}).BROWSER).toBe("none");
  });
});

/** A child process that tests can drive. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(signal?: string) {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

function fakeIo(): { io: DeviceLoginIo; child: FakeChild; calls: unknown[][] } {
  const child = new FakeChild();
  const calls: unknown[][] = [];
  const io = {
    spawn: ((...args: unknown[]) => {
      calls.push(args);
      return child;
    }) as unknown as DeviceLoginIo["spawn"],
  };
  return { io, child, calls };
}

describe("running one", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports the prompt from stderr as soon as it lands, long before exit", () => {
    const { io, child } = fakeIo();
    const onPrompt = vi.fn();
    const onDone = vi.fn();
    runDeviceLogin("/bin/grok", ["login", "--device-auth"], { onPrompt, onDone }, io, {});

    child.stderr.emit("data", GROK_REAL);

    expect(onPrompt).toHaveBeenCalledWith({
      url: "https://accounts.x.ai/oauth2/device?user_code=SDCN-9XZS",
      code: "SDCN-9XZS",
    });
    // The whole point: the code is usable while the child is still polling.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("reports it only once, however many chunks arrive", () => {
    const { io, child } = fakeIo();
    const onPrompt = vi.fn();
    runDeviceLogin("/bin/grok", [], { onPrompt, onDone: vi.fn() }, io, {});
    child.stderr.emit("data", GROK_REAL);
    child.stderr.emit("data", "Waiting for authorization...\n");
    child.stderr.emit("data", "Waiting for authorization...\n");
    expect(onPrompt).toHaveBeenCalledTimes(1);
  });

  it("closes stdin, so a CLI waiting for input cannot look like one that is working", () => {
    const { io, calls } = fakeIo();
    runDeviceLogin("/bin/grok", [], { onPrompt: vi.fn(), onDone: vi.fn() }, io, {});
    const options = calls[0][2] as { stdio: string[]; windowsHide: boolean };
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.windowsHide).toBe(true);
  });

  it("gives up on a CLI that never speaks, rather than spinning for fifteen minutes", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    runDeviceLogin("/bin/claude", ["setup-token"], { onPrompt: vi.fn(), onDone }, io, {});

    // The measured claude case: zero bytes on both streams.
    vi.advanceTimersByTime(DEVICE_LOGIN_PROMPT_TIMEOUT_MS + 1);

    expect(child.killed.length).toBeGreaterThan(0);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: "no-prompt" }));
  });

  it("does not start that clock over once the prompt has arrived", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    runDeviceLogin("/bin/grok", [], { onPrompt: vi.fn(), onDone }, io, {});
    child.stderr.emit("data", GROK_REAL);

    // A real device code lives ~15 minutes and the child polls the whole time.
    vi.advanceTimersByTime(DEVICE_LOGIN_PROMPT_TIMEOUT_MS * 4);

    expect(onDone).not.toHaveBeenCalled();
    expect(child.killed).toEqual([]);
  });

  it("succeeds on exit 0", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    runDeviceLogin("/bin/grok", [], { onPrompt: vi.fn(), onDone }, io, {});
    child.stderr.emit("data", GROK_REAL);
    child.emit("close", 0);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("classifies a non-zero exit from what the CLI said", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    runDeviceLogin("/bin/codex", [], { onPrompt: vi.fn(), onDone }, io, {});
    child.stderr.emit("data", "error: unexpected argument '--device-auth' found");
    child.emit("close", 2);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: "unsupported" }));
  });

  it("settles exactly once when cancel races the child's own exit", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    const handle = runDeviceLogin("/bin/grok", [], { onPrompt: vi.fn(), onDone }, io, {});
    handle.cancel();
    child.emit("close", 1);
    handle.cancel();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
  });

  it("does not settle twice when the child errors after closing", () => {
    const { io, child } = fakeIo();
    const onDone = vi.fn();
    runDeviceLogin("/bin/grok", [], { onPrompt: vi.fn(), onDone }, io, {});
    child.emit("close", 0);
    child.emit("error", new Error("late"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("survives a spawn that throws outright", () => {
    const onDone = vi.fn();
    const io = {
      spawn: (() => {
        throw new Error("ENOENT");
      }) as unknown as DeviceLoginIo["spawn"],
    };
    const handle = runDeviceLogin("/nope", [], { onPrompt: vi.fn(), onDone }, io, {});
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failure: "failed" }));
    expect(() => handle.cancel()).not.toThrow();
  });
});

describe("what we say when a provider cannot be signed in from here", () => {
  it("does not send a cloud environment to a computer that does not exist", () => {
    // The desk sentence is good advice at a desk and a dead end on a rented
    // Linux box, which is exactly why deviceLoginUnavailable withholds its own
    // desk sentence when isCloud. The sidebar's fallback used to hand the same
    // advice straight back, so a cloud user was told to walk to a machine that
    // is not there (owner, 2026-08-30).
    const desk = noRemoteSignInMessage("Claude");
    expect(desk).toContain("at your computer");

    const cloud = noRemoteSignInMessage("Claude", { isCloud: true });
    expect(cloud).not.toContain("at your computer");
    expect(cloud).toContain("cloud environment");
    // Says what DOES work, so it is a next step rather than a refusal.
    expect(cloud).toMatch(/Grok and Codex/);
  });
});

describe("the Codex preflight names where the setting actually is", () => {
  it("marks up the location, because people could not find it", () => {
    const pf = deviceLoginPreflight("codex", { isCloud: true });
    const step = (pf?.steps ?? []).find((s) => s.includes("Device code authorization"));
    expect(step).toBeDefined();
    // `**` is the panel's inline-bold marker (media/chat.js), applied AFTER
    // escaping so the host cannot inject markup through a step string.
    expect(step).toContain("**at the very bottom**");
  });

  it("is cloud-only and codex-only", () => {
    expect(deviceLoginPreflight("codex")).toBeUndefined();
    expect(deviceLoginPreflight("grok", { isCloud: true })).toBeUndefined();
    expect(deviceLoginPreflight("claude", { isCloud: true })).toBeUndefined();
  });
});
