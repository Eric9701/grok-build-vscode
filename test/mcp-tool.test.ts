import { describe, expect, it } from "vitest";
import { MAX_COMMAND_OUTPUT_CHARS } from "../src/acp-dispatch";
import {
  EMPTY_MCP_ARGS,
  createMcpPrepareState,
  extractMcpInput,
  extractMcpOutput,
  formatMcpArgs,
  isHiddenMcpRow,
  isMcpToolCall,
  mcpCommandOutput,
  prepareMcpToolCall,
} from "../src/mcp-tool";

const ARGS = { message: "MCPSHAPE_9931" };
const IN = JSON.stringify(ARGS, null, 2);
const OUT = "Echo: MCPSHAPE_9931";

const grokSearch = {
  sessionUpdate: "tool_call",
  toolCallId: "call-search-0",
  title: "search_tool",
  rawInput: { query: "everything echo", limit: 5 },
  _meta: { "x.ai/tool": { name: "search_tool", kind: "search_tool" } },
};

const grokSearchUpdate = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-search-0",
  kind: "other",
  title: "Search tools: \"everything echo\"",
  rawInput: { variant: "SearchTool", query: "everything echo", limit: 5 },
  _meta: { "x.ai/tool": { name: "search_tool", kind: "search_tool" } },
};

const grokSearchDone = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-search-0",
  status: "completed",
  rawOutput: { type: "SearchTool", result_count: 5, content: "{}" },
};

const grokUse = {
  sessionUpdate: "tool_call",
  toolCallId: "call-use-1",
  title: "use_tool",
  rawInput: { tool_name: "everything__echo", tool_input: ARGS },
  _meta: { "x.ai/tool": { name: "use_tool", kind: "use_tool" } },
};

const grokUseUpdate = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-use-1",
  kind: "other",
  title: "everything__echo",
  rawInput: { variant: "UseTool", tool_name: "everything__echo", tool_input: ARGS },
  _meta: { "x.ai/tool": { name: "use_tool", kind: "use_tool" } },
};

const grokUseDone = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-use-1",
  status: "completed",
  rawOutput: {
    type: "MCP",
    tool_name: "echo",
    server_name: "everything",
    output: { OkayOutput: OUT },
  },
};

const codexStartup = {
  sessionUpdate: "tool_call",
  toolCallId: "mcp_startup.everything",
  kind: "other",
  title: "mcp__everything__startup",
  status: "failed",
  content: [{
    type: "content",
    content: {
      type: "text",
      text: "[codex-acp forwarded startup error] MCP server `everything` startup was cancelled.",
    },
  }],
};

const codexCall = {
  sessionUpdate: "tool_call",
  toolCallId: "exec-mcp-1",
  kind: "execute",
  title: "mcp.everything.echo",
  status: "in_progress",
  rawInput: { server: "everything", tool: "echo", arguments: ARGS },
  _meta: { is_mcp_tool_call: true },
};

const codexDone = {
  sessionUpdate: "tool_call_update",
  toolCallId: "exec-mcp-1",
  status: "completed",
  rawInput: { server: "everything", tool: "echo", arguments: ARGS },
  rawOutput: {
    result: {
      content: [{ type: "text", text: OUT }],
      structuredContent: null,
      _meta: null,
    },
    error: null,
  },
};

const claudePending = {
  sessionUpdate: "tool_call",
  toolCallId: "toolu_mcp_1",
  rawInput: {},
  status: "pending",
  title: "mcp__everything__echo",
  kind: "other",
  _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
};

const claudeArgs = {
  sessionUpdate: "tool_call_update",
  toolCallId: "toolu_mcp_1",
  rawInput: ARGS,
  title: "mcp__everything__echo",
  kind: "other",
  _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
};

const claudeDone = {
  sessionUpdate: "tool_call_update",
  toolCallId: "toolu_mcp_1",
  status: "completed",
  rawOutput: [{ type: "text", text: OUT }],
  content: [{ type: "content", content: { type: "text", text: OUT } }],
  _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
};

