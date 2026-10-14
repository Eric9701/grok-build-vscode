import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const onboarding = (doc: Document) => doc.getElementById("welcome-onboarding")!;

describe("Antigravity in the chat renderer", () => {
  it("draws and sends nothing for Antigravity until the host names it", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "connect-agent" });
    expect(onboarding(h.doc).querySelector('[data-provider="agy"]')).toBeNull();
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy" });
    expect(onboarding(h.doc).textContent).not.toContain("Antigravity");
    dispatch(h.window, { type: "session", sessionId: "s", provider: "agy", models: [{ provider: "agy", modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] });
    click(h.window, h.doc.getElementById("gear-btn"));
    expect(h.doc.querySelector(".model-picker-row .provider-agy")).toBeNull();
  });

  it("offers Antigravity among the agents once advertised, and connects it", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "grok", connected: false }, { id: "agy", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "connect-agent" });
    const tile = onboarding(h.doc).querySelector('[data-provider="agy"]') as HTMLElement;
    expect(tile.textContent).toContain("Antigravity");
    click(h.window, tile);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "agy" });
  });

  it("installs from the missing-server panel and shows progress", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "missing-agy", provider: "agy", platform: "win32" });
    click(h.window, onboarding(h.doc).querySelector('[data-act="installAgy"]'));
    expect(h.posted).toContainEqual({ type: "installAgy" });
    dispatch(h.window, { type: "agyInstallProgress", phase: "downloading", receivedBytes: 25, totalBytes: 100 });
    expect(onboarding(h.doc).textContent).toContain("Downloading Antigravity (25%)");
    click(h.window, onboarding(h.doc).querySelector('[data-act="cancelAgyInstall"]'));
    expect(h.posted).toContainEqual({ type: "cancelAgyInstall" });
    dispatch(h.window, { type: "agyInstallProgress", phase: "idle", reason: "Antigravity installation failed: disk full" });
    expect(onboarding(h.doc).querySelector(".onb-install-error")?.textContent).toBe("Antigravity installation failed: disk full");
  });

  it("offers Google sign-in, then shows the server's link while it waits", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "initialState", capabilities: { remoteAgentSignIn: true } });
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: true, needsLogin: true }] });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy" });
    const signIn = onboarding(h.doc).querySelector('[data-act="connectProvider"][data-provider="agy"]') as HTMLElement;
    expect(signIn.textContent).toBe("Sign in with Google");
    click(h.window, signIn);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "agy" });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", launched: true,
      device: { status: "waiting", url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" } });
    const wizard = h.doc.querySelector(".connect-wizard-body")!;
    expect(wizard.textContent).toContain("Finish signing in to Antigravity");
    const link = wizard.querySelector('a[href="https://accounts.google.com/o/oauth2/v2/auth?x=1"]');
    expect(link?.textContent).toBe("Open the sign-in page");
    expect(wizard.querySelector('[data-act="cancelDeviceLogin"][data-provider="agy"]')).not.toBeNull();
  });

  it("tells a remote to connect Antigravity at the computer, with nothing to press", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy" });
    expect(onboarding(h.doc).textContent).toContain("Connect Antigravity at the computer");
    expect(onboarding(h.doc).querySelector(".onb-action")).toBeNull();
  });

  it("gives a lapsed Antigravity account no Sign in button on a remote", () => {
    const h = bootWebview({ remote: true });
    dispatch(h.window, { type: "initialState", capabilities: { remoteAgentSignIn: true } });
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: true, needsLogin: true }] });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "agy", models: [] });
    const card = h.doc.getElementById("provider-signin-card")!;
    expect(card.textContent).toContain("Antigravity can only be signed in on the computer running this workspace.");
    expect(card.querySelector(".provider-signin-btn")).toBeNull();
  });

  it("opens the connect dialog on the Install panel when Connect finds no server", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: false }] });
    dispatch(h.window, { type: "onboarding", state: "missing-agy", provider: "agy", platform: "win32",
      device: { status: "failed", message: "Antigravity is not installed on this machine." } });
    const wizard = h.doc.querySelector(".connect-wizard-body")!;
    expect(wizard.querySelector('[data-act="installAgy"]')).not.toBeNull();
    dispatch(h.window, { type: "agyInstallProgress", phase: "installing" });
    expect(wizard.textContent).toContain("Unpacking Antigravity...");
    dispatch(h.window, { type: "onboarding", state: "agy-login", provider: "agy", platform: "win32" });
    expect((wizard.querySelector('[data-act="connectProvider"][data-provider="agy"]') as HTMLElement).textContent).toBe("Connect Antigravity");
  });

  it("names Antigravity while it starts, and is patient with its slow start", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "providerState", providers: [{ id: "agy", connected: true }] });
    dispatch(h.window, { type: "session", sessionId: "s", provider: "agy", models: [] });
    expect((h.doc.getElementById("input") as HTMLTextAreaElement).placeholder).toBe("Ask Antigravity…");
    const chat = readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");
    expect(chat).toContain('startup.provider === "agy" ? 60 : 20');
  });
});

