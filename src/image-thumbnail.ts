// Host-side thumbnailing for images that cross to a remote browser.
//
// Shape: decode whatever we were given to RGBA, downscale, then encode BOTH a
// PNG and a JPEG and keep the smaller. That last part is not fussiness — the
// two formats fail in opposite directions on the two things people actually
// attach. A 320px screenshot is flat colour and crisp text: PNG lands around
// 10-50 KiB and stays sharp, while JPEG softens the text. A 320px photograph
// is the reverse: PNG runs ~100 KiB (measured: a 2000x1334 photo re-encoded as
// RGBA PNG came out at exactly the 96 KiB budget and was dropped) where JPEG
// costs ~15-25 KiB. Encoding twice at this size is microseconds; guessing wrong
// means no thumbnail at all.
//
// JPEG decoding uses jpeg-js: pure JS, zero dependencies. A native codec would
// be faster and much worse here — this extension is plain-tsc-compiled and
// ships node_modules inside the vsix, so a platform binary would break
// packaging on every machine that isn't the one that built it.

import { deflateSync, inflateSync } from "node:zlib";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Refuse implausible sources before decoding: this runs on the extension host's
 *  main thread, and a full decode of a huge image would stall the UI. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
/** Decoding costs roughly 200ms per megapixel on the host's MAIN thread, so this
 *  ceiling is a time budget wearing a pixel costume: 12 MP is about 2.4s worst
 *  case, paid once per file (the caller memoises on path + mtime) and only while
 *  a remote is actually connected.
 *
 *  It has to clear 4K — 3840x2160 is 8.3 MP and completely ordinary for both
 *  screenshots and camera output; an earlier 4 MP ceiling silently refused every
 *  one of them, which measured as 9 of 15 real photos producing nothing. It must
 *  NOT be much higher either: at 40 MP a single 48 MP phone photo would freeze
 *  the editor for ~8 seconds. Images arriving FROM a phone are already capped at
 *  2560px by the browser before upload, so this only bounds desk-side files. */
const MAX_PIXELS = 12_000_000;
const JPEG_QUALITY = 70;

