import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_PNG_PIXELS = 4_000_000;

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

/** Decode/filter the common 8-bit PNG forms and emit a small RGBA PNG. */
function downscalePng(source: Uint8Array, maxDimension: number): Uint8Array | null {
  if (source.byteLength > MAX_PNG_SOURCE_BYTES) return null;
  if (source.byteLength < PNG_SIGNATURE.byteLength || !Buffer.from(source).subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= source.byteLength) {
    const view = Buffer.from(source);
    const length = view.readUInt32BE(offset);
    const type = view.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > source.byteLength) return null;
    if (type === "IHDR" && length >= 13) {
      width = view.readUInt32BE(start);
      height = view.readUInt32BE(start + 4);
      if (!width || !height || width > MAX_PNG_PIXELS / height) return null;
      bitDepth = view[start + 8];
      colorType = view[start + 9];
      if (view[start + 10] !== 0 || view[start + 11] !== 0 || view[start + 12] !== 0) return null;
    } else if (type === "IDAT") {
      idat.push(view.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    offset = end + 4;
  }
  if (bitDepth !== 8 || idat.length === 0) return null;
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) return null; // palette PNGs need a PLTE lookup; don't guess.
  const rowBytes = width * channels;
  let filtered: Buffer;
  try {
    filtered = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  if (filtered.byteLength < height * (rowBytes + 1)) return null;
  const pixels = Buffer.alloc(height * rowBytes);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = filtered[input++];
    const rowStart = y * rowBytes;
    const priorStart = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = filtered[input++];
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const up = y > 0 ? pixels[priorStart + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[priorStart + x - channels] : 0;
      pixels[rowStart + x] = filter === 0
        ? raw
        : filter === 1
          ? (raw + left) & 0xff
          : filter === 2
            ? (raw + up) & 0xff
            : filter === 3
              ? (raw + Math.floor((left + up) / 2)) & 0xff
              : filter === 4
                ? (raw + paeth(left, up, upperLeft)) & 0xff
                : raw;
    }
  }

  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  if (outWidth === width && outHeight === height) return source;
  const raw = Buffer.alloc(outHeight * (outWidth * 4 + 1));
  for (let y = 0; y < outHeight; y++) {
    const sourceY = Math.min(height - 1, Math.floor(y / scale));
    const rowStart = y * (outWidth * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < outWidth; x++) {
      const sourceX = Math.min(width - 1, Math.floor(x / scale));
      const sourceOffset = sourceY * rowBytes + sourceX * channels;
      const destOffset = rowStart + 1 + x * 4;
      if (colorType === 6) {
        pixels.copy(raw, destOffset, sourceOffset, sourceOffset + 4);
      } else if (colorType === 4) {
        raw[destOffset] = pixels[sourceOffset];
        raw[destOffset + 1] = pixels[sourceOffset];
        raw[destOffset + 2] = pixels[sourceOffset];
        raw[destOffset + 3] = pixels[sourceOffset + 1];
      } else if (colorType === 2) {
        pixels.copy(raw, destOffset, sourceOffset, sourceOffset + 3);
        raw[destOffset + 3] = 255;
      } else {
        raw.fill(pixels[sourceOffset], destOffset, destOffset + 3);
        raw[destOffset + 3] = 255;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(outWidth, 0);
  header.writeUInt32BE(outHeight, 4);
  header[8] = 8;
  header[9] = 6;
  const output = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
  return output;
}

/** Best-effort thumbnailing with no image package dependency. Non-PNG images
 * stay eligible only when already below the relay decoration budget. */
export function thumbnailImage(bytes: Uint8Array, mimeType: string, maxDimension: number): Uint8Array | null {
  if (mimeType.toLowerCase() === "image/png") return downscalePng(bytes, maxDimension);
  return bytes;
}
