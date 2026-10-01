import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fromFn, fromRows, sameImage, solid } from '../../../test/rgba';
import type { RgbaImage } from '../../../types/geometry';
import { decodePng, encodePng } from '../png';
import { mulberry32 } from '../prng';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function randomImage(w: number, h: number, seed: number): RgbaImage {
  const rng = mulberry32(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rng() * 256);
  return { w, h, data };
}

// ---- an independent PNG writer for the decoder tests (node:zlib, its own CRC and filters) -----------------

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function ihdr(w: number, h: number, bitDepth: number, colorType: number, interlace = 0): Uint8Array {
  const body = new Uint8Array(13);
  const view = new DataView(body.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  body[8] = bitDepth;
  body[9] = colorType;
  body[12] = interlace;
  return chunk('IHDR', body);
}

/** Applies PNG filter `type` to unfiltered scanlines (each `rowBytes` long) and prefixes the filter bytes. */
function filterRows(rows: Uint8Array, h: number, rowBytes: number, bpp: number, type: number | 'cycle'): Uint8Array {
  const out = new Uint8Array(h * (rowBytes + 1));
  for (let y = 0; y < h; y++) {
    const t = type === 'cycle' ? y % 5 : type;
    out[y * (rowBytes + 1)] = t;
    for (let i = 0; i < rowBytes; i++) {
      const x = rows[y * rowBytes + i];
      const a = i >= bpp ? rows[y * rowBytes + i - bpp] : 0;
      const b = y > 0 ? rows[(y - 1) * rowBytes + i] : 0;
      const c = i >= bpp && y > 0 ? rows[(y - 1) * rowBytes + i - bpp] : 0;
      let predictor = 0;
      if (t === 1) predictor = a;
      else if (t === 2) predictor = b;
      else if (t === 3) predictor = (a + b) >> 1;
      else if (t === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * (rowBytes + 1) + 1 + i] = (x - predictor) & 255;
    }
  }
  return out;
}

interface ForeignPng {
  w: number;
  h: number;
  bitDepth: number;
  colorType: number;
  /** Unfiltered scanlines, packed as the PNG stores them. */
  rows: Uint8Array;
  filter?: number | 'cycle';
  palette?: number[];
  trns?: number[];
  idatSplit?: number;
  extra?: Uint8Array[];
  interlace?: number;
}

function foreignPng(p: ForeignPng): Uint8Array {
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[p.colorType];
  const bits = channels * p.bitDepth;
  const rowBytes = Math.ceil((p.w * bits) / 8);
  const filtered = filterRows(p.rows, p.h, rowBytes, Math.max(1, bits >> 3), p.filter ?? 0);
  const z = new Uint8Array(deflateSync(filtered));
  const parts: Uint8Array[] = [new Uint8Array(SIGNATURE), ihdr(p.w, p.h, p.bitDepth, p.colorType, p.interlace ?? 0)];
  for (const e of p.extra ?? []) parts.push(e);
  if (p.palette) parts.push(chunk('PLTE', new Uint8Array(p.palette)));
  if (p.trns) parts.push(chunk('tRNS', new Uint8Array(p.trns)));
  if (p.idatSplit) {
    for (let at = 0; at < z.length; at += p.idatSplit) parts.push(chunk('IDAT', z.subarray(at, at + p.idatSplit)));
  } else {
    parts.push(chunk('IDAT', z));
  }
  parts.push(chunk('IEND', new Uint8Array(0)));
  return concat(parts);
}

function rgbaRows(img: RgbaImage): Uint8Array {
  return new Uint8Array(img.data);
}

/** Lists a PNG's chunks, checking every CRC with node:zlib. */
function readChunks(png: Uint8Array): { type: string; body: Uint8Array }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; body: Uint8Array }[] = [];
  let at = 8;
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
    chunks.push({ type, body });
    at += 12 + length;
  }
  expect(at).toBe(png.length);
  return chunks;
}

// ---- encoder -------------------------------------------------------------------------------------------

