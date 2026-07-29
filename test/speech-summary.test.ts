import { describe, expect, it, vi } from "vitest";
import {
  SPEECH_SUMMARY_ENDPOINT,
  SPEECH_SUMMARY_MODEL,
  buildSpeechSummaryRequest,
  parseSpeechSummaryResponse,
  summarizeForSpeech,
} from "../src/speech-summary";

describe("speech summary request", () => {
  it("uses the Responses API without server-side storage or reasoning", () => {
    const request = buildSpeechSummaryRequest("A long reply.", "secret");
    expect(request.url).toBe(SPEECH_SUMMARY_ENDPOINT);
    expect(request.init.headers).toEqual({
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(request.init.body));
    expect(body.model).toBe(SPEECH_SUMMARY_MODEL);
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.max_output_tokens).toBe(160);
    expect(body.input.at(-1)).toEqual({ role: "user", content: "A long reply." });
  });

  it("extracts output text from a Responses API result", () => {
    expect(parseSpeechSummaryResponse({
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "  Brief update.  " }],
      }],
    })).toBe("Brief update.");
    expect(parseSpeechSummaryResponse({ output: [] })).toBe("");
  });

  it("returns the summary on success", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "Short version." }] }],
    }), { status: 200 }));
    await expect(summarizeForSpeech("Original.", "key", undefined, fetchImpl as typeof fetch))
      .resolves.toBe("Short version.");
  });

  it.each([
    ["missing key", undefined, vi.fn()],
    ["HTTP error", "key", vi.fn(async () => new Response("rate limited", { status: 429 }))],
    ["invalid JSON", "key", vi.fn(async () => new Response("not json", { status: 200 }))],
    ["empty response", "key", vi.fn(async () => new Response('{"output":[]}', { status: 200 }))],
  ])("falls back to the original text on %s", async (_name, key, fetchImpl) => {
    await expect(summarizeForSpeech("Original.", key, undefined, fetchImpl as typeof fetch))
      .resolves.toBe("Original.");
  });

  it("aborts a hung request and falls back", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }));
    await expect(summarizeForSpeech("Original.", "key", undefined, fetchImpl as typeof fetch, 1))
      .resolves.toBe("Original.");
  });
});
