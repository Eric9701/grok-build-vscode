import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AcpBackend,
  BackendConfigState,
  BackendSessionListEntry,
  BackendSessionListResult,
  BackendSpawnOptions,
  BackendSpawnSpec,
  BackendUpdate,
} from "./acp-backend";

/**
 * Google's Antigravity ACP server (`agy_acp_server`), spawned directly: it
 * speaks ACP itself, so unlike Codex, Claude and Muse there is no adapter in
 * between. Everything here is measured against server 1.4.0; the evidence is in
 * research/antigravity-acp.md.
 */

/** `GEMINI_HOME`, else `~/.gemini` -- the same resolution the server uses. */
export function agyGeminiHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const explicit = env.GEMINI_HOME?.trim();
  if (!explicit) return path.join(home, ".gemini");
  return explicit === "~" || explicit.startsWith("~/") || explicit.startsWith("~\\")
    ? path.join(home, explicit.slice(1))
    : explicit;
}

/** The server's private directory: settings, token, conversations. */
export function agyAcpDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(agyGeminiHome(env, home), "antigravity-acp");
}

/**
 * The server's harness sorts workspace roots alphabetically and treats the
 * first as the command directory. It is handed the project plus skill folders
 * under `~/.gemini`, so any project under the home folder lost to the skills
 * folder and commands ran there. The server's own system-prompt append moves
 * the agent back. It is prompt-level, so `scripts/acp-smoke.mjs` asserts a
 * command's `Cwd` live.
 */
export function agyWorkingFolderPrompt(cwd: string): string {
  return `The project folder for this session is ${cwd}. It is your working directory: run every command with its working directory set to this folder, and create or edit files inside it unless the user names another location. The other workspace folders listed in your context hold skills only.`;
}

export function agySessionParams(cwd: string): Record<string, unknown> {
  return { _meta: { antigravity: { systemPrompt: { append: agyWorkingFolderPrompt(cwd) } } } };
}

/** Linux builds take an (empty) `--uid=`, per the ACP registry entry. */
export function agyServerArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "linux" ? ["--uid="] : [];
}

/** Our effort ladder onto the server's `thinking_level`. */
export function agyThinkingLevel(level: string): "low" | "medium" | "high" | undefined {
  if (level === "none" || level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "high" || level === "xhigh") return "high";
  return undefined;
}

function optionValue(option: any): unknown {
  return option?.currentValue ?? option?.value;
}

function optionValues(option: any): any[] {
  return Array.isArray(option?.options) ? option.options : [];
}

function configOption(configOptions: unknown, id: string): any {
  return Array.isArray(configOptions) ? configOptions.find((option) => option?.id === id) : undefined;
}

/** The server's own order for a thinking-level picker, least thinking first. */
const LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "extra_high", "max"];

/**
 * One row per model family, effort as its level. The server lists every
 * variant as a model (`gemini-3.8-flash-high`, `-medium`, `-low`, ...) but its
 * `configOptions` describe a family with a `thinking_level` -- the shape the
 * host's picker already has for every other provider. A family's levels come
 * from the variants listed for it, because `thinking_level` only lists the
 * CURRENT family's (Gemini 3.1 Pro has high and low, the Flash models three);
 * a family with no listed variants falls back to the current option's levels.
 */
export function modelsFromAgyConfigOptions(
  configOptions: unknown,
  variantIds: readonly string[] = [],
): { currentModelId?: string; availableModels: any[] } {
  const model = configOption(configOptions, "model");
  const thinking = configOption(configOptions, "thinking_level");
  const currentModelId = typeof optionValue(model) === "string" ? optionValue(model) as string : undefined;
  const currentLevel = typeof optionValue(thinking) === "string" ? optionValue(thinking) as string : undefined;
  const currentLevels = optionValues(thinking).map((entry) => entry?.value).filter((value): value is string => typeof value === "string");
  const levelsOf = (family: string): string[] => {
    const listed = variantIds
      .filter((id) => id.startsWith(`${family}-`) && LEVEL_ORDER.includes(id.slice(family.length + 1)))
      .map((id) => id.slice(family.length + 1));
    if (!listed.length) return family === currentModelId ? currentLevels : [];
    return [...new Set(listed)].sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
  };
  return {
    currentModelId,
    availableModels: optionValues(model).flatMap((entry) => {
      const modelId = typeof entry?.value === "string" ? entry.value : "";
      if (!modelId) return [];
      const levels = levelsOf(modelId);
      return [{
        modelId,
        name: typeof entry?.name === "string" && entry.name.trim() ? entry.name : modelId,
        _meta: {
          supportsReasoningEffort: levels.length > 0,
          reasoningEfforts: levels.map((value) => ({ value })),
          ...(modelId === currentModelId && currentLevel ? { reasoningEffort: currentLevel } : {}),
        },
      }];
    }),
  };
}