describe('encodePng', () => {
  it('writes a well-formed RGBA8 PNG (checked with node:zlib)', () => {
    const img = randomImage(13, 7, 1);
    const png = encodePng(img);
    expect(png).toBeInstanceOf(Uint8Array);
    expect(Array.from(png.subarray(0, 8))).toEqual(SIGNATURE);

    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const head = chunks[0].body;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    expect(head.length).toBe(13);
    expect(view.getUint32(0)).toBe(13);
    expect(view.getUint32(4)).toBe(7);
    expect(Array.from(head.subarray(8))).toEqual([8, 6, 0, 0, 0]);
    expect(chunks[2].body.length).toBe(0);

    // filter 0 on every row, then the pixels unchanged
    const raw = new Uint8Array(inflateSync(chunks[1].body));
    expect(raw.length).toBe(7 * (1 + 13 * 4));
    for (let y = 0; y < 7; y++) {
      const start = y * (1 + 13 * 4);
      expect(raw[start]).toBe(0);
      expect(Array.from(raw.subarray(start + 1, start + 1 + 52))).toEqual(Array.from(img.data.subarray(y * 52, (y + 1) * 52)));
    }
  });

  it('is deterministic', () => {
    const img = randomImage(40, 30, 2);
    expect(Array.from(encodePng(img))).toEqual(Array.from(encodePng({ w: 40, h: 30, data: new Uint8ClampedArray(img.data) })));
  });

  it('rejects impossible images', () => {
    expect(() => encodePng({ w: 0, h: 4, data: new Uint8ClampedArray(0) })).toThrow(/encodePng/);
    expect(() => encodePng({ w: 2, h: -1, data: new Uint8ClampedArray(0) })).toThrow(/encodePng/);
    expect(() => encodePng({ w: 1.5, h: 2, data: new Uint8ClampedArray(12) })).toThrow(/encodePng/);
    expect(() => encodePng({ w: 2, h: 2, data: new Uint8ClampedArray(15) })).toThrow(/expected 16/);
  });
});

// ---- round trips ---------------------------------------------------------------------------------------

describe('PNG round trip', () => {
  it.each([
    [1, 1],
    [1, 9],
    [9, 1],
    [2, 2],
    [16, 16],
    [33, 17],
    [257, 3],
    [200, 200],
  ])('round-trips a random %i × %i RGBA8 image exactly', (w, h) => {
    const img = randomImage(w, h, w * 1000 + h);
    const back = decodePng(encodePng(img));
    expect(back.w).toBe(w);
    expect(back.h).toBe(h);
    expect(back.data).toBeInstanceOf(Uint8ClampedArray);
    expect(back.data.length).toBe(w * h * 4);
    expect(sameImage(back, img)).toBe(true);
  });

  it('keeps fully transparent and semi-transparent pixels as they are (no premultiplication)', () => {
    const img = fromFn(4, 4, (x, y) => [x * 60, y * 60, 200, (x + y) * 36]);
    expect(sameImage(decodePng(encodePng(img)), img)).toBe(true);
  });

  it('round-trips a 1-px-per-stitch chart export (G14 building block)', () => {
    const chart = fromRows(['BAAAA', 'ABBBA', 'AABAA'], { A: '#f4ebdd', B: '#c8a27a' });
    const back = decodePng(encodePng(chart));
    expect(back.w).toBe(5);
    expect(back.h).toBe(3);
    expect(sameImage(back, chart)).toBe(true);
  });

  it('compresses flat images well', () => {
    expect(encodePng(solid(300, 300, '#c8a27a')).length).toBeLessThan(2000);
  });

  it('decodes a view into a larger buffer', () => {
    const png = encodePng(randomImage(5, 5, 3));
    const padded = new Uint8Array(png.length + 20);
    padded.set(png, 7);
    expect(sameImage(decodePng(padded.subarray(7, 7 + png.length)), decodePng(png))).toBe(true);
  });
});

// ---- decoder against an independent writer -------------------------------------------------------------

