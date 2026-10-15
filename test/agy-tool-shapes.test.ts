/**
 * Antigravity's tool calls in the shapes the renderer reads, and invoke_subagent
 * as a subagent card. The frames are the ones Google's server 1.4.0 sent in a
 * live session (Gemini 3.8 Flash, Google sign-in, 2026-10-15), paths shortened;
 * the key-mode model ids are the 40 a real key was offered in gateway mode.
 */
import { describe, expect, it } from "vitest";
import {
  AgyBackend,
  AgyToolCallMerger,
  AgyToolCallShapes,
  agyKeyChatModels,
  agyToolNameFromTitle,
  isAgyKeyChatModel,
  normalizeAgyPermissionParams,
  normalizeAgySessionResponse,
  normalizeAgyUpdate,
} from "../src/agy-backend";

const WS = "C:/work/proj";

function run(frames: any[]): any[] {
  const shapes = new AgyToolCallShapes();
  const merger = new AgyToolCallMerger();
  return frames.map((frame) => normalizeAgyUpdate(frame, undefined, merger, shapes).update);
}

describe("Antigravity tool calls, normalised for the renderer", () => {
  it("names the tool from the title: awaiting approval, running, and a command's own line", () => {
    expect(["Run edit_file?", "Running view_file", "Running invoke_subagent", "Get-ChildItem", "Run edit_file", "github_list_issues"]
      .map(agyToolNameFromTitle)).toEqual(["edit_file", "view_file", "invoke_subagent", undefined, undefined, undefined]);
  });

  it("a command: its line and folder as command/cwd, a neutral title, and its output as output", () => {
    const id = "1582e01c751b443b9dbe7277c2bd4d37";
    const line = 'Get-ChildItem -Recurse -File -Exclude ".*" | Select-String "TODO"';
    const [pending, running, done] = run([
      { sessionUpdate: "tool_call", toolCallId: id, title: line, kind: "execute", status: "pending", rawInput: { CommandLine: line, Cwd: WS, WaitMsBeforeAsync: 5000 } },
      { sessionUpdate: "tool_call_update", toolCallId: id, title: line, kind: "execute", status: "in_progress", rawInput: { command_line: line, working_dir: WS } },
      { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { commandLine: line, workingDir: WS, exitCode: 0, exit_code: 0, combinedOutput: "\r\nsrc\\app.js:3:// TODO: tidy this up\r\n", formatted_output: "\r\nsrc\\app.js:3:// TODO: tidy this up\r\n" } },
    ]);
    expect(pending).toMatchObject({ tool: "run_command", title: "Run command", kind: "execute", rawInput: { CommandLine: line, command: line, cwd: WS } });
    expect(running).toMatchObject({ tool: "run_command", title: "Run command", rawInput: { command: line, cwd: WS } });
    expect(done).toMatchObject({ tool: "run_command", rawOutput: { output: "\r\nsrc\\app.js:3:// TODO: tidy this up\r\n", exit_code: 0 } });
    expect(done).not.toHaveProperty("title");
  });

  it("a read: the file and its line range where the renderer looks, in both spellings the server uses", () => {
    const [lower, upper] = run([
      { sessionUpdate: "tool_call", toolCallId: "call_576434", title: "Running view_file", kind: "read", status: "in_progress", rawInput: { absolute_path: `${WS}/src/app.js` }, locations: [{ path: `${WS}/src/app.js` }] },
      { sessionUpdate: "tool_call", toolCallId: "call_384298", title: "Running view_file", kind: "read", status: "in_progress", rawInput: { AbsolutePath: `${WS}/src/app.js`, StartLine: 1, EndLine: 2 } },
    ]);
    expect(lower).toMatchObject({ tool: "view_file", title: "Running view_file", rawInput: { file_path: `${WS}/src/app.js` } });
    expect(upper).toMatchObject({ tool: "view_file", rawInput: { file_path: `${WS}/src/app.js`, start_line: 1, end_line: 2 } });
  });

  it("an edit and a new file: the target as file_path, the diff untouched", () => {
    const diff = [{ type: "diff", path: `${WS}/src/app.js`, oldText: "const a = 1;", newText: "const a = 2;" }];
    const [edit, running] = run([
      { sessionUpdate: "tool_call", toolCallId: "785707b3", title: "Run edit_file?", kind: "edit", status: "pending", content: diff, locations: [{ path: `${WS}/src/app.js`, line: 1 }],
        rawInput: { TargetFile: `${WS}/src/app.js`, TargetContent: "const a = 1;", ReplacementContent: "const a = 2;", StartLine: 1, EndLine: 1 } },
      { sessionUpdate: "tool_call_update", toolCallId: "785707b3", title: "Running edit_file", kind: "edit", status: "in_progress", rawInput: { file_path: "C:\\work\\proj\\src\\app.js" } },
    ]);
    expect(edit).toMatchObject({ tool: "edit_file", content: diff, rawInput: { file_path: `${WS}/src/app.js` } });
    expect(running).toMatchObject({ tool: "edit_file", rawInput: { file_path: "C:\\work\\proj\\src\\app.js" } });
    const [create] = run([{ sessionUpdate: "tool_call", toolCallId: "b7ea9288", title: "Run create_file?", kind: "edit", status: "pending",
      rawInput: { CodeContent: "hello", Overwrite: true, TargetFile: `${WS}/hello.md` } }]);
    expect(create).toMatchObject({ tool: "write_file", rawInput: { file_path: `${WS}/hello.md` } });
  });

  it("a page read and a web search: the url and the query", () => {
    const [fetchCall, fetchRunning, search] = run([
      { sessionUpdate: "tool_call", toolCallId: "7543ce01", title: "Run read_url_content?", kind: "fetch", status: "pending", rawInput: { Url: "https://example.com" } },
      { sessionUpdate: "tool_call_update", toolCallId: "7543ce01", title: "Running read_url_content", kind: "fetch", status: "in_progress", rawInput: { url: "https://example.com", title: "", summary: "" } },
      { sessionUpdate: "tool_call", toolCallId: "19e39b22", title: "Run search_web?", kind: "search", status: "pending", rawInput: { query: "Agent Client Protocol specification" } },
    ]);
    expect(fetchCall).toMatchObject({ tool: "web_fetch", rawInput: { url: "https://example.com" } });
    expect(fetchRunning).toMatchObject({ tool: "web_fetch", rawInput: { url: "https://example.com" } });
    expect(search).toMatchObject({ tool: "search_web", rawInput: { query: "Agent Client Protocol specification" } });
  });

  // Not registered for the account the capture ran under ("list_dir,
  // grep_search and find_by_name are not registered tools in this
  // environment"), so these follow the field names the server's own location
  // helper reads (tools.py `extract_tool_locations`).
  it("a listing, a grep and a file search, by the server's own field names", () => {
    const [list, grep, find] = run([
      { sessionUpdate: "tool_call", toolCallId: "l1", title: "Running list_dir", kind: "search", status: "in_progress", rawInput: { DirectoryPath: WS } },
      { sessionUpdate: "tool_call", toolCallId: "g1", title: "Running grep_search", kind: "search", status: "in_progress", rawInput: { Query: "TODO", SearchPath: WS } },
      { sessionUpdate: "tool_call", toolCallId: "f1", title: "Running find_by_name", kind: "search", status: "in_progress", rawInput: { Pattern: "*.txt", SearchDirectory: WS } },
    ]);
    expect(list).toMatchObject({ tool: "list_dir", rawInput: { target_directory: WS } });
    expect(grep).toMatchObject({ tool: "grep", rawInput: { pattern: "TODO", path: WS } });
    expect(find).toMatchObject({ tool: "search_files", rawInput: { pattern: "*.txt", path: WS } });
  });

  it("reads replayed history's arguments, which arrive as the JSON text the model wrote", () => {
    const [replayed] = run([{ sessionUpdate: "tool_call", toolCallId: "step_7", title: "Running view_file", kind: "read", status: "completed",
      rawInput: JSON.stringify({ AbsolutePath: `${WS}/notes.txt` }) }]);
    expect(replayed).toMatchObject({ tool: "view_file", rawInput: { AbsolutePath: `${WS}/notes.txt`, file_path: `${WS}/notes.txt` } });
  });

  it("leaves an MCP tool and anything it cannot name as the server sent it", () => {
    const mcp = { sessionUpdate: "tool_call", toolCallId: "m1", title: "github_list_issues", kind: "other", status: "in_progress", rawInput: { repo: "x" }, _meta: { is_mcp_tool_call: true } };
    expect(run([mcp])[0]).toEqual(mcp);
  });

  it("puts the command where an approval card reads it, keeping the server's title", () => {
    const params = { sessionId: "s", toolCall: { toolCallId: "c", kind: "execute", status: "pending", title: "node --version", rawInput: { CommandLine: "node --version", Cwd: WS } }, options: [] };
    expect(normalizeAgyPermissionParams(params).toolCall).toMatchObject({ title: "node --version", rawInput: { command: "node --version", cwd: WS } });
  });
});

