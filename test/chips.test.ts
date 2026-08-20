import { describe, it, expect } from "vitest";
import {
  MAX_VISION_IMAGE_BYTES,
  clearImplicitChips,
  consumeChips,
  extFromMime,
  implicitChipStartsHidden,
  isVisionImagePath,
  isVisionMime,
  makeExplicitChip,
  makeImageChip,
  makeImplicitChip,
  mimeFromPath,
  removeChip,
  selectionLineRange,
  toggleChip,
  allocateImageIndex,
} from "../src/chips";

// VS Code positions are 0-based; the chip range is 1-based inclusive. Selection
// ends are exclusive: selecting whole lines parks `end` at character 0 of the
// NEXT line, which must not count as a selected line.
describe("selectionLineRange", () => {
  it("drops the phantom line of a full-line selection (end at col 0)", () => {
    // Lines 6-8 (1-based) selected via click-drag over whole lines: start {5,0},
    // end {8,0}. The old unconditional `end.line + 1` attached line 9 too.
    expect(selectionLineRange({ line: 5, character: 0 }, { line: 8, character: 0 }))
      .toEqual({ startLine: 6, endLine: 8 });
  });

  it("keeps the end line when the selection ends mid-line", () => {
    expect(selectionLineRange({ line: 5, character: 2 }, { line: 8, character: 10 }))
      .toEqual({ startLine: 6, endLine: 9 });
  });

  it("handles a single full line (end at col 0 of the next line)", () => {
    expect(selectionLineRange({ line: 3, character: 0 }, { line: 4, character: 0 }))
      .toEqual({ startLine: 4, endLine: 4 });
  });

  it("handles a selection within one line (end col 0 never happens below start)", () => {
    expect(selectionLineRange({ line: 3, character: 4 }, { line: 3, character: 9 }))
      .toEqual({ startLine: 4, endLine: 4 });
  });

  it("a partial first line ending at col 0 of a later line still excludes that line", () => {
    expect(selectionLineRange({ line: 3, character: 7 }, { line: 4, character: 0 }))
      .toEqual({ startLine: 4, endLine: 4 });
  });
});

