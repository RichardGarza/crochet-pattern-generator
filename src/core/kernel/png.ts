// PNG codec for RGBA8 images, on fflate (DESIGN.md §2.3.1, §5.2.1). Step 0 kernel: pure, no DOM.
//
// src/core never decodes user files — the browser does that in workers/decode.ts. This codec exists so that
// node tests can read PNG fixtures (vitest's node environment has neither createImageBitmap nor OffscreenCanvas)
// and so that charts can be exported as 1-px-per-stitch PNGs.
import { unzlibSync, zlibSync } from 'fflate';
import type { RgbaImage } from '../../types/geometry';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Refuse absurd headers before allocating (2^26 px = 8192 × 8192; photos never come through here). */
const MAX_PIXELS = 1 << 26;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeU32(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 24) & 255;
  out[at + 1] = (value >>> 16) & 255;
  out[at + 2] = (value >>> 8) & 255;
  out[at + 3] = value & 255;
}

const readU32 = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

function fail(message: string): never {
  throw new Error(`decodePng: ${message}`);
}

/**
 * Encodes an image as an 8-bit RGBA PNG (color type 6, filter 0 on every row, one IDAT chunk, fflate zlib).
 * The output is deterministic: the same image always gives the same bytes.
 */
export function encodePng(img: RgbaImage): Uint8Array<ArrayBuffer> {
  const { w, h, data } = img;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new Error(`encodePng: width and height must be integers >= 1, got ${w} × ${h}`);
  }
  if (data.length !== w * h * 4) {
    throw new Error(`encodePng: data has ${data.length} bytes, expected ${w * h * 4} (${w} × ${h} RGBA)`);
  }

  const stride = w * 4;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    // raw[y·(stride + 1)] stays 0: filter type "None"
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlibSync(raw, { level: 6 });

  const out = new Uint8Array(8 + (12 + 13) + (12 + idat.length) + 12);
  out.set(SIGNATURE, 0);
  let at = 8;
  const chunk = (type: string, body: Uint8Array): void => {
    writeU32(out, at, body.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(body, at + 8);
    writeU32(out, at + 8 + body.length, crc32(out, at + 4, at + 8 + body.length));
    at += 12 + body.length;
  };

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, w);
  writeU32(ihdr, 4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // ihdr[10..12] = 0: deflate, adaptive filtering, no interlace
  chunk('IHDR', ihdr);
  chunk('IDAT', idat);
  chunk('IEND', new Uint8Array(0));
  return out;
}

