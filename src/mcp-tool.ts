/**
 * Pure MCP tool-call normalizers.
 *
 * Providers agree on nothing (research/mcp-shapes.md). IN, OUT, and the
 * tool's own name each live in a different field, and grok/codex send no
 * `content` on the completed update — so the shell IN/OUT path cannot
 * reuse `content` unchanged. This module is the host-side normalizer:
 * fold grok `search_tool` into the explore group (stamp `kind:"search"`),
 * emit Codex startup rows instead of dropping them, stamp `detailInput`
 * (always, on recognized MCP rows), and emit `commandOutput` joined by
 * `toolCallId`.
 */

import { capCommandOutput, type CommandOutputPayload } from "./acp-dispatch";

/** Pretty-printed empty-object IN. A no-argument call still gets a row. */
export const EMPTY_MCP_ARGS = "{}";

/** ACP kind that `categorize` in chat.js rolls up as "Explored N items". */
export const MCP_MACHINERY_KIND = "search";

export type McpPrepareState = {
  machineryIds: Set<string>;
  searchIds: Set<string>;
  mcpIds: Set<string>;
  inputById: Map<string, string>;
  emittedOutputIds: Set<string>;
};

export function createMcpPrepareState(): McpPrepareState {
  return {
    machineryIds: new Set(),
    searchIds: new Set(),
    mcpIds: new Set(),
    inputById: new Map(),
    emittedOutputIds: new Set(),
  };
}

export type PreparedMcpToolCall =
  { action: "emit"; call: Record<string, unknown>; commandOutput: CommandOutputPayload | null };

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

function isGrokSearchToolRow(call: unknown): boolean {
  if (grokToolName(call) === "search_tool") return true;
  if (titleOf(call) === "search_tool") return true;
  const rawOut = asRecord(asRecord(call)?.rawOutput);
  if (rawOut?.type === "SearchTool") return true;
  const rawIn = asRecord(asRecord(call)?.rawInput);
  if (rawIn?.variant === "SearchTool") return true;
  return false;
}

/**
 * grok `search_tool` wrappers and Codex `mcp__<server>__startup` rows.
 * These stay in the transcript, folded into the explore tool-group —
 * they are not real MCP invocations and must not be dropped.
 */
export function isMcpMachineryRow(call: unknown): boolean {
  if (!asRecord(call)) return false;
  // Explicit invocation metadata is not machinery. Consult it before any
  // title / argument-key fold so a real tool cannot be re-categorized.
  if (hasClaudeMcpMeta(call) || hasGrokUseToolMeta(call)) return false;
  if (isCodexStartupTitle(titleOf(call))) return true;
  if (hasCodexMcpMeta(call)) return false;
  return isGrokSearchToolRow(call);
}

function foldSearchKind(call: Record<string, unknown>): Record<string, unknown> {
  const kind = typeof call.kind === "string" ? call.kind : "";
  if (kind && kind !== "other") return call;
  return { ...call, kind: MCP_MACHINERY_KIND };
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
  if (!asRecord(call) || isMcpMachineryRow(call)) return false;
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

/** Pretty-print structured MCP values. Strings stay raw so a JSON payload is not re-quoted. */
function formatStructured(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function joinOutputParts(parts: string[]): string | null {
  const nonempty = parts.filter((part) => part.length > 0);
  return nonempty.length ? nonempty.join("\n") : null;
}

/**
 * MCP content blocks: text as text, everything else as indented JSON so an
 * image/resource block cannot vanish. Unrecognized non-objects are skipped.
 */
function partsFromContentBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
      continue;
    }
    const formatted = formatStructured(rec);
    if (formatted) parts.push(formatted);
  }
  return parts;
}

function extractGrokMcpOutput(rec: Record<string, unknown>): string | null {
  const out = asRecord(rec.output);
  if (!out || typeof out.OkayOutput !== "string") return null;
  const parts = [out.OkayOutput];
  for (const [key, value] of Object.entries(out)) {
    if (key === "OkayOutput") continue;
    const formatted = formatStructured(value);
    if (formatted) parts.push(formatted);
  }
  return joinOutputParts(parts);
}

