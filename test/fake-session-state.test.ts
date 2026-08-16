import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  UNIQUE_ENV,
  createFakeSessionState,
} = require("./fixtures/fake-session-state.cjs") as {
  UNIQUE_ENV: string;
  createFakeSessionState: (opts?: {
    env?: Record<string, string | undefined>;
    pid?: number;
  }) => { readonly id: string; onNew(): string; onLoad(requested?: string): string };
};

describe("fake ACP session ids", () => {
  it("defaults to the historical singleton so existing fixtures stay stable", () => {
    const a = createFakeSessionState({ env: {}, pid: 11 });
    const b = createFakeSessionState({ env: {}, pid: 22 });
    expect(a.onNew()).toBe("fake-session-1");
    expect(b.onNew()).toBe("fake-session-1");
  });

  it("mints a distinct id per session/new when unique mode is on", () => {
    const wsA = createFakeSessionState({ env: { [UNIQUE_ENV]: "1" }, pid: 11 });
    const wsB = createFakeSessionState({ env: { [UNIQUE_ENV]: "1" }, pid: 22 });
    const first = wsA.onNew();
    const second = wsA.onNew();
    const other = wsB.onNew();
    expect(first).not.toBe(second);
    expect(first).not.toBe(other);
    expect(second).not.toBe(other);
    expect(first).toMatch(/^fake-session-11-1$/);
    expect(second).toMatch(/^fake-session-11-2$/);
    expect(other).toMatch(/^fake-session-22-1$/);
  });

  it("keeps a loaded id as the active id for later notifications", () => {
    const state = createFakeSessionState({ env: { [UNIQUE_ENV]: "1" }, pid: 99 });
    const minted = state.onNew();
    expect(minted).toMatch(/^fake-session-99-1$/);
    expect(state.onLoad("kept-across-restart")).toBe("kept-across-restart");
    expect(state.id).toBe("kept-across-restart");
    expect(state.onLoad("")).toBe("kept-across-restart");
  });

  it("a pid-derived mint still yields to session/load", () => {
    const state = createFakeSessionState({
      env: { FAKE_SESSION_ID_FROM_PID: "1" },
      pid: 4242,
    });
    expect(state.onNew()).toBe("fake-session-4242-1");
    expect(state.onLoad("stored-from-disk")).toBe("stored-from-disk");
    expect(state.id).toBe("stored-from-disk");
  });
});
