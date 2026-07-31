import { describe, expect, it } from "vitest";
import { Session, sessionUiSnapshot } from "../src/session";

describe("sessionUiSnapshot", () => {
  it("restores the focused session's own chips and queued composer state", () => {
    const session = new Session();
    session.chips = [{
      id: "chip-b",
      path: "/repo-b/file.ts",
      relPath: "file.ts",
      hidden: false,
    }];
    session.queuedSends = ["queued for B"];

    expect(sessionUiSnapshot(session, "plan")).toEqual([
      { type: "modeChanged", modeId: "plan" },
      { type: "planModeAvailability", available: true, reason: undefined },
      { type: "chips", chips: session.chips },
      { type: "queuedSends", items: ["queued for B"] },
    ]);
  });

  it("keeps an old CLI's Plan restriction attached to that session", () => {
    const session = new Session();
    session.planModeAvailable = false;
    session.planModeUnavailableReason = "Plan mode requires a newer CLI.";

    expect(sessionUiSnapshot(session, "agent")).toContainEqual({
      type: "planModeAvailability",
      available: false,
      reason: "Plan mode requires a newer CLI.",
    });
  });
});
