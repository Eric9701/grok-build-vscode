import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Re-focusing a LIVE conversation must say which agent it belongs to.
 *
 * The symptom was reported from a phone and is worth recording, because the
 * one detail that looks like a contradiction is the thing that identifies it:
 * switching to a live Codex conversation updated the MODEL PICKER (it showed
 * `gpt-5.6-sol`) while everything around it still said Grok — the composer read
 * "Ask Grok", the working indicator read "grokking", and steering was attempted
 * and refused by a CLI that has no such method.
 *
 * That split is exact. `sessionUiSnapshot` carries `modelChanged`, which sets
 * the model id, and the re-focus paths sent it. `session` is the ONLY frame
 * that sets `state.activeProvider`, `state.availableModels` and the composer
 * placeholder (`media/chat.js` case "session"), and neither re-focus path sent
 * it: cold loads reach it through `startSession`, live re-focuses never did.
 *
 * It is the same omission the `sessionName` comment in `focusSession` already
 * records — a small identity frame missing from a path that replays everything
 * else — so this guards both surfaces at once. The desk had the same hole.
 *
 * A source-shape guard, and honest about it: it proves the call is present and
 * ordered before the transcript replay, not that the frame reaches a client.
 * The end-to-end path needs a real host and belongs in the integration suite.
 */
const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
  "utf8",
);

function methodBody(signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  private ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("the identity frame on a live re-focus", () => {
  it("builds the frame from the session's own provider, not a default", () => {
    const body = methodBody("private sessionIdentityFrame(");
    expect(body).toContain('type: "session"');
    expect(body).toContain("provider: session.provider");
    // A re-focus is not a new conversation: startSession passes `!resumeId`,
    // so the catalog must be built the same way here.
    expect(body).toContain("client.currentModelId, false");
  });

  it("is sent to the browser client before the transcript replay", () => {
    const body = methodBody("private focusRemoteSession(");
    expect(body).toContain("this.sessionIdentityFrame(session)");
    const identityAt = body.indexOf("sessionIdentityFrame");
    const replayAt = body.indexOf("bracketRemoteSnapshot");
    expect(identityAt).toBeGreaterThan(-1);
    expect(replayAt).toBeGreaterThan(-1);
    expect(identityAt).toBeLessThan(replayAt);
  });

  it("is sent on the desk path too, to the webview and to remote holders", () => {
    const body = methodBody("private focusSession(");
    expect(body).toContain("this.sessionIdentityFrame(session)");
    // Both surfaces, not just the one that reported the bug.
    expect(body).toContain("if (identity) wv.postMessage(identity)");
    expect(body).toContain("...(identity ? [identity] : [])");
  });
});
