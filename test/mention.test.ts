import { describe, it, expect } from "vitest";
import {
  MENTION_RESULT_LIMIT,
  buildExcludeGlob,
  filterMentionFiles,
  normalizeRelPath,
  orderMentionIndex,
} from "../src/mention";
// The webview half of the feature (token detection + pick rewrite) lives in the
// shared plain-JS helpers so chat.js and the tests exercise the same code.
import { getMentionQuery, applyMentionPick } from "../media/webview-helpers.js";

describe("getMentionQuery (webview token detection)", () => {
  it("triggers on @ at the start of the text", () => {
    expect(getMentionQuery("@", 1)).toBe("");
    expect(getMentionQuery("@src", 4)).toBe("src");
  });

  it("triggers after whitespace and newlines", () => {
    expect(getMentionQuery("fix @ch", 7)).toBe("ch");
    expect(getMentionQuery("line one\n@te", 12)).toBe("te");
    expect(getMentionQuery("a\t@x", 4)).toBe("x");
  });

  it("does not trigger mid-word (emails, handles)", () => {
    expect(getMentionQuery("user@host", 9)).toBeNull();
    expect(getMentionQuery("a@b", 3)).toBeNull();
  });

  it("is caret-anchored: text after the caret is ignored", () => {
    // Caret right after "@s" — the trailing prose doesn't kill the token.
    expect(getMentionQuery("@s and more", 2)).toBe("s");
    // Caret in the prose after the token's closing space — no token.
    expect(getMentionQuery("@src/a.ts done", 14)).toBeNull();
  });

  it("closes on whitespace and on a second @", () => {
    expect(getMentionQuery("@src ", 5)).toBeNull();
    expect(getMentionQuery("@a@b", 4)).toBeNull(); // second @ isn't whitespace-preceded
  });

  it("allows path characters in the token", () => {
    expect(getMentionQuery("@src/chips.ts", 13)).toBe("src/chips.ts");
    expect(getMentionQuery("@.github/ci", 11)).toBe(".github/ci");
  });
});

describe("applyMentionPick (webview pick rewrite)", () => {
  it("replaces the partial token with @relPath and a trailing space", () => {
    const r = applyMentionPick("@ch", 3, "src/chips.ts");
    expect(r.text).toBe("@src/chips.ts ");
    expect(r.caret).toBe(14);
  });

  it("preserves text before and after the caret", () => {
    const r = applyMentionPick("fix @ch please", 7, "src/chips.ts");
    expect(r.text).toBe("fix @src/chips.ts  please");
    expect(r.caret).toBe("fix @src/chips.ts ".length);
  });

  it("handles a bare @ (empty token)", () => {
    const r = applyMentionPick("see @", 5, "a.ts");
    expect(r.text).toBe("see @a.ts ");
    expect(r.caret).toBe(10);
  });

  it("does not misread $ sequences in a path as replace directives", () => {
    const r = applyMentionPick("@p", 2, "src/$&weird$'.ts");
    expect(r.text).toBe("@src/$&weird$'.ts ");
  });
});

describe("filterMentionFiles (host ranking)", () => {
  const files = [
    "README.md",
    "src/chips.ts",
    "src/chat-helpers.ts",
    "media/chat.js",
    "test/chips.test.ts",
    "docs/architecture.md",
  ];

  it("empty query passes the index through (capped)", () => {
    expect(filterMentionFiles(files, "")).toEqual(files);
    expect(filterMentionFiles(files, "", 2)).toEqual(["README.md", "src/chips.ts"]);
  });

  it("ranks basename prefix above basename substring above path substring", () => {
    const ranked = filterMentionFiles(files, "chat");
    // Prefix on basename: chat.js + chat-helpers.ts (shorter path first);
    // then nothing else matches "chat" in these fixtures.
    expect(ranked[0]).toBe("media/chat.js");
    expect(ranked[1]).toBe("src/chat-helpers.ts");
  });

  it("matches directory-qualified queries via the path tier", () => {
    expect(filterMentionFiles(files, "src/ch")).toEqual(["src/chips.ts", "src/chat-helpers.ts"]);
  });

  it("is case-insensitive", () => {
    expect(filterMentionFiles(files, "readme")).toEqual(["README.md"]);
    expect(filterMentionFiles(files, "CHIPS")[0]).toBe("src/chips.ts");
  });

  it("falls back to in-order subsequence matching", () => {
    // "darch" is not a substring of docs/architecture.md but is a subsequence.
    expect(filterMentionFiles(files, "darch")).toEqual(["docs/architecture.md"]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterMentionFiles(files, "zzz-nope")).toEqual([]);
  });

  it("caps results at the limit", () => {
    const many = Array.from({ length: 100 }, (_, i) => `src/f${String(i).padStart(3, "0")}.ts`);
    expect(filterMentionFiles(many, "f").length).toBe(MENTION_RESULT_LIMIT);
    expect(filterMentionFiles(many, "f", 5).length).toBe(5);
  });

  it("prefers the shorter path within a tier", () => {
    const ranked = filterMentionFiles(["deep/nested/dir/chips.ts", "src/chips.ts"], "chips");
    expect(ranked).toEqual(["src/chips.ts", "deep/nested/dir/chips.ts"]);
  });
});

describe("buildExcludeGlob", () => {
  it("always excludes node_modules and .git", () => {
    expect(buildExcludeGlob([])).toBe("{**/node_modules/**,**/.git/**}");
    expect(buildExcludeGlob([undefined, undefined])).toBe("{**/node_modules/**,**/.git/**}");
  });

  it("merges only true-valued patterns from the config maps", () => {
    const glob = buildExcludeGlob([
      { "**/out/**": true, "**/keep/**": false },
      // files.exclude values can be `{ when: … }` clause objects — not `true`.
      { "**/dist/**": true, "**/*.meta": { when: "$(basename)" } as unknown },
    ] as Array<Record<string, unknown>>);
    expect(glob).toContain("**/out/**");
    expect(glob).toContain("**/dist/**");
    expect(glob).not.toContain("keep");
    expect(glob).not.toContain("*.meta");
  });

  it("dedupes a pattern present in both maps", () => {
    const glob = buildExcludeGlob([{ "**/out/**": true }, { "**/out/**": true }]);
    expect(glob.match(/\*\*\/out\/\*\*/g)?.length).toBe(1);
  });
});

describe("orderMentionIndex / normalizeRelPath", () => {
  it("orders shallow-first, then alphabetical", () => {
    expect(orderMentionIndex(["src/z.ts", "b.md", "a.md", "src/a/deep.ts"])).toEqual([
      "a.md",
      "b.md",
      "src/z.ts",
      "src/a/deep.ts",
    ]);
  });

  it("does not mutate its input", () => {
    const input = ["b.md", "a.md"];
    orderMentionIndex(input);
    expect(input).toEqual(["b.md", "a.md"]);
  });

  it("normalizeRelPath converts backslashes", () => {
    expect(normalizeRelPath("src\\a\\b.ts")).toBe("src/a/b.ts");
    expect(normalizeRelPath("src/a.ts")).toBe("src/a.ts");
  });
});
