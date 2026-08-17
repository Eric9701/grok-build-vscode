import { describe, expect, it } from "vitest";
import {
  adapterCompactSignal,
  applyContextOccupancy,
  occupancyFromAdapterTurn,
  occupancyFromUsageLog,
  type ContextOccupancyState,
} from "../src/acp-dispatch";
import {
  contextUsageFromLog,
  persistSessionContext,
  persistedContextUsage,
  type SessionMetaOverride,
} from "../src/sessions";

describe("applyContextOccupancy", () => {
  it("starts empty and takes the first prompt size", () => {
    expect(applyContextOccupancy({}, { occupancy: 12000, window: 200000 })).toEqual({
      used: 12000,
      window: 200000,
      pendingCompact: false,
    });
  });

  it("grows with the conversation and ignores a later smaller prompt", () => {
    let state: ContextOccupancyState = {};
    state = applyContextOccupancy(state, { occupancy: 12000, window: 1000000 });
    state = applyContextOccupancy(state, { occupancy: 389000 });
    state = applyContextOccupancy(state, { occupancy: 135000 });
    expect(state.used).toBe(389000);
    expect(state.window).toBe(1000000);
    expect(state.pendingCompact).toBe(false);
  });

  it("adopts a lower value only after a compact", () => {
    let state: ContextOccupancyState = { used: 389000, window: 1000000 };
    state = applyContextOccupancy(state, { compacted: true });
    expect(state.pendingCompact).toBe(true);
    expect(state.used).toBe(389000);
    state = applyContextOccupancy(state, { occupancy: 48000 });
    expect(state).toEqual({ used: 48000, window: 1000000, pendingCompact: false });
  });

  it("adopts getContextUsage occupancy that arrives with the compact event", () => {
    expect(applyContextOccupancy(
      { used: 389000, window: 1000000 },
      { occupancy: 51200, compacted: true },
    )).toEqual({ used: 51200, window: 1000000, pendingCompact: false });
  });

  it("keeps the stored figure when compaction fails", () => {
    expect(applyContextOccupancy(
      { used: 389000, pendingCompact: true, window: 1000000 },
      { compactFailed: true, occupancy: 12 },
    )).toEqual({ used: 389000, window: 1000000, pendingCompact: false });
  });

  it("ignores non-positive observations", () => {
    expect(applyContextOccupancy({ used: 10 }, { occupancy: 0 })).toEqual({ used: 10, pendingCompact: false });
    expect(applyContextOccupancy({ used: 10 }, { occupancy: -4 })).toEqual({ used: 10, pendingCompact: false });
  });
});

describe("occupancyFromAdapterTurn", () => {
  it("uses the largest per-call observation when the result is a sum", () => {
    // research/adapter-usage-probe.cjs claude multi (2026-08-17):
    // 5 tools / ~6 model calls. usage_update.used stayed in the 36–37k
    // band; PromptResponse occupancy was the SUM, 221044.
    const calls = [
      36172, 36268, 36286, 36713, 36756, 37043, 37117, 37242, 37282, 37439, 37473, 37475, 37475,
    ];
    expect(occupancyFromAdapterTurn(221044, calls)).toBe(37475);
  });

  it("prefers the result when it is a single/last call (excludes output)", () => {
    expect(occupancyFromAdapterTurn(35507, [35511, 35511])).toBe(35507);
  });

  it("falls back to the result when the wire has no per-call updates", () => {
    expect(occupancyFromAdapterTurn(35507, [])).toBe(35507);
    expect(occupancyFromAdapterTurn(undefined, undefined)).toBeUndefined();
  });
});

describe("adapterCompactSignal", () => {
  it("recognizes Claude's exact compact status strings", () => {
    expect(adapterCompactSignal("Compacting...")).toBe("started");
    expect(adapterCompactSignal("\n\nCompacting completed.")).toBe("completed");
    expect(adapterCompactSignal("\n\nCompacting failed: no content")).toBe("failed");
    expect(adapterCompactSignal("I will compact the files later")).toBeNull();
  });

  it("recognizes Codex contextCompaction tool meta", () => {
    expect(adapterCompactSignal({
      sessionUpdate: "tool_call",
      title: "Context compacting",
      status: "in_progress",
      _meta: { contextCompaction: true },
    })).toBe("started");
    expect(adapterCompactSignal({
      sessionUpdate: "tool_call_update",
      title: "Context compacted",
      status: "completed",
      _meta: { contextCompaction: true },
    })).toBe("completed");
  });
});

