import type { FileChip } from "./chips";
import { isImplicitChip, withPerMessageImageIndices } from "./chips";
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
 * Split `items` into the prefix whose joined text equals `text` and the rest
 * (contributions appended while a flush was in flight).
 */
export function takeQueuedSendsPrefix(
  items: readonly QueuedSendEntry[],
  text: string,
): { prefix: QueuedSendEntry[]; rest: QueuedSendEntry[] } | undefined {
  const full = queuedSendsText(items);
  if (full === text) return { prefix: [...items], rest: [] };
  if (text === "" || !full.startsWith(text + "\n\n")) return undefined;
  let acc = "";
  for (let i = 0; i < items.length; i++) {
    acc = i === 0 ? items[i].text : `${acc}\n\n${items[i].text}`;
    if (acc === text) {
      return { prefix: items.slice(0, i + 1), rest: items.slice(i + 1) };
    }
  }
  return undefined;
}

/** Re-attach queued chips to the composer (Edit / Stop). Dedupes by id. */
export function restoreQueuedChips(
  sessionChips: readonly FileChip[],
  items: readonly QueuedSendEntry[],
): FileChip[] {
  const have = new Set(sessionChips.map((chip) => chip.id));
  const next = [...sessionChips];
  for (const item of items) {
    for (const chip of item.chips) {
      if (have.has(chip.id)) continue;
      next.push(cloneChipForQueue(chip));
      have.add(chip.id);
    }
  }
  return withPerMessageImageIndices(next);
}

export function allQueuedChips(items: readonly QueuedSendEntry[]): FileChip[] {
  return items.flatMap((item) => item.chips);
}