describe("Antigravity subagents, as subagent cards", () => {
  const launch = { Subagents: [{ Model: "inherit", Prompt: "List the files and read notes.txt.", Role: "Project File Reader", TypeName: "research", Workspace: "inherit" }] };

  it("shows the role and the task, and says the work is in the background: the server reports nothing after the launch", () => {
    const id = "24ac72049c3b49ecac09e055152210cf";
    const [pending, running, done, child] = run([
      { sessionUpdate: "tool_call", toolCallId: id, title: "Run invoke_subagent?", kind: "other", status: "pending", rawInput: launch },
      { sessionUpdate: "tool_call_update", toolCallId: id, title: "Running invoke_subagent", kind: "other", status: "in_progress", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: "Invoke subagent" },
      { sessionUpdate: "tool_call", toolCallId: "call_636537", title: "Running view_file", kind: "read", status: "in_progress", rawInput: { absolute_path: `${WS}/notes.txt` } },
    ]);
    expect(pending).toMatchObject({ kind: "subagent", tool: "invoke_subagent", title: "Project File Reader",
      rawInput: { description: "Project File Reader", prompt: "List the files and read notes.txt.", subagent_type: "research" } });
    // The running update must not blank the card's title or task.
    expect(running).toMatchObject({ kind: "subagent", status: "in_progress" });
    expect(running).not.toHaveProperty("title");
    expect(running).not.toHaveProperty("rawInput");
    // "Invoke subagent" is the model's own summary of the call, not a result.
    expect(done).toMatchObject({ kind: "subagent", status: "background", rawOutput: { output: "" } });
    // The child's call has nothing that ties it to the card, so it is an ordinary row.
    expect(child).toMatchObject({ tool: "view_file", kind: "read" });
  });

  it("settles a replayed subagent as done, and names several children by the first", () => {
    const [replayed, result] = run([
      { sessionUpdate: "tool_call", toolCallId: "step_3", title: "Running invoke_subagent", kind: "other", status: "completed",
        rawInput: JSON.stringify({ Subagents: [...launch.Subagents, { Role: "Line Counter", Prompt: "Count README.md lines." }] }) },
      { sessionUpdate: "tool_call_update", toolCallId: "step_3", status: "completed", rawOutput: "Invoke subagent" },
    ]);
    expect(replayed).toMatchObject({ kind: "subagent", title: "Project File Reader and 1 more",
      rawInput: { prompt: "List the files and read notes.txt.\n\nCount README.md lines." } });
    expect(result).toMatchObject({ status: "completed", rawOutput: { output: "" } });
  });
});