interface Rgba {
  data: Uint8Array;
  width: number;
  height: number;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.allocUnsafe(12 + data.byteLength);
  out.writeUInt32BE(data.byteLength, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.byteLength);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode the 8-bit PNG colour types to RGBA. Palette (type 3) is included
 *  because it is common — the extension's own icon is one, and the previous
 *  decoder refused it. Interlaced and 16-bit stay unsupported: rare enough that
 *  falling back to no thumbnail beats carrying the code. */
function decodePngRgba(source: Uint8Array): Rgba | null {
  const view = Buffer.from(source);
  if (view.byteLength < PNG_SIGNATURE.byteLength || !view.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Buffer | undefined;
  let paletteAlpha: Buffer | undefined;
  const idat: Buffer[] = [];
  while (offset + 12 <= view.byteLength) {
    const length = view.readUInt32BE(offset);
    const type = view.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > view.byteLength) return null;
    if (type === "IHDR" && length >= 13) {
      width = view.readUInt32BE(start);
      height = view.readUInt32BE(start + 4);
      if (!width || !height || width > MAX_PIXELS / height) return null;
      bitDepth = view[start + 8];
      colorType = view[start + 9];
      // compression / filter / interlace must all be the baseline values.
      if (view[start + 10] !== 0 || view[start + 11] !== 0 || view[start + 12] !== 0) return null;
    } else if (type === "PLTE") {
      palette = view.subarray(start, end);
    } else if (type === "tRNS") {
      paletteAlpha = view.subarray(start, end);
    } else if (type === "IDAT") {
      idat.push(view.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  if (bitDepth !== 8 || idat.length === 0) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) return null;
  if (colorType === 3 && (!palette || palette.byteLength < 3)) return null;

  const rowBytes = width * channels;
  let filtered: Buffer;
  try {
    filtered = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  if (filtered.byteLength < height * (rowBytes + 1)) return null;

  const raw = Buffer.alloc(height * rowBytes);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = filtered[input++];
    const rowStart = y * rowBytes;
    const priorStart = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const value = filtered[input++];
      const left = x >= channels ? raw[rowStart + x - channels] : 0;
      const up = y > 0 ? raw[priorStart + x] : 0;
      const upperLeft = y > 0 && x >= channels ? raw[priorStart + x - channels] : 0;
      raw[rowStart + x] = filter === 0
        ? value
        : filter === 1
          ? (value + left) & 0xff
          : filter === 2
            ? (value + up) & 0xff
            : filter === 3
              ? (value + Math.floor((left + up) / 2)) & 0xff
              : filter === 4
                ? (value + paeth(left, up, upperLeft)) & 0xff
                : value;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, px = 0; px < width * height; px++) {
    const src = px * channels;
    const dst = px * 4;
    if (colorType === 6) {
      raw.copy(rgba, dst, src, src + 4);
    } else if (colorType === 2) {
      raw.copy(rgba, dst, src, src + 3);
      rgba[dst + 3] = 255;
    } else if (colorType === 4) {
      rgba.fill(raw[src], dst, dst + 3);
      rgba[dst + 3] = raw[src + 1];
    } else if (colorType === 3) {
      const index = raw[src];
      const entry = index * 3;
      // An out-of-range index is a corrupt file, not something to render.
      if (!palette || entry + 2 >= palette.byteLength) return null;
      rgba[dst] = palette[entry];
      rgba[dst + 1] = palette[entry + 1];
      rgba[dst + 2] = palette[entry + 2];
      rgba[dst + 3] = paletteAlpha && index < paletteAlpha.byteLength ? paletteAlpha[index] : 255;
    } else {
      rgba.fill(raw[src], dst, dst + 3);
      rgba[dst + 3] = 255;
    }
    i = dst;
  }
  return { data: rgba, width, height };
}

function decodeJpegRgba(source: Uint8Array): Rgba | null {
  try {
    // jpeg-js enforces the pixel ceiling itself, so a huge photo is refused
    // during parsing rather than after allocating for it.
    const out = decodeJpeg(Buffer.from(source), {
      useTArray: true,
      maxResolutionInMP: MAX_PIXELS / 1_000_000,
      // Decoding 3840x2160 needs ~91 MB of working set, so a tighter budget
      // silently refuses every 4K photo — which is what 64 did. This is the
      // real ceiling on the work, paired with MAX_SOURCE_BYTES above.
      maxMemoryUsageInMB: 256,
    });
    if (!out?.width || !out?.height) return null;
    return { data: out.data, width: out.width, height: out.height };
  } catch {
    return null;
  }
}

/** Nearest-neighbour: at 320px the difference from a filtered resample is not
 *  visible on a chip, and this stays cheap on the host's main thread. */
function resizeRgba(source: Rgba, maxDimension: number): Rgba {
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  if (scale >= 1) return source;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(source.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(source.width - 1, Math.floor(x / scale));
      const from = (sourceY * source.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      data[to] = source.data[from];
      data[to + 1] = source.data[from + 1];
      data[to + 2] = source.data[from + 2];
      data[to + 3] = source.data[from + 3];
    }
  }
  return { data, width, height };
}

function encodePngRgba(image: Rgba): Uint8Array {
  const stride = image.width * 4 + 1;
  const raw = Buffer.alloc(image.height * stride);
  for (let y = 0; y < image.height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: none
    Buffer.from(image.data.buffer, image.data.byteOffset + y * image.width * 4, image.width * 4)
      .copy(raw, rowStart + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function encodeJpegRgba(image: Rgba): Uint8Array | null {
  // JPEG has no alpha. Compositing onto white keeps a transparent screenshot
  // readable; leaving it alone turns transparency black and destroys the text
  // contrast. This mirrors what the browser-side upload path already does.
  const opaque = Buffer.alloc(image.width * image.height * 4);
  for (let i = 0; i < opaque.byteLength; i += 4) {
    const alpha = image.data[i + 3];
    if (alpha === 255) {
      opaque[i] = image.data[i];
      opaque[i + 1] = image.data[i + 1];
      opaque[i + 2] = image.data[i + 2];
    } else {
      const a = alpha / 255;
      opaque[i] = Math.round(image.data[i] * a + 255 * (1 - a));
      opaque[i + 1] = Math.round(image.data[i + 1] * a + 255 * (1 - a));
      opaque[i + 2] = Math.round(image.data[i + 2] * a + 255 * (1 - a));
    }
    opaque[i + 3] = 255;
  }
  try {
    return encodeJpeg({ data: opaque, width: image.width, height: image.height }, JPEG_QUALITY).data;
  } catch {
    return null;
  }
}

/** Downscale to `maxDimension` and return the smallest encoding, or null when
 *  the source is implausible or in a form we do not decode. Null is a supported
 *  answer: the caller drops the preview and the client shows the plain
 *  `[Image #N]` chip. */
export function thumbnailImage(bytes: Uint8Array, mimeType: string, maxDimension: number): Uint8Array | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_BYTES) return null;
  const mime = mimeType.toLowerCase();
  const decoded = mime === "image/png"
    ? decodePngRgba(bytes)
    : mime === "image/jpeg" || mime === "image/jpg"
      ? decodeJpegRgba(bytes)
      : null;
  if (!decoded) return null;

  const resized = resizeRgba(decoded, maxDimension);
  const png = encodePngRgba(resized);
  const jpeg = encodeJpegRgba(resized);
  if (!jpeg) return png;
  return jpeg.byteLength < png.byteLength ? jpeg : png;
}

/** The mime the thumbnail bytes are actually in — the encoder picks per image,
 *  so a PNG source can come back as JPEG and vice versa. Callers build a data:
 *  URI and MUST label it with this rather than the source's mime. */
export function thumbnailMime(thumb: Uint8Array): string {
  return thumb.byteLength >= 8 && Buffer.from(thumb).subarray(0, 8).equals(PNG_SIGNATURE)
    ? "image/png"
    : "image/jpeg";
}
