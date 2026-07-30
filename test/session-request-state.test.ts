import { describe, expect, it } from "vitest";
import { SessionRequestState } from "../src/session-request-state";

describe("SessionRequestState", () => {
  it("keeps identical process-local request ids isolated by session", () => {
    const state = new SessionRequestState<object, string>();
    const desktop = {};
    const phone = {};

    state.set(desktop, 1, "desktop diff");
    state.set(phone, 1, "phone diff");

    expect(state.take(phone, 1)).toBe("phone diff");
    expect(state.take(desktop, 1)).toBe("desktop diff");
  });

  it("replaces only a stale request in the same session", () => {
    const state = new SessionRequestState<object, string>();
    const first = {};
    const second = {};

    expect(state.set(first, "1", "old")).toBeUndefined();
    expect(state.set(first, 1, "new")).toBe("old");
    expect(state.set(second, 1, "other")).toBeUndefined();
    expect(state.take(first, 1)).toBe("new");
    expect(state.take(second, 1)).toBe("other");
  });
});
