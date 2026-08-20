import { describe, expect, it } from "vitest";
import {
  FEEDBACK_RPC_METHOD,
  buildClientFeedbackParams,
  classifyFeedbackUserText,
  commandsAdvertiseFeedback,
  decideFeedbackAvailability,
  feedbackClientType,
  feedbackMapIsConsistent,
  feedbackTurnNumberForVisibleBubble,
  feedbackUserItemsFromBuffer,
  isFeedbackDisabledError,
  isThumbsRating,
  parseFeedbackEnabledMeta,
  truncateTurnRatings,
  visibleFeedbackPromptCount,
} from "../src/feedback";
import type { HostMsg } from "../src/protocol";

describe("wire helpers", () => {
  it("sends the ACP extension-prefix method, not the bare logical name", () => {
    expect(FEEDBACK_RPC_METHOD).toBe("_x.ai/feedback");
  });

  it("builds snake_case ClientFeedbackInput without a request_id", () => {
    expect(buildClientFeedbackParams({
      sessionId: "s1",
      clientType: "extension",
      ratingValue: 1,
      turnNumber: 3,
      clientVersion: "3.13.0",
    })).toEqual({
      session_id: "s1",
      client_type: "extension",
      rating_type: "thumbs",
      rating_value: 1,
      turn_number: 3,
      client_version: "3.13.0",
    });
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

describe("turn_number mapping", () => {
  it("indexes the prompt among ALL User items, not the visible-bubble index", () => {
    const items = ["hidden", "prompt", "steer", "prompt"] as const;
    expect(feedbackTurnNumberForVisibleBubble(items, 0)).toBe(1);
    expect(feedbackTurnNumberForVisibleBubble(items, 1)).toBe(3);
    expect(feedbackTurnNumberForVisibleBubble(items, 2)).toBeNull();
  });

  it("is not rewind promptIndex once a steer has landed", () => {
    // Rewind would still number the second real prompt as 1 (steers are not
    // session/prompt turns). Feedback's User-nth for that same bubble is 2.
    const items = ["prompt", "steer", "prompt"] as const;
    expect(feedbackTurnNumberForVisibleBubble(items, 1)).toBe(2);
  });

  it("walks live userMessage and restored userMessageChunk the same way", () => {
    const live: HostMsg[] = [
      { type: "userMessage", text: "first" },
      { type: "userMessage", text: "steer now", steer: true },
      { type: "userMessage", text: "second" },
    ];
    const restored: HostMsg[] = [
      { type: "userMessageChunk", text: "first" },
      { type: "agentStart" },
      { type: "userMessageChunk", text: "The user sent a message while you were working:\nsteer now" },
      { type: "messageChunk", text: "ok" },
      { type: "userMessageChunk", text: "second" },
    ];
    expect(feedbackUserItemsFromBuffer(live)).toEqual(["prompt", "steer", "prompt"]);
    expect(feedbackUserItemsFromBuffer(restored)).toEqual(["prompt", "steer", "prompt"]);
    expect(feedbackTurnNumberForVisibleBubble(feedbackUserItemsFromBuffer(live), 1)).toBe(2);
  });

  it("counts a legacy primer as a User item the visible bubble must skip", () => {
    const buffer: HostMsg[] = [
      { type: "userMessageChunk", text: "[grok-build-vscode primer v4] hidden" },
      { type: "userMessage", text: "real question" },
    ];
    const items = feedbackUserItemsFromBuffer(buffer);
    expect(items).toEqual(["hidden", "prompt"]);
    expect(feedbackTurnNumberForVisibleBubble(items, 0)).toBe(1);
    expect(visibleFeedbackPromptCount(items)).toBe(1);
  });

  it("refuses when the visible count no longer matches the map", () => {
    const items = ["prompt", "steer", "prompt"] as const;
    expect(feedbackMapIsConsistent(items, 2)).toBe(true);
    expect(feedbackMapIsConsistent(items, 3)).toBe(false);
    expect(feedbackMapIsConsistent(items, undefined)).toBe(true);
  });

  it("classifies interjection envelopes as steers even without the live flag", () => {
    expect(classifyFeedbackUserText("The user sent a message while you were working:\nstop")).toBe("steer");
    expect(classifyFeedbackUserText("hello", true)).toBe("steer");
    expect(classifyFeedbackUserText("hello")).toBe("prompt");
  });
});

describe("truncateTurnRatings", () => {
  it("drops ratings on discarded turns and keeps earlier ones", () => {
    const ratings = new Map<number, 1 | -1>([[0, 1], [1, -1], [2, 1]]);
    expect([...truncateTurnRatings(ratings, 2).entries()]).toEqual([[0, 1], [1, -1]]);
  });
});
