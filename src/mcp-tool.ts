/**
 * Pure MCP tool-call normalizers.
 *
 * Providers agree on nothing (research/mcp-shapes.md). IN, OUT, and the
 * tool's own name each live in a different field, and grok/codex send no
 * `content` on the completed update — so the shell IN/OUT path cannot
 * reuse `content` unchanged. This module is the host-side normalizer:
 * hide machinery rows, stamp `detailInput` (always, on recognized MCP
 * rows), and emit `commandOutput` joined by `toolCallId`.
 */

import { capCommandOutput, type CommandOutputPayload } from "./acp-dispatch";

/** Pretty-printed empty-object IN. A no-argument call still gets a row. */
export const EMPTY_MCP_ARGS = "{}";

export type McpPrepareState = {
  hiddenIds: Set<string>;
  mcpIds: Set<string>;
  inputById: Map<string, string>;
  emittedOutputIds: Set<string>;
};

export function createMcpPrepareState(): McpPrepareState {
  return {
    hiddenIds: new Set(),
    mcpIds: new Set(),
    inputById: new Map(),
    emittedOutputIds: new Set(),
  };
}

export type PreparedMcpToolCall =
  | { action: "hide" }
  | { action: "emit"; call: Record<string, unknown>; commandOutput: CommandOutputPayload | null };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toolCallIdOf(call: unknown): string {
  const id = asRecord(call)?.toolCallId;
  return typeof id === "string" && id ? id : "";
}

function titleOf(call: unknown): string {
  const title = asRecord(call)?.title;
  return typeof title === "string" ? title : "";
}

function statusOf(call: unknown): string {
  const status = asRecord(call)?.status;
  return typeof status === "string" ? status.toLowerCase() : "";
}

function isSettledStatus(call: unknown): boolean {
  const status = statusOf(call);
  return status === "completed" || status === "failed";
}

function grokToolName(call: unknown): string {
  const meta = asRecord(asRecord(call)?._meta);
  const xai = asRecord(meta?.["x.ai/tool"]);
  return typeof xai?.name === "string" ? xai.name : "";
}

function claudeToolName(call: unknown): string {
  const meta = asRecord(asRecord(call)?._meta);
  const claude = asRecord(meta?.claudeCode);
  return typeof claude?.toolName === "string" ? claude.toolName : "";
}

function hasClaudeMcpMeta(call: unknown): boolean {
  return claudeToolName(call).startsWith("mcp__");
}

function hasCodexMcpMeta(call: unknown): boolean {
  return asRecord(asRecord(call)?._meta)?.is_mcp_tool_call === true;
}

function hasGrokUseToolMeta(call: unknown): boolean {
  return grokToolName(call) === "use_tool";
}

function isCodexStartupTitle(title: string): boolean {
  return /^mcp__.+__startup$/i.test(title);
}

function contentTexts(call: unknown): string[] {
  const content = asRecord(call)?.content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    const inner = asRecord(rec?.content);
    if (typeof inner?.text === "string") texts.push(inner.text);
  }
  return texts;
}

function isFailedCodexStartup(call: unknown): boolean {
  if (!isCodexStartupTitle(titleOf(call))) return false;
  if (statusOf(call) === "failed") return true;
  return contentTexts(call).some((text) => /startup was cancelled/i.test(text));
}

/** Machinery the user did not ask to see. */
export function isHiddenMcpRow(call: unknown): boolean {
  if (!asRecord(call)) return false;
  // Explicit invocation metadata is not machinery. Consult it before any
  // title / argument-key hide so a real tool cannot be swallowed.
  if (hasClaudeMcpMeta(call) || hasGrokUseToolMeta(call)) return false;
  if (isFailedCodexStartup(call)) return true;
  if (hasCodexMcpMeta(call)) return false;

  if (grokToolName(call) === "search_tool") return true;
  if (titleOf(call) === "search_tool") return true;
  const rawOut = asRecord(asRecord(call)?.rawOutput);
  if (rawOut?.type === "SearchTool") return true;
  const rawIn = asRecord(asRecord(call)?.rawInput);
  if (rawIn?.variant === "SearchTool") return true;
  return false;
}

function isClaudeMcpTitle(call: unknown): boolean {
  const title = titleOf(call);
  return title.startsWith("mcp__") && !isCodexStartupTitle(title);
}

function isCodexMcpArgs(call: unknown): boolean {
  const rawIn = asRecord(asRecord(call)?.rawInput);
  return !!(rawIn
    && typeof rawIn.server === "string" && rawIn.server
    && typeof rawIn.tool === "string" && rawIn.tool
    && typeof rawIn.command !== "string");
}

function isGrokUseToolArgs(call: unknown): boolean {
  const rawIn = asRecord(asRecord(call)?.rawInput);
  return typeof rawIn?.tool_name === "string" && !!rawIn.tool_name
    && asRecord(rawIn.tool_input) !== null;
}

function grokMcpOutput(call: unknown): boolean {
  return asRecord(asRecord(call)?.rawOutput)?.type === "MCP";
}

/** Recognized MCP invocation — not search/startup machinery. */
export function isMcpToolCall(call: unknown): boolean {
  if (!asRecord(call) || isHiddenMcpRow(call)) return false;
  if (hasClaudeMcpMeta(call) || hasCodexMcpMeta(call) || hasGrokUseToolMeta(call)) return true;
  if (grokMcpOutput(call)) return true;
  if (isClaudeMcpTitle(call) || isCodexMcpArgs(call) || isGrokUseToolArgs(call)) return true;
  return false;
}