export function normalizeAgySessionResponse(response: any): any {
  if (!response || typeof response !== "object") return response;
  const variantIds = Array.isArray(response.models?.availableModels)
    ? response.models.availableModels.map((entry: any) => entry?.modelId).filter((id: unknown): id is string => typeof id === "string")
    : [];
  const models = modelsFromAgyConfigOptions(response.configOptions, variantIds);
  if (!models.availableModels.length) return response;
  return { ...response, models };
}

export function configStateFromAgyOptions(response: any, fallback: BackendConfigState): BackendConfigState {
  const model = optionValue(configOption(response?.configOptions, "model"));
  const level = optionValue(configOption(response?.configOptions, "thinking_level"));
  return {
    modelId: typeof model === "string" ? model : fallback.modelId,
    reasoningEffort: typeof level === "string" ? level : fallback.reasoningEffort,
    modeId: fallback.modeId,
  };
}

/**
 * Google refusing the credential DURING a turn. The server does not fail the
 * prompt for it: it sends the API's message as agent text (`format_execution_
 * error`) and ends the turn, so the session would otherwise sit there looking
 * fine. These are the Gemini API's own wordings for a bad, expired or missing
 * key and a refused token. Unverified against a live bad key.
 *
 * Anchored to the start of the chunk: that error is one chunk that is the
 * whole message (the API's own sentence, or `Agent execution error: ...` when
 * it does not parse), while an agent explaining an "API key not valid" error in
 * someone's code says it mid-reply, and must not reopen the sign-in.
 */
const REJECTED_CREDENTIAL = /^\s*(?:API key not valid\b|API key expired\b|Request had invalid authentication credentials\b|Method doesn't allow unregistered callers\b|Agent execution error:.*\b(?:API_KEY_INVALID|API_KEY_EXPIRED|UNAUTHENTICATED)\b)/s;

export function isAgyRejectedCredentialText(text: unknown): boolean {
  return typeof text === "string" && REJECTED_CREDENTIAL.test(text);
}

/** `-32000` is the server's auth-required code and nothing else uses it. */
export function isAgyCredentialError(error: unknown): boolean {
  const value = error as any;
  if (value?.code === -32000) return true;
  const message = String(value?.message ?? value?.data?.message ?? value ?? "");
  return /authentication required|auth[_ ]required|onboarding failed|logged out\. sign in again/i.test(message);
}

/** Commands this host must not offer: `/logout` would sign the account out
 *  behind the host's back, and `/plan` waits for a "Proceed" click ACP cannot
 *  deliver. */
const HIDDEN_COMMANDS = new Set(["logout", "plan"]);

function updatePaths(update: any): string[] {
  const out: string[] = [];
  for (const location of Array.isArray(update?.locations) ? update.locations : []) {
    if (typeof location?.path === "string") out.push(location.path);
  }
  for (const block of Array.isArray(update?.content) ? update.content : []) {
    if (block?.type === "diff" && typeof block.path === "string") out.push(block.path);
  }
  return [...new Set(out.map((value) => value.replace(/\\/g, "/").toLowerCase()))];
}

function outputText(update: any): string {
  const raw = update?.rawOutput;
  return typeof raw === "string" ? raw : typeof raw?.output === "string" ? raw.output : "";
}

/**
 * The server reports an approved edit twice: once as the call the user
 * approved ("Run create_file?", with the diff), then again under a new id
 * (`<sessionId>:<n>`, "Running edit_file") that is the one which actually
 * runs. At the end of the turn it sweeps the first as `failed` -- "Tool call
 * was approved but never executed." -- so, left alone, every approved edit
 * leaves a red card beside a green one. The executing call is folded into the
 * approved card instead: its progress moves the approved card, and the sweep
 * is dropped for a card whose execution was seen.
 */
export class AgyToolCallMerger {
  private pendingEdits: { id: string; paths: string[] }[] = [];
  private readonly aliases = new Map<string, string>();
  private readonly absorbed = new Set<string>();

  accept(update: any): any | undefined {
    const id = update?.toolCallId;
    if (typeof id !== "string") return update;
    if (update.sessionUpdate === "tool_call") {
      if (update.kind === "edit" && update.status === "pending") {
        this.pendingEdits.push({ id, paths: updatePaths(update) });
        return update;
      }
      if (update.kind === "edit" && !this.aliases.has(id) && !this.pendingEdits.some((edit) => edit.id === id)) {
        const approved = this.claim(updatePaths(update));
        if (approved) {
          this.aliases.set(id, approved);
          this.absorbed.add(approved);
          // Progress only: the approved card keeps its title, diff and paths.
          return { sessionUpdate: "tool_call_update", toolCallId: approved, status: update.status ?? "in_progress" };
        }
      }
      return update;
    }
    if (update.sessionUpdate !== "tool_call_update") return update;
    const approved = this.aliases.get(id);
    if (approved) return { ...update, toolCallId: approved };
    if (this.absorbed.has(id) && update.status === "failed" && /approved but never executed/i.test(outputText(update))) {
      return undefined;
    }
    if (update.status === "completed" || update.status === "failed" || update.status === "cancelled") {
      this.pendingEdits = this.pendingEdits.filter((edit) => edit.id !== id);
    }
    return update;
  }

  /** The approved edit an executing one belongs to: the same file, or -- when
   *  either side names none -- the only edit awaiting execution. */
  private claim(paths: readonly string[]): string | undefined {
    let index = this.pendingEdits.findIndex((edit) => edit.paths.some((value) => paths.includes(value)));
    if (index < 0 && this.pendingEdits.length === 1 && (!paths.length || !this.pendingEdits[0].paths.length)) index = 0;
    if (index < 0) return undefined;
    const [edit] = this.pendingEdits.splice(index, 1);
    return edit.id;
  }
}

export function normalizeAgyUpdate(update: any, meta: any, toolCalls: AgyToolCallMerger): BackendUpdate {
  if (!update || typeof update !== "object") return { update, meta };
  if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
    return { update: { ...update, availableCommands: update.availableCommands.filter((command: any) => !HIDDEN_COMMANDS.has(command?.name)) }, meta };
  }
  // The server's own approval modes are not this host's modes: Agent and Auto
  // accept are answered here, so a server mode change has nothing to update.
  if (update.sessionUpdate === "current_mode_update") return { meta };
  if (update.sessionUpdate === "usage_update") {
    return { update, meta, contextUsed: update.used, contextWindow: update.size };
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const merged = toolCalls.accept(update);
    return merged ? { update: merged, meta } : { meta };
  }
  if (update.sessionUpdate === "agent_message_chunk" && isAgyRejectedCredentialText(update.content?.text)) {
    return { update, meta, credentialRejected: true };
  }
  return { update, meta };
}