describe('decodePng', () => {
  it.each([0, 1, 2, 3, 4, 'cycle'] as const)('undoes filter type %s (RGBA)', (filter) => {
    const img = randomImage(11, 9, 50);
    const png = foreignPng({ w: 11, h: 9, bitDepth: 8, colorType: 6, rows: rgbaRows(img), filter });
    expect(sameImage(decodePng(png), img)).toBe(true);
  });

  it.each([1, 2, 3, 4] as const)('undoes filter type %i on smooth gradients too', (filter) => {
    const img = fromFn(64, 48, (x, y) => [x * 4, y * 5, (x + y) * 2, 255 - x]);
    const png = foreignPng({ w: 64, h: 48, bitDepth: 8, colorType: 6, rows: rgbaRows(img), filter });
    expect(sameImage(decodePng(png), img)).toBe(true);
  });

  it('decodes 8-bit RGB (opaque) with every filter', () => {
    const rng = mulberry32(8);
    const w = 10;
    const h = 6;
    const rows = new Uint8Array(w * h * 3);
    for (let i = 0; i < rows.length; i++) rows[i] = Math.floor(rng() * 256);
    const out = decodePng(foreignPng({ w, h, bitDepth: 8, colorType: 2, rows, filter: 'cycle' }));
    for (let i = 0; i < w * h; i++) {
      expect(Array.from(out.data.subarray(i * 4, i * 4 + 4))).toEqual([rows[i * 3], rows[i * 3 + 1], rows[i * 3 + 2], 255]);
    }
  });

  it('applies an RGB color key (tRNS)', () => {
    const rows = new Uint8Array([10, 20, 30, 255, 0, 255, 10, 20, 31, 255, 0, 255]);
    const out = decodePng(foreignPng({ w: 4, h: 1, bitDepth: 8, colorType: 2, rows, trns: [0, 255, 0, 0, 0, 255] }));
    expect(Array.from(out.data)).toEqual([10, 20, 30, 255, 255, 0, 255, 0, 10, 20, 31, 255, 255, 0, 255, 0]);
  });

  it('decodes 8-bit gray and gray with a color key', () => {
    const rows = new Uint8Array([0, 128, 255, 7]);
    const opaque = decodePng(foreignPng({ w: 2, h: 2, bitDepth: 8, colorType: 0, rows, filter: 1 }));
    expect(Array.from(opaque.data)).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255, 7, 7, 7, 255]);
    const keyed = decodePng(foreignPng({ w: 2, h: 2, bitDepth: 8, colorType: 0, rows, trns: [0, 128] }));
    expect(Array.from(keyed.data)).toEqual([0, 0, 0, 255, 128, 128, 128, 0, 255, 255, 255, 255, 7, 7, 7, 255]);
  });

  it('decodes 8-bit gray + alpha', () => {
    const rows = new Uint8Array([10, 255, 200, 0, 99, 128, 0, 1]);
    const out = decodePng(foreignPng({ w: 2, h: 2, bitDepth: 8, colorType: 4, rows, filter: 4 }));
    expect(Array.from(out.data)).toEqual([10, 10, 10, 255, 200, 200, 200, 0, 99, 99, 99, 128, 0, 0, 0, 1]);
  });

  it('decodes an 8-bit palette image with partial tRNS', () => {
    const palette = [200, 162, 122, 244, 235, 221, 34, 34, 34];
    const rows = new Uint8Array([0, 1, 2, 2, 1, 0]);
    const out = decodePng(foreignPng({ w: 3, h: 2, bitDepth: 8, colorType: 3, rows, palette, trns: [255, 64], filter: 2 }));
    expect(Array.from(out.data)).toEqual([
      200, 162, 122, 255, 244, 235, 221, 64, 34, 34, 34, 255, 34, 34, 34, 255, 244, 235, 221, 64, 200, 162, 122, 255,
    ]);
  });

  it('decodes 1-, 2- and 4-bit palette images (how tools store logos with few colors)', () => {
    const palette = [255, 255, 255, 204, 0, 0, 0, 0, 255, 0, 128, 0];
    // 1-bit, 10 px wide: 2 bytes per row, the last 6 bits are padding
    const one = decodePng(
      foreignPng({ w: 10, h: 2, bitDepth: 1, colorType: 3, rows: new Uint8Array([0b10110000, 0b01000000, 0b00000000, 0b11000000]), palette }),
    );
    const idx1 = [1, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1];
    idx1.forEach((p, i) => expect(Array.from(one.data.subarray(i * 4, i * 4 + 3))).toEqual(palette.slice(p * 3, p * 3 + 3)));
    // 2-bit, 5 px wide: 2 bytes per row
    const two = decodePng(
      foreignPng({ w: 5, h: 1, bitDepth: 2, colorType: 3, rows: new Uint8Array([0b00011011, 0b11000000]), palette }),
    );
    [0, 1, 2, 3, 3].forEach((p, i) => expect(Array.from(two.data.subarray(i * 4, i * 4 + 3))).toEqual(palette.slice(p * 3, p * 3 + 3)));
    // 4-bit, 3 px wide: 2 bytes per row
    const four = decodePng(foreignPng({ w: 3, h: 1, bitDepth: 4, colorType: 3, rows: new Uint8Array([0x32, 0x10]), palette }));
    [3, 2, 1].forEach((p, i) => expect(Array.from(four.data.subarray(i * 4, i * 4 + 3))).toEqual(palette.slice(p * 3, p * 3 + 3)));
  });

  it('scales 1-, 2- and 4-bit gray to 0..255', () => {
    const one = decodePng(foreignPng({ w: 3, h: 1, bitDepth: 1, colorType: 0, rows: new Uint8Array([0b10100000]) }));
    expect(Array.from(one.data)).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const two = decodePng(foreignPng({ w: 4, h: 1, bitDepth: 2, colorType: 0, rows: new Uint8Array([0b00011011]) }));
    expect([0, 4, 8, 12].map((i) => two.data[i])).toEqual([0, 85, 170, 255]);
    const four = decodePng(foreignPng({ w: 2, h: 1, bitDepth: 4, colorType: 0, rows: new Uint8Array([0x0f]), trns: [0, 15] }));
    expect(Array.from(four.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 0]);
  });

  it.each([1, 2, 3, 4, 'cycle'] as const)('undoes filter type %s on 1-, 2- and 4-bit rows (the filter unit is one whole byte)', (filter) => {
    const rng = mulberry32(31);
    const palette = Array.from({ length: 16 * 3 }, (_, i) => (i * 37 + 11) % 256);
    for (const bitDepth of [1, 2, 4]) {
      const w = 13; // not a multiple of 8, 4 or 2 samples per byte: the last byte of each row is padded
      const h = 7;
      const rowBytes = Math.ceil((w * bitDepth) / 8);
      const rows = new Uint8Array(rowBytes * h);
      const samples: number[] = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = Math.floor(rng() * (1 << bitDepth));
          samples.push(v);
          const bit = x * bitDepth;
          rows[y * rowBytes + (bit >> 3)] |= v << (8 - bitDepth - (bit & 7));
        }
      }
      const gray = decodePng(foreignPng({ w, h, bitDepth, colorType: 0, rows, filter }));
      const scale = 255 / ((1 << bitDepth) - 1);
      samples.forEach((v, i) => expect(gray.data[i * 4]).toBe(Math.round(v * scale)));
      const indexed = decodePng(foreignPng({ w, h, bitDepth, colorType: 3, rows, filter, palette }));
      samples.forEach((v, i) => expect(Array.from(indexed.data.subarray(i * 4, i * 4 + 4))).toEqual([...palette.slice(v * 3, v * 3 + 3), 255]));
    }
  });

  it('applies palette transparency (tRNS) at every bit depth', () => {
    const palette = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const trns = [0, 128, 255]; // entry 3 has no tRNS byte: opaque
    const expectPixels = (img: RgbaImage, indices: number[]) =>
      indices.forEach((p, i) =>
        expect(Array.from(img.data.subarray(i * 4, i * 4 + 4))).toEqual([...palette.slice(p * 3, p * 3 + 3), p < trns.length ? trns[p] : 255]),
      );
    // 2-bit: 00 01 10 11 | 01 (padded)
    expectPixels(decodePng(foreignPng({ w: 5, h: 1, bitDepth: 2, colorType: 3, rows: new Uint8Array([0b00011011, 0b01000000]), palette, trns })), [0, 1, 2, 3, 1]);
    // 4-bit: 0x3 0x0 | 0x2 (padded)
    expectPixels(decodePng(foreignPng({ w: 3, h: 1, bitDepth: 4, colorType: 3, rows: new Uint8Array([0x30, 0x20]), palette, trns })), [3, 0, 2]);
    // 1-bit: 1 0 1 (padded), a two-color palette with the first color transparent
    const one = decodePng(foreignPng({ w: 3, h: 1, bitDepth: 1, colorType: 3, rows: new Uint8Array([0b10100000]), palette: palette.slice(0, 6), trns: [0] }));
    expect(Array.from(one.data)).toEqual([40, 50, 60, 255, 10, 20, 30, 0, 40, 50, 60, 255]);
    // 8-bit
    expectPixels(decodePng(foreignPng({ w: 4, h: 1, bitDepth: 8, colorType: 3, rows: new Uint8Array([3, 2, 1, 0]), palette, trns })), [3, 2, 1, 0]);
  });

  it('joins several IDAT chunks and skips ancillary chunks', () => {
    const img = randomImage(31, 23, 77);
    const text = chunk('tEXt', new TextEncoder().encode('Software\0an independent writer'));
    const gamma = chunk('gAMA', new Uint8Array([0, 0, 0xb1, 0x8f]));
    const png = foreignPng({ w: 31, h: 23, bitDepth: 8, colorType: 6, rows: rgbaRows(img), filter: 'cycle', idatSplit: 97, extra: [gamma, text] });
    expect(readChunks(png).filter((c) => c.type === 'IDAT').length).toBeGreaterThan(5);
    expect(sameImage(decodePng(png), img)).toBe(true);
  });

  it('reads a real PNG written by another encoder (8-bit RGB, 1200 × 800)', () => {
    const file = fileURLToPath(new URL('../../../../fixtures/claude-design/teddy-bear/teddy-bear.local-render.png', import.meta.url));
    const img = decodePng(new Uint8Array(readFileSync(file)));
    expect(img.w).toBe(1200);
    expect(img.h).toBe(800);
    expect(img.data.length).toBe(1200 * 800 * 4);
    // opaque everywhere; the top-left corner is the stage background (§3.7.2: #f0eee6 / #f4efe6)
    for (let i = 3; i < img.data.length; i += 4 * 9973) expect(img.data[i]).toBe(255);
    const corner = Array.from(img.data.subarray(0, 3));
    expect(corner.every((v) => v > 200)).toBe(true);
    // not a flat image: the teddy is in it
    const seen = new Set<number>();
    for (let i = 0; i < img.data.length; i += 4 * 101) seen.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
    expect(seen.size).toBeGreaterThan(50);
    // and it survives our own encoder
    expect(sameImage(decodePng(encodePng(img)), img)).toBe(true);
  });
});

