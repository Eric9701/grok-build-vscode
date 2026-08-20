import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { consumeChips, makeExplicitChip, makeImageChip, makeImplicitChip, removeChip } from "../src/chips";
import {
  chipsForQueueSend,
  claimQueuedSendDispatch,
  composerImageIndexStart,
  dequeueQueuedSends,
  enqueueQueuedSend,
  queuedFlushText,
  queuedSendsMessage,
  queuedSendsText,
  reindexQueuedImageChips,
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

  it("keeps an image-only contribution as empty text plus chips", () => {
    const image = img("a");
    expect(queuedSendsMessage([{ text: "", chips: [image] }])).toEqual({
      type: "queuedSends",
      items: [""],
      queued: [{ text: "", chips: [image] }],
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

  it("treats an image-only first contribution as a real prefix after a later append", () => {
    const image = img("only");
    const items = [
      { text: "", chips: [image] },
      { text: "later", chips: [] },
    ];
    expect(takeQueuedSendsPrefix(items, "")).toEqual({
      prefix: [items[0]],
      rest: [items[1]],
    });
  });

  it("does not treat empty text as a prefix of a non-empty first contribution", () => {
    expect(takeQueuedSendsPrefix([{ text: "later", chips: [] }], "")).toBeUndefined();
    expect(takeQueuedSendsPrefix([], "")).toBeUndefined();
  });
});

describe("dequeueQueuedSends index meaning by client generation", () => {
  it("an old-capability webview sending index 0 removes the whole pending block", () => {
    const items = [
      { text: "first", chips: [] },
      { text: "second", chips: [] },
    ];
    expect(dequeueQueuedSends(items, 0, false)).toEqual({
      rest: [],
      removed: items,
    });
  });

  it("a chip-aware dequeueSend index 0 removes only that contribution", () => {
    const items = [
      { text: "first", chips: [] },
      { text: "second", chips: [] },
    ];
    expect(dequeueQueuedSends(items, 0, true)).toEqual({
      removed: [items[0]],
      rest: [items[1]],
    });
  });
});

describe("live host keeps the entry-store invariants", () => {
  const sidebarSrc = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

  it("dequeueSend from an old webview is the pending block, not index-into-entries", () => {
    expect(sidebarSrc).toContain("dequeueQueuedSends(s.queuedSends, msg.index, false)");
  });

  it("reconnect minting uses claimQueuedSendDispatch so image-only text is not dropped", () => {
    expect(sidebarSrc).toContain("session.queuedSendDispatch = claimQueuedSendDispatch(");
  });

  it("composer image numbers continue from the live queue", () => {
    expect(sidebarSrc).toContain("composerImageIndexStart(session.queuedSends)");
  });
});

describe("claimQueuedSendDispatch treats empty text as a real image-only payload", () => {
  it("mints a reconnect dispatch when the ready queue is image-only", () => {
    const image = img("shot");
    const ready = queuedFlushText([{ text: "", chips: [image] }]);
    expect(ready).toBe("");
    const dispatch = claimQueuedSendDispatch(undefined, ready, () => "dispatch-id");
    expect(dispatch).toEqual({ id: "dispatch-id", text: "" });
    expect(claimQueuedSendDispatch(dispatch, ready, () => "other")).toEqual(dispatch);
  });

  it("does not mint when the queue is not ready", () => {
    expect(queuedFlushText([])).toBeUndefined();
    expect(claimQueuedSendDispatch(undefined, undefined, () => "id")).toBeUndefined();
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

  it("puts restored queued images ahead of composer images so numbers match prepended text", () => {
    const queued = makeImageChip("/s/q.png", 1, "image/png");
    const composing = makeImageChip("/s/c.png", 2, "image/png");
    const restored = restoreQueuedChips([composing], [{ text: "see [Image #1]", chips: [queued] }]);
    const images = restored.filter((c) => c.imageIndex != null);
    expect(images.map((c) => c.path)).toEqual(["/s/q.png", "/s/c.png"]);
    expect(images.map((c) => c.imageIndex)).toEqual([1, 2]);
  });
});

describe("composerImageIndexStart continues from the live queue", () => {
  it("starts at 1 when nothing is queued", () => {
    expect(composerImageIndexStart([])).toBe(1);
    expect(composerImageIndexStart([{ text: "x", chips: [makeExplicitChip("/repo/a.ts", "a.ts")] }])).toBe(1);
  });

  it("counts visible queued images so the next composer chip is the flush number", () => {
    expect(composerImageIndexStart([{ text: "a", chips: [img("a")] }])).toBe(2);
    expect(composerImageIndexStart([
      { text: "a", chips: [makeImageChip("/s/a.png", 1, "image/png")] },
      { text: "b", chips: [makeImageChip("/s/b.png", 2, "image/png")] },
    ])).toBe(3);
  });
});

describe("reindexQueuedImageChips", () => {
  it("is a no-op when snapshots already continue through the queue", () => {
    const a = makeImageChip("/s/a.png", 1, "image/png");
    const b = makeImageChip("/s/b.png", 2, "image/png");
    const items = [
      { text: "look at A", chips: [a] },
      { text: "edit [Image #2]", chips: [b] },
    ];
    const out = reindexQueuedImageChips(items);
    expect(out[0]).toBe(items[0]);
    expect(out[1]).toBe(items[1]);
  });

  it("compacts remaining chip labels after an earlier contribution is removed, and leaves text alone", () => {
    const a = makeImageChip("/s/a.png", 1, "image/png");
    const b = makeImageChip("/s/b.png", 2, "image/png");
    const items = [
      { text: "first", chips: [a] },
      { text: "see [Image #2]", chips: [b] },
    ];
    const rest = dequeueQueuedSends(items, 0, true)!.rest;
    const out = reindexQueuedImageChips(rest);
    expect(out[0].chips[0].imageIndex).toBe(1);
    expect(out[0].chips[0].relPath).toBe("Image #1");
    expect(out[0].text).toBe("see [Image #2]");
  });

  it("maps a stale session-scoped index down to #1 on a single-item flush", () => {
    const stale = makeImageChip("/s/x.png", 7, "image/png");
    const out = reindexQueuedImageChips([{ text: "make it green", chips: [stale] }]);
    expect(out[0].chips[0].imageIndex).toBe(1);
    expect(out[0].chips[0].relPath).toBe("Image #1");
    expect(out[0].text).toBe("make it green");
  });
});