describe("Antigravity in Settings", () => {
  const settingsSrc = readFileSync(path.join(__dirname, "..", "media", "settings.js"), "utf8");
  function mount(env: Record<string, unknown>, providers: unknown[], category = "providers") {
    const window = new Window({ url: "https://localhost/" });
    (window as any).eval(settingsSrc);
    const api = (window as any).GrokSettings;
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const posted: any[] = [];
    api.mount(container, { snapshot: api.defaultSnapshot({ providers }), env: api.defaultEnv(env), category, post: (m: unknown) => posted.push(m) });
    return { container, posted, window };
  }
  const desk = { isRemote: false, isDesktop: false, providersKnown: true };

  it("has a desk row only when advertised: Connect, then Disconnect that keeps the Google sign-in", () => {
    expect(mount(desk, [{ id: "grok", connected: false }]).container.querySelector('[data-id="providerAgy"]')).toBeNull();
    const off = mount(desk, [{ id: "agy", connected: false, keepsCliSignIn: true }]);
    const row = off.container.querySelector('[data-id="providerAgy"]')!;
    expect(row.textContent).toContain("Antigravity");
    const button = row.querySelector(".settings-action") as HTMLElement;
    expect(button.textContent).toBe("Connect");
    button.dispatchEvent(new (off.window as any).MouseEvent("click", { bubbles: true }));
    expect(off.posted).toContainEqual({ type: "runGrokLogin", provider: "agy" });
    const on = mount(desk, [{ id: "agy", connected: true, keepsCliSignIn: true }]);
    const connected = on.container.querySelector('[data-id="providerAgy"]')!;
    expect(connected.textContent).toContain("your Google sign-in for Antigravity stays");
    expect((connected.querySelector(".settings-action") as HTMLElement).textContent).toBe("Disconnect");
  });

  it("gives a remote a status row with no Connect", () => {
    const remote = mount({ isRemote: true, isDesktop: false, providersKnown: true, hostCaps: { remoteAgentSignIn: true } },
      [{ id: "agy", connected: false }]);
    expect(remote.container.querySelector('[data-id="providerAgy"]')).toBeNull();
    const status = remote.container.querySelector('[data-id="providerAgyStatus"]')!;
    expect(status.textContent).toContain("Connect Antigravity on the computer running this workspace.");
    expect(status.querySelector("button")).toBeNull();
  });

  it("points at the experimental setting from Advanced, at a desk only", () => {
    const advanced = mount(desk, [], "advanced");
    const row = advanced.container.querySelector('[data-id="experimentalAntigravity"]')!;
    (row.querySelector(".settings-action") as HTMLElement).dispatchEvent(new (advanced.window as any).MouseEvent("click", { bubbles: true }));
    expect(advanced.posted).toContainEqual({ type: "openSettings", section: "grok.experimentalAntigravity" });
    expect(mount({ isRemote: true, providersKnown: true }, [], "advanced").container.querySelector('[data-id="experimentalAntigravity"]')).toBeNull();
  });
});
