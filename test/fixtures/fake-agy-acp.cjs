#!/usr/bin/env node
// A stand-in for Google's agy_acp_server 1.4.0, replaying the frames measured
// against the real server (research/antigravity-acp.md). State lives under
// GEMINI_HOME exactly where the real server keeps it, so host code that reads
// the server's files sees what it would see in production.
//
// Env: GEMINI_HOME (required), FAKE_AGY_SINK (JSONL of requests received),
// FAKE_AGY_SIGN_IN = approve (default) | deny | hang.
//
// `gemini-api-key` behaves as the real server's does: the key arrives in
// `authenticate` `_meta` (or GEMINI_API_KEY), is held in memory only, and
// `auth.type` is written to the shared settings.json. Key mode lists the
// hardcoded catalog (several families, no Gemini 4 Argon), and a turn with the
// key "bad-key" fails the way the Gemini API refuses one: as agent text.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const home = process.env.GEMINI_HOME;
const acpDir = path.join(home, "antigravity-acp");
const settingsFile = path.join(acpDir, "settings.json");
const tokenFile = path.join(acpDir, "acp_token.json");
const conversations = path.join(acpDir, "conversations");
const rl = readline.createInterface({ input: process.stdin });
let nextServerId = 0;
const waiting = new Map();
const cancelled = new Set();
const sessions = new Map();
let loggedOut = false;
// What `authenticate` selected in this process; settings.json otherwise.
let auth;

function write(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function update(sessionId, value) { write({ method: "session/update", params: { sessionId, update: value } }); }
function sink(method, params) {
  if (process.env.FAKE_AGY_SINK) fs.appendFileSync(process.env.FAKE_AGY_SINK, JSON.stringify({ method, params }) + "\n");
}
function request(method, params) {
  const id = nextServerId++;
  write({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
function savedAuthType() {
  try { return JSON.parse(fs.readFileSync(settingsFile, "utf8")).auth.type; } catch { return undefined; }
}
function rememberAuthType(type) {
  fs.mkdirSync(acpDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ auth: { type } }));
}
/** The method in force: the one authenticate chose, else settings.json's. */
function currentAuth() {
  if (loggedOut) return undefined;
  if (auth) return auth;
  const type = savedAuthType();
  if (type === "oauth-personal" && fs.existsSync(tokenFile)) return { method: type };
  if (type === "gemini-api-key" && process.env.GEMINI_API_KEY) return { method: type, key: process.env.GEMINI_API_KEY };
  return undefined;
}
function signedIn() { return !!currentAuth(); }
function apiKeyFromMeta(meta) {
  for (const entry of ["api-key", "apiKey", "api_key"]) {
    const value = meta?.[entry];
    if (typeof value === "string" && value) return value;
    if (value && typeof value === "object") {
      for (const field of ["apiKey", "api_key", "api-key", "key"]) if (typeof value[field] === "string" && value[field]) return value[field];
    }
  }
  return undefined;
}
function authRequired() {
  return { code: -32000, message: "Authentication required", data: { message: "No authentication method selected." } };
}
// model_selection.py DEFAULT_MODEL_LIST: the API-key catalog. Gemini 4 Argon
// is agent-platform only, so it is not here.
const KEY_FAMILIES = [
  ["gemini-3.8-flash", "Gemini 3.8 Flash", ["high", "medium", "low"]],
  ["gemini-3.7-flash", "Gemini 3.7 Flash", ["high", "medium", "low"]],
  ["gemini-3.6-flash", "Gemini 3.6 Flash", ["high", "medium", "low"]],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", ["high", "medium", "low"]],
  ["gemini-3.1-pro", "Gemini 3.1 Pro", ["high", "low"]],
];
function families() {
  return currentAuth()?.method === "gemini-api-key" ? KEY_FAMILIES : KEY_FAMILIES.slice(0, 1);
}
function configOptions(level, family = "gemini-3.8-flash") {
  const current = families().find(([id]) => id === family) ?? families()[0];
  const order = ["low", "medium", "high"];
  return [
    { currentValue: current[0], options: families().map(([value, name]) => ({ value, name })), id: "model", name: "Model", category: "model", type: "select" },
    { currentValue: level, options: [...current[2]].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((value) => ({ value, name: value })), id: "thinking_level", name: "Thinking Level", category: "thought_level", type: "select" },
    { currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "auto_edit", name: "Auto Edit" }, { value: "yolo", name: "YOLO" }], id: "mode", name: "Session Mode", category: "mode", type: "select" },
  ];
}
function sessionResult(sessionId) {
  const session = sessions.get(sessionId);
  const level = session?.level ?? "high";
  const family = session?.family ?? "gemini-3.8-flash";
  return {
    ...(sessionId ? { sessionId } : {}),
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "auto_edit", name: "Auto Edit" }, { id: "yolo", name: "YOLO" }] },
    configOptions: configOptions(level, family),
    models: {
      availableModels: families().flatMap(([id, name, levels]) => levels.map((l) => ({ modelId: `${id}-${l}`, name: `${name} (${l})` }))),
      currentModelId: `${family}-${level}`,
    },
  };
}
function commands(sessionId) {
  update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [
    { name: "plan", description: "Plan carefully" }, { name: "logout", description: "Log out" }, { name: "usage", description: "Show usage" }] });
}
function remember(sessionId, cwd) {
  fs.mkdirSync(conversations, { recursive: true });
  fs.writeFileSync(path.join(conversations, `${sessionId}.db`), "");
  fs.writeFileSync(path.join(conversations, `${sessionId}.meta`), JSON.stringify({ cwd }));
}

