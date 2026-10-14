import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpClient, type PermissionRequest } from "../src/acp";
import { AgyBackend, agyWorkingFolderPrompt } from "../src/agy-backend";
import { agyGoogleSignInPresent, agyStartupAuth, runAgySignIn } from "../src/agy-auth";

const FAKE = path.join(__dirname, "fixtures", "fake-agy-acp.cjs");

function signIn(home: string): void {
  const acp = path.join(home, "antigravity-acp");
  fs.mkdirSync(acp, { recursive: true });
  fs.writeFileSync(path.join(acp, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }));
  fs.writeFileSync(path.join(acp, "acp_token.json"), "{}");
}

describe("Antigravity over ACP (real subprocess, fake server)", () => {
  let home: string;
  let cwd: string;
  let sink: string;
  const clients: AcpClient[] = [];

  function client(extraEnv: NodeJS.ProcessEnv = {}, startupAuth?: { methodId: string; meta?: Record<string, unknown> }): AcpClient {
    const made = new AcpClient({
      cliPath: FAKE,
      cwd,
      backend: new AgyBackend({ env: { GEMINI_HOME: home } }),
      env: { ...process.env, GEMINI_HOME: home, FAKE_AGY_SINK: sink, ...extraEnv },
      log: () => {},
      ...(startupAuth ? { startupAuth } : {}),
    });
    clients.push(made);
    return made;
  }

  const received = () => fs.readFileSync(sink, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-test-"));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-project-test-"));
    sink = path.join(home, "requests.jsonl");
    fs.writeFileSync(sink, "");
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((made) => { made.removeAllListeners(); return made.dispose(); }));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("opens a session with the working-folder append, one model, and effort as thinking_level", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    const initialize = received().find((entry) => entry.method === "initialize");
    expect(initialize.params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    await agy.newSession();
    const sessionNew = received().find((entry) => entry.method === "session/new");
    expect(sessionNew.params).toMatchObject({ cwd, mcpServers: [], _meta: { antigravity: { systemPrompt: { append: agyWorkingFolderPrompt(cwd) } } } });
    expect(agy.availableModels.map((model) => model.modelId)).toEqual(["gemini-3.8-flash"]);
    expect(agy.availableModels[0].reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(agy.currentReasoningEffort).toBe("high");
    await expect(agy.setReasoningEffort("xhigh")).resolves.toBe(true);
    await expect(agy.setReasoningEffort("minimal")).resolves.toBe(true);
    expect(agy.currentReasoningEffort).toBe("low");
    expect(received().filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params.value)).toEqual(["high", "low"]);
  });

  it("starts at the remembered effort", async () => {
    signIn(home);
    const agy = new AcpClient({
      cliPath: FAKE, cwd, effort: "medium",
      backend: new AgyBackend({ env: { GEMINI_HOME: home } }),
      env: { ...process.env, GEMINI_HOME: home, FAKE_AGY_SINK: sink },
      log: () => {},
    });
    clients.push(agy);
    await agy.start();
    await agy.newSession();
    expect(agy.currentReasoningEffort).toBe("medium");
  });

  it("classifies a signed-out session/new as a credential error", async () => {
    const agy = client();
    await agy.start();
    const failure = await agy.newSession().catch((error) => error);
    expect(failure).toMatchObject({ code: -32000 });
    expect(agy.isCredentialError(failure)).toBe(true);
  });

  it("renders one completed card for an approved edit, not a red one beside it", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    await agy.newSession();
    const updates: any[] = [];
    const calls: any[] = [];
    agy.on("toolCall", (call) => calls.push(call));
    agy.on("toolCallUpdate", (update) => updates.push(update));
    agy.on("permissionRequest", (request: PermissionRequest) => agy.respondPermission(request.id, "allow"));
    await agy.prompt("please edit hello.txt");
    expect(calls.map((call) => call.toolCallId)).toEqual(["b6f93483bd0942fa8b4b4751ca211cc3"]);
    expect(updates.map((update) => [update.toolCallId, update.status])).toEqual([
      ["b6f93483bd0942fa8b4b4751ca211cc3", "in_progress"],
      ["b6f93483bd0942fa8b4b4751ca211cc3", "completed"],
    ]);
  });

  it("hides /logout and /plan from the command list", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    await agy.newSession();
    await agy.prompt("hello");
    expect(agy.availableCommands.map((command) => command.name)).toEqual(["usage"]);
  });

  it("cancels a running turn and takes the next prompt", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    await agy.newSession();
    const chunks: string[] = [];
    agy.on("messageChunk", (text) => chunks.push(text));
    const turn = agy.prompt("a slow answer please");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await agy.cancel("test");
    await expect(turn).resolves.toBeDefined();
    expect(received().some((entry) => entry.method === "session/cancel")).toBe(true);
    expect(chunks.join("")).toContain("The request was cancelled by the client.");
    chunks.length = 0;
    await agy.prompt("hello");
    expect(chunks).toEqual(["OK"]);
  });

  it("resumes with the working-folder append and replays the transcript", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    const chunks: string[] = [];
    agy.on("messageChunk", (text) => chunks.push(text));
    await agy.loadSession("5e550000-0000-4000-8000-000000000001");
    const load = received().find((entry) => entry.method === "session/load");
    expect(load.params._meta.antigravity.systemPrompt.append).toBe(agyWorkingFolderPrompt(cwd));
    expect(chunks.join("")).toContain("OK");
    expect(agy.availableModels.map((model) => model.modelId)).toEqual(["gemini-3.8-flash"]);
  });

  it("signs in through authenticate and out through logout, on the server's own files", async () => {
    const onPrompt = (url: string) => urls.push(url);
    const urls: string[] = [];
    const done = await new Promise<any>((resolve) => {
      runAgySignIn(client(), { onPrompt: (prompt) => onPrompt(prompt.url), onDone: resolve });
    });
    expect(done).toEqual({ ok: true, output: "" });
    expect(urls).toEqual(["https://accounts.google.com/o/oauth2/v2/auth?client_id=fake"]);
    expect(await agyGoogleSignInPresent({ env: { GEMINI_HOME: home }, platform: "linux" })).toBe(true);
    const agy = client();
    await agy.start();
    await agy.logout();
    expect(await agyGoogleSignInPresent({ env: { GEMINI_HOME: home }, platform: "linux" })).toBe(false);
  });

  it("reports a refused Google sign-in as failed", async () => {
    const done = await new Promise<any>((resolve) => {
      runAgySignIn(client({ FAKE_AGY_SIGN_IN: "deny" }), { onPrompt: () => {}, onDone: resolve });
    });
    expect(done).toMatchObject({ ok: false, failure: "failed" });
    expect(done.output).toContain("Onboarding failed");
  });

  it("authenticates a key start in _meta before the session, and offers the key catalog", async () => {
    const agy = client({}, agyStartupAuth("api-key", "AIza-good"));
    await agy.start();
    await agy.newSession();
    const methods = received().map((entry) => entry.method);
    expect(methods.indexOf("authenticate")).toBeGreaterThan(methods.indexOf("initialize"));
    expect(methods.indexOf("authenticate")).toBeLessThan(methods.indexOf("session/new"));
    expect(received().find((entry) => entry.method === "authenticate").params)
      .toEqual({ methodId: "gemini-api-key", _meta: { "api-key": "AIza-good" } });
    // One row per family, effort as each family's own levels; no Gemini 4 Argon.
    expect(agy.availableModels.map((model) => model.modelId))
      .toEqual(["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-pro"]);
    expect(agy.availableModels.find((model) => model.modelId === "gemini-3.1-pro")?.reasoningEfforts).toEqual(["low", "high"]);
    expect(agy.availableModels[0].reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(agy.availableModels.some((model) => /argon/i.test(model.modelId))).toBe(false);
    await agy.setModel("gemini-3.1-pro");
    expect(agy.currentModelId).toBe("gemini-3.1-pro");
  });

  it("states the Google method on every start, whatever settings.json was left saying", async () => {
    signIn(home);
    fs.writeFileSync(path.join(home, "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: "gemini-api-key" } }));
    const agy = client({}, agyStartupAuth("google"));
    await agy.start();
    await agy.newSession();
    expect(received().find((entry) => entry.method === "authenticate").params).toEqual({ methodId: "oauth-personal" });
    expect(agy.availableModels.map((model) => model.modelId)).toEqual(["gemini-3.8-flash"]);
  });

  it("reports a key Google refuses mid-turn as a rejected credential", async () => {
    const agy = client({}, agyStartupAuth("api-key", "bad-key"));
    await agy.start();
    await agy.newSession();
    let rejected = 0;
    agy.on("credentialRejected", () => { rejected += 1; });
    await agy.prompt("hello");
    expect(rejected).toBe(1);
  });

  it("lists the project's conversations from disk", async () => {
    signIn(home);
    const agy = client();
    await agy.start();
    const { sessionId } = await agy.newSession();
    const listed = await new AgyBackend({ env: { GEMINI_HOME: home } }).listSessions(async () => ({}), cwd, process.platform);
    expect(listed.sessions.map((entry) => entry.sessionId)).toEqual([sessionId]);
    expect(typeof listed.sessions[0].updatedAt).toBe("number");
  });
});