describe("chips", () => {
  it("creates an implicit chip with a stable id", () => {
    const c = makeImplicitChip("/abs/path/foo.ts", "foo.ts");
    expect(c.id).toBe("implicit:/abs/path/foo.ts");
    expect(c.hidden).toBe(false);
    expect(c.selectionStart).toBeUndefined();
  });

  it("makeImplicitChip carries the editor selection while keeping the id stable", () => {
    const sel = makeImplicitChip("/abs/path/foo.ts", "foo.ts", 8, 15);
    // Same identity with or without a selection — the chip tracks ONE active
    // editor, so a selection change must update it in place, not add a sibling.
    expect(sel.id).toBe("implicit:/abs/path/foo.ts");
    expect(sel.selectionStart).toBe(8);
    expect(sel.selectionEnd).toBe(15);
  });

  it("creates an explicit chip with a unique id and selection range", () => {
    const c1 = makeExplicitChip("/a.ts", "a.ts", 1, 10);
    const c2 = makeExplicitChip("/a.ts", "a.ts", 1, 10);
    expect(c1.selectionStart).toBe(1);
    expect(c1.selectionEnd).toBe(10);
    expect(c1.id).not.toBe(c2.id); // Date.now suffix makes them unique
  });

  it("removeChip removes by id", () => {
    const a = makeImplicitChip("/a", "a");
    const b = makeImplicitChip("/b", "b");
    const result = removeChip([a, b], a.id);
    expect(result).toEqual([b]);
  });

  it("toggleChip flips hidden without mutating", () => {
    const a = makeImplicitChip("/a", "a");
    const result = toggleChip([a], a.id);
    expect(result[0].hidden).toBe(true);
    expect(a.hidden).toBe(false); // original untouched
    const back = toggleChip(result, a.id);
    expect(back[0].hidden).toBe(false);
  });

  it("toggleChip leaves other chips alone", () => {
    const a = makeImplicitChip("/a", "a");
    const b = makeImplicitChip("/b", "b");
    const result = toggleChip([a, b], a.id);
    expect(result[0].hidden).toBe(true);
    expect(result[1].hidden).toBe(false);
  });

  it("clearImplicitChips removes only implicit ones", () => {
    const imp = makeImplicitChip("/a", "a");
    const exp = makeExplicitChip("/b", "b");
    const result = clearImplicitChips([imp, exp]);
    expect(result).toEqual([exp]);
  });

  it("consumeChips drops exactly what the send snapshotted, keeps the implicit chip", () => {
    const imp = makeImplicitChip("/abs/open.ts", "open.ts");
    const sent = makeExplicitChip("/abs/a.txt", "a.txt");
    expect(consumeChips([imp, sent], [imp, sent])).toEqual([imp]);
  });

  it("consumeChips keeps a chip staged after the send snapshot (next-turn attachment)", () => {
    const sent = makeImageChip("/staging/a.png", 1, "image/png");
    const late = makeImageChip("/staging/b.png", 2, "image/png");
    expect(consumeChips([sent, late], [sent])).toEqual([late]);
  });

  it("isVisionImagePath accepts raster vision formats only", () => {
    expect(isVisionImagePath("/tmp/a.PNG")).toBe(true);
    expect(isVisionImagePath("clip.jpeg")).toBe(true);
    expect(isVisionImagePath("anim.webp")).toBe(true);
    // SVG is an editable text source — it must stay a path chip so grok can
    // read/edit the file; BMP is undocumented for the vision API and huge.
    expect(isVisionImagePath("logo.svg")).toBe(false);
    expect(isVisionImagePath("shot.bmp")).toBe(false);
    expect(isVisionImagePath("notes.md")).toBe(false);
  });

  it("isVisionMime mirrors the extension whitelist", () => {
    expect(isVisionMime("image/png")).toBe(true);
    expect(isVisionMime("image/JPEG")).toBe(true);
    expect(isVisionMime("image/svg+xml")).toBe(false);
    expect(isVisionMime("image/bmp")).toBe(false);
    expect(isVisionMime("text/plain")).toBe(false);
  });

  it("mimeFromPath and extFromMime are derived from one table", () => {
    expect(mimeFromPath("/a/b.JPG")).toBe("image/jpeg");
    expect(mimeFromPath("/a/b.jpeg")).toBe("image/jpeg");
    expect(mimeFromPath("noext")).toBe("image/png"); // no extension → safe default
    expect(extFromMime("image/jpeg")).toBe(".jpg"); // canonical ext, not .jpeg
    expect(extFromMime("image/webp")).toBe(".webp");
    expect(extFromMime("application/octet-stream")).toBe(".png");
  });

  it("caps vision images at the documented 20MiB", () => {
    expect(MAX_VISION_IMAGE_BYTES).toBe(20 * 1024 * 1024);
  });

  it("makeImageChip labels relPath as Image #N and carries the origin path", () => {
    const c = makeImageChip("/staging/x.png", 2, "image/png", "assets/hero.png");
    expect(c.relPath).toBe("Image #2");
    expect(c.imageIndex).toBe(2);
    expect(c.mimeType).toBe("image/png");
    expect(c.originRelPath).toBe("assets/hero.png");
    const pasted = makeImageChip("/staging/y.png", 3, "image/png");
    expect(pasted.originRelPath).toBeUndefined();
  });
});

// The chip is rebuilt from scratch on every active-editor change, so this is
// the ONLY thing carrying the user's eye-off choice across a file switch.
describe("implicitChipStartsHidden (#67)", () => {
  const chip = (hidden: boolean) => ({ ...makeImplicitChip("/w/a.ts", "a.ts"), hidden });

  it("carries an eye-off chip's state forward — the #67 regression", () => {
    // Switching files rebuilds the chip; before the fix this reset to false and
    // silently re-enabled the context the user had just turned off.
    expect(implicitChipStartsHidden(chip(true), true)).toBe(true);
  });

  it("keeps a visible chip visible", () => {
    expect(implicitChipStartsHidden(chip(false), false)).toBe(false);
  });

  it("prefers the live chip over the store, so an in-flight write can't flip it back", () => {
    // globalState.update is fire-and-forget; the chip is the synchronous truth.
    expect(implicitChipStartsHidden(chip(true), false)).toBe(true);
    expect(implicitChipStartsHidden(chip(false), true)).toBe(false);
  });

  it("falls back to the remembered preference when there is no chip yet", () => {
    // Fresh webview / extension restart / chip cleared by a non-file editor.
    expect(implicitChipStartsHidden(undefined, true)).toBe(true);
    expect(implicitChipStartsHidden(undefined, false)).toBe(false);
  });

  it("defaults to visible for a first-run install with nothing remembered", () => {
    expect(implicitChipStartsHidden(undefined, false)).toBe(false);
  });
});