/** Samples per pixel for each PNG color type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decodes a PNG into RGBA8. Supported: non-interlaced, 8-bit gray / RGB / palette / gray-alpha / RGBA, and
 * 1-, 2- and 4-bit gray and palette images; tRNS transparency is applied. Throws an Error starting with
 * "decodePng:" on 16-bit or interlaced images, on a bad signature or CRC, and on truncated or inconsistent data.
 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) fail('not a PNG file (bad signature)');

  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = -1;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idatParts: Uint8Array[] = [];
  let idatLength = 0;
  let seenEnd = false;

  let at = 8;
  while (!seenEnd) {
    if (at + 12 > bytes.length) fail('truncated file (no IEND chunk)');
    const length = readU32(bytes, at);
    const bodyStart = at + 8;
    const bodyEnd = bodyStart + length;
    if (bodyEnd + 4 > bytes.length) fail('truncated chunk');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, bodyEnd) !== readU32(bytes, bodyEnd)) fail(`bad CRC in ${type} chunk`);
    const body = bytes.subarray(bodyStart, bodyEnd);
    if (colorType < 0 && type !== 'IHDR') fail('IHDR is not the first chunk');

    switch (type) {
      case 'IHDR': {
        if (colorType >= 0) fail('more than one IHDR chunk');
        if (length !== 13) fail('IHDR has the wrong length');
        w = readU32(body, 0);
        h = readU32(body, 4);
        bitDepth = body[8];
        colorType = body[9];
        if (w < 1 || h < 1) fail('image has no pixels');
        if (w * h > MAX_PIXELS) fail(`image is too large (${w} × ${h})`);
        if (!(colorType in CHANNELS)) fail(`unknown color type ${colorType}`);
        if (bitDepth === 16) fail('16-bit PNGs are not supported');
        const subByte = bitDepth === 1 || bitDepth === 2 || bitDepth === 4;
        if (bitDepth !== 8 && !(subByte && (colorType === 0 || colorType === 3))) {
          fail(`bit depth ${bitDepth} is not valid for color type ${colorType}`);
        }
        if (body[10] !== 0 || body[11] !== 0) fail('unknown compression or filter method');
        if (body[12] !== 0) fail('interlaced PNGs are not supported');
        break;
      }
      case 'PLTE':
        if (length === 0 || length % 3 !== 0 || length > 768) fail('PLTE has the wrong length');
        palette = body;
        break;
      case 'tRNS':
        trns = body;
        break;
      case 'IDAT':
        idatParts.push(body);
        idatLength += length;
        break;
      case 'IEND':
        seenEnd = true;
        break;
      default:
        // An unknown critical chunk (uppercase first letter) means we cannot render the image correctly.
        if ((bytes[at + 4] & 0x20) === 0) fail(`unsupported critical chunk ${type}`);
    }
    at = bodyEnd + 4;
  }
  if (idatParts.length === 0) fail('no IDAT chunk');
  if (colorType === 3 && !palette) fail('palette image without a PLTE chunk');

  let zlibData = idatParts[0];
  if (idatParts.length > 1) {
    zlibData = new Uint8Array(idatLength);
    let offset = 0;
    for (const part of idatParts) {
      zlibData.set(part, offset);
      offset += part.length;
    }
  }

  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil((w * bitsPerPixel) / 8);
  const expected = h * (rowBytes + 1);
  let raw: Uint8Array;
  try {
    // The size is known from the header, so the stream is inflated into a fixed buffer: memory stays bounded
    // whatever the stream claims. fflate stops quietly when the buffer is full, hence one spare byte — a stream
    // that holds more than the header announces then shows up as a wrong length below.
    raw = unzlibSync(zlibData, { out: new Uint8Array(expected + 1) });
  } catch {
    fail('image data is not a valid zlib stream of the size the header announces');
  }
  if (raw.length !== expected) fail(`image data has ${raw.length} bytes, expected ${expected}`);

  unfilter(raw, h, rowBytes, Math.max(1, bitsPerPixel >> 3));

  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = y * (rowBytes + 1) + 1;
    let o = y * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
      switch (colorType) {
        case 0: {
          const v = sample(raw, row, x, bitDepth);
          const gray = bitDepth === 8 ? v : Math.round((v * 255) / ((1 << bitDepth) - 1));
          data[o] = data[o + 1] = data[o + 2] = gray;
          data[o + 3] = trns && trns.length >= 2 && ((trns[0] << 8) | trns[1]) === v ? 0 : 255;
          break;
        }
        case 2: {
          const p = row + x * 3;
          const r = raw[p];
          const g = raw[p + 1];
          const b = raw[p + 2];
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
          const keyed =
            trns !== undefined &&
            trns.length >= 6 &&
            ((trns[0] << 8) | trns[1]) === r &&
            ((trns[2] << 8) | trns[3]) === g &&
            ((trns[4] << 8) | trns[5]) === b;
          data[o + 3] = keyed ? 0 : 255;
          break;
        }
        case 3: {
          const index = sample(raw, row, x, bitDepth);
          const pal = palette as Uint8Array;
          if (index * 3 + 2 >= pal.length) fail(`palette index ${index} is out of range`);
          data[o] = pal[index * 3];
          data[o + 1] = pal[index * 3 + 1];
          data[o + 2] = pal[index * 3 + 2];
          data[o + 3] = trns && index < trns.length ? trns[index] : 255;
          break;
        }
        case 4: {
          const p = row + x * 2;
          data[o] = data[o + 1] = data[o + 2] = raw[p];
          data[o + 3] = raw[p + 1];
          break;
        }
        default: {
          const p = row + x * 4;
          data[o] = raw[p];
          data[o + 1] = raw[p + 1];
          data[o + 2] = raw[p + 2];
          data[o + 3] = raw[p + 3];
        }
      }
    }
  }
  return { w, h, data };
}

/** The x-th sample of a row of 1-, 2-, 4- or 8-bit samples (most significant bits first). */
function sample(raw: Uint8Array, row: number, x: number, bitDepth: number): number {
  if (bitDepth === 8) return raw[row + x];
  const bit = x * bitDepth;
  const shift = 8 - bitDepth - (bit & 7);
  return (raw[row + (bit >> 3)] >> shift) & ((1 << bitDepth) - 1);
}

/** Undoes the per-row PNG filters in place. `bpp` = bytes per complete pixel, at least 1. */
function unfilter(raw: Uint8Array, h: number, rowBytes: number, bpp: number): void {
  const stride = rowBytes + 1;
  for (let y = 0; y < h; y++) {
    const filter = raw[y * stride];
    const cur = y * stride + 1;
    const up = cur - stride; // only read when y > 0
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < rowBytes; i++) raw[cur + i] = (raw[cur + i] + raw[cur + i - bpp]) & 255;
        break;
      case 2:
        if (y > 0) for (let i = 0; i < rowBytes; i++) raw[cur + i] = (raw[cur + i] + raw[up + i]) & 255;
        break;
      case 3:
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= bpp ? raw[cur + i - bpp] : 0;
          const above = y > 0 ? raw[up + i] : 0;
          raw[cur + i] = (raw[cur + i] + ((left + above) >> 1)) & 255;
        }
        break;
      case 4:
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? raw[cur + i - bpp] : 0;
          const b = y > 0 ? raw[up + i] : 0;
          const c = i >= bpp && y > 0 ? raw[up + i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          raw[cur + i] = (raw[cur + i] + predictor) & 255;
        }
        break;
      default:
        fail(`unknown filter type ${filter} in row ${y}`);
    }
  }
}
