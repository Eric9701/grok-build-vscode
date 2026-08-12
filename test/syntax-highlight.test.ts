import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const hl = require("../media/syntax-highlight.js") as {
  escapeHtml(s: string): string;
  highlightCode(text: string, lang: string): string;
  languageForPath(p: string): string;
  MAX_HIGHLIGHT_BYTES: number;
  _rules: Record<string, Array<{ type: string; re: string; flags?: string }>>;
};

/** What the browser will actually show: tags removed, entities decoded. The
 *  highlighter is only allowed to ADD markup, never to change a character of
 *  the file, so this must reproduce the input exactly. */
function renderedText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const SAMPLES: Array<{ lang: string; text: string }> = [
  { lang: "ts", text: "// note\nexport const x: number = 42; // trailing\nconst s = `a${b}c`;\n" },
  { lang: "js", text: "function f(a) { /* block\nspans */ return 'it\\'s'; }\n" },
  { lang: "py", text: '# c\ndef f(x):\n    """doc\n    string"""\n    return x + 1\n' },
  { lang: "sh", text: '#!/bin/bash\nif [ -f "$1" ]; then\n  echo "hi"\nfi\n' },
  { lang: "sql", text: "-- comment\nSELECT \"col\", count(*) FROM t WHERE a = 'x' /* c */;\n" },
  { lang: "css", text: "/* c */\n.a > #b:hover { color: #fff; margin: 0 10px; }\n@media print { a { b: c } }\n" },
  { lang: "markup", text: '<!-- c -->\n<div class="a" data-x=\'y\' hidden>text &amp; more</div>\n' },
  { lang: "json", text: '{"a": 1, "b": [true, null, "s"], "c": {"d": -2.5e3}}\n' },
  { lang: "yaml", text: "# c\nkey: value\nlist:\n  - a: 1\n    b: 'q'\n" },
  { lang: "toml", text: '# c\n[section]\nkey = "v"\nn = 12\nflag = true\n' },
  { lang: "ini", text: "; c\n[sec]\nkey=value\n# other\n" },
  { lang: "diff", text: "diff --git a b\n@@ -1 +1 @@\n-old\n+new\n context\n" },
  { lang: "make", text: "# c\nCC = gcc\nall: build\n\tmake -C sub\n" },
  { lang: "go", text: 'package main\nimport "fmt"\nfunc main() { fmt.Println("hi") }\n' },
  { lang: "rust", text: 'fn main() { let s: String = "x".into(); // c\n}\n' },
  { lang: "c", text: "#include <stdio.h>\nint main(void) { return 0; /* c */ }\n" },
  { lang: "rb", text: "# c\ndef f(a)\n  puts \"x\#{a}\"\nend\n" },
  { lang: "ps1", text: '# c\nfunction Get-Thing { param($x) Write-Output "$x" }\n' },
];

describe("syntax highlighter — rule hygiene", () => {
  // Rules are merged into one alternation and identified by group index, so a
  // capturing group inside any rule silently shifts every token type after it.
  // Mechanical, because this is exactly the mistake a future rule author makes.
  it("every rule uses non-capturing groups only", () => {
    for (const [lang, rules] of Object.entries(hl._rules)) {
      for (const rule of rules) {
        // `re|` matches empty, so the result's length is 1 + capture-group count.
        const probe = new RegExp(`${rule.re}|`).exec("");
        expect(probe, `${lang}/${rule.type} failed to compile`).not.toBeNull();
        expect(probe!.length, `${lang}/${rule.type} contains a capturing group`).toBe(1);
      }
    }
  });

  it("every ruleset compiles and every declared language is reachable", () => {
    for (const lang of Object.keys(hl._rules)) {
      expect(() => hl.highlightCode("x", lang)).not.toThrow();
    }
  });
});

describe("syntax highlighter — the file survives", () => {
  // THE invariant. Highlighting is decoration: it may add markup and nothing
  // else. If this ever fails, the panel is showing something the file does not
  // say — which matters far more than a miscoloured keyword.
  it.each(SAMPLES)("$lang round-trips to the exact source", ({ lang, text }) => {
    expect(renderedText(hl.highlightCode(text, lang))).toBe(text);
  });

  it("round-trips text containing markup, entities and quotes", () => {
    const nasty = `<div>&amp; "q" 'a' </div>\n<!-- x -->\n`;
    for (const lang of Object.keys(hl._rules)) {
      expect(renderedText(hl.highlightCode(nasty, lang)), lang).toBe(nasty);
    }
  });

  it("preserves CRLF and trailing whitespace untouched", () => {
    const text = "const a = 1;  \r\n\r\n// end\t\r\n";
    expect(renderedText(hl.highlightCode(text, "ts"))).toBe(text);
  });
});

