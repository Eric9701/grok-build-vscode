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

    const confirm = methodBody("private async confirmDeviceLogin(");
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
  api.mount(container, {
    snapshot: api.defaultSnapshot(),
    env: api.defaultEnv(env),
    category: "providers",
    ...opts,
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
