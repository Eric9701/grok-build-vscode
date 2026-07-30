import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { beginAuthRecovery } from "../src/auth-recovery";

describe("session-scoped auth recovery", () => {
  it("reloads the owning pool member instead of the locally focused session", () => {
    const source = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const recovery = source.slice(
      source.indexOf("private async recoverAuthAndResend"),
      source.indexOf("private maybeGenerateTitle"),
    );

    expect(recovery).toContain("this.startSession(resumeId, session)");
    expect(recovery).not.toContain("session !== this.focused");
  });

  it("arms a remote-owned session without requiring it to be locally focused", () => {
    const remote = { activeSessionId: "remote-session", authRecoveryTried: false };

    expect(beginAuthRecovery(remote)).toBe("remote-session");
    expect(remote.authRecoveryTried).toBe(true);
  });

  it("preserves resend-once bookkeeping independently for concurrent sessions", () => {
    const local = { activeSessionId: "local-session", authRecoveryTried: false };
    const remote = { activeSessionId: "remote-session", authRecoveryTried: false };

    expect(beginAuthRecovery(remote)).toBe("remote-session");
    expect(beginAuthRecovery(remote)).toBeUndefined();
    expect(beginAuthRecovery(local)).toBe("local-session");
  });

  it("requires persisted history to reload", () => {
    expect(beginAuthRecovery({ authRecoveryTried: false })).toBeUndefined();
  });
});