describe("syntax highlighter — escaping", () => {
  it("never emits an executable tag from file contents", () => {
    const attack = `<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n`;
    for (const lang of [...Object.keys(hl._rules), "", "unknown"]) {
      const out = hl.highlightCode(attack, lang);
      expect(out, lang).not.toContain("<script");
      expect(out, lang).not.toContain("<img");
      expect(out, lang).not.toContain("onerror=\"");
    }
  });

  it("escapes inside a token as well as between tokens", () => {
    // The string token itself carries the angle brackets — a highlighter that
    // escapes only the gaps would emit live markup from a quoted string.
    const out = hl.highlightCode(`const s = "<b>bold</b>";`, "ts");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;b&gt;");
  });

  it("escapes an unknown language to plain text with no spans", () => {
    const out = hl.highlightCode("<x> & 'y'", "");
    expect(out).toBe("&lt;x&gt; &amp; &#39;y&#39;");
  });
});

describe("syntax highlighter — tokens people actually look for", () => {
  const classes = (html: string, cls: string) =>
    [...html.matchAll(new RegExp(`<span class="hl-${cls}">([^<]*)</span>`, "g"))].map((m) => m[1]);

  it("marks comments, strings and keywords in TypeScript", () => {
    const out = hl.highlightCode(`// hi\nconst a = "s";`, "ts");
    expect(classes(out, "com")).toContain("// hi");
    expect(classes(out, "str")).toContain("&quot;s&quot;");
    expect(classes(out, "kw")).toContain("const");
  });

  it("does not let a keyword inside a comment or string escape its token", () => {
    // Comments and strings are matched FIRST, so their contents stay one token.
    const out = hl.highlightCode(`// const x\nconst y = "const z";`, "ts");
    expect(classes(out, "kw")).toEqual(["const"]);
  });

  it("prefers the longest keyword, so `constructor` is not `const` + rest", () => {
    const out = hl.highlightCode("constructor()", "ts");
    expect(classes(out, "kw")).not.toContain("const");
  });

  it("treats SQL keywords case-insensitively", () => {
    const lower = hl.highlightCode("select * from t", "sql");
    const upper = hl.highlightCode("SELECT * FROM t", "sql");
    expect(classes(lower, "kw")).toContain("select");
    expect(classes(upper, "kw")).toContain("SELECT");
  });

  it("names a JSON key differently from a JSON string value", () => {
    const out = hl.highlightCode('{"k": "v"}', "json");
    expect(classes(out, "prop")).toContain("&quot;k&quot;");
    expect(classes(out, "str")).toContain("&quot;v&quot;");
  });

  it("splits an HTML tag into name, attribute and value", () => {
    const out = hl.highlightCode('<a href="x">t</a>', "markup");
    expect(classes(out, "tagname")).toContain("a");
    expect(classes(out, "atr")).toContain("href");
    expect(classes(out, "str")).toContain("&quot;x&quot;");
    // …and the text between tags is not swallowed by the tag token.
    expect(renderedText(out)).toBe('<a href="x">t</a>');
  });

  it("colours diff add/remove lines by line, not by character", () => {
    const out = hl.highlightCode("-gone\n+added\n same\n", "diff");
    expect(classes(out, "del")).toEqual(["-gone"]);
    expect(classes(out, "add")).toEqual(["+added"]);
  });

  it("keeps an unterminated block comment from swallowing nothing at all", () => {
    // Runs to EOF rather than failing to match, which would leave the rest of
    // the file coloured as code when it is all commented out.
    const out = hl.highlightCode("code();\n/* open\nstill comment", "ts");
    expect(classes(out, "com")).toContain("/* open\nstill comment");
  });
});

