import { describe, it, expect } from "vitest";
import { isPrimerText, isPrimerSummary } from "../src/grok-primer";

describe("isPrimerSummary (legacy empty-session/title cleanup)", () => {
  it("matches grok's primer-derived summaries/titles", () => {
    for (const s of [
      "Grok-Build-VSCode Primer V4 Plan Mode Handling",
      "Grok Build VSCode Hidden Primer v4",
      "Grok VSCode Build Primer v4 Plan Mode Instructions",
      "Grok Build VSCode v4 Primer Plan Mode Setup",
    ]) {
      expect(isPrimerSummary(s)).toBe(true);
    }
  });

  it("does not match real session summaries or empties", () => {
    expect(isPrimerSummary("Generate Elon Musk Desert Image Using Reference")).toBe(false);
    expect(isPrimerSummary("Fix the login bug")).toBe(false);
    expect(isPrimerSummary("")).toBe(false);
    // "primer" alone, without a product/context word, is not enough.
    expect(isPrimerSummary("A primer on CSS grid")).toBe(false);
  });
});

describe("isPrimerText (legacy replay detection)", () => {
  it("matches the last production primer marker", () => {
    expect(isPrimerText("[grok-build-vscode primer v4]\n\n## HIDDEN PRIMER")).toBe(true);
  });

  it("matches any primer version (v1, v2, … v17) for forward/back compat", () => {
    expect(isPrimerText("[grok-build-vscode primer v1]\n\nold")).toBe(true);
    expect(isPrimerText("[grok-build-vscode primer v2] whatever")).toBe(true);
    expect(isPrimerText("[grok-build-vscode primer v17] some future primer")).toBe(true);
  });

  it("tolerates leading whitespace (chunked replay can prepend a newline)", () => {
    expect(isPrimerText("\n  [grok-build-vscode primer v3] body")).toBe(true);
  });

  it("does not match a normal user message", () => {
    expect(isPrimerText("implement the login form")).toBe(false);
    expect(isPrimerText("")).toBe(false);
    expect(isPrimerText(undefined as unknown as string)).toBe(false);
  });

  it("only matches the marker at the START — a marker pasted mid-message is not a primer", () => {
    // A user who pastes the marker into the middle of their own text must still
    // get a real bubble; the primer is only ever at position 0 of a replayed msg.
    expect(isPrimerText("here is what I copied: [grok-build-vscode primer v3]")).toBe(false);
  });

  it("does not match a near-miss marker (wrong name / no version)", () => {
    expect(isPrimerText("[grok-build-vscode primer]")).toBe(false);
    expect(isPrimerText("[some-other primer v3]")).toBe(false);
  });
});
