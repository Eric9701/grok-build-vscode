import { describe, expect, it } from "vitest";
import {
  FEEDBACK_RPC_METHOD,
  buildClientFeedbackParams,
  commandsAdvertiseFeedback,
  decideFeedbackAvailability,
  feedbackClientType,
  isFeedbackDisabledError,
  isThumbsRating,
  parseFeedbackEnabledMeta,
} from "../src/feedback";

describe("wire helpers", () => {
  it("sends the ACP extension-prefix method, not the bare logical name", () => {
    expect(FEEDBACK_RPC_METHOD).toBe("_x.ai/feedback");
  });

  it("builds snake_case ClientFeedbackInput without a request_id or turn_number", () => {
    expect(buildClientFeedbackParams({
      sessionId: "s1",
      clientType: "extension",
      ratingValue: 1,
      clientVersion: "3.13.0",
    })).toEqual({
      session_id: "s1",
      client_type: "extension",
      rating_type: "thumbs",
      rating_value: 1,
      client_version: "3.13.0",
    });
    expect(buildClientFeedbackParams({
      sessionId: "s1",
      clientType: "desktop",
      ratingValue: -1,
    })).not.toHaveProperty("turn_number");
  });

  it("describes the host that files the rating, not the phone that clicked", () => {
    expect(feedbackClientType(false)).toBe("extension");
    expect(feedbackClientType(true)).toBe("desktop");
  });

  it("accepts only the thumbs scale", () => {
    expect(isThumbsRating(-1)).toBe(true);
    expect(isThumbsRating(0)).toBe(true);
    expect(isThumbsRating(1)).toBe(true);
    expect(isThumbsRating(2)).toBe(false);
    expect(isThumbsRating("1")).toBe(false);
  });
});

describe("availability", () => {
  it("reads session/new _meta.feedbackEnabled", () => {
    expect(parseFeedbackEnabledMeta({ _meta: { feedbackEnabled: true } })).toBe(true);
    expect(parseFeedbackEnabledMeta({ meta: { feedback_enabled: false } })).toBe(false);
    expect(parseFeedbackEnabledMeta({ sessionId: "s" })).toBeUndefined();
  });

  it("detects the /feedback builtin in available_commands_update", () => {
    expect(commandsAdvertiseFeedback([{ name: "compact" }, { name: "feedback" }])).toBe(true);
    expect(commandsAdvertiseFeedback([{ name: "compact" }])).toBe(false);
  });

  it("is grok-only, off until a positive signal, and latched off on unsupported", () => {
    expect(decideFeedbackAvailability({
      provider: "codex",
      metaEnabled: true,
      latchedUnsupported: false,
    })).toBe(false);
    expect(decideFeedbackAvailability({
      provider: "grok",
      latchedUnsupported: false,
    })).toBe(false);
    expect(decideFeedbackAvailability({
      provider: "grok",
      commandsAdvertise: true,
      latchedUnsupported: false,
    })).toBe(true);
    expect(decideFeedbackAvailability({
      provider: "grok",
      metaEnabled: true,
      commandsAdvertise: false,
      latchedUnsupported: false,
    })).toBe(true);
    expect(decideFeedbackAvailability({
      provider: "grok",
      metaEnabled: false,
      commandsAdvertise: true,
      latchedUnsupported: false,
    })).toBe(false);
    expect(decideFeedbackAvailability({
      provider: "grok",
      metaEnabled: true,
      latchedUnsupported: true,
    })).toBe(false);
  });

  it("treats the disabled internal_error as a capability gap, not a send failure", () => {
    expect(isFeedbackDisabledError({
      code: -32603,
      message: "Internal error",
      data: "Feedback is disabled. To enable, set GROK_FEEDBACK_ENABLED=true",
    })).toBe(true);
    expect(isFeedbackDisabledError({ code: -32603, message: "Internal error" })).toBe(false);
    expect(isFeedbackDisabledError({ code: -32601, message: "Method not found" })).toBe(false);
  });
});
