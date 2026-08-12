export interface FileChip {
  id: string;
  path: string;
  relPath: string;
  selectionStart?: number;
  selectionEnd?: number;
  hidden: boolean;
  /** 1-based, PER-MESSAGE index for pasted/uploaded images — the `[Image #N]`
   *  tag sent in the prompt text. Its position among the visible image chips of
   *  the message it rides on, so it restarts at #1 every turn; see
   *  `withPerMessageImageIndices`. */
  imageIndex?: number;
  mimeType?: string;
  /** Workspace-relative path of the original file for images imported from disk
   *  (kept so the prompt tag can carry the real file identity — `path` points at
   *  the staged copy). Absent for clipboard pastes, which have no origin file. */
  originRelPath?: string;
  /** Opaque browser-generated correlation id for a pasted image preview. The
   *  bytes stay in the browser; only this id crosses the relay and comes back. */
  previewId?: string;
  /** Local-webview-only URI for the staged file. Never stored on Session and
   *  never sent to a remote browser. */
  previewSrc?: string;
  /** Opaque HOST-issued handle letting a remote ask for a full-size render of
   *  this image. Attached on the way out to a remote, never stored on Session.
   *  A handle rather than a path, so a phone can only ask for pictures the host
   *  already chose to show it. */
  fullId?: string;
}

// Formats we send to grok as inline vision blocks. Deliberately narrower than
// "any image extension": SVG is excluded because it's an editable text source —
// a user attaching one almost always wants grok to read/edit the file, which the
// path-chip route does and a rasterized vision block cannot; BMP is excluded
// because xAI's vision API documents only jpg/jpeg/png (gif/webp verified
// accepted by research/vision-probe.cjs) and uncompressed BMPs are huge.
const VISION_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
const VISION_MIME_RE = /^image\/(png|jpeg|gif|webp)$/i;

/** xAI Image Understanding documents a 20MiB per-image cap — preflight it
 *  locally so an oversized file degrades to a path chip (or a clear error)
 *  instead of a failed turn. */
export const MAX_VISION_IMAGE_BYTES = 20 * 1024 * 1024;

/** Should this file ride the inline-vision path (vs a plain path chip)? */
export function isVisionImagePath(p: string): boolean {
  return VISION_EXT_RE.test(p);
}

export function isVisionMime(mime: string): boolean {
  return VISION_MIME_RE.test(mime);
}

export function isImageChip(chip: FileChip): boolean {
  return chip.imageIndex != null;
}

/** Single source of truth for the vision formats' ext ↔ MIME mapping —
 *  mimeFromPath and extFromMime are both derived from it. */
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function mimeFromPath(p: string): string {
  const dot = p.lastIndexOf(".");
  if (dot < 0) return "image/png";
  return EXT_MIME[p.slice(dot).toLowerCase()] ?? "image/png";
}

export function extFromMime(mime: string): string {
  const lower = mime.toLowerCase();
  for (const [ext, m] of Object.entries(EXT_MIME)) {
    if (m === lower && ext !== ".jpeg") return ext;
  }
  return ".png";
}

/** 1-based inclusive line range for a NON-EMPTY editor selection. VS Code
 *  selection ends are exclusive: selecting whole lines puts `end` at character
 *  0 of the NEXT line, so an end at column 0 (below the start line) does not
 *  include that line — the old unconditional `end.line + 1` attached one line
 *  the user never selected. */
export function selectionLineRange(
  start: { line: number; character: number },
  end: { line: number; character: number },
): { startLine: number; endLine: number } {
  const endLine = end.character === 0 && end.line > start.line ? end.line : end.line + 1;
  return { startLine: start.line + 1, endLine };
}

export function makeImplicitChip(
  absPath: string,
  relPath: string,
  selectionStart?: number,
  selectionEnd?: number,
): FileChip {
  return {
    id: `implicit:${absPath}`,
    path: absPath,
    relPath,
    selectionStart,
    selectionEnd,
    hidden: false,
  };
}

let explicitChipCounter = 0;

export function makeExplicitChip(
  absPath: string,
  relPath: string,
  selectionStart?: number,
  selectionEnd?: number,
): FileChip {
  explicitChipCounter += 1;
  return {
    id: `explicit:${absPath}:${selectionStart ?? 0}-${selectionEnd ?? 0}:${explicitChipCounter}`,
    path: absPath,
    relPath,
    selectionStart,
    selectionEnd,
    hidden: false,
  };
}

