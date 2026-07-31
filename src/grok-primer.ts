// Compatibility readers for sessions created by extension versions that sent a
// hidden plan-verdict primer. New sessions no longer receive that turn, but old
// histories must keep it invisible and excluded from replay position/title logic.

/** Matches the marker prefix of any primer version (v1, v2, …) at the start of
 *  a message. Mirrors the webview's legacy PRIMER_PATTERN. Version-agnostic so
 *  every previously persisted primer remains hidden. */
export const PRIMER_PATTERN = /^\s*\[grok-build-vscode primer v\d+\]/;

/** True when replayed `text` starts with a legacy hidden-primer marker. */
export function isPrimerText(text: string): boolean {
  return PRIMER_PATTERN.test(text ?? "");
}

/** True when a grok-generated legacy session title was derived from the hidden
 *  primer that older extension versions sent as their first message, e.g.
 *  "Grok Build VSCode Primer v4 Plan Mode" or "Hidden Primer v4". grok summarizes
 *  from message #1, so a primer-only session gets one of these titles. Used as the
 *  cheap pre-filter for the empty-session sweep (the authoritative check reads the
 *  chat history); deliberately conservative — it requires "primer" plus a
 *  product/context word so a real session that merely mentions "primer" won't match. */
export function isPrimerSummary(summary: string): boolean {
  const t = (summary ?? "").toLowerCase();
  if (!t.includes("primer")) return false;
  return /grok|vs ?code|plan mode|hidden/.test(t);
}