/**
 * This runs on the UI thread — of a phone — so a pathological file must not be
 * able to wedge it. Twice now it could:
 *
 *  - CSS's property rule had no left anchor, so it was retried at every
 *    position and each attempt ran to end of input and backtracked a character
 *    at a time: 40KB took 2.3s, 80KB 45s, 160KB 201s.
 *  - Every STRING rule had the same shape for a different reason: an
 *    unterminated quote made the match fail, so the scan restarted at the next
 *    quote, and the next. The same 60KB blob took 1638ms without its closing
 *    quote and 4ms with it.
 *
 * Both are quadratic, and `MAX_HIGHLIGHT_BYTES` bounds the input, not the work.
 *
 * HOW IT MEASURES, and this took three attempts to get right — worth recording,
 * because each attempt failed in a way that looked like the previous fix.
 *
 *  1. An absolute budget at a small size. A shape timing 59ms alone hit 2003ms
 *     under vitest's parallel load, so the budget had to be loosened; loosened,
 *     it no longer caught the string defect, which fit inside it at that size.
 *  2. A ratio — does doubling the input more than double the time. Immune to
 *     machine speed, but not to a single GC landing in one of the two samples:
 *     a healthy 3ms baseline drifting to 45ms reads as "15x". Ten provably
 *     linear shapes failed.
 *  3. What is here now. The signal being hunted is ORDERS OF MAGNITUDE — the
 *     regressions measured 40KB/2.3s, 160KB/201s, 60KB/1638ms-vs-4ms — so the
 *     input is sized to make a quadratic rule take SECONDS while a linear one
 *     takes milliseconds, and the budget sits in the wide gap between. Best of
 *     three suppresses the GC spikes that defeated attempt 2.
 *
 * The trap common to 1 and 2 was measuring something close to what a healthy
 * run costs. Nothing here is a benchmark: `quotes only` legitimately spends
 * most of its time ALLOCATING (its markup is ~35x its input), and that cost is
 * real, linear, and none of this test's business.
 */
describe("syntax highlighter — pathological input cannot wedge the thread", () => {
  // Sized for a WIDE gap rather than a plausible one, because a perf check that
  // fails once in seven runs is worse than none — it teaches everyone to stop
  // reading the output. Measured at this size: the worst healthy shape is 132ms
  // best-of-three (markup/unclosed tags) and the whole block costs ~3s, while
  // the string and CSS regressions this guards land at 12–20s. So there is ~15x
  // of headroom below the budget and ~6x of margin above it. An earlier
  // half-size version left only ~2x above and flaked.
  const BUDGET_MS = 2000;
  const SIZE = 60000;
  const rep = (s: string, n: number) => s.repeat(n);

  // Shapes are built from a repeat count so the size is tunable in one place.
  // EVERY ONE MUST STAY UNDER MAX_HIGHLIGHT_BYTES — above it `highlightCode`
  // returns plainly-escaped text without running a single rule, so an oversized
  // shape silently benchmarks the escaper and guards nothing. One of these did
  // exactly that (`unterminated template` was 300,001 characters against a
  // 262,144 cap); the test below now asserts the whole corpus is in range.
  const SHAPES: Array<[string, (n: number) => string]> = [
    ["identifier run with no delimiters", (n) => rep("x", n * 4)],
    ["unterminated string", (n) => '"' + rep("a\\", n)],
    ["unterminated block comment", (n) => "/*" + rep("x", n * 4)],
    ["unterminated template", (n) => "`" + rep("a${b}", Math.floor(n / 3))],
    // A run of digits that fails the tail. Its own size, because this one is
    // not merely quadratic: the rule it guards combined an overlapping `\d*`
    // and `\d+`, so the engine could split the run at every position and tried
    // all of them — 12.8s on TWO KILOBYTES. Scaling it with the others would
    // mean a regression never finishes rather than failing.
    ["digit run failing its unit", () => rep("1", 2000) + "a"],
    ["quotes only", (n) => rep('"', n * 2)],
    ["backslashes", (n) => rep("\\", n * 2)],
    // The shapes the first version of this list missed. A run of quotes alone
    // is cheap and a run of backslashes alone is cheap; ALTERNATING them is
    // what made every string rule quadratic. A corpus holding only the shapes
    // you already thought of proves nothing.
    ["escaped double quotes", (n) => rep('"\\', n)],
    ["escaped single quotes", (n) => rep("'\\", n)],
    ["escaped backticks", (n) => rep("`\\", n)],
    // The realistic version of the same thing: a long string literal whose
    // closing quote is missing — a truncated fixture, or a trailing backslash.
    ["unclosed literal", (n) => 'const payload = "' + rep('{\\"k\\":\\"v\\"},', n / 4)],
    ["open angle brackets", (n) => rep("<", n * 2)],
    ["unclosed tags", (n) => rep('<a b="', n / 2)],
    ["triple quotes", (n) => '"""' + rep("x", n * 3)],
    ["comment openers", (n) => rep("/*", n)],
    ["hyphens", (n) => rep("-", n * 2)],
    ["colons", (n) => rep(":", n * 2)],
  ];

  // BEST of three, not a single sample: the output here is megabytes of markup,
  // so one GC landing inside a lone measurement is enough to treble it. The
  // minimum is the least-contaminated estimate of what the work actually costs.
  const timeBest = (text: string, lang: string) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      const out = hl.highlightCode(text, lang);
      const elapsed = Date.now() - started;
      expect(typeof out).toBe("string");
      if (elapsed < best) best = elapsed;
    }
    return best;
  };

  it("every shape actually reaches the rules", () => {
    // Above the cap `highlightCode` never runs a rule, so an oversized shape
    // measures the escaper and proves nothing — which is how one of them sat
    // in this list doing nothing at all.
    for (const [name, build] of SHAPES) {
      const size = build(SIZE).length;
      expect(size, `${name} is ${size} bytes, past the ${hl.MAX_HIGHLIGHT_BYTES} cap`)
        .toBeLessThan(hl.MAX_HIGHLIGHT_BYTES);
    }
  });

  for (const lang of Object.keys(hl._rules)) {
    it(`${lang} survives every pathological shape`, () => {
      for (const [name, build] of SHAPES) {
        const elapsed = timeBest(build(SIZE), lang);
        expect(
          elapsed,
          `${lang}/${name} took ${elapsed}ms — a linear rule spends milliseconds ` +
            `on this input, so this is backtracking`,
        ).toBeLessThan(BUDGET_MS);
      }
    });
  }
});

