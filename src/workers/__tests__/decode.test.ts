// workers/decode.ts in the node environment: the pass-through, the HEIF brand sniffing, the size limits and
// the error mapping, with the browser APIs replaced through `DecodeEnv`. The real decode (createImageBitmap
// with the EXIF orientation, OffscreenCanvas, a real /__convert) runs in the Playwright smoke test
// (e2e/smoke.spec.ts, Step 0c) and in T8's plugin test on macOS.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { fromRows, solid } from '../../test/rgba';
import type { DecodeImageFn } from '../../types/entryPoints';
import {
  browserDecodeEnv,
  checkDecodeSize,
  CONVERT_TIMEOUT_MS,
  convertFailure,
  decodeBlob,
  decodeImage,
  HEIC_EXPORT_MESSAGE,
  HEIF_BRANDS,
  ImageDecodeError,
  isImageDecodeError,
  MAX_CONVERT_BYTES,
  MAX_DECODE_PIXELS,
  MAX_DECODE_SIDE,
  sniffHeifBrand,
  type BitmapLike,
  type ConvertResponse,
  type DecodeEnv,
} from '../decode';

/** An ISO-BMFF `ftyp` box followed by `tail` bytes. */
function ftyp(major: string, compatible: string[] = [], o: { size?: number; tail?: string } = {}): Uint8Array<ArrayBuffer> {
  const boxSize = 16 + 4 * compatible.length;
  const text = `ftyp${major}\0\0\0\0${compatible.join('')}${o.tail ?? ''}`;
  const bytes = new Uint8Array(4 + text.length);
  new DataView(bytes.buffer).setUint32(0, o.size ?? boxSize);
  for (let i = 0; i < text.length; i++) bytes[4 + i] = text.charCodeAt(i);
  return bytes;
}

const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

async function failure(run: () => Promise<unknown>): Promise<ImageDecodeError> {
  const error: unknown = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ImageDecodeError);
  return error as ImageDecodeError;
}

function response(status: number, type: string | null, body: Blob = new Blob([JPEG_HEAD], { type: type ?? '' })): ConvertResponse {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) }, blob: async () => body };
}

/** A fake browser: it "decodes" every blob except those in `undecodable`, as a w × h image of one gray. */
function fakeEnv(o: { undecodable?: (blob: Blob) => boolean; size?: [number, number]; convert?: DecodeEnv['convert'] } = {}) {
  const log = { decoded: [] as Blob[], closed: 0, read: 0, converted: [] as { blob: Blob; timeoutMs: number }[] };
  const [w, h] = o.size ?? [3, 2];
  const env: DecodeEnv = {
    async decodeBitmap(blob) {
      if (o.undecodable?.(blob)) throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      log.decoded.push(blob);
      return {
        width: w,
        height: h,
        close: () => {
          log.closed++;
        },
      } satisfies BitmapLike;
    },
    readPixels(bitmap) {
      log.read++;
      return new Uint8ClampedArray(bitmap.width * bitmap.height * 4).fill(128);
    },
    convert(blob, timeoutMs) {
      log.converted.push({ blob, timeoutMs });
      if (!o.convert) throw new Error('no converter in this test');
      return o.convert(blob, timeoutMs);
    },
  };
  return { env, log };
}

const heicBlob = (): Blob => new Blob([ftyp('heic', ['mif1', 'heic']), new Uint8Array(100)], { type: 'image/heic' });
const isHeic = (blob: Blob): boolean => blob.type === 'image/heic';

describe('decodeImage: an RgbaImage passes through', () => {
  it('has the frozen signature of §5.2.1', () => {
    expectTypeOf(decodeImage).toEqualTypeOf<DecodeImageFn>();
  });

  it('returns the same object, untouched', async () => {
    const image = fromRows(['AB', 'BA', 'AA'], { A: '#ffffff', B: [200, 10, 10, 128] });
    const copy = new Uint8ClampedArray(image.data);
    const out = await decodeImage(image);
    expect(out).toBe(image);
    expect(out.data).toBe(image.data);
    expect([...out.data]).toEqual([...copy]);
    expect([out.w, out.h]).toEqual([2, 3]);
  });

  it('refuses an RgbaImage whose data does not match its size', async () => {
    const good = solid(4, 4, '#336699');
    for (const bad of [
      { w: 4, h: 4, data: new Uint8ClampedArray(63) },
      { w: 0, h: 4, data: new Uint8ClampedArray(0) },
      { w: 2.5, h: 2, data: new Uint8ClampedArray(20) },
      { w: 4, h: 4, data: [...good.data] as unknown as Uint8ClampedArray<ArrayBuffer> },
    ]) {
      const error = await failure(() => decodeImage(bad));
      expect(error.code).toBe('invalid-image');
    }
  });

  it('has no decoder in node, and says what to pass instead', async () => {
    expect(() => browserDecodeEnv()).toThrow(ImageDecodeError);
    const error = await failure(() => decodeImage(new Blob([JPEG_HEAD], { type: 'image/jpeg' })));
    expect(error.code).toBe('no-decoder');
    expect(error.message).toContain('RgbaImage');
  });
});

