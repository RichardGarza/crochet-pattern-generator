// Track T8 — the content-addressed asset store (DESIGN.md §5.5.1, §5.5.5): keys, hashing, base64 for the
// project file, and the reference walk that asset garbage collection is built on.
//
// An asset's key is `<projectId>/<sha256>`. A conflict copy and an imported copy keep the keys of the project
// they came from (assets are shared by hash, §5.5.2), so a key's prefix says where an asset was first stored,
// not who uses it: GC therefore looks at the references of EVERY project and snapshot, never at prefixes.
import type { AssetRef } from '../../types/project';

export const SHA256_HEX = /^[0-9a-f]{64}$/;
/** An asset key: `<projectId>/<sha256>` (the project id has no `/`, §5.3 `isProjectId`). */
export const ASSET_KEY = /^[^/\s]{1,200}\/[0-9a-f]{64}$/;

/** GC never deletes an asset younger than this (§5.5.5: "only when older than 7 days"). */
export const ASSET_GC_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const assetKeyOf = (projectId: string, sha256: string): string => `${projectId}/${sha256}`;

/** The sha256 part of an asset key, or null when `key` is not one. */
export function shaOfKey(key: string): string | null {
  return ASSET_KEY.test(key) ? key.slice(key.lastIndexOf('/') + 1) : null;
}

const hex = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

/** SHA-256 of the bytes, 64 lowercase hex digits (WebCrypto: browsers, workers and Node 22). */
export async function sha256Hex(data: Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>): Promise<string> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));
}

const CHUNK = 0x8000;

/** Standard base64 (with padding) of the bytes, in chunks so large assets do not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

/** The bytes of standard base64; throws a `SyntaxError` (as `atob` does) on anything else. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new SyntaxError('Not valid base64');
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A ref for a stored blob. */
export function refFor(key: string, blob: Blob, mime?: string): AssetRef {
  const sha256 = shaOfKey(key);
  if (!sha256) throw new TypeError(`Not an asset key: ${JSON.stringify(key)}`);
  return { key, mime: blob.type || mime || 'application/octet-stream', bytes: blob.size, sha256 };
}

/**
 * Every asset key a value names: an `AssetRef.key`, a bare key (`PhotoView.imageKey`, `maskKey`, `labelsKey`),
 * anything anywhere in the document that is a string of the form `<projectId>/<sha256>`. Generous on purpose:
 * keeping an asset too many is harmless; deleting one a document names is data loss.
 */
export function collectAssetKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (v.length >= 66 && v.length <= 265 && ASSET_KEY.test(v)) into.add(v);
    } else if (typeof v === 'object' && v !== null) {
      if (seen.has(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof Blob !== 'undefined' && v instanceof Blob)) continue;
      seen.add(v);
      if (Array.isArray(v)) for (const item of v) stack.push(item);
      else for (const item of Object.values(v)) stack.push(item);
    }
  }
  return into;
}

/** JSON assets may hold references of their own (a model revision's `meshAssets`, §5.3 `ModelRevisionSnapshot`). */
export const isJsonAsset = (mime: string): boolean => /^application\/(?:[\w.+-]+\+)?json\b/i.test(mime);

/**
 * The keys GC may delete: stored, referenced by nothing, and created at least `minAgeMs` before `now`.
 * A malformed `createdAt` counts as new (never deleted).
 */
export function selectUnreferenced(
  stored: Iterable<readonly [string, { createdAt: string }]>,
  referenced: ReadonlySet<string>,
  now: Date,
  minAgeMs: number = ASSET_GC_MIN_AGE_MS,
): string[] {
  const out: string[] = [];
  for (const [key, asset] of stored) {
    if (referenced.has(key)) continue;
    const created = Date.parse(asset.createdAt);
    if (!Number.isFinite(created)) continue;
    if (now.getTime() - created >= minAgeMs) out.push(key);
  }
  return out;
}