describe("syntax highlighter — limits", () => {
  it("falls back to plain escaped text above the size cap", () => {
    const big = `const a = 1; // x\n`.repeat(Math.ceil(hl.MAX_HIGHLIGHT_BYTES / 18) + 10);
    expect(big.length).toBeGreaterThan(hl.MAX_HIGHLIGHT_BYTES);
    const out = hl.highlightCode(big, "ts");
    expect(out).not.toContain("<span");
    expect(renderedText(out)).toBe(big);
  });

  it("handles an empty file", () => {
    expect(hl.highlightCode("", "ts")).toBe("");
  });
});

describe("languageForPath", () => {
  it("resolves by extension, case-insensitively", () => {
    expect(hl.languageForPath("src/a.TS")).toBe("ts");
    expect(hl.languageForPath("C:\\w\\b.sql")).toBe("sql");
    expect(hl.languageForPath("deep/dir/x.scss")).toBe("css");
    // NOT panel coverage: `classifyFilePreview` checks PREVIEW_IMAGE_EXT before
    // PREVIEW_TEXT_EXT and `.svg` is in both, so the panel opens it as an IMAGE
    // and never asks for a language. This pins the mapping only, against the day
    // a "view source" affordance makes it reachable.
    expect(hl.languageForPath("a.svg")).toBe("markup");
  });

  it("resolves the extensionless names that are real languages", () => {
    expect(hl.languageForPath("Dockerfile")).toBe("sh");
    expect(hl.languageForPath("build/Makefile")).toBe("make");
  });

  it("treats a leading-dot file as a name, not an extension", () => {
    // `.env` must not resolve as the extension "env" of an empty basename.
    expect(hl.languageForPath(".env")).toBe("ini");
    expect(hl.languageForPath(".gitignore")).toBe("ini");
  });

  it("returns empty for anything it has no ruleset for", () => {
    expect(hl.languageForPath("a.bin")).toBe("");
    expect(hl.languageForPath("noext")).toBe("");
    expect(hl.languageForPath("")).toBe("");
    expect(hl.languageForPath(undefined as any)).toBe("");
  });

  it("every language it can name has a ruleset", () => {
    // A path resolving to a language with no rules would silently paint plain
    // text — the mapping and the rulesets must not drift apart.
    for (const name of ["a.ts", "a.py", "a.sql", "a.css", "a.html", "a.json", "a.yml",
      "a.toml", "a.ini", "a.diff", "Makefile", "a.go", "a.rs", "a.rb", "a.ps1", "a.sh"]) {
      const lang = hl.languageForPath(name);
      expect(hl._rules[lang], `${name} → ${lang}`).toBeTruthy();
    }
  });
});