describe("Antigravity's key-mode model catalog", () => {
  // The MODELS line of a live gateway session with a real key.
  const OFFERED = "gemini-2.5-flash, gemini-2.5-pro, gemini-2.5-flash-preview-tts, gemini-2.5-pro-preview-tts, gemma-4-26b-a4b-it, gemma-4-31b-it, gemini-flash-latest, gemini-flash-lite-latest, gemini-pro-latest, gemini-2.5-flash-lite, gemini-3-flash-preview, gemini-3.1-pro-preview, gemini-3.1-pro-preview-customtools, gemini-3.1-flash-lite-preview, gemini-3.1-flash-lite, nano-banana-pro-preview, gemini-nano-banana-2.1, gemini-3.5-flash, gemini-3.5-flash-lite, gemini-omni-flash-preview, gemini-omni-1.1-flash, gemini-3.5-transcribe, gemini-3.6-flash, gemini-3.7-flash, gemini-3.8-flash, gemini-4-argon, lyria-3-clip-preview, lyria-3-pro-preview, lyria-3.5, gemini-3.1-flash-tts-preview, gemini-3.8-flash-tts, gemini-3.8-flash-lite-tts, gemini-robotics-er-2-preview, gemini-2.5-computer-use-preview-10-2025, antigravity-preview-05-2026, antigravity-preview-09-2026, antigravity-preview-latest, deep-research-max-preview-04-2026, deep-research-preview-04-2026, deep-research-pro-preview-12-2025".split(", ");

  it("keeps the Gemini chat models, newest first", () => {
    expect(OFFERED).toHaveLength(40);
    expect(agyKeyChatModels(OFFERED.map((modelId) => ({ modelId }))).map((model) => model.modelId)).toEqual([
      "gemini-4-argon", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite",
      "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools", "gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite",
      "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite",
    ]);
    for (const dropped of ["gemini-2.5-flash-preview-tts", "gemma-4-31b-it", "gemini-flash-latest", "gemini-nano-banana-2.1", "gemini-omni-1.1-flash",
      "gemini-3.5-transcribe", "lyria-3.5", "gemini-robotics-er-2-preview", "gemini-2.5-computer-use-preview-10-2025", "antigravity-preview-latest",
      "deep-research-preview-04-2026", "gemini-3.1-flash-image", "gemini-live-2.5-flash"]) {
      expect(isAgyKeyChatModel(dropped)).toBe(false);
    }
  });

  it("never drops the model in use, and filters only in key mode", () => {
    expect(agyKeyChatModels([{ modelId: "gemma-4-31b-it" }, { modelId: "gemini-3.8-flash" }], "gemma-4-31b-it").map((m) => m.modelId))
      .toEqual(["gemini-3.8-flash", "gemma-4-31b-it"]);
    const response = { sessionId: "s", configOptions: [
      { id: "model", currentValue: "gemini-2.5-flash", options: ["gemini-2.5-flash", "gemini-2.5-flash-preview-tts", "gemini-4-argon"].map((value) => ({ value, name: value })) },
      { id: "mode", currentValue: "default", options: [] },
    ] };
    expect(normalizeAgySessionResponse(response, true).models.availableModels.map((m: any) => m.modelId)).toEqual(["gemini-4-argon", "gemini-2.5-flash"]);
    expect(normalizeAgySessionResponse(response).models.availableModels.map((m: any) => m.modelId)).toHaveLength(3);
  });

  it("starts a key's conversation on Gemini 4 Argon, and offers no effort where the server has no thinking_level", () => {
    const keyed = new AgyBackend({ keyMode: true });
    expect(keyed.defaultModelId(["gemini-2.5-flash", "gemini-4-argon"])).toBe("gemini-4-argon");
    expect(keyed.defaultModelId(["gemini-2.5-flash"])).toBeUndefined();
    expect(new AgyBackend().defaultModelId(["gemini-4-argon"])).toBeUndefined();
    keyed.normalizeSessionResponse({ sessionId: "s", configOptions: [{ id: "model", currentValue: "gemini-4-argon", options: [{ value: "gemini-4-argon" }] }] });
    expect(keyed.setReasoningEffort("s", "gemini-4-argon", "high")).toBeNull();
    const google = new AgyBackend();
    google.normalizeSessionResponse({ sessionId: "s", configOptions: [{ id: "model", currentValue: "gemini-3.8-flash", options: [{ value: "gemini-3.8-flash" }] },
      { id: "thinking_level", currentValue: "high", options: [{ value: "low" }, { value: "high" }] }] });
    expect(google.setReasoningEffort("s", "gemini-3.8-flash", "high")).toEqual({ method: "session/set_config_option", params: { sessionId: "s", configId: "thinking_level", value: "high" } });
  });
});
