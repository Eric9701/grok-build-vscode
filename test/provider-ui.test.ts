import { describe, expect, it } from "vitest";
import {
  codexListEntry,
  compareHistoryEntries,
  connectedProviderIds,
  findCachedCodexSession,
  mergeProviderHistoryPage,
  mergeProviderSessionEntries,
  modelsForConnectedProviders,
  parseCodexVersionOutput,
  projectProviderKey,
  providerLoginState,
  versionIsOlder,
  type ProviderHistoryCursor,
} from "../src/provider-ui";
import type { SessionListEntry } from "../src/sessions";

describe("provider UI pure policy", () => {
  it("requires both explicit connection state and a located binary", () => {
    expect(connectedProviderIds(
      { grok: true, codex: true },
      { grok: true, codex: false },
    )).toEqual(["grok"]);
    expect(connectedProviderIds(
      { codex: true },
      { grok: true, codex: true },
    )).toEqual(["codex"]);
  });

  it("groups Grok first, uses live models, and implies a default for an empty cache", () => {
    const models = modelsForConnectedProviders(
      ["codex", "grok"],
      { codex: { models: [], seenAt: 1 } },
      { provider: "grok", models: [{ modelId: "grok-build", name: "Grok Build" }] },
    );
    expect(models).toEqual([
      expect.objectContaining({ provider: "grok", modelId: "grok-build" }),
      expect.objectContaining({ provider: "codex", modelId: "", defaultImplied: true }),
    ]);
  });

  it("maps Codex list titles to auto-name strength without overriding a rename", () => {
    const entry = codexListEntry(
      { sessionId: "c1", cwd: "C:\\Work", title: "Generated title", updatedAt: 20 },
      { c1: { provider: "codex", customName: "My name" } },
      100,
    );
    expect(entry).toMatchObject({
      id: "c1",
      provider: "codex",
      displayName: "My name",
      rawSummary: "Generated title",
      updatedAt: 20,
    });
  });

  it("merges connected providers into one recency order and filters by name", () => {
    const row = (id: string, updatedAt: number, provider?: "grok" | "codex"): SessionListEntry => ({
      id,
      cwd: "/repo",
      displayName: id,
      rawSummary: id,
      updatedAt,
      createdAt: updatedAt,
      numMessages: 1,
      provider,
    });
    const merged = mergeProviderSessionEntries(
      [row("grok-old", 1), row("grok-new", 4)],
      [row("codex-mid", 3, "codex")],
      ["grok", "codex"],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["grok-new", "codex-mid", "grok-old"]);
    expect(mergeProviderSessionEntries(merged, [], ["grok", "codex"], "codex").map((entry) => entry.id))
      .toEqual(["codex-mid"]);
    expect(mergeProviderSessionEntries(
      [row("grok-plan", 4)],
      [row("codex-other", 5, "codex")],
      ["codex"],
      "plan",
    ).map((entry) => entry.id)).toEqual(["grok-plan"]);
  });

  it("dedupes the final searchable provider merge by globally unique session id", () => {
    const grok = {
      id: "shared-id", cwd: "C:\\Work\\Repo", displayName: "old", rawSummary: "old",
      updatedAt: 1, createdAt: 1, numMessages: 1,
    } satisfies SessionListEntry;
    const codex = {
      ...grok, cwd: "c:\\work\\REPO", displayName: "new", rawSummary: "new",
      updatedAt: 2, provider: "codex" as const,
    };
    expect(mergeProviderSessionEntries([grok], [codex], ["grok", "codex"]))
      .toEqual([codex]);
  });

  it("folds Windows project keys but preserves POSIX case", () => {
    expect(projectProviderKey("C:\\Work\\Repo", "win32")).toBe("c:\\work\\repo");
    expect(projectProviderKey("/Work/Repo", "linux")).toBe("/Work/Repo");
  });

  it("uses the Codex catalog as existence proof without widening repository scope", () => {
    const codex: SessionListEntry = {
      id: "codex-cold",
      cwd: "/repo",
      displayName: "Cold Codex",
      rawSummary: "Cold Codex",
      updatedAt: 2,
      createdAt: 1,
      numMessages: 1,
      provider: "codex",
    };
    const belongs = (cwd: string, allowed: readonly string[]) => allowed.includes(cwd);
    expect(findCachedCodexSession([[codex]], "codex-cold", ["/repo"], belongs)).toBe(codex);
    expect(findCachedCodexSession([[codex]], "codex-cold", ["/other"], belongs)).toBeUndefined();
  });

  it("uses the Codex timestamp/id high-water mark without reinterpreting Grok's cursor", () => {
    const row = (id: string, updatedAt: number, provider?: "grok" | "codex"): SessionListEntry => ({
      id,
      cwd: "/repo",
      displayName: id,
      rawSummary: id,
      updatedAt,
      createdAt: updatedAt,
      numMessages: 1,
      provider,
    });
    const first = mergeProviderHistoryPage(
      { entries: [row("grok-20", 20)], nextOffset: 100, total: 102 },
      [row("codex-a", 20, "codex"), row("codex-b", 20, "codex"), row("codex-old", 10, "codex")],
      { grokOffset: 0 },
    );
    expect(first.entries.map((entry) => entry.id)).toEqual(["codex-a", "codex-b", "grok-20"]);
    expect(first.providerCursor).toEqual({
      grokOffset: 100,
      codexHighWater: { updatedAt: 20, id: "codex-b" },
    });
    expect(first.hasMore).toBe(true);

    const second = mergeProviderHistoryPage(
      { entries: [row("grok-visible", 1)], nextOffset: 102, total: 102 },
      [row("codex-a", 20, "codex"), row("codex-b", 20, "codex"), row("codex-old", 10, "codex")],
      first.providerCursor,
    );
    expect(second.entries.map((entry) => entry.id)).toEqual(["codex-old", "grok-visible"]);
    expect(second.providerCursor).toEqual({
      grokOffset: 102,
      codexHighWater: { updatedAt: 10, id: "codex-old" },
    });
    expect(second.hasMore).toBe(false);
  });

  it("pages the Codex suffix by limit after Grok is exhausted", () => {
    const row = (id: string, updatedAt: number): SessionListEntry => ({
      id, cwd: "/repo", displayName: id, rawSummary: id,
      updatedAt, createdAt: updatedAt, numMessages: 1, provider: "codex",
    });
    const codex = [row("c3", 3), row("c2", 2), row("c1", 1)];
    const first = mergeProviderHistoryPage(undefined, codex, { grokOffset: 100 }, 2);
    expect(first.entries.map((entry) => entry.id)).toEqual(["c3", "c2"]);
    expect(first.hasMore).toBe(true);
    const second = mergeProviderHistoryPage(undefined, codex, first.providerCursor, 2);
    expect(second.entries.map((entry) => entry.id)).toEqual(["c1"]);
    expect(second.hasMore).toBe(false);
  });

  it("every session id appears exactly once with none skipped across randomized combined pagination", () => {
    const row = (id: string, updatedAt: number, provider?: "grok" | "codex"): SessionListEntry => ({
      id,
      cwd: "/repo",
      displayName: id,
      rawSummary: id,
      updatedAt,
      createdAt: updatedAt,
      numMessages: 1,
      provider,
    });
    for (let seed = 1; seed <= 100; seed++) {
      let state = seed;
      const random = (max: number) => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state % max;
      };
      const rawGrok = Array.from({ length: 20 + random(80) }, (_, index) => ({
        mtime: random(30),
        entry: random(5) === 0 ? undefined : row(`g-${seed}-${index}`, random(25)),
      })).sort((a, b) => b.mtime - a.mtime);
      const codex = Array.from({ length: random(50) }, (_, index) =>
        row(`c-${seed}-${index}`, random(25), "codex"));
      const pageSize = 1 + random(12);
      const emitted: SessionListEntry[] = [];
      const emittedPage = new Map<string, number>();
      let cursor: ProviderHistoryCursor = { grokOffset: 0 };
      let page = 0;
      let firstPageReads = 0;
      let hasMore = true;

      while (hasMore) {
        const rawPage = rawGrok.slice(cursor.grokOffset, cursor.grokOffset + pageSize);
        if (page === 0) firstPageReads = rawPage.length;
        const grokPage = {
          entries: rawPage.flatMap((slot) => slot.entry ? [slot.entry] : []).sort(compareHistoryEntries),
          nextOffset: cursor.grokOffset + rawPage.length,
          total: rawGrok.length,
        };
        const merged = mergeProviderHistoryPage(grokPage, codex, cursor);
        for (const entry of merged.entries) {
          emitted.push(entry);
          emittedPage.set(entry.id, page);
        }
        cursor = merged.providerCursor;
        hasMore = merged.hasMore;
        page++;
        expect(page).toBeLessThanOrEqual(Math.ceil(rawGrok.length / pageSize) + 1);
      }

      const oracle = [...rawGrok.flatMap((slot) => slot.entry ? [slot.entry] : []), ...codex]
        .sort(compareHistoryEntries);
      expect(new Set(emitted.map((entry) => entry.id)).size, `seed ${seed}: duplicate id`).toBe(emitted.length);
      expect(emitted.map((entry) => entry.id).sort(), `seed ${seed}: skipped id`)
        .toEqual(oracle.map((entry) => entry.id).sort());
      expect(firstPageReads, `seed ${seed}: first-open reads`).toBe(Math.min(pageSize, rawGrok.length));
      for (let index = 1; index < emitted.length; index++) {
        if (emitted[index - 1].updatedAt >= emitted[index].updatedAt) continue;
        expect(emitted[index].provider, `seed ${seed}: non-Grok ordering inversion`).not.toBe("codex");
        expect(emittedPage.get(emitted[index].id), `seed ${seed}: within-page inversion`)
          .not.toBe(emittedPage.get(emitted[index - 1].id));
      }
    }
  });

  it("selects the provider-specific second-stage login state", () => {
    expect(providerLoginState("grok")).toBe("auth-required");
    expect(providerLoginState("codex")).toBe("codex-login");
  });

  it("keeps Codex ordering stable across an open-only adapter restamp, then moves on send", () => {
    const raw = { sessionId: "codex-old", cwd: "/repo", title: "Old", updatedAt: 100 };
    const first = codexListEntry(raw, {});
    const opened = codexListEntry({ ...raw, updatedAt: 900 }, {
      "codex-old": { provider: "codex", activeAt: first.updatedAt },
    });
    const other = codexListEntry({
      sessionId: "codex-new", cwd: "/repo", title: "New", updatedAt: 500,
    }, {});

    expect(mergeProviderSessionEntries([], [opened, other], ["codex"]).map((entry) => entry.id))
      .toEqual(["codex-new", "codex-old"]);

    const sent = codexListEntry(raw, {
      "codex-old": { provider: "codex", activeAt: 1_000 },
    });
    expect(mergeProviderSessionEntries([], [sent, other], ["codex"]).map((entry) => entry.id))
      .toEqual(["codex-old", "codex-new"]);
  });

  it("parses the binary version rather than using the Codex ACP handshake version", () => {
    expect(parseCodexVersionOutput("codex-cli 0.147.0\n")).toBe("0.147.0");
    expect(parseCodexVersionOutput("codex 0.148.0-beta.1")).toBe("0.148.0-beta.1");
    expect(parseCodexVersionOutput("codex-acp adapter")).toBe("");
    expect(versionIsOlder("0.146.0", "0.147.0")).toBe(true);
    expect(versionIsOlder("0.147.0", "0.147.0")).toBe(false);
    expect(versionIsOlder("0.148.0", "0.147.0")).toBe(false);
  });
});
