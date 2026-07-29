export const SPEECH_SUMMARY_ENDPOINT = "https://api.x.ai/v1/responses";
export const SPEECH_SUMMARY_MODEL = "grok-4.3";
export const SPEECH_SUMMARY_TIMEOUT_MS = 10_000;

const SPEECH_SUMMARY_INSTRUCTIONS =
  "Rewrite the supplied assistant text as a brief, natural spoken update. " +
  "Preserve decisions, warnings, and required user actions. Use at most three short sentences and 60 words. " +
  "Return only the speech-ready wording, with no preface, markdown, code, or tool details.";

export function buildSpeechSummaryRequest(text: string, apiKey: string): {
  url: string;
  init: RequestInit;
} {
  return {
    url: SPEECH_SUMMARY_ENDPOINT,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SPEECH_SUMMARY_MODEL,
        store: false,
        reasoning: { effort: "none" },
        max_output_tokens: 160,
        input: [
          { role: "system", content: SPEECH_SUMMARY_INSTRUCTIONS },
          { role: "user", content: text },
        ],
      }),
    },
  };
}

export function parseSpeechSummaryResponse(value: unknown): string {
  const output = (value as any)?.output;
  if (!Array.isArray(output)) return "";
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text.trim();
      }
    }
  }
  return "";
}

export async function summarizeForSpeech(
  text: string,
  apiKey: string | undefined,
  log?: (message: string) => void,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = SPEECH_SUMMARY_TIMEOUT_MS,
): Promise<string> {
  if (!text || !apiKey) return text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { url, init } = buildSpeechSummaryRequest(text, apiKey);
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const summary = parseSpeechSummaryResponse(JSON.parse(bodyText));
    if (!summary) throw new Error("empty response");
    return summary;
  } catch (error) {
    const reason = controller.signal.aborted
      ? "timed out"
      : (error as Error)?.message || String(error);
    log?.(`[speech-summary] ${reason}; using the original reply`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}
