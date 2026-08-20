import type { FileChip } from "./chips";
import { isImplicitChip, visibleImageCount, withPerMessageImageIndices } from "./chips";
import type { HostMsg, QueuedSend } from "./protocol";

export type { QueuedSend };

/** Session storage: chips always present (empty array if none). */
export type QueuedSendEntry = { text: string; chips: FileChip[] };

/** Persistable copy of a composer chip: drop webview-only preview fields. */
export function cloneChipForQueue(chip: FileChip): FileChip {
  const { previewSrc: _previewSrc, fullId: _fullId, ...rest } = chip;
  return { ...rest };
}

/** Explicit attachments the user staged — not the ambient editor chip. */
export function explicitVisibleChips(chips: readonly FileChip[]): FileChip[] {
  return chips.filter((chip) => !chip.hidden && !isImplicitChip(chip));
}

/**
 * Which composer chips a `queueSend` should snapshot.
 *
 * - omitted `requested` (old client): take every explicit visible chip — the
 *   accidental-right behavior before the queue carried attachments.
 * - present `requested` (new client, including `[]`): take only matching ids
 *   from the live composer. Paths on the request are ignored; the session copy
 *   is authoritative.
 */
export function chipsForQueueSend(
  sessionChips: readonly FileChip[],
  requested: readonly Pick<FileChip, "id">[] | undefined,
): FileChip[] {
  const explicit = explicitVisibleChips(sessionChips);
  if (requested === undefined) return explicit.map(cloneChipForQueue);
  const ids = new Set(requested.map((chip) => chip.id).filter(Boolean));
  return explicit.filter((chip) => ids.has(chip.id)).map(cloneChipForQueue);
}

export function enqueueQueuedSend(
  items: readonly QueuedSendEntry[],
  text: string,
  chips: readonly FileChip[],
): QueuedSendEntry[] {
  return [...items, { text, chips: chips.map(cloneChipForQueue) }];
}

export function queuedSendsText(items: readonly QueuedSendEntry[]): string {
  return items.map((item) => item.text).join("\n\n");
}

export function queuedSendsHaveContent(items: readonly QueuedSendEntry[]): boolean {
  return items.some((item) => !!item.text.trim() || item.chips.length > 0);
}

/**
 * Combined flush / `submitQueuedSend` payload.
 *
 * `undefined` means there is nothing to send. `""` is a real image-only queue
 * — never treat it as absence. Entries are the source of truth; this string is
 * only the derived handshake/prompt text.
 */
export function queuedFlushText(items: readonly QueuedSendEntry[]): string | undefined {
  if (!queuedSendsHaveContent(items)) return undefined;
  return queuedSendsText(items);
}

/**
 * Open (or keep) the relay dequeue dispatch.
 *
 * `readyText === undefined` is "not ready". `readyText === ""` is a legitimate
 * image-only payload and must mint a dispatch.
 */
export function claimQueuedSendDispatch(
  existing: { id: string; text: string } | undefined,
  readyText: string | undefined,
  mintId: () => string,
): { id: string; text: string } | undefined {
  if (existing) return existing;
  if (readyText === undefined) return undefined;
  return { id: mintId(), text: readyText };
}

/** Additive host snapshot: `items` stays `string[]` for old webviews. */
export function queuedSendsMessage(
  items: readonly QueuedSendEntry[],
): Extract<HostMsg, { type: "queuedSends" }> {
  return {
    type: "queuedSends",
    items: items.map((item) => item.text),
    queued: items.map((item) =>
      item.chips.length > 0
        ? { text: item.text, chips: item.chips }
        : { text: item.text },
    ),
  };
}

/**
 * Split `items` into the prefix whose joined texts equal `text` and the rest
 * (contributions appended while a flush was in flight).
 *
 * Walks entries rather than treating the joined string as a second store:
 * `""` is a real first contribution (image-only), so it matches that entry
 * and leaves later ones. An empty `text` does not match a non-empty first
 * item, and it is not a prefix of an empty list.
 */
export function takeQueuedSendsPrefix(
  items: readonly QueuedSendEntry[],
  text: string,
): { prefix: QueuedSendEntry[]; rest: QueuedSendEntry[] } | undefined {
  let acc = "";
  for (let i = 0; i < items.length; i++) {
    acc = i === 0 ? items[i].text : `${acc}\n\n${items[i].text}`;
    if (acc === text) {
      return { prefix: items.slice(0, i + 1), rest: items.slice(i + 1) };
    }
  }
  return undefined;
}

/**
 * What `dequeueSend.index` means depends on the client generation:
 *
 * - Old webview (`queueSendChips: false`): one pending block, and Edit /
 *   Remove / Steer always send `index: 0` for that block. Remove every entry.
 * - Chip-aware client (`queueSendChips: true`): `index` is one contribution.
 *
 * Live `dequeueSend` is the old message (chip-aware clients use
 * `clearQueuedSends` for the block). Pass `false` unless the sender is known
 * to address entries individually.
 */
export function dequeueQueuedSends(
  items: readonly QueuedSendEntry[],
  index: number,
  queueSendChips: boolean,
): { rest: QueuedSendEntry[]; removed: QueuedSendEntry[] } | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) return undefined;
  if (!queueSendChips) {
    if (index !== 0) return undefined;
    return { rest: [], removed: [...items] };
  }
  return {
    removed: [items[index]],
    rest: [...items.slice(0, index), ...items.slice(index + 1)],
  };
}

/** Visible images already snapshotted on the pending follow-ups. */
export function queuedVisibleImageCount(items: readonly QueuedSendEntry[]): number {
  let n = 0;
  for (const item of items) n += visibleImageCount(item.chips);
  return n;
}

/** First `[Image #N]` a new composer chip should take, given the live queue. */
export function composerImageIndexStart(items: readonly QueuedSendEntry[]): number {
  return queuedVisibleImageCount(items) + 1;
}

/**
 * Dense 1..N across queued contributions, in queue order. Chip labels only —
 * contribution text is left alone. A no-op when the snapshots are already
 * sequential (the type-time numbering). Closes gaps after an earlier
 * contribution is removed, and maps a stale session-scoped index down to #1
 * on a single-item flush.
 */
export function reindexQueuedImageChips(
  items: readonly QueuedSendEntry[],
): QueuedSendEntry[] {
  let start = 1;
  return items.map((item) => {
    const chips = withPerMessageImageIndices(item.chips, start);
    start += visibleImageCount(item.chips);
    const same = chips.length === item.chips.length && chips.every((chip, i) => chip === item.chips[i]);
    return same ? item : { ...item, chips };
  });
}

/** Re-attach queued chips to the composer (Edit / Stop). Dedupes by id.
 *  Queued chips lead: Edit prepends their text, so they keep the leading
 *  numbers. */
export function restoreQueuedChips(
  sessionChips: readonly FileChip[],
  items: readonly QueuedSendEntry[],
): FileChip[] {
  const have = new Set(sessionChips.map((chip) => chip.id));
  const fromQueue: FileChip[] = [];
  for (const item of items) {
    for (const chip of item.chips) {
      if (have.has(chip.id)) continue;
      fromQueue.push(cloneChipForQueue(chip));
      have.add(chip.id);
    }
  }
  return withPerMessageImageIndices([...fromQueue, ...sessionChips]);
}

export function allQueuedChips(items: readonly QueuedSendEntry[]): FileChip[] {
  return items.flatMap((item) => item.chips);
}