describe("session context persistence lifecycle", () => {
  function observe(store: Record<string, SessionMetaOverride>, id: string, event: Parameters<typeof persistSessionContext>[1]) {
    store[id] = persistSessionContext(store[id] ?? {}, event);
    return persistedContextUsage(store[id]);
  }

  it("survives several turns, a reload, a restore, and a compact", () => {
    const id = "sess-1";
    const live: Record<string, SessionMetaOverride> = {};

    expect(persistedContextUsage(live[id])).toBeNull();

    expect(observe(live, id, { occupancy: 12000, window: 1000000 })?.used).toBe(12000);
    expect(observe(live, id, { occupancy: 48000 })?.used).toBe(48000);
    expect(observe(live, id, { occupancy: 389000 })?.used).toBe(389000);
    expect(observe(live, id, { occupancy: 135000 })?.used).toBe(389000);

    live[id] = {
      ...live[id],
      usageLog: [
        { afterUserMessage: 1, contextUsed: 12000 },
        { afterUserMessage: 2, contextUsed: 48000 },
        { afterUserMessage: 3, contextUsed: 389000 },
        { afterUserMessage: 4, contextUsed: 135000 },
      ],
    };

    const reloaded: Record<string, SessionMetaOverride> = JSON.parse(JSON.stringify(live));
    expect(persistedContextUsage(reloaded[id])).toEqual({ used: 389000, window: 1000000 });

    const restored = persistSessionContext(reloaded[id], {});
    expect(persistedContextUsage(restored)).toEqual({ used: 389000, window: 1000000 });

    reloaded[id] = persistSessionContext(restored, { compacted: true, occupancy: 51200 });
    reloaded[id] = {
      ...reloaded[id],
      usageLog: [
        ...(reloaded[id].usageLog ?? []),
        { afterUserMessage: 5, contextUsed: 51200, compacted: true },
      ],
    };
    expect(persistedContextUsage(reloaded[id])).toEqual({ used: 51200, window: 1000000 });

    const afterRestart: Record<string, SessionMetaOverride> = JSON.parse(JSON.stringify(reloaded));
    expect(persistedContextUsage(afterRestart[id])).toEqual({ used: 51200, window: 1000000 });
    expect(observe(afterRestart, id, { occupancy: 64000 })?.used).toBe(64000);
    expect(observe(afterRestart, id, { occupancy: 20000 })?.used).toBe(64000);
  });

  it("refolds occupancy after a rewind the way usageLog is truncated", () => {
    const log = [
      { afterUserMessage: 1, contextUsed: 12000 },
      { afterUserMessage: 2, contextUsed: 389000 },
      { afterUserMessage: 3, contextUsed: 51200, compacted: true },
      { afterUserMessage: 4, contextUsed: 64000 },
    ];
    expect(occupancyFromUsageLog(log).used).toBe(64000);
    expect(contextUsageFromLog(log.slice(0, 2), 1000000)).toEqual({
      used: 389000,
      window: 1000000,
      pendingCompact: false,
    });
    expect(occupancyFromUsageLog(log.slice(0, 3)).used).toBe(51200);
  });

  it("a multi-call turn does not persist the sum or clobber a compact adoption", () => {
    const id = "sess-multi";
    const live: Record<string, SessionMetaOverride> = {};

    const first = occupancyFromAdapterTurn(35507, [35511]);
    expect(observe(live, id, { occupancy: first, window: 1000000 })?.used).toBe(35507);

    const multi = occupancyFromAdapterTurn(221044, [36172, 37475]);
    expect(multi).toBe(37475);
    expect(observe(live, id, { occupancy: multi })?.used).toBe(37475);

    live[id] = persistSessionContext(live[id], { compacted: true, occupancy: 51200 });
    expect(persistedContextUsage(live[id])).toEqual({ used: 51200, window: 1000000 });

    const afterCompact = occupancyFromAdapterTurn(180000, [52000, 54800]);
    expect(afterCompact).toBe(54800);
    expect(observe(live, id, { occupancy: afterCompact })?.used).toBe(54800);

    live[id] = {
      ...live[id],
      usageLog: [
        { afterUserMessage: 1, contextUsed: 35507 },
        { afterUserMessage: 2, contextUsed: 37475 },
        { afterUserMessage: 3, contextUsed: 51200, compacted: true },
        { afterUserMessage: 4, contextUsed: 54800 },
      ],
    };
    const reloaded: Record<string, SessionMetaOverride> = JSON.parse(JSON.stringify(live));
    expect(persistedContextUsage(reloaded[id])).toEqual({ used: 54800, window: 1000000 });
    expect(occupancyFromUsageLog(reloaded[id].usageLog).used).toBe(54800);
  });
});
