// Image intake (DESIGN.md §2.3.1 step 1, D23): Blob → RgbaImage. Step 0 owned.
//
// `src/core` never decodes files: the worker request types carry `Blob | RgbaImage`, the worker adapter calls
// `decodeImage`, and core functions only ever see `RgbaImage`s. The decode itself needs a browser or a worker
// (`createImageBitmap`, `OffscreenCanvas`); the vitest node environment has neither, so node tests pass
// `RgbaImage`s (src/test/rgba.ts, core/kernel/png.ts) and this module keeps everything else — the HEIF brand
// sniffing, the size limits, the conversion route and the error mapping — free of browser APIs behind a small
// `DecodeEnv`, which the tests replace.
//
// HEIC/HEIF (iPhone photos; no desktop Chrome decodes it): when the browser decode fails and the bytes carry an
// ISO-BMFF `ftyp` box with a HEIF brand, the bytes go to the dev/preview server's `POST /__convert` (§5.5.4:
// macOS `sips`, ≤ 50 MB) and the returned JPEG is decoded instead. The original HEIC is not kept: the caller
// stores `DecodedImage.source` (the JPEG) and shows the "Converted from HEIC" chip when `convertedFromHeic`.
// In a static build, or when the server has no converter (501), the user is asked to export a JPEG.
import { sniffHeifBrand } from '../core/kernel/heif';
import type { DecodeImageFn } from '../types/entryPoints';
import type { RgbaImage } from '../types/geometry';

// The HEIF brand sniffing lives in a module without imports (design v1.5), so the folder plugin
// (scripts/project-folder.ts, run by Vite's config loader) can share it.
export { HEIF_BRANDS, sniffHeifBrand, type HeifBrand } from '../core/kernel/heif';

/** The dev/preview server's converter (scripts/project-folder.ts, §5.5.4). */
export const HEIC_CONVERT_URL = '/__convert';
/** The server refuses more than this (§5.5.4), so the client does not upload it. */
export const MAX_CONVERT_BYTES = 50 * 1024 * 1024;
/** The server gives `sips` 20 s; the client waits a little longer, then stops waiting. */
export const CONVERT_TIMEOUT_MS = 30_000;
/** How many bytes `sniffHeifBrand` wants: the `ftyp` box of a real file is 24–40 bytes. */
export const SNIFF_BYTES = 64;

/** Largest decoded image: 64 megapixels (256 MB of RGBA8), and no side longer than a canvas can be. */
export const MAX_DECODE_PIXELS = 64_000_000;
export const MAX_DECODE_SIDE = 16_384;

/** §2.3.1: what the user reads when a HEIC photo cannot be converted here. */
export const HEIC_EXPORT_MESSAGE = 'This is a HEIC photo; export it as JPEG (Photos → File → Export) and add it again';

export type ImageDecodeErrorCode =
  /** HEIC, and there is no converter: a static build, a non-macOS server (501), or the request failed. */
  | 'heic-unavailable'
  /** HEIC above MAX_CONVERT_BYTES (or the server answered 413). */
  | 'heic-too-large'
  /** HEIC, and the converter answered with an error or with something that is not an image. */
  | 'heic-failed'
  /** The browser could not decode the bytes and they are not HEIC. */
  | 'unsupported'
  /** Decoded, but larger than MAX_DECODE_PIXELS / MAX_DECODE_SIDE. */
  | 'too-large'
  /** An `RgbaImage` whose `data` is not a Uint8ClampedArray of `w × h × 4` bytes. */
  | 'invalid-image'
  /** No `createImageBitmap` / `OffscreenCanvas`: node, or a main-thread context without them. */
  | 'no-decoder';

/**
 * Every failure of `decodeImage`. `message` is written for the user. After a worker boundary only `name` and
 * `message` survive (comlink), so `isImageDecodeError` goes by name and `code` is then undefined.
 */
export class ImageDecodeError extends Error {
  readonly code: ImageDecodeErrorCode;

  constructor(code: ImageDecodeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImageDecodeError';
    this.code = code;
  }
}

export function isImageDecodeError(error: unknown): error is Error & { code?: ImageDecodeErrorCode } {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ImageDecodeError';
}

// ---- pure parts