describe('sniffHeifBrand', () => {
  it('finds every HEIF major brand', () => {
    expect(HEIF_BRANDS).toEqual(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
    for (const brand of HEIF_BRANDS) {
      expect(sniffHeifBrand(ftyp(brand))).toBe(brand);
      expect(sniffHeifBrand(ftyp(brand, ['mif1', 'miaf']))).toBe(brand);
    }
  });

  it('reads an iPhone photo header: ftyp heic, compatible mif1 MiHE MiPr miaf MiHB heic', () => {
    const iphone = ftyp('heic', ['mif1', 'MiHE', 'MiPr', 'miaf', 'MiHB', 'heic'], { tail: '\0\0\0\x08meta' });
    expect(iphone.length).toBeGreaterThan(40);
    expect(sniffHeifBrand(iphone)).toBe('heic');
    expect(sniffHeifBrand(iphone.subarray(0, 12))).toBe('heic'); // the major brand alone is enough
  });

  it('falls back to the compatible brands when the major brand is not a HEIF brand', () => {
    expect(sniffHeifBrand(ftyp('isom', ['iso2', 'heic']))).toBe('heic');
    expect(sniffHeifBrand(ftyp('MiHE', ['msf1', 'hevc']))).toBe('msf1');
  });

  it('does not mistake AVIF for HEIC, although AVIF lists mif1', () => {
    expect(sniffHeifBrand(ftyp('avif', ['mif1', 'miaf', 'MA1B']))).toBeNull();
    expect(sniffHeifBrand(ftyp('avis', ['msf1', 'miaf']))).toBeNull();
    expect(sniffHeifBrand(ftyp('mif1', ['avif', 'miaf']))).toBeNull();
  });

  it('is null for video containers, other image formats and garbage', () => {
    expect(sniffHeifBrand(ftyp('isom', ['iso2', 'avc1', 'mp41']))).toBeNull(); // mp4 video
    expect(sniffHeifBrand(ftyp('qt  '))).toBeNull(); // QuickTime
    expect(sniffHeifBrand(ftyp('crx ', ['isom']))).toBeNull(); // Canon CR3
    expect(sniffHeifBrand(JPEG_HEAD)).toBeNull();
    expect(sniffHeifBrand(PNG_HEAD)).toBeNull();
    expect(sniffHeifBrand(new Uint8Array(0))).toBeNull();
    expect(sniffHeifBrand(new Uint8Array(11))).toBeNull();
    expect(sniffHeifBrand(new TextEncoder().encode('ftypheic is not at offset 4 here'))).toBeNull();
    expect(sniffHeifBrand(new TextEncoder().encode('....FTYPheic....'))).toBeNull(); // case matters
  });

  it('looks for compatible brands only inside the ftyp box', () => {
    // box of 20 bytes: one compatible brand ('iso2'); the 'heic' after it belongs to the next box
    expect(sniffHeifBrand(ftyp('isom', ['iso2'], { tail: 'heic' }))).toBeNull();
    // a box that claims to be longer than the bytes we have: read what is there
    expect(sniffHeifBrand(ftyp('isom', ['iso2', 'heix'], { size: 4096 }))).toBe('heix');
    // sizes 0 ("to the end of the file") and 1 (64-bit size): read what is there
    expect(sniffHeifBrand(ftyp('isom', ['hevc'], { size: 0 }))).toBe('hevc');
    expect(sniffHeifBrand(ftyp('isom', ['hevc'], { size: 1 }))).toBe('hevc');
  });

  it('works on a subarray with an offset', () => {
    const padded = new Uint8Array(100);
    padded.set(ftyp('heix', ['mif1']), 10);
    expect(sniffHeifBrand(padded.subarray(10))).toBe('heix');
    expect(sniffHeifBrand(padded)).toBeNull();
  });
});

describe('size limits', () => {
  it('accepts phone and camera photos and refuses what a canvas could not hold', () => {
    expect(() => checkDecodeSize(1, 1)).not.toThrow();
    expect(() => checkDecodeSize(4032, 3024)).not.toThrow(); // 12 MP
    expect(() => checkDecodeSize(8064, 6048)).not.toThrow(); // 48 MP
    expect(() => checkDecodeSize(9504, 6336)).not.toThrow(); // 60 MP
    expect(() => checkDecodeSize(8000, 8000)).not.toThrow(); // exactly 64 MP
    expect(() => checkDecodeSize(MAX_DECODE_SIDE, 100)).not.toThrow();
    for (const [w, h] of [
      [8001, 8000],
      [MAX_DECODE_SIDE + 1, 1],
      [1, MAX_DECODE_SIDE + 1],
      [12000, 9000],
    ]) {
      try {
        checkDecodeSize(w, h);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ImageDecodeError);
        expect((e as ImageDecodeError).code).toBe('too-large');
        expect((e as ImageDecodeError).message).toContain(`${w} × ${h}`);
      }
    }
    expect(MAX_DECODE_PIXELS).toBe(64_000_000);
    expect(MAX_CONVERT_BYTES).toBe(50 * 1024 * 1024);
  });

  it('refuses sizes that are not positive integers', () => {
    for (const [w, h] of [
      [0, 10],
      [10, 0],
      [-1, 5],
      [1.5, 2],
      [Number.NaN, 2],
    ]) {
      expect(() => checkDecodeSize(w, h)).toThrow(ImageDecodeError);
    }
  });
});

