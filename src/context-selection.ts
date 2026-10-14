/** Native Grok context choices; counts are tokens, never byte sizes. */
export function contextWindowSizes(raw: unknown, fallback?: unknown): number[] {
  const values = Array.isArray(raw) ? raw : [fallback];
  return [...new Set(values.filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0))];
}

/** MIRRORED in media/webview-helpers.js, which reads a typed size to decide
 *  whether a switch down asks first. KEEP THE TWO IN STEP:
 *  test/context-selection.test.ts drives one fixture set through both. */
export function parseContextWindowSize(text: string): number | undefined {
  const match = /^(\d+)(k)?$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]) * (match[2] ? 1000 : 1);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export interface ContextWindowSelection {
  sessionId: string;
  modelId?: string;
  generation: number;
  sizes: number[];
  defaultSize?: number;
  selectedSize?: number;
  available: boolean;
  changing: boolean;
  stale?: boolean;
  reason?: string;
}
