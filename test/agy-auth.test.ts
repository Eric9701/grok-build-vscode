import { EventEmitter } from "node:events";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AGY_SIGN_IN_METHOD, AGY_SIGN_IN_TIMEOUT_MS, agyCredentialPresent, agySavedAuthType, agySignInUrl, runAgySignIn } from "../src/agy-auth";

const home = "/home/me";
const acp = path.join(home, ".gemini", "antigravity-acp");

function probe(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    env: {}, home, platform: "linux" as NodeJS.Platform,
    exists: (file: string) => file in files,
    readFile: (file: string) => { if (!(file in files)) throw new Error("ENOENT"); return files[file]; },
    ...extra,
  };
}

describe("Antigravity stored sign-in", () => {
  const settings = { [path.join(acp, "settings.json")]: JSON.stringify({ auth: { type: "oauth-personal" } }) };
  const token = { [path.join(acp, "acp_token.json")]: "{}" };

  it("needs the saved Google method AND its token", async () => {
    expect(await agyCredentialPresent(probe({ ...settings, ...token }))).toBe(true);
    expect(await agyCredentialPresent(probe(settings))).toBe(false);
    expect(await agyCredentialPresent(probe(token))).toBe(false);
    expect(await agyCredentialPresent(probe({ [path.join(acp, "settings.json")]: JSON.stringify({ auth: { type: "gemini-api-key" } }), ...token }))).toBe(false);
    expect(agySavedAuthType(probe({ [path.join(acp, "settings.json")]: "not json" }))).toBeUndefined();
  });

  it("asks the macOS keychain only when there is no token file and file storage is not forced", async () => {
    const keychainEntry = vi.fn(async () => true);
    expect(await agyCredentialPresent(probe(settings, { platform: "darwin", keychainEntry }))).toBe(true);
    expect(keychainEntry).toHaveBeenCalledTimes(1);
    expect(await agyCredentialPresent(probe(settings, { platform: "darwin", keychainEntry, env: { AGY_ACP_FORCE_FILE_STORAGE: "1" } }))).toBe(false);
    expect(await agyCredentialPresent(probe(settings, { platform: "win32", keychainEntry }))).toBe(false);
    expect(keychainEntry).toHaveBeenCalledTimes(1);
  });

  it("honours GEMINI_HOME", async () => {
    const custom = path.join("/data", "g", "antigravity-acp");
    expect(await agyCredentialPresent(probe({
      [path.join(custom, "settings.json")]: JSON.stringify({ auth: { type: "oauth-personal" } }),
      [path.join(custom, "acp_token.json")]: "{}",
    }, { env: { GEMINI_HOME: path.join("/data", "g") } }))).toBe(true);
  });
});

describe("Antigravity sign-in runner", () => {
  it("finds the link the server prints while it waits", () => {
    expect(agySignInUrl("I1014 noise\nOpen the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?x=1&y=2\n"))
      .toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1&y=2");
    expect(agySignInUrl("Open the following link to authenticate the ACP server: http://evil")).toBeUndefined();
  });

  function fakeClient(authenticate: () => Promise<unknown>) {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      start: vi.fn(async () => {}),
      authenticate: vi.fn(authenticate),
      dispose: vi.fn(async () => {}),
    });
  }

  it("reports the link once, then success, and always stops the server", async () => {
    let resolve!: () => void;
    const client = fakeClient(() => new Promise<void>((r) => { resolve = r; }));
    const onPrompt = vi.fn();
    const onDone = vi.fn();
    runAgySignIn(client, { onPrompt, onDone });
    await vi.waitFor(() => expect(client.authenticate).toHaveBeenCalledWith(AGY_SIGN_IN_METHOD, AGY_SIGN_IN_TIMEOUT_MS));
    client.emit("stderr", "Open the following link to authenticate the ACP");
    client.emit("stderr", " server: https://accounts.google.com/auth?a=1\n");
    client.emit("stderr", "Open the following link to authenticate the ACP server: https://accounts.google.com/auth?a=2\n");
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith({ url: "https://accounts.google.com/auth?a=1" });
    resolve();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith({ ok: true, output: "" }));
    await vi.waitFor(() => expect(client.dispose).toHaveBeenCalled());
  });

  it("reports a refused or timed-out sign-in as failed with the server's reason", async () => {
    const client = fakeClient(async () => { throw { code: -32000, message: "Authentication required", data: { message: "Onboarding failed: x" } }; });
    const onDone = vi.fn();
    runAgySignIn(client, { onPrompt: vi.fn(), onDone });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith({ ok: false, failure: "failed", output: "Onboarding failed: x" }));
  });

  it("settles a cancel at once and stops the server, ignoring what follows", async () => {
    let reject!: (error: Error) => void;
    const client = fakeClient(() => new Promise((_r, j) => { reject = j; }));
    const onDone = vi.fn();
    const handle = runAgySignIn(client, { onPrompt: vi.fn(), onDone });
    await vi.waitFor(() => expect(client.authenticate).toHaveBeenCalled());
    handle.cancel();
    expect(onDone).toHaveBeenCalledWith({ ok: false, cancelled: true, output: "" });
    expect(client.dispose).toHaveBeenCalled();
    reject(new Error("server exited"));
    await new Promise((r) => setTimeout(r, 10));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