export function agySessionPathKey(value: string, platform: NodeJS.Platform): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  const resolved = api.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export type AgyRun = (command: string, args: string[]) => Promise<string>;

const runQuietly: AgyRun = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { windowsHide: true, timeout: 8_000 }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
});

/**
 * Stop the Windows server so it cleans up after itself.
 *
 * The Windows build is a PyInstaller one-file program: a bootloader unpacks
 * about 300 MB into `%TEMP%\_MEI*` on every start and deletes it when its
 * Python child exits. Closing stdin does not stop the server, and killing the
 * bootloader (or the whole tree) skips the delete, so every conversation used
 * to leave 300 MB behind. Killing the bootloader's child tree instead -- the
 * Python process, and the harness under it -- lets the bootloader finish its
 * cleanup and exit on its own. Only children carrying the server's own image
 * name are touched, so a recycled pid cannot take an unrelated process down.
 */
export async function stopAgyServerTree(pid: number, command: string, run: AgyRun = runQuietly): Promise<void> {
  const image = path.win32.basename(command).replace(/'/g, "");
  const listing = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Math.trunc(pid)} AND Name='${image}'" | ForEach-Object { $_.ProcessId }`]);
  for (const child of listing.split(/\s+/).filter((value) => /^\d+$/.test(value))) {
    await run("taskkill", ["/PID", child, "/T", "/F"]).catch(() => undefined);
  }
}

export interface AgyHistoryFs {
  readDir(dir: string): string[];
  readFile(file: string): string;
  /** When a file last changed, or undefined if it cannot be read. */
  modifiedAt(file: string): number | undefined;
}

const realHistoryFs: AgyHistoryFs = {
  readDir: (dir) => fs.readdirSync(dir),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  modifiedAt: (file) => { try { return fs.statSync(file).mtimeMs; } catch { return undefined; } },
};

