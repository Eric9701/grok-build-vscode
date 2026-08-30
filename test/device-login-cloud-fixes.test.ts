/**
 * The first real cloud test (2026-08-31) found four ways a device sign-in
 * could fail with no visible or recorded trace: a "success" announced before
 * any credential existed, a re-tap answered with silence, settles that logged
 * nothing, and feedback rendered into a welcome card that cannot show over a
 * painted conversation. These tests pin the fixes.
 *
 * The sidebar half uses the same source-shape pattern as
 * provider-review-fixes.test.ts: the orchestration lives deep in GrokSidebar,
 * and what must not regress is the SHAPE — what is announced when, and what
 * always leaves a log line.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { shouldKeepAwake } from "../src/keep-awake";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8").replace(/\r\n/g, "\n");
const modelCache = fs.readFileSync(path.join(root, "src", "codex-model-cache.ts"), "utf8");

function methodBody(signature: string): string {
  const start = sidebar.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const next = sidebar.indexOf("\n  private ", start + signature.length);
  return sidebar.slice(start, next < 0 ? sidebar.length : next);
}

describe("device login: announce only what is verified", () => {
  it("never sends done from the flow itself — only the credential probe may", () => {
    const start = methodBody("private async startDeviceLogin(");
    // Exit 0 says the vendor approved; codex 0.147 exited 0 having written no
    // auth.json. "done" therefore belongs exclusively to confirmDeviceLogin.
    expect(start).not.toContain('status: "done"');
    expect(start).toContain("this.confirmDeviceLogin(");

    const confirm = methodBody("private async confirmDeviceLoginInner(");
    expect(confirm).toContain("reprobeProviderCredentials(");
    expect(confirm).toContain('status: "done"');
    expect(confirm.indexOf("reprobeProviderCredentials(")).toBeLessThan(
      confirm.indexOf('status: "done"'),
    );
    // And a verdict either way: exhausting the probes must tell the user.
    expect(confirm).toContain('status: "failed"');
    expect(confirm).toContain("no usable credential");
  });

  it("answers a re-tap by repeating the flow's state, never with silence", () => {
    const body = methodBody("private async startDeviceLogin(");
    expect(body).toContain("running.clientId = clientId");
    expect(body).toContain("running.send(running.last)");
  });

  it("logs every settle, including cancellation", () => {
    const body = methodBody("private async startDeviceLogin(");
    expect(body).toContain("device login started");
    expect(body).toContain("device login cancelled after");
    expect(body).toContain("device login failed (");
    expect(body).toContain("verifying the credential");
  });

  it("never parks a settled flow in the guard map (synchronous spawn failure)", () => {
    const body = methodBody("private async startDeviceLogin(");
    const settledCheck = body.indexOf("if (!settled)");
    const registration = body.indexOf("this.deviceLogins.set(");
    expect(settledCheck).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(settledCheck);
  });
});

describe("keep-awake on a hosted cloud machine", () => {
  it("never holds an OS wake lock there — sleeping is the cost model", () => {
    expect(shouldKeepAwake({ enabled: true, linked: true, cloudHost: true })).toBe(false);
    expect(shouldKeepAwake({ enabled: true, linked: false, turnInFlight: true, cloudHost: true })).toBe(false);
    // And the desk behaviour is untouched.
    expect(shouldKeepAwake({ enabled: true, linked: true })).toBe(true);
    expect(shouldKeepAwake({ enabled: false, linked: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Settings → Providers renders the flow where the click happened.
// ---------------------------------------------------------------------------

const settingsSrc = fs.readFileSync(path.join(root, "media", "settings.js"), "utf8");

type SettingsApi = {
  ROWS: Array<{ id: string; keepOpen?: (s: unknown, e: unknown) => boolean }>;
  defaultSnapshot: (p?: Record<string, unknown>) => Record<string, unknown>;
  defaultEnv: (p?: Record<string, unknown>) => Record<string, unknown>;
  mount: (el: Element, opts: Record<string, unknown>) => { dispose: () => void };
};

function mountSettings(env: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  const window = new Window({ url: "https://localhost/" });
  (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
  const api = (window as unknown as { GrokSettings: SettingsApi }).GrokSettings;
  const doc = window.document as unknown as Document;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const { snapshotOverrides, ...mountOpts } = opts as { snapshotOverrides?: Record<string, unknown> };
  api.mount(container, {
    snapshot: api.defaultSnapshot(snapshotOverrides || {}),
    env: api.defaultEnv(env),
    category: "providers",
    ...mountOpts,
  });
  return { api, container, window };
}

const remoteEnv = (extra: Record<string, unknown> = {}) => ({
  isRemote: true,
  isDesktop: false,
  providersKnown: true,
  hostCaps: { remoteAgentSignIn: true, remoteAgentSignOut: true },
  ...extra,
});

describe("settings renders the device flow where the click happened", () => {
  it("shows the code and the sign-in link for a waiting flow", () => {
    const { container } = mountSettings(remoteEnv({
      deviceLogin: { codex: { status: "waiting", url: "https://auth.openai.com/codex/device", code: "ABCD-1234" } },
    }));
    const row = container.querySelector('.settings-row[data-id="providerCodexFlow"]');
    expect(row, "flow row must render").toBeTruthy();
    expect(row!.textContent).toContain("ABCD-1234");
    expect(row!.textContent).toContain("Open sign-in page");
    expect(row!.querySelector("[data-device-cancel]")).toBeTruthy();
  });

  it("posts cancelDeviceLogin from the flow row's cancel", () => {
    const posted: unknown[] = [];
    const { container, window } = mountSettings(remoteEnv({
      deviceLogin: { grok: { status: "waiting", url: "https://accounts.x.ai/oauth2/device", code: "WXYZ-9876" } },
    }), { post: (m: unknown) => posted.push(m) });
    const cancel = container.querySelector('[data-device-cancel]') as HTMLElement;
    expect(cancel).toBeTruthy();
    cancel.dispatchEvent(new (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ type: "cancelDeviceLogin", provider: "grok" });
  });

  it("keeps the overlay open when a remote connect is clicked", () => {
    // The flow reports into this very page; closing it on the click was how
    // "Connect does nothing" happened.
    const onClose = vi.fn();
    const posted: unknown[] = [];
    const { container, window } = mountSettings(remoteEnv(), {
      post: (m: unknown) => posted.push(m),
      closeOnAction: true,
      onClose,
    });
    const row = container.querySelector('.settings-row[data-id="providerCodexRemote"]');
    expect(row, "remote connect row must render").toBeTruthy();
    const btn = row!.querySelector(".settings-action") as HTMLElement;
    btn.dispatchEvent(new (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ type: "runGrokLogin", provider: "codex" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hides the flow rows when nothing is in flight", () => {
    const { container } = mountSettings(remoteEnv());
    expect(container.querySelector('[data-id="providerGrokFlow"]')).toBeNull();
    expect(container.querySelector('[data-id="providerCodexFlow"]')).toBeNull();
    expect(container.querySelector('[data-id="providerClaudeFlow"]')).toBeNull();
  });
});

describe("host-config wording knows there is no desk in the cloud", () => {
  it("says cloud on a cloud host and host-machine on a desk remote", () => {
    const cloud = mountSettings(remoteEnv(), { category: "advanced" });
    const cloudRow = cloud.container.querySelector('.settings-row[data-id="hostConfigRemote"]');
    expect(cloudRow!.textContent).toContain("cloud machine");

    const desk = mountSettings(remoteEnv({ hostCaps: { remoteAgentSignIn: true } }), { category: "advanced" });
    const deskRow = desk.container.querySelector('.settings-row[data-id="hostConfigRemote"]');
    expect(deskRow!.textContent).toContain("machine running this workspace");
    expect(deskRow!.textContent).not.toContain("desk");
  });
});

describe("the codex warm-up survives its own cleanup", () => {
  it("never lets the throwaway delete fail the warm-up — that read a valid sign-in as no credential", () => {
    const start = modelCache.indexOf("await client.deleteSession(created.sessionId);");
    expect(start).toBeGreaterThan(-1);
    const before = modelCache.slice(0, start);
    // The delete sits inside its own try. codex 0.147 answers it with
    // "Internal error: no rollout found" for a session that never rolled out.
    expect(before.lastIndexOf("try {")).toBeGreaterThan(before.lastIndexOf("await options.onModels"));
    expect(modelCache).toContain("models already cached, continuing");
  });
});

describe("the verdict never blames a credential that landed", () => {
  it("announces verifying, and separates probe failure from a missing credential", () => {
    const start = methodBody("private async startDeviceLogin(");
    expect(start).toContain('send({ status: "verifying" })');
    const confirm = methodBody("private async confirmDeviceLoginInner(");
    expect(confirm).toContain("providerCredentialFilePresent(");
    expect(confirm).toContain("does not need repeating");
    const present = methodBody("private providerCredentialFilePresent(");
    expect(present).toContain("auth.json");
  });
});

describe("one row per provider, whatever the flow state", () => {
  it("hides the ordinary rows while a flow row owns the space", () => {
    const { container } = mountSettings(remoteEnv({
      deviceLogin: { codex: { status: "waiting", url: "https://auth.openai.com/codex/device", code: "AB12-CD34" } },
    }));
    expect(container.querySelector('[data-id="providerCodexFlow"]')).toBeTruthy();
    expect(container.querySelector('[data-id="providerCodexRemote"]')).toBeNull();
    expect(container.querySelector('[data-id="providerCodexStatus"]')).toBeNull();
    expect(container.querySelector('[data-id="providerCodexFlow"] [data-device-copy]')).toBeTruthy();
  });

  it("folds a failure into the ordinary row instead of doubling it", () => {
    const { container } = mountSettings(remoteEnv({
      deviceLogin: { codex: { status: "failed", message: "Codex approved the sign-in, but nothing landed." } },
    }));
    expect(container.querySelector('[data-id="providerCodexFlow"]')).toBeNull();
    const row = container.querySelector('[data-id="providerCodexRemote"]');
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain("nothing landed");
  });
});

describe("a cloud machine tells the truth about its agents up front", () => {
  it("gives Claude its answer with no Connect button, and recommends Grok", () => {
    const { container } = mountSettings(remoteEnv());
    const claude = container.querySelector('[data-id="providerClaudeCloud"]');
    expect(claude).toBeTruthy();
    expect(claude!.textContent).toContain("working on adding it");
    expect(claude!.querySelector(".settings-action")).toBeNull();
    expect(container.querySelector('[data-id="providerClaudeRemote"]')).toBeNull();
    const grok = container.querySelector('[data-id="providerGrokRemote"]');
    expect(grok!.textContent).toContain("Recommended");
  });

  it("keeps the desk remote unchanged: Claude offers Connect, Grok carries no tag", () => {
    const { container } = mountSettings(remoteEnv({ hostCaps: { remoteAgentSignIn: true } }));
    expect(container.querySelector('[data-id="providerClaudeCloud"]')).toBeNull();
    expect(container.querySelector('[data-id="providerClaudeRemote"]')).toBeTruthy();
    const grok = container.querySelector('[data-id="providerGrokRemote"]');
    expect(grok!.textContent).not.toContain("Recommended");
  });
});

// ---------------------------------------------------------------------------
// The whole state matrix, in one loop. The owner asked to see every button in
// every configuration rather than reach them by clicking; these are the same
// cases the scratchpad screenshot harness renders, asserted here so they stay
// true.
// ---------------------------------------------------------------------------

const CLOUD = { remoteAgentSignIn: true, remoteAgentSignOut: true };
const DESK = { remoteAgentSignIn: true };
const prov = (id: string, extra: Record<string, unknown> = {}) => ({ id, connected: false, ...extra });
const NONE = [prov("grok"), prov("codex"), prov("claude")];

type Case = {
  label: string;
  providers: Array<Record<string, unknown>>;
  deviceLogin: Record<string, unknown>;
  caps: Record<string, unknown>;
};

const CASES: Case[] = [
  { label: "fresh cloud machine", providers: NONE, deviceLogin: {}, caps: CLOUD },
  { label: "grok starting", providers: NONE, deviceLogin: { grok: { status: "starting" } }, caps: CLOUD },
  { label: "grok waiting", providers: NONE, deviceLogin: { grok: { status: "waiting", url: "https://x", code: "AAAA-1111" } }, caps: CLOUD },
  { label: "grok verifying", providers: NONE, deviceLogin: { grok: { status: "verifying" } }, caps: CLOUD },
  { label: "grok done, snapshot behind", providers: NONE, deviceLogin: { grok: { status: "done" } }, caps: CLOUD },
  { label: "grok connected", providers: [prov("grok", { connected: true }), prov("codex"), prov("claude")], deviceLogin: {}, caps: CLOUD },
  { label: "grok lapsed", providers: [prov("grok", { connected: true, needsLogin: true }), prov("codex"), prov("claude")], deviceLogin: {}, caps: CLOUD },
  { label: "grok failed", providers: NONE, deviceLogin: { grok: { status: "failed", message: "did not finish" } }, caps: CLOUD },
  { label: "codex waiting", providers: NONE, deviceLogin: { codex: { status: "waiting", url: "https://y", code: "BBBB-2222" } }, caps: CLOUD },
  { label: "both connected", providers: [prov("grok", { connected: true }), prov("codex", { connected: true }), prov("claude")], deviceLogin: {}, caps: CLOUD },
  { label: "desk remote, nothing connected", providers: NONE, deviceLogin: {}, caps: DESK },
  { label: "desk remote, grok connected", providers: [prov("grok", { connected: true }), prov("codex"), prov("claude")], deviceLogin: {}, caps: DESK },
];

describe("every provider configuration a remote can be in", () => {
  for (const testCase of CASES) {
    it(`renders one row per provider: ${testCase.label}`, () => {
      const { container } = mountSettings({
        isRemote: true,
        isDesktop: false,
        providersKnown: true,
        hostCaps: testCase.caps,
        deviceLogin: testCase.deviceLogin,
      }, { snapshotOverrides: { providers: testCase.providers } });
      for (const provider of ["Grok", "Codex", "Claude"]) {
        const rows = [...container.querySelectorAll(".settings-row")]
          .filter((row) => ((row as HTMLElement).dataset.id || "").startsWith("provider" + provider));
        expect(rows.length, `${testCase.label}: ${provider}`).toBe(1);
        // A heading is the account's name, whatever is happening to it.
        const title = rows[0].querySelector(".settings-row-title");
        expect((title!.textContent || "").trim()).toBe(provider);
      }
    });
  }

  it("offers Sign out for every connected account, and never for a live flow", () => {
    const connected = mountSettings({
      isRemote: true, isDesktop: false, providersKnown: true, hostCaps: CLOUD, deviceLogin: {},
    }, { snapshotOverrides: { providers: [prov("grok", { connected: true }), prov("codex", { connected: true }), prov("claude")] } });
    for (const id of ["providerGrokRemote", "providerCodexRemote"]) {
      const row = connected.container.querySelector(`[data-id="${id}"]`);
      expect([...row!.querySelectorAll("button")].map((b) => b.textContent)).toContain("Sign out");
    }
  });

  it("keeps Codex's account-setting steps on screen with the code", () => {
    const { container } = mountSettings({
      isRemote: true, isDesktop: false, providersKnown: true, hostCaps: CLOUD,
      deviceLogin: {
        codex: {
          status: "waiting", url: "https://auth.openai.com/codex/device", code: "CCCC-3333",
          preflight: {
            reason: "Codex needs one setting turned on before the code below will be accepted.",
            steps: ["Open ChatGPT and go to Settings → Security", 'Turn on "Device code authorization for Codex" **at the very bottom**'],
            url: "https://chatgpt.com/#settings/Security",
          },
        },
      },
    }, { snapshotOverrides: { providers: NONE } });
    const row = container.querySelector('[data-id="providerCodexFlow"]')!;
    expect(row.textContent).toContain("one setting turned on");
    expect(row.querySelectorAll(".settings-deviceflow-steps li").length).toBe(2);
    // The emphasis is the point: the setting is at the bottom of a long page.
    expect(row.querySelector(".settings-deviceflow-steps strong")!.textContent).toBe("at the very bottom");
    expect(row.textContent).not.toContain("**");
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toContain("Copy");
  });
});

describe("an outdated host cannot describe its own age, so the client does", () => {
  const chatSrc = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");

  it("appends the update hint only to the project-availability errors, and only when the host is behind", () => {
    // The rail already knows: repoPreviewsUnsupported is the same signal that
    // makes every project say it needs a newer Grok Build. The chat error next
    // to it said nothing about age (owner, 2026-08-31).
    const start = chatSrc.indexOf("function errorTextForHostAge(");
    expect(start).toBeGreaterThan(-1);
    const body = chatSrc.slice(start, chatSrc.indexOf("function addError(", start));
    expect(body).toContain("state.repoPreviewsUnsupported");
    expect(body).toContain("no longer open on the desktop");
    expect(body).toContain("archived, so it is not available from here");
    // Appended, never replaced: the folder may really be closed.
    expect(body).toContain("return text");
    expect(body).toContain("updating it there is worth trying first");
    // And it is actually wired into the error path.
    expect(chatSrc).toContain("addError(errorTextForHostAge(msg.text), msg.code)");
  });
});

describe("a newly connected agent reaches the picker you are looking at", () => {
  it("refreshes every live session when a provider appears for the first time", () => {
    const body = methodBody("private cacheProviderModels(");
    // Connected Codex from a conversation with history: Providers said
    // connected, the model picker did not list it until a reload (owner,
    // 2026-08-31). A first-time provider is additive, so every live session
    // gets the catalog; an ordinary re-cache keeps the empty-session rule.
    expect(body).toContain("providerIsNew");
    expect(body).toContain("this.sessionsForModelRefresh()");
    expect(body).toContain("this.emptySessionsForModelRefresh()");
    const post = methodBody("private postSessionModels(");
    expect(post).not.toContain("session.hasHistory) return");
  });
});

describe("a sign-in must not be paused underneath", () => {
  it("holds the machine from BEFORE the spawn until AFTER verification", () => {
    // The first attempt at this fix did not work and the test did not notice:
    // it asserted that refreshKeepAwake appeared after a log line, while the
    // flag it depended on was set later still, so the refresh ran with an
    // empty map and asserted "not working" (found in review, 2026-08-31).
    // Pin the ORDER that matters and the single exit door.
    const start = methodBody("private async startDeviceLogin(");
    const enter = start.indexOf("this.beginDeviceLoginWork()");
    const spawn = start.indexOf("runDeviceLogin(");
    expect(enter).toBeGreaterThan(-1);
    expect(enter).toBeLessThan(spawn);

    // Success must NOT release at onDone: verification is still to come.
    expect(start).toContain("if (!result.ok) this.endDeviceLoginWork(workId)");

    // The verification wrapper releases in a finally, whatever happened.
    const confirm = methodBody("private async confirmDeviceLogin(");
    expect(confirm).toContain("finally");
    expect(confirm).toContain("this.endDeviceLoginWork(workId)");

    // The flag the keep-awake reads is the operation's own set, never the
    // guard map whose lifetime is shorter than the operation.
    const inFlight = methodBody("private deviceLoginInFlight(");
    expect(inFlight).toContain("this.deviceLoginWork.size > 0");
    expect(inFlight).not.toContain("this.deviceLogins.size");

    // Ownership is per OPERATION, not per provider: a login that is still
    // verifying has already left the guard map, so a second tab can start the
    // same provider and a provider-keyed hold let the older one's cleanup
    // release the newer one's machine (review round 2).
    const begin = methodBody("private beginDeviceLoginWork(");
    expect(begin).toContain("++this.deviceLoginWorkSeq");
    const end = methodBody("private endDeviceLoginWork(");
    expect(end).toContain("this.deviceLoginWork.delete(id)");
    expect(start).toContain("const workId = this.beginDeviceLoginWork()");
    expect(start).toContain("this.endDeviceLoginWork(workId)");
    expect(confirm).toContain("this.endDeviceLoginWork(workId)");
    // Nothing may release by provider any more.
    expect(sidebar).not.toContain("setDeviceLoginWork(");
  });

  it("keeps the credential fallback on GROK_HOME rather than a hardcoded path", () => {
    const present = methodBody("private providerCredentialFilePresent(");
    expect(present).toContain("resolveGrokHome(process.env)");
    expect(present).not.toContain('os.homedir(), ".grok"');
  });

  it("counts a pending device login as work, so the cloud machine stays awake", () => {
    // The relay holds a machine awake only while frames arrive (90s idle).
    // A phone that switches to the vendor's page generates none, and the
    // platform pauses the sprite seconds after the hold is released, killing
    // the CLI's polling connection. cloud-environments.md measured exactly
    // that failure with `grok login --device-auth`.
    const refresh = methodBody("private refreshKeepAwake(");
    expect(refresh).toContain("this.deviceLoginInFlight()");

    // Cancel is the third exit and releases too.
    // Cancel releases through onDone (cancel() settles the runner
    // synchronously), so the handler must NOT release a token it does not own.
    const cancelBlock = sidebar.slice(sidebar.indexOf('case "cancelDeviceLogin"'), sidebar.indexOf('case "recheckConnection"'));
    expect(cancelBlock).toContain("running.handle.cancel()");
    expect(cancelBlock).not.toContain("DeviceLoginWork");
  });
});

describe("a settled flow's explanation survives the refresh that Providers sends", () => {
  it("keeps a failed mirror on a disconnected provider, and drops only done", () => {
    const chatSrc = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");
    const start = chatSrc.indexOf("A confirmed account retires its device-flow mirror");
    const block = chatSrc.slice(start, start + 2000);
    expect(block).toContain('mirrored.status === "done"');
    // Nothing may key the retirement on the live states any more: that
    // erased the reason a login had just failed (review round 2).
    expect(block).not.toContain('mirrored.status !== "waiting"');
    // But a healthy account retires its old failure too, or the row offers
    // Sign out above the reason an earlier attempt failed (review round 3).
    expect(block).toContain("provider.needsLogin !== true");
    expect(block).toContain("healthy && terminal");
  });
});