const shell = {
  sessionUpdate: "tool_call",
  toolCallId: "cmd-1",
  kind: "execute",
  title: "Run echo hi",
  rawInput: { command: "echo hi" },
};

describe("formatMcpArgs", () => {
  it("pretty-prints objects, including empty, and rejects non-objects", () => {
    expect(formatMcpArgs(ARGS)).toBe(IN);
    expect(formatMcpArgs({})).toBe(EMPTY_MCP_ARGS);
    expect(formatMcpArgs(null)).toBeNull();
    expect(formatMcpArgs("x")).toBeNull();
    expect(formatMcpArgs(["x"])).toBeNull();
  });
});

describe("hidden MCP rows", () => {
  it("hides grok search_tool on the initial call, the titled update, and the SearchTool result", () => {
    expect(isHiddenMcpRow(grokSearch)).toBe(true);
    expect(isHiddenMcpRow(grokSearchUpdate)).toBe(true);
    expect(isHiddenMcpRow(grokSearchDone)).toBe(true);
    expect(isMcpToolCall(grokSearch)).toBe(false);
  });

  it("hides Codex's failed mcp__<server>__startup row", () => {
    expect(isHiddenMcpRow(codexStartup)).toBe(true);
    expect(isMcpToolCall(codexStartup)).toBe(false);
  });

  it("does not hide a successful MCP call or a shell command", () => {
    expect(isHiddenMcpRow(grokUse)).toBe(false);
    expect(isHiddenMcpRow(codexCall)).toBe(false);
    expect(isHiddenMcpRow(claudePending)).toBe(false);
    expect(isHiddenMcpRow(shell)).toBe(false);
  });
});

describe("grok use_tool IN/OUT", () => {
  it("reads tool_input and OkayOutput, not content", () => {
    expect(isMcpToolCall(grokUse)).toBe(true);
    expect(extractMcpInput(grokUse)).toBe(IN);
    expect(extractMcpInput(grokUseUpdate)).toBe(IN);
    expect(extractMcpOutput(grokUse)).toBeNull();
    expect(extractMcpOutput(grokUseDone)).toEqual({ output: OUT, truncated: false });
    expect(extractMcpOutput({
      ...grokUseDone,
      rawOutput: { type: "MCP", output: { ErrorOutput: "nope" } },
    })).toBeNull();
  });
});

describe("codex MCP IN/OUT", () => {
  it("reads arguments and result.content[].text", () => {
    expect(isMcpToolCall(codexCall)).toBe(true);
    expect(extractMcpInput(codexCall)).toBe(IN);
    expect(extractMcpOutput(codexCall)).toBeNull();
    expect(extractMcpOutput(codexDone)).toEqual({ output: OUT, truncated: false });
    expect(extractMcpOutput({
      ...codexDone,
      rawOutput: { result: { content: [{ type: "text", text: OUT }] }, error: "boom" },
    })).toBeNull();
    expect(extractMcpOutput({
      ...codexDone,
      rawOutput: { result: { content: [{ type: "image", data: "x" }] }, error: null },
    })).toBeNull();
  });
});

describe("claude MCP pending-then-filled", () => {
  it("treats empty rawInput as pending and fills IN from the later flat args", () => {
    expect(isMcpToolCall(claudePending)).toBe(true);
    expect(extractMcpInput(claudePending)).toBeNull();
    expect(extractMcpInput(claudeArgs)).toBe(IN);
    expect(extractMcpOutput(claudeArgs)).toBeNull();
    expect(extractMcpOutput(claudeDone)).toEqual({ output: OUT, truncated: false });
  });

  it("does not treat Claude ToolSearch as an MCP invocation", () => {
    const search = {
      title: "ToolSearch",
      rawInput: { query: "select:mcp__everything__echo" },
      _meta: { claudeCode: { toolName: "ToolSearch" } },
    };
    expect(isMcpToolCall(search)).toBe(false);
    expect(isHiddenMcpRow(search)).toBe(false);
    expect(extractMcpInput(search)).toBeNull();
  });
});