/** Throws `too-large` for a decoded size above the limits, and `unsupported` for a size that is not a positive integer. */
export function checkDecodeSize(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new ImageDecodeError('unsupported', `This image has no usable size (${w} × ${h}).`);
  }
  if (w > MAX_DECODE_SIDE || h > MAX_DECODE_SIDE || w * h > MAX_DECODE_PIXELS) {
    const megapixels = Math.round((w * h) / 1e6);
    throw new ImageDecodeError(
      'too-large',
      `This image is too large (${w} × ${h} px, ${megapixels} megapixels). The largest supported is ` +
        `${MAX_DECODE_PIXELS / 1e6} megapixels and ${MAX_DECODE_SIDE} px on a side; export a smaller copy and add it again.`,
    );
  }
}

/**
 * The error for an answer of `POST /__convert` that is not a converted image. 501 (the server is not on
 * macOS), 404 and 405 (a static host: no such route) and 503 mean "no converter here"; 413 is the size limit.
 */
export function convertFailure(status: number): ImageDecodeError {
  if (status === 413) return tooLargeToConvert();
  if (status === 501 || status === 404 || status === 405 || status === 503) return new ImageDecodeError('heic-unavailable', HEIC_EXPORT_MESSAGE);
  return new ImageDecodeError('heic-failed', `${HEIC_EXPORT_MESSAGE}. (The converter answered ${status}.)`);
}

function tooLargeToConvert(): ImageDecodeError {
  return new ImageDecodeError(
    'heic-too-large',
    `This HEIC photo is larger than ${MAX_CONVERT_BYTES / (1024 * 1024)} MB; export it as JPEG (Photos → File → Export) and add it again`,
  );
}

function isRgbaImage(input: Blob | RgbaImage): input is RgbaImage {
  return typeof (input as Blob).arrayBuffer !== 'function' && 'data' in input && 'w' in input && 'h' in input;
}

/** By tag, not `instanceof`, so an array from another realm (a test environment, an iframe) is recognized. */
const isUint8Clamped = (data: unknown): data is Uint8ClampedArray =>
  Object.prototype.toString.call(data) === '[object Uint8ClampedArray]';

function checkRgbaImage(image: RgbaImage): void {
  const { w, h } = image;
  const data: unknown = image.data;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || !isUint8Clamped(data) || data.byteLength !== w * h * 4) {
    const has = isUint8Clamped(data)
      ? `${data.byteLength} bytes`
      : ArrayBuffer.isView(data)
        ? `a ${Object.prototype.toString.call(data).slice(8, -1)} instead of a Uint8ClampedArray`
        : 'no typed array';
    throw new ImageDecodeError('invalid-image', `RgbaImage ${w} × ${h} needs ${w * h * 4} bytes of RGBA8 data (a Uint8ClampedArray), but has ${has}.`);
  }
}

// ---- the browser seam

/** A decoded bitmap, as far as this module needs it (`ImageBitmap` in the browser). */
export interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close?(): void;
}

/** What `POST /__convert` answers, as far as this module needs it (`Response` in the browser). */
export interface ConvertResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  blob(): Promise<Blob>;
}

/** The browser APIs behind the decode. `browserDecodeEnv()` is the real one; tests pass their own. */
export interface DecodeEnv {
  /** `createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' })`. */
  decodeBitmap(blob: Blob): Promise<BitmapLike>;
  /** Draws the bitmap on an `OffscreenCanvas` of its size and reads the RGBA8 pixels back. */
  readPixels(bitmap: BitmapLike): Uint8ClampedArray<ArrayBuffer>;
  /** `fetch(HEIC_CONVERT_URL, { method: 'POST', body })`, given up after `timeoutMs`. */
  convert(heic: Blob, timeoutMs: number): Promise<ConvertResponse>;
}

/**
 * The real decode environment of a worker or a page. Throws `no-decoder` where `createImageBitmap` or
 * `OffscreenCanvas` is missing (the vitest node environment).
 */
export function browserDecodeEnv(): DecodeEnv {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new ImageDecodeError(
      'no-decoder',
      'decodeImage needs a browser or a worker: createImageBitmap and OffscreenCanvas are not available here. ' +
        'In node tests pass an RgbaImage (src/test/rgba.ts, or decodePng of core/kernel/png.ts).',
    );
  }
  return {
    // EXIF orientation applied, alpha not premultiplied by the decoder (§2.3.1).
    decodeBitmap: (blob) => createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' }),
    readPixels(bitmap) {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new ImageDecodeError('no-decoder', 'This browser gave no 2D context for an OffscreenCanvas.');
      context.drawImage(bitmap as ImageBitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      return data as Uint8ClampedArray<ArrayBuffer>;
    },
    convert: (heic, timeoutMs) => fetch(HEIC_CONVERT_URL, { method: 'POST', body: heic, signal: AbortSignal.timeout(timeoutMs) }),
  };
}