describe('error mapping', () => {
  it('maps the converter’s answers', () => {
    for (const status of [501, 404, 405, 503]) {
      const error = convertFailure(status);
      expect(error.code).toBe('heic-unavailable');
      expect(error.message).toBe(HEIC_EXPORT_MESSAGE);
    }
    expect(convertFailure(413).code).toBe('heic-too-large');
    expect(convertFailure(413).message).toContain('50 MB');
    for (const status of [415, 500, 502, 400]) {
      const error = convertFailure(status);
      expect(error.code).toBe('heic-failed');
      expect(error.message).toContain(HEIC_EXPORT_MESSAGE);
      expect(error.message).toContain(String(status));
    }
  });

  it('the documented message is the one of §2.3.1', () => {
    expect(HEIC_EXPORT_MESSAGE).toBe('This is a HEIC photo; export it as JPEG (Photos → File → Export) and add it again');
  });

  it('is recognizable by name after a worker boundary', () => {
    const error = new ImageDecodeError('heic-unavailable', HEIC_EXPORT_MESSAGE);
    expect(isImageDecodeError(error)).toBe(true);
    expect(error.code).toBe('heic-unavailable');
    // comlink keeps name, message and stack only
    const rebuilt = Object.assign(new Error(error.message), { name: error.name });
    expect(isImageDecodeError(rebuilt)).toBe(true);
    expect(rebuilt.message).toBe(HEIC_EXPORT_MESSAGE);
    expect(isImageDecodeError(new Error('x'))).toBe(false);
    expect(isImageDecodeError(null)).toBe(false);
  });
});

