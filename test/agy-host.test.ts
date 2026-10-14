/**
 * Antigravity at the host: the providerState row, Google sign-in through the
 * device-login card, Disconnect and Sign out -- driven against the fake ACP
 * server, whose state lives under GEMINI_HOME exactly where the real one's
 * does, so the host's own credential check reads real files.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { CLOUD_ENVIRONMENT_ENV } from "../src/remote-frames";

const FAKE = path.join(__dirname, "fixtures", "fake-agy-acp.cjs");

let home: string;
const token = () => path.join(home, "antigravity-acp", "acp_token.json");

function signIn(): void {
  fs.mkdirSync(path.dirname(token()), { recursive: true });
  fs.writeFileSync(path.join(home, "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }));
  fs.writeFileSync(token(), "{}");
}

function host(opts: { connected?: boolean; experimental?: boolean } = {}): any {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.provider = "agy";
  session.cwd = home;
  sidebar.focused = session;
  sidebar.pool = new Set([session]);
  sidebar.providerConnectionState = opts.connected ? { agy: true } : {};
  sidebar.providerNeedsLogin = {};
  sidebar.providerCliVersions = {};
  sidebar.deviceLogins = new Map();
  sidebar.deviceLoginPreflightShown = new Set();
  sidebar.deviceLoginWork = new Set();
  sidebar.deviceLoginWorkSeq = 0;
  sidebar.refreshKeepAwake = vi.fn();
  sidebar.remoteClients = { detachedActiveValues: () => [], clients: () => [], tabToken: () => undefined, cwdIfPresent: () => undefined };
  sidebar.locateProvider = vi.fn(() => FAKE);
  sidebar.locatedProviders = () => ({ agy: true });
  sidebar.workspaceRoot = vi.fn(() => home);
  sidebar.host = {
    appendLine: vi.fn(),
    createTerminal: vi.fn(),
    showWarningMessage: vi.fn(async () => "Sign Out"),
    showErrorMessage: vi.fn(async () => undefined),
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === "experimentalAntigravity" ? opts.experimental !== false : fallback }),
  };
  sidebar.state = { get: (_key: string, fallback: unknown) => fallback, update: vi.fn(async () => {}) };
  sidebar.invalidateSubscriptionUsage = vi.fn();
  sidebar.adapterHistory = vi.fn(() => undefined);
  sidebar.rearmAuthRecovery = vi.fn();
  sidebar.post = vi.fn();
  sidebar.postLocal = vi.fn();
  sidebar.postProviderState = vi.fn();
  sidebar.adoptSessionsForConnectedProvider = vi.fn(async () => {});
  sidebar.resetProviderSessionsAfterLogout = vi.fn();
  sidebar.probeProviderVersion = vi.fn(async () => "");
  sidebar.disposeAdapterHistoryClient = vi.fn(async () => {});
  sidebar.postSessionsList = vi.fn();
  sidebar.worktreeCache = new Map();
  return sidebar;
}

const deviceFrames = (sidebar: any) => sidebar.post.mock.calls
  .map(([message]: any[]) => message)
  .filter((message: any) => message.type === "onboarding" && message.device)
  .map((message: any) => message.device);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-host-test-"));
  vi.stubEnv("GEMINI_HOME", home);
  vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Antigravity in providerState", () => {
  it("is advertised at a desk with the experimental setting, with Disconnect semantics", () => {
    const sidebar = host({ connected: true });
    sidebar.providerCliVersions = { agy: "1.4.0" };
    sidebar.providerNeedsLogin = { agy: true };
    const row = GrokSidebar.prototype["providerStateMessage"].call(sidebar).providers.find((p: any) => p.id === "agy");
    expect(row).toEqual({ id: "agy", connected: true, keepsCliSignIn: true, cliVersion: "1.4.0", needsLogin: true });
  });

  it("is not advertised without the setting, or on a cloud machine", () => {
    const off = host({ connected: true, experimental: false });
    expect(GrokSidebar.prototype["providerStateMessage"].call(off).providers.map((p: any) => p.id)).not.toContain("agy");
    vi.stubEnv(CLOUD_ENVIRONMENT_ENV, "1");
    const cloud = host({ connected: true });
    expect(GrokSidebar.prototype["providerStateMessage"].call(cloud).providers.map((p: any) => p.id)).not.toContain("agy");
  });

  it("notes the server's version from its handshake", () => {
    const sidebar = host({ connected: true });
    sidebar.noteAgyVersion({ agentInfo: { name: "antigravity-acp", version: "1.4.0" } });
    expect(sidebar.providerCliVersions.agy).toBe("1.4.0");
    expect(sidebar.postProviderState).toHaveBeenCalledTimes(1);
    sidebar.noteAgyVersion({ agentInfo: { version: "1.4.0" } });
    expect(sidebar.postProviderState).toHaveBeenCalledTimes(1);
  });

  it("an Antigravity conversation that cannot start gets a card a renderer will draw", () => {
    const off = host({ experimental: false });
    off.usableProviders = () => ["grok"];
    // Renderers draw no card for an unadvertised `agy`, so the refusal must not name it.
    expect(off.refusedStartOnboarding("agy")).toEqual({ state: "connect-agent" });
    const on = host();
    on.usableProviders = () => ["grok", "agy"];
    expect(on.refusedStartOnboarding("agy")).toEqual({ state: "missing-agy", provider: "agy" });
  });
});

describe("connecting Antigravity at the desk", () => {
  it("adopts a stored Google sign-in without starting a server", async () => {
    signIn();
    const sidebar = host();
    await sidebar.onMessage({ type: "runGrokLogin", provider: "agy" }, "local");
    expect(sidebar.providerConnectionState.agy).toBe(true);
    expect(sidebar.providerNeedsLogin.agy).toBe(false);
    expect(sidebar.adoptSessionsForConnectedProvider).toHaveBeenCalledWith("agy", sidebar.focused);
    expect(deviceFrames(sidebar)).toEqual([]);
  });

  it("offers the sign-in, and opens nothing, when no sign-in is stored", async () => {
    const sidebar = host();
    await sidebar.onMessage({ type: "runGrokLogin", provider: "agy" }, "local");
    expect(sidebar.providerNeedsLogin.agy).toBe(true);
    expect(sidebar.post).toHaveBeenCalledWith(expect.objectContaining({ type: "onboarding", state: "agy-login", provider: "agy" }));
    expect(deviceFrames(sidebar)).toEqual([]);
  });

  it("signs in with Google through the server, shows the link, and connects", async () => {
    const sidebar = host({ connected: true });
    sidebar.providerNeedsLogin = { agy: true };
    await sidebar.onMessage({ type: "runGrokLogin", provider: "agy" }, "local");
    await vi.waitFor(() => expect(deviceFrames(sidebar).at(-1)).toEqual({ status: "done" }), { timeout: 15_000 });
    const statuses = deviceFrames(sidebar).map((device: any) => device.status);
    expect(statuses[0]).toBe("starting");
    expect(statuses).toContain("verifying");
    expect(deviceFrames(sidebar).find((device: any) => device.status === "waiting").url)
      .toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=fake");
    expect(fs.existsSync(token())).toBe(true);
    expect(sidebar.providerNeedsLogin.agy).toBe(false);
    expect(sidebar.adoptSessionsForConnectedProvider).toHaveBeenCalled();
  });

  it("cancels a sign-in that is waiting on the browser", async () => {
    vi.stubEnv("FAKE_AGY_SIGN_IN", "hang");
    const sidebar = host({ connected: true });
    sidebar.providerNeedsLogin = { agy: true };
    await sidebar.onMessage({ type: "runGrokLogin", provider: "agy" }, "local");
    await vi.waitFor(() => expect(deviceFrames(sidebar).some((device: any) => device.status === "waiting")).toBe(true), { timeout: 15_000 });
    await sidebar.onMessage({ type: "cancelDeviceLogin", provider: "agy" }, "local");
    expect(sidebar.deviceLogins.size).toBe(0);
    expect(sidebar.post.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ state: "agy-login", provider: "agy" }));
    expect(sidebar.post.mock.calls.at(-1)[0]).not.toHaveProperty("device");
    expect(fs.existsSync(token())).toBe(false);
  });

  it("answers a missing server with the install panel, at the desk only", async () => {
    const sidebar = host();
    sidebar.locateProvider = vi.fn(() => undefined);
    await sidebar.onMessage({ type: "runGrokLogin", provider: "agy" }, "local");
    expect(sidebar.postLocal).toHaveBeenCalledWith(expect.objectContaining({
      type: "onboarding", state: "missing-agy", provider: "agy",
      device: { status: "failed", message: "Antigravity is not installed on this machine." },
    }));
    expect(sidebar.providerConnectionState.agy).toBeUndefined();
  });

  it("installs only on a local request", async () => {
    const sidebar = host();
    sidebar.installManagedAgyServer = vi.fn(async () => {});
    await sidebar.onMessage({ type: "installAgy" }, "remote");
    expect(sidebar.installManagedAgyServer).not.toHaveBeenCalled();
    await sidebar.onMessage({ type: "installAgy" }, "local");
    expect(sidebar.installManagedAgyServer).toHaveBeenCalledTimes(1);
  });
});

describe("Disconnect and Sign out", () => {
  it("Disconnect turns Antigravity off here and keeps the Google sign-in", async () => {
    signIn();
    const sidebar = host({ connected: true });
    sidebar.persistProviderConnections = vi.fn(async () => {});
    await sidebar.logout("agy");
    expect(sidebar.providerConnectionState.agy).toBe(false);
    expect(fs.existsSync(token())).toBe(true);
  });

  it("Sign out clears the stored sign-in through the server's ACP logout", async () => {
    signIn();
    const sidebar = host({ connected: true });
    sidebar.persistProviderConnections = vi.fn(async () => {});
    await sidebar.logout("agy", { signOutCli: true });
    expect(sidebar.host.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("Sign out of Antigravity?"), { modal: true }, "Sign Out");
    expect(fs.existsSync(token())).toBe(false);
    expect(sidebar.providerConnectionState.agy).toBe(false);
  });

  it("keeps the account when the person declines", async () => {
    signIn();
    const sidebar = host({ connected: true });
    sidebar.host.showWarningMessage = vi.fn(async () => undefined);
    await sidebar.logout("agy", { signOutCli: true });
    expect(fs.existsSync(token())).toBe(true);
    expect(sidebar.providerConnectionState.agy).toBe(true);
  });
});