describe("shell rows stay untouched", () => {
  it("does not classify or extract a command row as MCP", () => {
    expect(isMcpToolCall(shell)).toBe(false);
    expect(extractMcpInput(shell)).toBeNull();
    expect(extractMcpOutput({
      ...shell,
      rawOutput: { type: "Bash", output: "hi\n", exit_code: 0 },
    })).toBeNull();
  });
});

describe("100K display cap", () => {
  it("caps MCP OUT the same way as shell commandOutput", () => {
    const huge = "x".repeat(MAX_COMMAND_OUTPUT_CHARS + 25);
    const capped = extractMcpOutput({
      ...grokUseDone,
      rawOutput: { type: "MCP", output: { OkayOutput: huge } },
    });
    expect(capped?.output).toHaveLength(MAX_COMMAND_OUTPUT_CHARS);
    expect(capped?.truncated).toBe(true);
    expect(mcpCommandOutput({
      ...claudeDone,
      rawOutput: [{ type: "text", text: huge }],
    }, IN, "toolu_mcp_1")).toEqual({
      command: IN,
      toolCallId: "toolu_mcp_1",
      output: huge.slice(0, MAX_COMMAND_OUTPUT_CHARS),
      exitCode: null,
      truncated: true,
      cancelled: false,
    });
    expect(mcpCommandOutput(claudeDone, IN, "")).toBeNull();
  });
});

describe("prepareMcpToolCall", () => {
  it("drops grok search_tool for the whole id, including a later update without the name", () => {
    const state = createMcpPrepareState();
    expect(prepareMcpToolCall(grokSearch, state)).toEqual({ action: "hide" });
    expect(prepareMcpToolCall(grokSearchUpdate, state).action).toBe("hide");
    expect(prepareMcpToolCall(grokSearchDone, state).action).toBe("hide");
  });

  it("drops the Codex startup-failure row and still emits the real call", () => {
    const state = createMcpPrepareState();
    expect(prepareMcpToolCall(codexStartup, state)).toEqual({ action: "hide" });
    const first = prepareMcpToolCall(codexCall, state);
    expect(first.action).toBe("emit");
    if (first.action !== "emit") return;
    expect(first.call.detailInput).toBe(IN);
    expect(first.commandOutput).toBeNull();
    const done = prepareMcpToolCall(codexDone, state);
    expect(done.action).toBe("emit");
    if (done.action !== "emit") return;
    expect(done.commandOutput).toEqual({
      command: IN,
      toolCallId: "exec-mcp-1",
      output: OUT,
      exitCode: null,
      truncated: false,
      cancelled: false,
    });
  });

  it("states detailInput: null on Claude's pending row, then fills IN and OUT", () => {
    const state = createMcpPrepareState();
    const pending = prepareMcpToolCall(claudePending, state);
    expect(pending).toEqual({
      action: "emit",
      call: { ...claudePending, detailInput: null },
      commandOutput: null,
    });
    const args = prepareMcpToolCall(claudeArgs, state);
    expect(args.action).toBe("emit");
    if (args.action !== "emit") return;
    expect(args.call.detailInput).toBe(IN);
    expect(args.commandOutput).toBeNull();
    const done = prepareMcpToolCall(claudeDone, state);
    expect(done.action).toBe("emit");
    if (done.action !== "emit") return;
    expect(done.call.detailInput).toBe(IN);
    expect(done.commandOutput).toEqual({
      command: IN,
      toolCallId: "toolu_mcp_1",
      output: OUT,
      exitCode: null,
      truncated: false,
      cancelled: false,
    });
  });

  it("emits grok use_tool IN immediately and OUT once, even if the completed row is seen twice", () => {
    const state = createMcpPrepareState();
    const first = prepareMcpToolCall(grokUse, state);
    expect(first.action).toBe("emit");
    if (first.action !== "emit") return;
    expect(first.call.detailInput).toBe(IN);
    expect(first.call.title).toBe("use_tool");
    expect(first.commandOutput).toBeNull();
    expect(prepareMcpToolCall(grokUseUpdate, state).action).toBe("emit");
    const done = prepareMcpToolCall(grokUseDone, state);
    expect(done.action).toBe("emit");
    if (done.action !== "emit") return;
    expect(done.commandOutput?.output).toBe(OUT);
    const again = prepareMcpToolCall(grokUseDone, state);
    expect(again.action).toBe("emit");
    if (again.action !== "emit") return;
    expect(again.commandOutput).toBeNull();
  });

  it("passes a shell command through with no detailInput and no MCP output", () => {
    const state = createMcpPrepareState();
    expect(prepareMcpToolCall(shell, state)).toEqual({
      action: "emit",
      call: shell,
      commandOutput: null,
    });
    expect(Object.prototype.hasOwnProperty.call(
      (prepareMcpToolCall(shell, createMcpPrepareState()) as { call: object }).call,
      "detailInput",
    )).toBe(false);
  });
});

