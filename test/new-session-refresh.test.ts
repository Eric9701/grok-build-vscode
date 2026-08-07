import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A new local session must refresh the project's conversation list.
 *
 * The symptom was oddly specific: starting a new session moved the project to
 * the top of the rail but added no row for the conversation, and only closing
 * and reopening the project made it appear. Both halves are explained by
 * `newFocusedSession` posting the repo CATALOG (which re-sorts projects by
 * recency) and never the sessions LIST (which is where the rail's rows come
 * from). The remote path has always sent its own list; only the local one
 * missed it, so it went unnoticed until the desktop grew a rail.
 *
 * This is a source-shape guard, and worth being honest about: it proves the
 * call is present and correctly ordered after the sweep, not that the frame
 * reaches the webview. The end-to-end path needs a real host and lives in the
 * integration suite. What it does buy is a failure that is loud — the bug it
 * guards is invisible locally and only shows up as "the rail is stale".
 */
const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
  "utf8",
);

const body = (() => {
  const start = src.indexOf("private async newFocusedSession(");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n  private ", start + 1);
  return src.slice(start, end);
})();

describe("a new local session refreshes the rail", () => {
  it("posts the sessions list, not only the repo catalog", () => {
    expect(body).toContain("this.postRepoCatalog();");
    expect(body).toContain("this.postSessionsList();");
  });

  it("posts it after the empty-session sweep", () => {
    // The sweep can retire the empty session this one replaced. A list built
    // before it would carry a row that no longer exists.
    const sweep = body.indexOf("sweepEmptySessions");
    const list = body.indexOf("this.postSessionsList();");
    expect(sweep).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(sweep);
  });
});
