import { describe, expect, it } from "vitest";
import { planReviewFileBaseName,
  planReviewFileName, sanitizePlanReviewFilePart } from "../src/plan-review";

describe("planReviewFileBaseName", () => {
  it("uses an explicit plan name prefix as the file base", () => {
    expect(planReviewFileBaseName("plan2: Simple Plan Example\n\n## Context")).toBe("plan2");
  });

  it("uses a markdown heading when no explicit prefix exists", () => {
    expect(planReviewFileBaseName("# Refactor auth helper\n\nSteps...")).toBe("refactor-auth-helper");
  });

  it("skips status lines when picking a useful title", () => {
    expect(planReviewFileBaseName("Status: Ready\n# Add tests")).toBe("add-tests");
  });
});

describe("sanitizePlanReviewFilePart", () => {
  it("creates a filesystem-friendly ascii slug", () => {
    expect(sanitizePlanReviewFilePart("Plan: Review / Copy Path!")).toBe("plan-review-copy-path");
  });

  it("falls back to plan for empty values", () => {
    expect(sanitizePlanReviewFilePart("   ")).toBe("plan");
  });
});

// Snapshots are re-created on EVERY restore, so the filename must be a pure
// function of the content — otherwise reopening a session writes another copy
// each time. One real session accumulated 13 identical `no-op-plan-test*.md`.
describe("planReviewFileName (content-addressed, so restores don't multiply files)", () => {
  it("is stable for identical content", () => {
    const plan = "# Refactor auth\n\n- step one\n";
    expect(planReviewFileName(plan)).toBe(planReviewFileName(plan));
  });

  it("differs when the plan text differs, even with the same title", () => {
    const a = planReviewFileName("# Refactor auth\n\n- step one\n");
    const b = planReviewFileName("# Refactor auth\n\n- step two\n");
    expect(a).not.toBe(b);
    // Same readable stem, different hash — findable by eye, unique on disk.
    expect(a.split("-").slice(0, -1).join("-")).toBe(b.split("-").slice(0, -1).join("-"));
  });

  it("keeps the human-readable title as the stem", () => {
    expect(planReviewFileName("No-op plan test\n\nnothing")).toMatch(/^no-op-plan-test-[0-9a-f]{8}\.md$/);
  });

  it("normalizes empty/blank plans to one stable name", () => {
    expect(planReviewFileName("")).toBe(planReviewFileName("   \n  "));
    expect(planReviewFileName("")).toMatch(/\.md$/);
  });

  it("never emits path separators from a hostile title", () => {
    const name = planReviewFileName("../../etc/passwd: do bad things\n");
    expect(name).not.toMatch(/[\/]/);
    expect(name).toMatch(/^[\w.-]+\.md$/);
  });
});