describe("zero-argument MCP keeps IN and OUT", () => {
  const emptyGrok = {
    ...grokUse,
    toolCallId: "call-use-empty",
    rawInput: { tool_name: "everything__list_folders", tool_input: {} },
  };
  const emptyGrokDone = {
    ...grokUseDone,
    toolCallId: "call-use-empty",
    rawOutput: {
      type: "MCP",
      tool_name: "list_folders",
      server_name: "everything",
      output: { OkayOutput: "[]" },
    },
  };
  const emptyCodex = {
    ...codexCall,
    toolCallId: "exec-mcp-empty",
    title: "mcp.everything.list_folders",
    rawInput: { server: "everything", tool: "list_folders", arguments: {} },
  };
  const emptyCodexDone = {
    ...codexDone,
    toolCallId: "exec-mcp-empty",
    rawInput: { server: "everything", tool: "list_folders", arguments: {} },
    rawOutput: {
      result: { content: [{ type: "text", text: "[]" }], structuredContent: null, _meta: null },
      error: null,
    },
  };
  const emptyClaudePending = {
    ...claudePending,
    toolCallId: "toolu_mcp_empty",
    title: "mcp__everything__list_folders",
    _meta: { claudeCode: { toolName: "mcp__everything__list_folders" } },
  };
  const emptyClaudeDone = {
    ...claudeDone,
    toolCallId: "toolu_mcp_empty",
    rawOutput: [{ type: "text", text: "[]" }],
    content: [{ type: "content", content: { type: "text", text: "[]" } }],
    _meta: { claudeCode: { toolName: "mcp__everything__list_folders" } },
  };

  it("keeps IN {} and OUT on grok, Codex, and Claude", () => {
    const grokState = createMcpPrepareState();
    expect(extractMcpInput(emptyGrok)).toBe(EMPTY_MCP_ARGS);
    const grokFirst = prepareMcpToolCall(emptyGrok, grokState);
    expect(grokFirst.action).toBe("emit");
    if (grokFirst.action !== "emit") return;
    expect(grokFirst.call.detailInput).toBe(EMPTY_MCP_ARGS);
    expect(grokFirst.commandOutput).toBeNull();
    const grokDone = prepareMcpToolCall(emptyGrokDone, grokState);
    expect(grokDone.action).toBe("emit");
    if (grokDone.action !== "emit") return;
    expect(grokDone.call.detailInput).toBe(EMPTY_MCP_ARGS);
    expect(grokDone.commandOutput).toEqual({
      command: EMPTY_MCP_ARGS,
      toolCallId: "call-use-empty",
      output: "[]",
      exitCode: null,
      truncated: false,
      cancelled: false,
    });

    const codexState = createMcpPrepareState();
    expect(extractMcpInput(emptyCodex)).toBe(EMPTY_MCP_ARGS);
    expect(prepareMcpToolCall(emptyCodex, codexState).commandOutput).toBeNull();
    const codexDonePrep = prepareMcpToolCall(emptyCodexDone, codexState);
    expect(codexDonePrep.action).toBe("emit");
    if (codexDonePrep.action !== "emit") return;
    expect(codexDonePrep.call.detailInput).toBe(EMPTY_MCP_ARGS);
    expect(codexDonePrep.commandOutput).toMatchObject({
      command: EMPTY_MCP_ARGS,
      toolCallId: "exec-mcp-empty",
      output: "[]",
    });

    const claudeState = createMcpPrepareState();
    expect(extractMcpInput(emptyClaudePending)).toBeNull();
    const pending = prepareMcpToolCall(emptyClaudePending, claudeState);
    expect(pending.action).toBe("emit");
    if (pending.action !== "emit") return;
    expect(pending.call.detailInput).toBeNull();
    const claudeDonePrep = prepareMcpToolCall(emptyClaudeDone, claudeState);
    expect(claudeDonePrep.action).toBe("emit");
    if (claudeDonePrep.action !== "emit") return;
    expect(claudeDonePrep.call.detailInput).toBe(EMPTY_MCP_ARGS);
    expect(claudeDonePrep.commandOutput).toMatchObject({
      command: EMPTY_MCP_ARGS,
      toolCallId: "toolu_mcp_empty",
      output: "[]",
    });
  });
});