describe('decodeBlob with a fake browser', () => {
  it('decodes, reads the pixels, closes the bitmap and reports the input as the source', async () => {
    const { env, log } = fakeEnv({ size: [3, 2] });
    const blob = new Blob([JPEG_HEAD], { type: 'image/jpeg' });
    const out = await decodeBlob(blob, env);
    expect(out.source).toBe(blob);
    expect(out.convertedFromHeic).toBe(false);
    expect([out.image.w, out.image.h, out.image.data.length]).toEqual([3, 2, 24]);
    expect(out.image.data).toBeInstanceOf(Uint8ClampedArray);
    expect(log).toMatchObject({ closed: 1, read: 1, converted: [] });
  });

  it('converts a HEIC photo through /__convert and reports the JPEG as the source', async () => {
    const jpeg = new Blob([JPEG_HEAD], { type: 'image/jpeg' });
    const { env, log } = fakeEnv({ undecodable: isHeic, convert: async () => response(200, 'image/jpeg', jpeg) });
    const heic = heicBlob();
    const out = await decodeBlob(heic, env);
    expect(out.convertedFromHeic).toBe(true);
    expect(out.source).toBe(jpeg); // the original HEIC is not kept (§2.3.1)
    expect(out.image.data.length).toBe(24);
    expect(log.converted).toEqual([{ blob: heic, timeoutMs: CONVERT_TIMEOUT_MS }]);
    expect(log.decoded).toEqual([jpeg]);
    expect(log.closed).toBe(1);
  });

  it('gives the documented message when the conversion is unavailable', async () => {
    const cases: [string, DecodeEnv['convert']][] = [
      ['501: the server is not on macOS (and the Step 0 stub)', async () => response(501, 'application/json')],
      ['404: a static build has no such route', async () => response(404, 'text/html')],
      ['405: a static host refuses POST', async () => response(405, null)],
      ['200 with the index page: a static host with an SPA fallback', async () => response(200, 'text/html; charset=utf-8')],
      ['200 without a content type', async () => response(200, null)],
      [
        'the request fails: offline or timed out',
        async () => {
          throw new TypeError('Failed to fetch');
        },
      ],
    ];
    for (const [label, convert] of cases) {
      const { env, log } = fakeEnv({ undecodable: isHeic, convert });
      const error = await failure(() => decodeBlob(heicBlob(), env));
      expect(error.code, label).toBe('heic-unavailable');
      expect(error.message, label).toBe(HEIC_EXPORT_MESSAGE);
      expect(isImageDecodeError(error)).toBe(true);
      expect(log.read, label).toBe(0);
    }
  });

  it('does not upload a HEIC photo above 50 MB', async () => {
    const { env, log } = fakeEnv({ undecodable: () => true, convert: async () => response(200, 'image/jpeg') });
    const head = ftyp('heic', ['mif1']);
    const huge = { size: MAX_CONVERT_BYTES + 1, type: 'image/heic', slice: () => new Blob([head]) } as unknown as Blob;
    const error = await failure(() => decodeBlob(huge, env));
    expect(error.code).toBe('heic-too-large');
    expect(error.message).toContain('50 MB');
    expect(log.converted).toEqual([]);
    // exactly 50 MB is still sent
    const atLimit = { size: MAX_CONVERT_BYTES, type: 'image/heic', slice: () => new Blob([head]) } as unknown as Blob;
    const { env: env2, log: log2 } = fakeEnv({ undecodable: isHeic, convert: async () => response(200, 'image/jpeg') });
    await decodeBlob(atLimit, env2);
    expect(log2.converted).toHaveLength(1);
  });

  it('reports a converter error, and a converted file that still does not decode', async () => {
    const failing = fakeEnv({ undecodable: isHeic, convert: async () => response(500, 'application/json') });
    const error = await failure(() => decodeBlob(heicBlob(), failing.env));
    expect(error.code).toBe('heic-failed');
    expect(error.message).toContain(HEIC_EXPORT_MESSAGE);

    const garbage = fakeEnv({ undecodable: () => true, convert: async () => response(200, 'image/jpeg') });
    const second = await failure(() => decodeBlob(heicBlob(), garbage.env));
    expect(second.code).toBe('heic-failed');
    expect(second.message).toBe(HEIC_EXPORT_MESSAGE);
  });

  it('says so when a file is simply not an image, without asking the converter', async () => {
    const { env, log } = fakeEnv({ undecodable: () => true });
    const error = await failure(() => decodeBlob(new Blob(['%PDF-1.7 not an image at all'], { type: 'application/pdf' }), env));
    expect(error.code).toBe('unsupported');
    expect(error.cause).toBeInstanceOf(DOMException);
    expect(log.converted).toEqual([]);
    // an mp4 video has an ftyp box, but no HEIF brand
    const video = await failure(() => decodeBlob(new Blob([ftyp('isom', ['iso2', 'avc1'])]), env));
    expect(video.code).toBe('unsupported');
    expect(log.converted).toEqual([]);
  });

  it('refuses an image that decodes to more than the limit, and still closes the bitmap', async () => {
    const { env, log } = fakeEnv({ size: [9000, 9000] });
    const error = await failure(() => decodeBlob(new Blob([JPEG_HEAD]), env));
    expect(error.code).toBe('too-large');
    expect(log.read).toBe(0);
    expect(log.closed).toBe(1);
  });

  it('refuses pixels that do not match the bitmap size', async () => {
    const { env } = fakeEnv();
    env.readPixels = () => new Uint8ClampedArray(7);
    const error = await failure(() => decodeBlob(new Blob([JPEG_HEAD]), env));
    expect(error.code).toBe('unsupported');
  });
});