async function prompt(id, params) {
  const { sessionId } = params;
  const text = params.prompt?.map((block) => block.text ?? "").join(" ") ?? "";
  if (loggedOut) return write({ id, error: { code: -32000, message: "Logged out. Sign in again to continue." } });
  commands(sessionId);
  const session = sessions.get(sessionId);
  if (currentAuth()?.key === "bad-key") {
    // The server reports an API refusal as text and ends the turn normally.
    update(sessionId, { content: { type: "text", text: "API key not valid. Please pass a valid API key." }, sessionUpdate: "agent_message_chunk" });
    return write({ id, result: { stopReason: "end_turn" } });
  }
  if (/edit/i.test(text)) {
    // The approved edit is reported twice; the first is swept as failed.
    const target = path.join(session.cwd, "hello.txt");
    const approved = "b6f93483bd0942fa8b4b4751ca211cc3";
    const call = { toolCallId: approved, title: "Run create_file?", kind: "edit", status: "pending",
      content: [{ path: target, newText: "hi", _meta: { kind: "add" }, type: "diff" }], locations: [{ path: target }],
      rawInput: { CodeContent: "hi", TargetFile: target } };
    update(sessionId, { ...call, sessionUpdate: "tool_call" });
    const answer = await request("session/request_permission", { sessionId, toolCall: call,
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    if (answer?.outcome?.optionId === "allow") {
      const running = `${sessionId}:1`;
      update(sessionId, { toolCallId: running, title: "Running edit_file", kind: "edit", status: "in_progress", locations: [{ path: target }], rawInput: { file_path: target }, sessionUpdate: "tool_call" });
      update(sessionId, { toolCallId: running, status: "completed", rawOutput: "Create hello.txt", sessionUpdate: "tool_call_update" });
      update(sessionId, { content: { type: "text", text: "Created hello.txt." }, sessionUpdate: "agent_message_chunk" });
      update(sessionId, { toolCallId: approved, status: "failed", rawOutput: "Tool call was approved but never executed.", sessionUpdate: "tool_call_update" });
    } else {
      update(sessionId, { toolCallId: approved, status: "failed", rawOutput: "Denied by user.", sessionUpdate: "tool_call_update" });
    }
  } else if (/run/i.test(text)) {
    const call = { toolCallId: "64aef4da43e841118774c470deebb567", kind: "execute", status: "pending", title: "echo done",
      rawInput: { CommandLine: "echo done", Cwd: session.cwd } };
    update(sessionId, { ...call, sessionUpdate: "tool_call" });
    const answer = await request("session/request_permission", { sessionId, toolCall: call, options: [
      { optionId: "allow_always", name: "Allow Always (risky)", kind: "allow_always" },
      { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    sink("permissionAnswer", answer);
    update(sessionId, { toolCallId: call.toolCallId, status: "completed", rawOutput: { commandLine: "echo done", exitCode: 0, combinedOutput: "done\n" }, sessionUpdate: "tool_call_update" });
  } else if (/slow/i.test(text)) {
    for (let index = 0; index < 400 && !cancelled.has(sessionId); index++) {
      update(sessionId, { content: { type: "text", text: `${index}. ` }, sessionUpdate: "agent_message_chunk" });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (cancelled.delete(sessionId)) {
      update(sessionId, { content: { type: "text", text: "The request was cancelled by the client." }, sessionUpdate: "agent_message_chunk" });
      return write({ id, result: { stopReason: "cancelled" } });
    }
  } else {
    update(sessionId, { content: { type: "text", text: "OK" }, sessionUpdate: "agent_message_chunk" });
  }
  update(sessionId, { used: 13224, size: 1048576, sessionUpdate: "usage_update" });
  write({ id, result: { stopReason: "end_turn" } });
}

rl.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && !message.method) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params = {} } = message;
  sink(method, params);
  switch (method) {
    case "initialize":
      return write({ id, result: { protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} }, auth: { logout: {} },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "1.4.0" } } });
    case "authenticate": {
      if (params.methodId === "gemini-api-key") {
        // Held in memory only; the method is remembered in settings.json.
        const key = apiKeyFromMeta(params._meta) ?? process.env.GEMINI_API_KEY;
        if (!key) { auth = undefined; rememberAuthType("gemini-api-key"); return write({ id, result: {} }); }
        auth = { method: "gemini-api-key", key };
        loggedOut = false;
        rememberAuthType("gemini-api-key");
        return write({ id, result: {} });
      }
      if (fs.existsSync(tokenFile)) {
        auth = { method: "oauth-personal" };
        loggedOut = false;
        rememberAuthType("oauth-personal");
        return write({ id, result: {} });
      }
      process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?client_id=fake\n");
      const mode = process.env.FAKE_AGY_SIGN_IN || "approve";
      if (mode === "hang") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (mode === "deny") return write({ id, error: { code: -32000, message: "Onboarding failed: denied" } });
      fs.mkdirSync(acpDir, { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify({ token: "fake" }));
      rememberAuthType("oauth-personal");
      auth = { method: "oauth-personal" };
      loggedOut = false;
      return write({ id, result: {} });
    }
    case "logout":
      fs.rmSync(tokenFile, { force: true });
      fs.mkdirSync(acpDir, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify({}));
      auth = undefined;
      loggedOut = true;
      sessions.clear();
      return write({ id, result: {} });
    case "session/new": {
      if (!signedIn()) return write({ id, error: authRequired() });
      const sessionId = `5e55${String(sessions.size).padStart(4, "0")}-0000-4000-8000-${String(process.pid).padStart(12, "0").slice(-12)}`;
      sessions.set(sessionId, { cwd: params.cwd, level: "high" });
      remember(sessionId, params.cwd);
      return write({ id, result: sessionResult(sessionId) });
    }
    case "session/load": {
      if (!signedIn()) return write({ id, error: authRequired() });
      sessions.set(params.sessionId, { cwd: params.cwd, level: "high" });
      update(params.sessionId, { content: { type: "text", text: "Remember 41." }, sessionUpdate: "user_message_chunk" });
      update(params.sessionId, { content: { type: "text", text: "OK" }, sessionUpdate: "agent_message_chunk" });
      return write({ id, result: sessionResult(undefined) });
    }
    case "session/list":
      return write({ id, result: { sessions: [...sessions].map(([sessionId, value]) => ({ sessionId, cwd: value.cwd, title: `Session ${sessionId.slice(0, 8)}` })) } });
    case "session/set_config_option": {
      const session = sessions.get(params.sessionId);
      if (!session) return write({ id, error: { code: -32002, message: "Resource not found" } });
      if (params.configId === "thinking_level") session.level = params.value;
      if (params.configId === "model") {
        const family = families().find(([value]) => value === params.value);
        if (!family) return write({ id, error: { code: -32602, message: `Unknown model ${params.value}` } });
        session.family = family[0];
        if (!family[2].includes(session.level)) session.level = family[2][0];
      }
      return write({ id, result: { configOptions: configOptions(session.level, session.family) } });
    }
    case "session/set_mode":
      return write({ id, result: {} });
    case "session/cancel":
      cancelled.add(params.sessionId);
      return;
    case "session/prompt":
      return prompt(id, params);
    default:
      if (id !== undefined) write({ id, error: { code: -32601, message: "Method not found", data: { method } } });
  }
});
rl.on("close", () => process.exit(0));
