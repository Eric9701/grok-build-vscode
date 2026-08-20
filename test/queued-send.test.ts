import { describe, expect, it } from "vitest";
import { consumeChips, makeExplicitChip, makeImageChip, makeImplicitChip, removeChip } from "../src/chips";
import {
  chipsForQueueSend,
  enqueueQueuedSend,
  queuedSendsMessage,
  queuedSendsText,
  restoreQueuedChips,
  takeQueuedSendsPrefix,
} from "../src/queued-send";

const img = (name: string) => makeImageChip(`/s/${name}.png`, 1, "image/png");

describe("chipsForQueueSend", () => {
  const implicit = makeImplicitChip("/repo/open.ts", "open.ts");
  const file = makeExplicitChip("/repo/notes.md", "notes.md");
  const image = img("shot");

  it("snapshots every explicit visible chip when the client omitted chips (old host path)", () => {
    expect(chipsForQueueSend([implicit, file, image], undefined).map((c) => c.id))
      .toEqual([file.id, image.id]);
  });

  it("takes only requested ids when the client sent chips, including none", () => {
    expect(chipsForQueueSend([file, image], [])).toEqual([]);
    expect(chipsForQueueSend([file, image], [{ id: image.id }]).map((c) => c.id))
      .toEqual([image.id]);
  });

  it("ignores requested ids that are not on the composer", () => {
    expect(chipsForQueueSend([file], [{ id: "stale" }])).toEqual([]);
  });
});

describe("enqueueQueuedSend keeps per-item chips", () => {
  it("pushes a new contribution instead of unioning chips onto one string", () => {
    const a = img("a");
    const b = img("b");
    const once = enqueueQueuedSend([], "look at A", [a]);
    const twice = enqueueQueuedSend(once, "and B", [b]);
    expect(queuedSendsText(twice)).toBe("look at A\n\nand B");
    expect(twice[0].chips.map((c) => c.path)).toEqual(["/s/a.png"]);
    expect(twice[1].chips.map((c) => c.path)).toEqual(["/s/b.png"]);
  });

  it("does not let a later composer removeChip drop a snapshotted queued chip", () => {
    const image = img("keep");
    const file = makeExplicitChip("/repo/a.ts", "a.ts");
    let composer = [image, file];
    const queued = enqueueQueuedSend([], "see this", chipsForQueueSend(composer, [{ id: image.id }]));
    composer = consumeChips(composer, queued[0].chips);
    composer = removeChip(composer, image.id);
    expect(composer.map((c) => c.id)).toEqual([file.id]);
    expect(queued[0].chips.map((c) => c.id)).toEqual([image.id]);
  });
});

describe("queuedSendsMessage is additive", () => {
  it("keeps items: string[] and adds queued entries", () => {
    const image = img("a");
    expect(queuedSendsMessage([{ text: "hi", chips: [] }])).toEqual({
      type: "queuedSends",
      items: ["hi"],
      queued: [{ text: "hi" }],
    });
    expect(queuedSendsMessage([{ text: "see", chips: [image] }])).toEqual({
      type: "queuedSends",
      items: ["see"],
      queued: [{ text: "see", chips: [image] }],
    });
  });
});

describe("takeQueuedSendsPrefix", () => {
  it("splits off the committed contributions and leaves later ones", () => {
    const items = [
      { text: "first", chips: [] },
      { text: "second", chips: [] },
      { text: "third", chips: [] },
    ];
    expect(takeQueuedSendsPrefix(items, "first\n\nsecond")).toEqual({
      prefix: [items[0], items[1]],
      rest: [items[2]],
    });
  });
});

describe("restoreQueuedChips", () => {
  it("returns queued chips to the composer without duplicating ids", () => {
    const image = img("a");
    const already = makeExplicitChip("/repo/b.ts", "b.ts");
    const restored = restoreQueuedChips([already, image], [{ text: "x", chips: [image] }]);
    expect(restored.filter((c) => c.id === image.id)).toHaveLength(1);
    expect(restored.map((c) => c.id)).toContain(already.id);
  });
});