// ---- errors --------------------------------------------------------------------------------------------

describe('decodePng errors', () => {
  const good = encodePng(randomImage(6, 5, 9));

  it('rejects files that are not PNGs', () => {
    expect(() => decodePng(new Uint8Array(0))).toThrow(/decodePng: not a PNG/);
    expect(() => decodePng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]))).toThrow(/not a PNG/);
    expect(() => decodePng(new TextEncoder().encode('<!doctype html><html></html>'))).toThrow(/not a PNG/);
  });

  it('rejects a corrupted byte (CRC)', () => {
    const bad = new Uint8Array(good);
    bad[bad.length - 20] ^= 0x01;
    expect(() => decodePng(bad)).toThrow(/decodePng: bad CRC/);
    const badHeader = new Uint8Array(good);
    badHeader[19] ^= 0x01; // width
    expect(() => decodePng(badHeader)).toThrow(/bad CRC in IHDR/);
  });

  it('rejects truncated files', () => {
    for (const cut of [8, 20, 33, good.length - 12, good.length - 1]) {
      expect(() => decodePng(good.subarray(0, cut))).toThrow(/decodePng: truncated/);
    }
  });

  it('rejects interlaced and 16-bit images with a clear message', () => {
    const rows = new Uint8Array(4);
    expect(() => decodePng(foreignPng({ w: 1, h: 1, bitDepth: 8, colorType: 6, rows, interlace: 1 }))).toThrow(/interlaced PNGs are not supported/);
    expect(() => decodePng(foreignPng({ w: 1, h: 1, bitDepth: 16, colorType: 2, rows: new Uint8Array(6) }))).toThrow(/16-bit PNGs are not supported/);
  });

  it('rejects invalid headers', () => {
    expect(() => decodePng(foreignPng({ w: 1, h: 1, bitDepth: 8, colorType: 5, rows: new Uint8Array(4) }))).toThrow(/unknown color type 5/);
    expect(() => decodePng(foreignPng({ w: 1, h: 1, bitDepth: 4, colorType: 6, rows: new Uint8Array(2) }))).toThrow(/bit depth 4 is not valid/);
    expect(() => decodePng(foreignPng({ w: 0, h: 1, bitDepth: 8, colorType: 6, rows: new Uint8Array(0) }))).toThrow(/no pixels/);
    expect(() => decodePng(concat([new Uint8Array(SIGNATURE), ihdr(70000, 70000, 8, 6), chunk('IEND', new Uint8Array(0))]))).toThrow(/too large/);
  });

  it('rejects structural problems', () => {
    const iend = chunk('IEND', new Uint8Array(0));
    const sig = new Uint8Array(SIGNATURE);
    expect(() => decodePng(concat([sig, iend]))).toThrow(/IHDR is not the first chunk/);
    expect(() => decodePng(concat([sig, ihdr(1, 1, 8, 6), iend]))).toThrow(/no IDAT chunk/);
    expect(() => decodePng(concat([sig, ihdr(1, 1, 8, 6), ihdr(1, 1, 8, 6), iend]))).toThrow(/more than one IHDR/);
    expect(() => decodePng(foreignPng({ w: 2, h: 1, bitDepth: 8, colorType: 3, rows: new Uint8Array([0, 1]) }))).toThrow(/without a PLTE/);
    expect(() =>
      decodePng(foreignPng({ w: 2, h: 1, bitDepth: 8, colorType: 3, rows: new Uint8Array([0, 5]), palette: [1, 2, 3, 4, 5, 6] })),
    ).toThrow(/palette index 5 is out of range/);
    expect(() =>
      decodePng(foreignPng({ w: 1, h: 1, bitDepth: 8, colorType: 6, rows: new Uint8Array(4), extra: [chunk('ABCD', new Uint8Array(1))] })),
    ).toThrow(/unsupported critical chunk ABCD/);
  });

  it('rejects image data of the wrong size or with an unknown filter', () => {
    const sig = new Uint8Array(SIGNATURE);
    const iend = chunk('IEND', new Uint8Array(0));
    const idat = (bytes: Uint8Array) => chunk('IDAT', new Uint8Array(deflateSync(bytes)));
    // 2 × 2 RGBA needs 2 · (1 + 8) = 18 bytes
    expect(() => decodePng(concat([sig, ihdr(2, 2, 8, 6), idat(new Uint8Array(17)), iend]))).toThrow(/decodePng: image data/);
    expect(() => decodePng(concat([sig, ihdr(2, 2, 8, 6), idat(new Uint8Array(40)), iend]))).toThrow(/decodePng: image data/);
    expect(() => decodePng(concat([sig, ihdr(2, 2, 8, 6), chunk('IDAT', new Uint8Array([1, 2, 3, 4, 5, 6])), iend]))).toThrow(/decodePng: image data/);
    const badFilter = new Uint8Array(18);
    badFilter[9] = 7;
    expect(() => decodePng(concat([sig, ihdr(2, 2, 8, 6), idat(badFilter), iend]))).toThrow(/unknown filter type 7 in row 1/);
  });
});