/**
 * The conversations for one project, read the way the server's own
 * `session/list` reads them: a `<id>.db` transcript per conversation, and a
 * `<id>.meta` sidecar naming the folder it belongs to.
 *
 * Read here rather than asked for, because that RPC is only a directory
 * listing, and asking means starting a server -- 15-25 s and a 300 MB unpack
 * on Windows -- to read a directory. It also gives what the RPC lacks: recency
 * (the transcript's mtime) and a folder match that ignores Windows case, where
 * the RPC compares strings exactly. Titles are left to the host: the server's
 * are placeholders.
 */
export function listAgySessions(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  options: { env?: NodeJS.ProcessEnv; home?: string; fs?: AgyHistoryFs } = {},
): BackendSessionListEntry[] {
  const io = options.fs ?? realHistoryFs;
  const dir = path.join(agyAcpDir(options.env, options.home), "conversations");
  let names: string[];
  try { names = io.readDir(dir); } catch { return []; }
  const target = agySessionPathKey(cwd, platform);
  const sessions: BackendSessionListEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".db")) continue;
    const sessionId = name.slice(0, -3);
    let sessionCwd: unknown;
    try { sessionCwd = JSON.parse(io.readFile(path.join(dir, `${sessionId}.meta`)))?.cwd; } catch { continue; }
    if (typeof sessionCwd !== "string" || agySessionPathKey(sessionCwd, platform) !== target) continue;
    const updatedAt = io.modifiedAt(path.join(dir, name));
    sessions.push({ sessionId, cwd: sessionCwd, ...(updatedAt !== undefined ? { updatedAt } : {}) });
  }
  return sessions;
}

export interface AgyBackendOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  fs?: AgyHistoryFs;
  run?: AgyRun;
}

export class AgyBackend implements AcpBackend<"agy"> {
  readonly provider = "agy" as const;
  readonly processName = "Antigravity ACP server";
  readonly usesClientPlanGate = false;
  private readonly toolCalls = new AgyToolCallMerger();

  constructor(private readonly options: AgyBackendOptions = {}) {}

  spawn(options: BackendSpawnOptions): BackendSpawnSpec {
    const args = agyServerArgs(this.options.platform ?? process.platform);
    // A script server (the test fixture, or a user's wrapper) runs under Node.
    if (/\.[cm]?js$/i.test(options.cliPath)) {
      return { command: process.execPath, args: [options.cliPath, ...args], env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" }, shell: false };
    }
    return { command: options.cliPath, args, env: { ...options.env }, shell: false };
  }

  sessionParams(cwd: string): Record<string, unknown> { return agySessionParams(cwd); }

  async stopProcess(pid: number, command: string): Promise<void> {
    if ((this.options.platform ?? process.platform) !== "win32" || !/\.exe$/i.test(command)) return;
    await stopAgyServerTree(pid, command, this.options.run);
  }
  normalizeSessionResponse(response: any): any { return normalizeAgySessionResponse(response); }
  normalizePromptResult(result: any): any { return result; }
  normalizeUpdate(update: any, meta: any): BackendUpdate { return normalizeAgyUpdate(update, meta, this.toolCalls); }
  normalizePermissionParams(params: any): any { return params; }

  setModel(sessionId: string, modelId: string): { method: string; params: any } {
    return { method: "session/set_config_option", params: { sessionId, configId: "model", value: modelId } };
  }

  setReasoningEffort(sessionId: string, _modelId: string | undefined, level: string): { method: string; params: any } | null {
    const value = agyThinkingLevel(level);
    return value ? { method: "session/set_config_option", params: { sessionId, configId: "thinking_level", value } } : null;
  }

  setMode(sessionId: string, modeId: string): { method: string; params: any } {
    if (modeId !== "agent" && modeId !== "yolo") throw new Error("Antigravity does not offer Plan mode.");
    return { method: "session/set_mode", params: { sessionId, modeId: modeId === "agent" ? "default" : "yolo" } };
  }

  steeringCapabilities() { return { supported: false, acceptsContent: false }; }
  interject(): null { return null; }
  steerDelivered(): boolean { return false; }
  configState(response: any, fallback: BackendConfigState): BackendConfigState { return configStateFromAgyOptions(response, fallback); }
  modelSetSucceeded(): boolean { return true; }

  /** From disk, never through the server; see {@link listAgySessions}. */
  async listSessions(
    _request: (method: string, params: any) => Promise<any>,
    cwd: string,
    platform: NodeJS.Platform,
  ): Promise<BackendSessionListResult> {
    return { sessions: listAgySessions(cwd, platform, this.options), nextCursor: null };
  }

  isCredentialError(error: unknown): boolean { return isAgyCredentialError(error); }
}