// A chip's `[Image #N]` is stamped once at attach and is never rewritten.
// Removing or flushing an earlier chip must not relabel a later one — that
// is the handle the user already wrote into the draft.
describe("allocateImageIndex", () => {
  const img = (name: string, index: number) => makeImageChip(`/staging/${name}.png`, index, "image/png");

  it("starts at #1 when nothing is staged, even after a previous high-water", () => {
    expect(allocateImageIndex(0, [])).toEqual({ index: 1, highWater: 1 });
    expect(allocateImageIndex(7, [])).toEqual({ index: 1, highWater: 1 });
    expect(allocateImageIndex(4, [makeExplicitChip("/a.ts", "a.ts")])).toEqual({ index: 1, highWater: 1 });
  });

  it("continues from the high-water while anything is still staged", () => {
    expect(allocateImageIndex(1, [img("a", 1)])).toEqual({ index: 2, highWater: 2 });
    expect(allocateImageIndex(2, [img("a", 1), img("b", 2)])).toEqual({ index: 3, highWater: 3 });
  });

  it("does not relabel remaining chips when an earlier one is removed, and does not reuse its number", () => {
    const a = img("a", 1);
    const b = img("b", 2);
    const rest = removeChip([a, b], a.id);
    expect(rest.map((c) => c.imageIndex)).toEqual([2]);
    expect(rest[0].relPath).toBe("Image #2");
    expect(allocateImageIndex(2, rest)).toEqual({ index: 3, highWater: 3 });
  });

  it("floors the high-water on live chip indices so a restored draft cannot collide", () => {
    expect(allocateImageIndex(0, [img("kept", 2)])).toEqual({ index: 3, highWater: 3 });
  });

  it("file chips consume no numbers", () => {
    const staged = [makeExplicitChip("/a.ts", "a.ts"), img("a", 1), makeImplicitChip("/w/open.ts", "open.ts")];
    expect(allocateImageIndex(1, staged)).toEqual({ index: 2, highWater: 2 });
  });

  it("does not reuse a removed later chip's number while an earlier one remains", () => {
    const a = img("a", 1);
    const b = img("b", 2);
    const rest = removeChip([a, b], b.id);
    expect(rest.map((c) => c.imageIndex)).toEqual([1]);
    expect(allocateImageIndex(2, rest)).toEqual({ index: 3, highWater: 3 });
  });

  it("a queued image with an empty composer still holds the generation open", () => {
    expect(allocateImageIndex(1, [img("queued", 1)])).toEqual({ index: 2, highWater: 2 });
  });

  it("a hidden image chip still holds the generation open", () => {
    const hidden = { ...img("hidden", 1), hidden: true };
    expect(allocateImageIndex(1, [hidden])).toEqual({ index: 2, highWater: 2 });
  });

  it("queue #1, attach #2, drop #1 → #2 stays #2, next is #3, idle resets to #1", () => {
    let highWater = 0;
    let composer = [] as ReturnType<typeof img>[];
    let queued = [] as ReturnType<typeof img>[];

    let alloc = allocateImageIndex(highWater, [...composer, ...queued]);
    highWater = alloc.highWater;
    const a = img("a", alloc.index);
    composer = [a];
    expect(a.imageIndex).toBe(1);

    queued = [a];
    composer = consumeChips(composer, [a]);

    alloc = allocateImageIndex(highWater, [...composer, ...queued]);
    highWater = alloc.highWater;
    const b = img("b", alloc.index);
    composer = [b];
    expect(b.imageIndex).toBe(2);
    expect(b.relPath).toBe("Image #2");

    queued = [];
    expect(composer.map((c) => c.imageIndex)).toEqual([2]);
    alloc = allocateImageIndex(highWater, [...composer, ...queued]);
    expect(alloc.index).toBe(3);

    composer = [];
    expect(allocateImageIndex(alloc.highWater, [...composer, ...queued])).toEqual({ index: 1, highWater: 1 });
  });
});
