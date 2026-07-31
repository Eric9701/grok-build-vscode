import { describe, expect, it } from "vitest";
import {
  Session,
  beginQueuedSendCommit,
  finishQueuedSendCommit,
} from "../src/session";

describe("queued send commit", () => {
  it("retains a queued send when the send does not commit", () => {
    const session = new Session();
    session.queuedSends = ["do not lose this"];
    session.queuedSendRequiresRelay = true;

    const claim = beginQueuedSendCommit(session, "do not lose this")!;
    expect(finishQueuedSendCommit(session, claim, false)).toBe(false);
    expect(session.queuedSends).toEqual(["do not lose this"]);
    expect(session.queuedSendRequiresRelay).toBe(true);
  });

  it("releases a queued send exactly once when the send commits", () => {
    const session = new Session();
    session.queuedSends = ["run this once"];
    session.queuedSendRequiresRelay = true;

    const claim = beginQueuedSendCommit(session, "run this once")!;
    expect(finishQueuedSendCommit(session, claim, true)).toBe(true);
    expect(session.queuedSends).toEqual([]);
    expect(session.queuedSendRequiresRelay).toBe(false);
    expect(finishQueuedSendCommit(session, claim, true)).toBe(false);
  });

  it("keeps text appended while a failing send is awaiting commit", () => {
    const session = new Session();
    session.queuedSends = ["first part"];
    session.queuedSendRequiresRelay = true;

    const claim = beginQueuedSendCommit(session, "first part")!;
    session.queuedSends[0] += "\n\nsecond part";
    expect(finishQueuedSendCommit(session, claim, false)).toBe(false);
    expect(session.queuedSends).toEqual(["first part\n\nsecond part"]);
  });

  it("releases only the committed prefix when text was appended in flight", () => {
    const session = new Session();
    session.queuedSends = ["first part"];
    session.queuedSendRequiresRelay = true;

    const claim = beginQueuedSendCommit(session, "first part")!;
    session.queuedSends[0] += "\n\nsecond part";
    expect(finishQueuedSendCommit(session, claim, true)).toBe(true);
    expect(session.queuedSends).toEqual(["second part"]);
    expect(session.queuedSendRequiresRelay).toBe(true);
  });
});
