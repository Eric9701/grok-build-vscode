import { describe, expect, it } from "vitest";
import {
  Session,
  beginTurn,
  decideSessionStart,
  sessionReadyForPrompt,
} from "../src/session";

function readySession(): Session {
  const session = new Session();
  session.client = { sessionId: "live-1" } as Session["client"];
  session.priming = false;
  session.activeSessionId = "live-1";
  return session;
}

describe("decideSessionStart", () => {
  it("lets an intentional replacement proceed even mid-turn", () => {
    const session = readySession();
    beginTurn(session);
    expect(decideSessionStart(session, session.client!.sessionId, "replace")).toBe("proceed");
  });

  it("refuses an opportunistic start while a turn is in flight", () => {
    const session = readySession();
    beginTurn(session);
    expect(sessionReadyForPrompt(session)).toBe(true);
    expect(decideSessionStart(session, session.client!.sessionId, "ensure")).toBe("refuse-turn");
  });

  it("reuses a ready matching client instead of replacing it", () => {
    const session = readySession();
    expect(decideSessionStart(session, "live-1", "ensure")).toBe("reuse");
    expect(decideSessionStart(session, undefined, "ensure")).toBe("reuse");
  });

  it("refuses an opportunistic resume of a different live session id", () => {
    const session = readySession();
    expect(decideSessionStart(session, "other-id", "ensure")).toBe("refuse-mismatch");
  });

  it("starts when there is no live client yet", () => {
    const session = new Session();
    expect(decideSessionStart(session, undefined, "ensure")).toBe("proceed");
    expect(decideSessionStart(session, "resume-1", "ensure")).toBe("proceed");
  });
});