// ---- decode

export interface DecodedImage {
  /** RGBA8, EXIF orientation applied. */
  image: RgbaImage;
  /** The bytes that were decoded: the input, or the JPEG it was converted to. This is the source to store. */
  source: Blob;
  /** True when `source` is the JPEG that `/__convert` made from a HEIC input ("Converted from HEIC"). */
  convertedFromHeic: boolean;
}

async function convertHeic(heic: Blob, env: DecodeEnv): Promise<Blob> {
  if (heic.size > MAX_CONVERT_BYTES) throw tooLargeToConvert();
  let response: ConvertResponse;
  try {
    response = await env.convert(heic, CONVERT_TIMEOUT_MS);
  } catch (cause) {
    // offline, no server, or the timeout
    throw new ImageDecodeError('heic-unavailable', HEIC_EXPORT_MESSAGE, { cause });
  }
  if (!response.ok) throw convertFailure(response.status);
  // A static host may answer a POST with its index page and status 200.
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('image/')) throw new ImageDecodeError('heic-unavailable', HEIC_EXPORT_MESSAGE);
  try {
    return await response.blob();
  } catch (cause) {
    throw new ImageDecodeError('heic-failed', HEIC_EXPORT_MESSAGE, { cause });
  }
}

function rasterize(bitmap: BitmapLike, env: DecodeEnv): RgbaImage {
  try {
    const { width: w, height: h } = bitmap;
    checkDecodeSize(w, h);
    let data: Uint8ClampedArray<ArrayBuffer>;
    try {
      data = env.readPixels(bitmap);
    } catch (cause) {
      // e.g. a RangeError or SecurityError from OffscreenCanvas / getImageData (a canvas the browser cannot allocate)
      if (isImageDecodeError(cause)) throw cause;
      throw new ImageDecodeError('unsupported', `This image could not be read back after decoding (${w} × ${h} px). Try a smaller copy.`, { cause });
    }
    if (!isUint8Clamped(data) || data.byteLength !== w * h * 4) {
      throw new ImageDecodeError('unsupported', `The browser returned ${String((data as { byteLength?: unknown } | null)?.byteLength)} bytes for a ${w} × ${h} image.`);
    }
    return { w, h, data };
  } finally {
    bitmap.close?.();
  }
}

/**
 * Decodes a file to RGBA8 and reports what was decoded: the browser decode with the EXIF orientation applied
 * and no premultiplication, and for HEIC/HEIF the conversion through `POST /__convert` first. Every failure
 * is an `ImageDecodeError`.
 */
export async function decodeBlob(blob: Blob, env: DecodeEnv = browserDecodeEnv()): Promise<DecodedImage> {
  let bitmap: BitmapLike;
  try {
    bitmap = await env.decodeBitmap(blob);
  } catch (cause) {
    let head: Uint8Array;
    try {
      head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
    } catch {
      head = new Uint8Array(0); // unreadable bytes are not HEIC either
    }
    if (sniffHeifBrand(head) === null) {
      throw new ImageDecodeError('unsupported', 'This file could not be read as an image. Use a JPEG, PNG, WebP, GIF, BMP or AVIF file.', { cause });
    }
    const jpeg = await convertHeic(blob, env);
    let converted: BitmapLike;
    try {
      converted = await env.decodeBitmap(jpeg);
    } catch (decodeCause) {
      throw new ImageDecodeError('heic-failed', HEIC_EXPORT_MESSAGE, { cause: decodeCause });
    }
    return { image: rasterize(converted, env), source: jpeg, convertedFromHeic: true };
  }
  return { image: rasterize(bitmap, env), source: blob, convertedFromHeic: false };
}

/**
 * Blob → RgbaImage (§2.3.1); an `RgbaImage` passes through unchanged (the same object), after a check that its
 * data is a Uint8ClampedArray of `w × h × 4` bytes. Workers and browsers only: in node, pass `RgbaImage`s. Use `decodeBlob` when the
 * caller also needs the converted JPEG of a HEIC photo.
 */
export const decodeImage: DecodeImageFn = async (input) => {
  if (isRgbaImage(input)) {
    checkRgbaImage(input);
    return input;
  }
  return (await decodeBlob(input)).image;
};