function extractCodexMcpOutput(rec: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const result = asRecord(rec.result);
  if (result) {
    parts.push(...partsFromContentBlocks(result.content));
    if (result.structuredContent != null) {
      const structured = formatStructured(result.structuredContent);
      if (structured) parts.push(structured);
    }
  }
  if (rec.error != null) {
    const error = formatStructured(rec.error);
    if (error) parts.push(error);
  }
  return joinOutputParts(parts);
}

/**
 * Claude structured results arrive as a JSON string (the serialized
 * structuredContent). Pretty-print objects/arrays the same way as Codex
 * structuredContent; anything else — including a non-JSON string — is
 * already the whole payload and is shown verbatim.
 */
function formatStringRawOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      return formatStructured(parsed) ?? raw;
    }
  } catch {
    /* not a JSON object / array */
  }
  return raw;
}

/**
 * Provider-specific OUT — the complete measured result, not a chosen field.
 * Unrecognized envelopes return null rather than guessing. Does not read
 * ACP `content` — grok/codex omit it on the completed MCP update, and
 * Claude's copy there is a duplicate of `rawOutput`. Does not read
 * `_meta.claudeCode.toolResponse` (same payload one update earlier).
 *
 * Codex: every `result.content` block plus `structuredContent`; a non-null
 * `error` is shown (a failed call must not look empty). grok: `OkayOutput`
 * and any sibling keys on `output`. Claude: `rawOutput` is polymorphic —
 * a content-block array (plain text; non-text as JSON) or a string
 * (structured: pretty-printed when it is JSON, otherwise verbatim).
 * Claude has no measured `result`/`structuredContent` envelope — do not
 * invent one.
 */
export function extractMcpOutput(call: unknown): { output: string; truncated: boolean } | null {
  if (!isMcpToolCall(call)) return null;
  const rawOut = asRecord(call)?.rawOutput;

  if (typeof rawOut === "string") {
    return capCommandOutput(formatStringRawOutput(rawOut), false);
  }

  if (Array.isArray(rawOut)) {
    const text = joinOutputParts(partsFromContentBlocks(rawOut));
    return text === null ? null : capCommandOutput(text, false);
  }

  const rec = asRecord(rawOut);
  if (!rec) return null;

  if (rec.type === "MCP") {
    const text = extractGrokMcpOutput(rec);
    return text === null ? null : capCommandOutput(text, false);
  }

  if ("result" in rec || rec.error != null) {
    const text = extractCodexMcpOutput(rec);
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
    // Display cap only — the provider already returned the full result.
    agentSawCut: false,
    cancelled: false,
  };
}

/**
 * Host emit decision for one tool_call / tool_call_update.
 *
 * Machinery (grok `search_tool`, Codex `mcp__<server>__startup`) is
 * emitted, not dropped. grok `search_tool` is stamped `kind:"search"`
 * so the existing explore group folds it; a later update without the
 * marker stays folded by id. Codex startup keeps its title and failed
 * status so a broken server stays reachable. Recognized MCP rows always
 * state `detailInput` (`string` or `null`). OUT becomes a
 * `commandOutput` joined by `toolCallId`, never by argument text.
 */
export function prepareMcpToolCall(call: unknown, state: McpPrepareState): PreparedMcpToolCall {
  const rec = asRecord(call);
  if (!rec) return { action: "emit", call: {}, commandOutput: null };

  const id = toolCallIdOf(call);
  const machinery = !!(id && state.machineryIds.has(id)) || isMcpMachineryRow(call);
  if (machinery) {
    if (id) state.machineryIds.add(id);
    const asSearch = isGrokSearchToolRow(call) || !!(id && state.searchIds.has(id));
    if (asSearch && id) state.searchIds.add(id);
    return {
      action: "emit",
      call: asSearch ? foldSearchKind(rec) : rec,
      commandOutput: null,
    };
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
