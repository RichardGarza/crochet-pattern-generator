// Track T7 — §3.7.4 E1: the standalone HTML that Claude Design exports is a self-unpacking `__bundler` page [08].
// Its `<script type="__bundler/template">` body is a JSON string literal holding the whole page (every `</` written
// `<\/` or `</`), and `<script type="__bundler/manifest">` maps uuids to base64 assets, gzipped when
// `compressed`. No DOM, no DecompressionStream: `JSON.parse` and fflate.
import { inflateCapped } from './archive';
import { IMPORT_LIMITS, isPlainObject } from './common';
import { FORBIDDEN_KEYS } from './text';

/** The page HTML inside a `__bundler/template` script body. */
export function unbundleTemplate(body: string): { ok: true; html: string } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(body.trim());
    if (typeof value !== 'string') return { ok: false, error: 'the template is not a JSON string' };
    return { ok: true, html: value };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export interface BundlerAsset {
  uuid: string;
  mime: string;
  text: string;
}

/** Text-like manifest entries are decoded (html, javascript, json, text/*); fonts and images are not. */
const TEXT_MIME = /^(text\/|application\/(javascript|x-javascript|ecmascript|json|xhtml\+xml|xml)|[^/]+\/[^;]*\+(json|xml))/i;
/** One decoded asset at most (a three.js build is about 1.3 MB). */
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

function base64ToBytes(data: string): Uint8Array {
  const clean = data.replace(/[^A-Za-z0-9+/=_-]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The size a gzip stream declares in its trailer (ISIZE, mod 2³²). */
function gzipDeclaredSize(bytes: Uint8Array): number {
  const n = bytes.length;
  return n < 18 ? 0 : (bytes[n - 4] | (bytes[n - 3] << 8) | (bytes[n - 2] << 16) | (bytes[n - 1] << 24)) >>> 0;
}

/**
 * The text entries of a `__bundler/manifest` body, decoded (base64, then gunzip when `compressed`) and capped:
 * 64 MB per entry and 300 MB in all, checked against the gzip trailer before anything is inflated.
 */
export function decodeBundlerAssets(body: string): { assets: BundlerAsset[]; errors: string[] } {
  const errors: string[] = [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(body.trim());
  } catch (error) {
    return { assets: [], errors: [`the bundle's manifest is not JSON: ${(error as Error).message}`] };
  }
  if (!isPlainObject(manifest)) return { assets: [], errors: ['the bundle manifest is not an object'] };
  const assets: BundlerAsset[] = [];
  let total = 0;
  for (const [uuid, entry] of Object.entries(manifest)) {
    if (FORBIDDEN_KEYS.has(uuid) || !isPlainObject(entry)) continue;
    const mime = typeof entry.mime === 'string' ? entry.mime : '';
    if (!TEXT_MIME.test(mime) || typeof entry.data !== 'string') continue;
    try {
      let bytes = base64ToBytes(entry.data);
      if (entry.compressed === true) {
        const size = gzipDeclaredSize(bytes);
        if (size > MAX_ASSET_BYTES || total + size > IMPORT_LIMITS.maxUncompressedBytes) {
          errors.push(`bundled asset ${uuid} (${mime}) is too large to unpack (${size} bytes): skipped`);
          continue;
        }
        const r = inflateCapped(bytes, size, 'gzip');
        if (r.overflow) {
          errors.push(`bundled asset ${uuid} (${mime}) unpacks to more than it says: skipped`);
          continue;
        }
        bytes = r.bytes;
      }
      if (bytes.length > MAX_ASSET_BYTES || total + bytes.length > IMPORT_LIMITS.maxUncompressedBytes) {
        errors.push(`bundled asset ${uuid} (${mime}) is too large: skipped`);
        continue;
      }
      total += bytes.length;
      assets.push({ uuid, mime, text: new TextDecoder().decode(bytes) });
    } catch (error) {
      errors.push(`bundled asset ${uuid} (${mime}) could not be decoded: ${(error as Error).message}`);
    }
  }
  return { assets, errors };
}
