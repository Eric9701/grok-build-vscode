/**
 * What the host does differently when it is hosted.
 *
 * Three decisions, and each is one line of code that is easy to lose in a
 * refactor and impossible to notice afterwards:
 *
 *  - a cloud environment reports itself as one, and says NOTHING about the box
 *    underneath;
 *  - it reduces its whole routine schedule to a single timestamp, so the relay
 *    can wake it without ever learning what is due;
 *  - "am I hosted" is read from one variable and never inferred from something
 *    adjacent.
 */
import { describe, expect, it } from "vitest";
import {
  CLOUD_CLIENT_LABEL,
  CLOUD_ENVIRONMENT_ENV,
  isCloudEnvironment,
  relayClientMeta,
} from "../src/remote-frames";
import { deviceLoginPreflight, deviceLoginUnavailable } from "../src/device-login";
import { nextWakeAt, type Routine } from "../src/routines";

const desk = {
  platform: "linux",
  release: "6.12.0",
  appName: "Visual Studio Code",
  isDesktop: true,
};

describe("knowing it is hosted", () => {
  it("is exactly one variable, set to exactly one value", () => {
    expect(isCloudEnvironment({ [CLOUD_ENVIRONMENT_ENV]: "1" })).toBe(true);
    expect(isCloudEnvironment({})).toBe(false);
    // Not truthiness: "0", "false" and "true" are all things somebody types into
    // a deploy config by accident, and a host that guesses wrong about what it
    // is will guess wrong about what it may do.
    for (const v of ["0", "false", "true", "yes", ""]) {
      expect(isCloudEnvironment({ [CLOUD_ENVIRONMENT_ENV]: v })).toBe(false);
    }
  });

  it("is never inferred from the platform", () => {
    // A Linux laptop is a laptop. This is the inference that would look most
    // reasonable and be most wrong.
    expect(isCloudEnvironment({ OS: "linux" })).toBe(false);
  });
});

describe("what a cloud environment calls itself", () => {
  it("says who runs it and nothing about the machine", () => {
    const meta = relayClientMeta({ ...desk, isCloud: true });
    expect(meta.platform).toBe("cloud");
    expect(meta.clientLabel).toBe(CLOUD_CLIENT_LABEL);
    // The OS half is OMITTED, not blanked. Nobody installed a desktop app, and
    // the operating system of a machine you do not administer is not
    // information — it is an invitation to reason about something you cannot
    // touch.
    expect(meta.osLabel).toBeUndefined();
  });

  it("names afkpilot.com, because who runs it is the one useful fact", () => {
    expect(CLOUD_CLIENT_LABEL).toMatch(/afkpilot\.com/);
  });

  it("leaves an ordinary host exactly as it was", () => {
    // isDesktop, so the label is the desktop app's — the point is that it still
    // describes the CLIENT and still carries an OS half, both of which the
    // cloud branch above deliberately drops.
    const meta = relayClientMeta(desk);
    expect(meta.platform).toBe("linux");
    expect(meta.clientLabel).toBe("Desktop app");
    expect(meta.osLabel).toBeTruthy();
  });

  it("still names the editor for an extension host", () => {
    const meta = relayClientMeta({ ...desk, isDesktop: false });
    expect(meta.clientLabel).toBe("VS Code extension");
  });
});

describe("the one timestamp the relay is told", () => {
  const routine = (over: Partial<Routine> = {}): Routine => ({
    id: "r1",
    title: "Morning brief",
    prompt: "What changed?",
    cwd: "/repo",
    provider: "grok",
    model: "grok-4.6",
    cadence: { every: 1, unit: "hours" },
    createdAt: 1_700_000_000_000,
    ...over,
  } as Routine);

  it("reduces a whole schedule to one number", () => {
    // Everything the relay could otherwise learn — the cadence, the title, the
    // prompt — collapses to a single instant. That is what keeps the relay free
    // of payloads while routines still fire on time.
    const at = nextWakeAt([routine(), routine({ id: "r2", cadence: { every: 6, unit: "hours" } })], 1_700_000_000_000);
    expect(typeof at).toBe("number");
  });

  it("says null when nothing is scheduled, so a stale wake can be cleared", () => {
    expect(nextWakeAt([], 1_700_000_000_000)).toBeNull();
    expect(nextWakeAt([routine({ paused: true })], 1_700_000_000_000)).toBeNull();
  });
});

describe("telling somebody before they fail", () => {
  it("warns about the Codex setting in a cloud environment", () => {
    // Off by default on EVERY account — OpenAI disables device-code sign-in
    // unless you ask for it. So the first attempt fails for almost everyone,
    // and the fix takes about fifteen seconds if you know where to look.
    const pf = deviceLoginPreflight("codex", { isCloud: true })!;
    expect(pf.reason).toMatch(/off by default/i);
    expect(pf.steps.join(" ")).toMatch(/Security/);
    expect(pf.steps.join(" ")).toMatch(/Device code authorization/i);
    expect(pf.url).toMatch(/chatgpt\.com/);
  });

  it("says nothing at a desk, where the browser flow just works", () => {
    // A warning about a problem the reader does not have is noise.
    expect(deviceLoginPreflight("codex", { isCloud: false })).toBeUndefined();
    expect(deviceLoginPreflight("codex")).toBeUndefined();
  });

  it("has nothing to say about the agents that do not need it", () => {
    expect(deviceLoginPreflight("grok", { isCloud: true })).toBeUndefined();
    expect(deviceLoginPreflight("claude", { isCloud: true })).toBeUndefined();
  });

  it("no longer withholds Claude: paste-code works on a pipe, cloud included", () => {
    expect(deviceLoginUnavailable("claude")).toBeUndefined();
    expect(deviceLoginUnavailable("claude", { isCloud: true })).toBeUndefined();
  });
});