export function formatMcpArgs(value: unknown): string | null {
  const rec = asRecord(value);
  if (!rec) return null;
  try {
    return JSON.stringify(rec, null, 2);
  } catch {
    return null;
  }
}

function isClaudePendingEmpty(call: unknown, rawIn: Record<string, unknown>): boolean {
  return Object.keys(rawIn).length === 0 && !isSettledStatus(call);
}

function extractClaudeMcpInput(call: unknown, rawIn: Record<string, unknown> | null): string | null {
  if (!rawIn) return null;
  if (isClaudePendingEmpty(call, rawIn)) return null;
  return formatMcpArgs(rawIn);
}

function extractCodexMcpInput(rawIn: Record<string, unknown> | null): string | null {
  if (!rawIn || !("arguments" in rawIn)) return null;
  return formatMcpArgs(rawIn.arguments);
}

function extractGrokMcpInput(rawIn: Record<string, unknown> | null): string | null {
  if (!rawIn || !("tool_input" in rawIn)) return null;
  return formatMcpArgs(rawIn.tool_input);
}

/**
 * Provider-specific IN. Provider metadata is consulted first; argument-key
 * heuristics are last-resort only. Claude pending empty args stay `null`
 * (title-only row). A known-empty object is `{}`.
 */
export function extractMcpInput(call: unknown): string | null {
  const rawIn = asRecord(asRecord(call)?.rawInput);
  if (hasClaudeMcpMeta(call)) return extractClaudeMcpInput(call, rawIn);
  if (hasCodexMcpMeta(call)) return extractCodexMcpInput(rawIn);
  if (hasGrokUseToolMeta(call)) return extractGrokMcpInput(rawIn);
  if (isClaudeMcpTitle(call)) return extractClaudeMcpInput(call, rawIn);
  if (isCodexMcpArgs(call)) return extractCodexMcpInput(rawIn);
  if (isGrokUseToolArgs(call) || grokMcpOutput(call)) return extractGrokMcpInput(rawIn);
  return null;
}

function textPartsFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (rec?.type === "text" && typeof rec.text === "string") parts.push(rec.text);
  }
  return parts.length ? parts.join("\n") : null;
}

/**
 * Provider-specific OUT. Unrecognized envelopes return null rather than
 * guessing. Does not read `content` — grok/codex omit it on the completed
 * MCP update, and Claude's copy there is a duplicate of `rawOutput`.
 */
export function extractMcpOutput(call: unknown): { output: string; truncated: boolean } | null {
  if (!isMcpToolCall(call)) return null;
  const rawOut = asRecord(call)?.rawOutput;

  if (Array.isArray(rawOut)) {
    const text = textPartsFromContent(rawOut);
    return text === null ? null : capCommandOutput(text, false);
  }

  const rec = asRecord(rawOut);
  if (!rec) return null;

  if (rec.type === "MCP") {
    const out = asRecord(rec.output);
    return typeof out?.OkayOutput === "string"
      ? capCommandOutput(out.OkayOutput, false)
      : null;
  }

  if ("result" in rec) {
    if (rec.error != null) return null;
    const text = textPartsFromContent(asRecord(rec.result)?.content);
    return text === null ? null : capCommandOutput(text, false);
  }

  return null;
}

export function mcpCommandOutput(
  call: unknown,
  command: string,
  toolCallId: string,
): CommandOutputPayload | null {
  if (!toolCallId) return null;
  const extracted = extractMcpOutput(call);
  if (!extracted) return null;
  return {
    command,
    toolCallId,
    output: extracted.output,
    exitCode: null,
    truncated: extracted.truncated,
    cancelled: false,
  };
}

/**
 * Host emit decision for one tool_call / tool_call_update.
 *
 * Hidden machinery is dropped (and remembered by id so a later update
 * without the marker stays dropped). Recognized MCP rows always state
 * `detailInput` (`string` or `null`). OUT becomes a `commandOutput`
 * joined by `toolCallId`, never by argument text.
 */
export function prepareMcpToolCall(call: unknown, state: McpPrepareState): PreparedMcpToolCall {
  const rec = asRecord(call);
  if (!rec) return { action: "emit", call: {}, commandOutput: null };

  const id = toolCallIdOf(call);
  if (id && state.hiddenIds.has(id)) return { action: "hide" };
  if (isHiddenMcpRow(call)) {
    if (id) state.hiddenIds.add(id);
    return { action: "hide" };
  }

  const recognized = isMcpToolCall(call) || !!(id && state.mcpIds.has(id));
  if (!recognized) return { action: "emit", call: rec, commandOutput: null };

  if (id) state.mcpIds.add(id);
  const extractedInput = extractMcpInput(call);
  if (extractedInput && id) state.inputById.set(id, extractedInput);
  let detailInput = extractedInput ?? (id ? state.inputById.get(id) ?? null : null);
  // A settled call with OUT but no remembered args is a no-argument tool
  // (or a completed row that omitted rawInput). Invent `{}` so the IN box
  // exists for the id-keyed OUT attach — never drop the result.
  if (detailInput == null && isSettledStatus(call) && extractMcpOutput(call)) {
    detailInput = EMPTY_MCP_ARGS;
  }
  const decorated = { ...rec, detailInput };
  let commandOutput: CommandOutputPayload | null = null;
  if (id && !state.emittedOutputIds.has(id)) {
    commandOutput = mcpCommandOutput(call, detailInput ?? EMPTY_MCP_ARGS, id);
    if (commandOutput) state.emittedOutputIds.add(id);
  }
  return { action: "emit", call: decorated, commandOutput };
}