export function makeImageChip(
  absPath: string,
  imageIndex: number,
  mimeType: string,
  originRelPath?: string,
  previewId?: string,
): FileChip {
  explicitChipCounter += 1;
  return {
    id: `image:${absPath}:${imageIndex}:${explicitChipCounter}`,
    path: absPath,
    relPath: `Image #${imageIndex}`,
    hidden: false,
    imageIndex,
    mimeType,
    originRelPath,
    ...(previewId ? { previewId } : {}),
  };
}

/**
 * Renumber the image chips `[Image #1..N]` by their position in this list.
 *
 * The CLI resolves an `[Image #N]` reference against the images attached to the
 * message it is reading, numbered from 1 — earlier images are not addressable
 * by index at all (measured against grok 1.0.0, `research/image-index-probe.cjs`:
 * a bad reference is refused with "matches no image attached to THIS MESSAGE …
 * ask the user to re-attach it here"). We used to number session-scoped, from a
 * counter that never reset, so the second image of a conversation went out
 * tagged `[Image #2]` while the CLI knew it as `#1` and every `image_edit` on it
 * failed. Position IS the contract, so the tag is now derived from position
 * rather than remembered.
 *
 * Numbering counts only VISIBLE chips, matching the two things a send derives
 * from the same list — the image blocks (`chip.hidden` skips the pre-read) and
 * the bubble's chips (`chips.filter(c => !c.hidden)`) — so the tag, the block
 * order, and the label the user sees cannot disagree. A hidden image chip keeps
 * its previous number: it is not on the wire, and there is no way to hide one
 * from the UI anyway (explicit chips render as removable rows, only the implicit
 * editor chip has the eye), so this is a degenerate case kept merely total.
 *
 * `id` is deliberately NOT rewritten — it is the handle the webview holds for
 * removeChip/toggleChip, and renumbering must not invalidate a click that is
 * already in flight. Its embedded index is an opaque uniqueness component, not
 * a claim about the current tag.
 */
export function withPerMessageImageIndices(chips: FileChip[]): FileChip[] {
  let n = 0;
  return chips.map((chip) => {
    if (!isImageChip(chip) || chip.hidden) return chip;
    n += 1;
    return chip.imageIndex === n ? chip : { ...chip, imageIndex: n, relPath: `Image #${n}` };
  });
}

/**
 * Should a freshly rebuilt implicit chip start eye-off?
 *
 * The active-editor chip is destroyed and rebuilt on every file switch, so the
 * user's "don't send this" has to be re-derived each time — reading it off the
 * old chip alone made dismissing the context futile, since switching files
 * silently re-enabled it (#67). The live chip wins when there is one: it is
 * already in sync with the persisted value and needs no await. Otherwise
 * (fresh webview, extension restart, chip cleared by a non-file editor) the
 * remembered preference seeds it.
 */
export function implicitChipStartsHidden(
  prev: FileChip | undefined,
  remembered: boolean,
): boolean {
  return prev ? prev.hidden : remembered;
}

export function removeChip(chips: FileChip[], id: string): FileChip[] {
  return chips.filter((c) => c.id !== id);
}

export function toggleChip(chips: FileChip[], id: string): FileChip[] {
  return chips.map((c) => (c.id === id ? { ...c, hidden: !c.hidden } : c));
}

export function clearImplicitChips(chips: FileChip[]): FileChip[] {
  return chips.filter((c) => !isImplicitChip(c));
}

/** Drop exactly the chips a send consumed. The implicit context chip stays
 *  (it mirrors IDE state, not a one-shot attachment) — and so does anything
 *  NOT in the send's snapshot: a chip staged while the send was pre-reading
 *  images belongs to the next turn, not the bin. */
export function consumeChips(current: FileChip[], sent: FileChip[]): FileChip[] {
  const sentIds = new Set(sent.map((c) => c.id));
  return current.filter((c) => isImplicitChip(c) || !sentIds.has(c.id));
}

/** An implicit chip is the active-editor file auto-added for ambient context
 *  (vs. a file the user explicitly attached). The id prefix is the source of
 *  truth — set by makeImplicitChip / makeExplicitChip. */
export function isImplicitChip(chip: FileChip): boolean {
  return chip.id.startsWith("implicit:");
}
