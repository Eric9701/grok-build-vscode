import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isSafeRelativePlanReviewLink,
  isTrustedPlanReviewPath,
} from "../src/plan-review";
import {
  authorizeDesktopWebviewMsg,
  authorizeOpenFile,
  desktopAuthRoots,
  resolveAuthorizedFileForOpen,
} from "../src/desktop/desktop-policy";

describe("plan-review path fence", () => {
  it("accepts only a session segment and one Markdown file", () => {
    expect(isSafeRelativePlanReviewLink("session-id/no-op.md")).toBe(true);
    expect(isSafeRelativePlanReviewLink("session-id/NO-OP.MD")).toBe(true);
    expect(isSafeRelativePlanReviewLink("session-id/sub/no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("../session-id/no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("session-id/../no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("session-id/no-op.txt")).toBe(false);
    expect(isSafeRelativePlanReviewLink("C:\\outside\\no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("\\\\server\\share\\no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("file:///outside/no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("session-id/no-op.md\0")).toBe(false);
  });

  it("requires existence before and after canonicalisation", () => {
    const root = path.join(path.resolve("."), "plan-review-root");
    const candidate = path.join(root, "session-id", "no-op.md");
    const existing = new Set([candidate]);
    const realpath = (p: string) => path.resolve(p);

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(true);
    expect(
      isTrustedPlanReviewPath(path.join(root, "session-id", "..", "no-op.md"), root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);

    existing.clear();
    existing.add(candidate);
    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath: (p) => path.join(path.dirname(root), "canonical-missing.md"),
      }),
    ).toBe(false);
  });

  it("refuses a plan file symlink that leaves plan-reviews", () => {
    const root = path.join(path.resolve("."), "plan-review-root");
    const candidate = path.join(root, "session-id", "no-op.md");
    const outside = path.join(path.dirname(root), "secret.md");
    const existing = new Set([candidate, outside]);
    const realpath = (p: string) => (path.resolve(p) === path.resolve(candidate) ? outside : path.resolve(p));

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("refuses a relocated plan-reviews directory", () => {
    const storage = path.join(path.resolve("."), "global-storage");
    const root = path.join(storage, "plan-reviews");
    const candidate = path.join(root, "session-id", "no-op.md");
    const relocated = path.join(path.dirname(storage), "other-storage", "plan-reviews");
    const existing = new Set([candidate, path.join(relocated, "session-id", "no-op.md")]);
    const realpath = (p: string) => {
      const resolved = path.resolve(p);
      return resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep)
        ? path.join(relocated, path.relative(root, resolved))
        : resolved;
    };

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("refuses a session-directory link to a sibling session", () => {
    const root = path.join(path.resolve("."), "plan-review-root");
    const candidate = path.join(root, "session-a", "no-op.md");
    const sibling = path.join(root, "session-b", "no-op.md");
    const existing = new Set([candidate, sibling]);
    const realpath = (p: string) => {
      const resolved = path.resolve(p);
      const session = path.join(root, "session-a");
      return resolved === session || resolved.startsWith(session + path.sep)
        ? path.join(root, "session-b", path.relative(session, resolved))
        : resolved;
    };

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("refuses a file link to another file even within the same session", () => {
    const root = path.join(path.resolve("."), "plan-review-root");
    const candidate = path.join(root, "session-id", "no-op.md");
    const other = path.join(root, "session-id", "other.md");
    const existing = new Set([candidate, other]);
    const realpath = (p: string) => path.resolve(p) === path.resolve(candidate) ? other : path.resolve(p);

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("authorizes an existing snapshot without widening project roots", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-plan-open-"));
    const repo = path.join(base, "repo");
    const planReviewsRoot = path.join(base, "globalStorage", "plan-reviews");
    const plan = path.join(planReviewsRoot, "session-id", "no-op-plan.md");
    try {
      fs.mkdirSync(path.dirname(plan), { recursive: true });
      fs.mkdirSync(repo, { recursive: true });
      fs.writeFileSync(plan, "# no-op\n");
      const ctx = { workspaceRoot: repo, planReviewsRoot };

      expect(desktopAuthRoots(ctx)).toEqual([path.resolve(repo)]);
      expect(authorizeOpenFile(plan, ctx)).toEqual({ ok: true, absPath: path.resolve(plan) });
      expect(resolveAuthorizedFileForOpen(plan, ctx)).toEqual({
        ok: true,
        absPath: path.resolve(plan),
      });
      expect(authorizeDesktopWebviewMsg({ type: "openFile", path: plan }, ctx)).toEqual({
        msg: { type: "openFile", path: plan },
      });

      const outside = path.join(base, "globalStorage", "other.md");
      fs.writeFileSync(outside, "not a plan review");
      expect(authorizeOpenFile(outside, ctx).ok).toBe(false);
      expect(resolveAuthorizedFileForOpen(outside, ctx).ok).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