describe("same-argument MCP calls stay correlated by toolCallId", () => {
  it("does not swap OUT when two identical-arg calls complete out of order", () => {
    const state = createMcpPrepareState();
    const a = { ...codexCall, toolCallId: "exec-mcp-a" };
    const b = { ...codexCall, toolCallId: "exec-mcp-b" };
    expect(prepareMcpToolCall(a, state).call).toMatchObject({ detailInput: IN });
    expect(prepareMcpToolCall(b, state).call).toMatchObject({ detailInput: IN });
    const bDone = prepareMcpToolCall({
      ...codexDone,
      toolCallId: "exec-mcp-b",
      rawOutput: {
        result: { content: [{ type: "text", text: "out-b" }], structuredContent: null, _meta: null },
        error: null,
      },
    }, state);
    const aDone = prepareMcpToolCall({
      ...codexDone,
      toolCallId: "exec-mcp-a",
      rawOutput: {
        result: { content: [{ type: "text", text: "out-a" }], structuredContent: null, _meta: null },
        error: null,
      },
    }, state);
    expect(bDone.action).toBe("emit");
    expect(aDone.action).toBe("emit");
    if (bDone.action !== "emit" || aDone.action !== "emit") return;
    expect(bDone.commandOutput).toMatchObject({ toolCallId: "exec-mcp-b", output: "out-b", command: IN });
    expect(aDone.commandOutput).toMatchObject({ toolCallId: "exec-mcp-a", output: "out-a", command: IN });
  });
});

describe("provider metadata wins over argument-key heuristics", () => {
  it("reads a Claude tool whose args are named server/tool as Claude, not Codex", () => {
    const call = {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_collide",
      title: "mcp__everything__echo",
      kind: "other",
      rawInput: { server: "everything", tool: "echo", message: "keep-me" },
      _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
    };
    expect(isMcpToolCall(call)).toBe(true);
    expect(extractMcpInput(call)).toBe(JSON.stringify({
      server: "everything",
      tool: "echo",
      message: "keep-me",
    }, null, 2));
    const prepared = prepareMcpToolCall(call, createMcpPrepareState());
    expect(prepared.action).toBe("emit");
    if (prepared.action !== "emit") return;
    expect(prepared.call.detailInput).toContain("keep-me");
    expect(prepared.call.detailInput).not.toBeNull();
  });

  it("reads a Claude tool whose args are named tool_name/tool_input as Claude, not grok", () => {
    const call = {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_collide_grok",
      title: "mcp__everything__echo",
      rawInput: { tool_name: "not-grok", tool_input: { inner: "nope" }, message: "keep-me" },
      _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
    };
    expect(extractMcpInput(call)).toBe(JSON.stringify({
      tool_name: "not-grok",
      tool_input: { inner: "nope" },
      message: "keep-me",
    }, null, 2));
  });

  it("does not hide a Claude MCP tool whose arguments look like grok search", () => {
    const call = {
      title: "mcp__everything__echo",
      rawInput: { variant: "SearchTool", query: "x" },
      _meta: { claudeCode: { toolName: "mcp__everything__echo" } },
    };
    expect(isHiddenMcpRow(call)).toBe(false);
    expect(isMcpToolCall(call)).toBe(true);
    expect(extractMcpInput(call)).toContain("SearchTool");
  });
});
