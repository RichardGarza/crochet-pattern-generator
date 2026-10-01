// Deterministic hashing (DESIGN.md §2.4.1, §5.8). Step 0 kernel: pure, no DOM.
//
// Seeds and output hashes are `fnv1a64(input bytes ‖ canonical JSON of settings ‖ CODE_VERSION)` (§5.8). Output
// hashes cover integer labels, counts and rendered text, never raw floats.

/**
 * Version of the generating code. It is part of every seed and output hash, so "same input bytes + same settings
 * + same code version ⇒ byte-identical outputs" (§0.1) stays true when an algorithm changes: bump it then.
 */
export const CODE_VERSION = '0.1.0';

/**
 * What the hashers accept. The hash is always over BYTES:
 * - a string is hashed as its UTF-8 bytes;
 * - an ArrayBuffer, a DataView or any typed array is hashed as the bytes it holds (for Int16Array, Float32Array
 *   and the like: the bytes in memory order, which is little-endian on every platform this app runs on);
 * - a plain array must already hold byte values (integers 0..255) — anything else throws, because silently
 *   keeping the low 8 bits would give `[6]` and `[262]` the same hash. Hash counts through a typed array
 *   (`Int32Array.from(counts)`) or through canonicalJson.
 */
export type HashInput = string | ArrayBuffer | ArrayBufferView | readonly number[];

const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME = 0x01000193;
// FNV-1a 64: offset basis 0xcbf29ce484222325, prime 0x00000100000001b3 (kept as two 32-bit halves).
const FNV64_OFFSET_HI = 0xcbf29ce4;
const FNV64_OFFSET_LO = 0x84222325;
const FNV64_PRIME_LO = 0x1b3;
const TWO_32 = 4294967296;

const utf8 = new TextEncoder();

function toBytes(input: HashInput): Uint8Array {
  if (typeof input === 'string') return utf8.encode(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) {
    const bytes = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const v: unknown = input[i];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
        throw new RangeError(`hash input: element ${i} is ${String(v)}, not a byte (0..255); pass a typed array or canonicalJson text`);
      }
      bytes[i] = v;
    }
    return bytes;
  }
  // An ArrayBuffer, also one from another realm (instanceof would miss it).
  const tag = Object.prototype.toString.call(input);
  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return new Uint8Array(input as ArrayBuffer);
  throw new TypeError(`hash input: expected a string, bytes or a typed array, got ${tag}`);
}

/** An incremental FNV-1a 64-bit hasher: `update` any number of parts, then read the result. */
export interface Fnv1a64 {
  /** Mixes in more bytes; `a.update(x).update(y)` equals hashing the concatenation x ‖ y. */
  update(input: HashInput): Fnv1a64;
  /** The hash so far as an unsigned 64-bit integer. */
  digest(): bigint;
  /** The hash so far as 16 lowercase hex digits. */
  hex(): string;
  /** The hash so far folded to an unsigned 32-bit integer (high half XOR low half): a seed for mulberry32. */
  seed32(): number;
}

export function createFnv1a64(): Fnv1a64 {
  let hi = FNV64_OFFSET_HI;
  let lo = FNV64_OFFSET_LO;
  const hasher: Fnv1a64 = {
    update(input) {
      const bytes = toBytes(input);
      for (let i = 0; i < bytes.length; i++) {
        lo = (lo ^ bytes[i]) >>> 0;
        // (hi, lo) × prime mod 2^64, prime = 2^40 + 0x1b3:
        //   low 64 bits = lo·0x1b3 + ((hi·0x1b3 + lo·2^8) mod 2^32)·2^32
        const low = lo * FNV64_PRIME_LO; // < 2^41, exact in a double
        const carry = Math.floor(low / TWO_32);
        hi = (Math.imul(hi, FNV64_PRIME_LO) + (lo << 8) + carry) >>> 0;
        lo = low >>> 0;
      }
      return hasher;
    },
    digest: () => (BigInt(hi) << 32n) | BigInt(lo),
    hex: () => hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'),
    seed32: () => (hi ^ lo) >>> 0,
  };
  return hasher;
}

/** FNV-1a 64-bit hash of the input's bytes (see HashInput), as an unsigned 64-bit integer. */
export function fnv1a64(input: HashInput): bigint {
  return createFnv1a64().update(input).digest();
}

/** FNV-1a 64-bit hash as 16 lowercase hex digits — the form stored in `hash` fields and used as cache keys. */
export function fnv1a64Hex(input: HashInput): string {
  return createFnv1a64().update(input).hex();
}

/** FNV-1a 32-bit hash of the input's bytes (see HashInput), as an unsigned 32-bit integer. */
export function fnv1a32(input: HashInput): number {
  const bytes = toBytes(input);
  let h = FNV32_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i], FNV32_PRIME);
  }
  return h >>> 0;
}

/**
 * Canonical JSON: object keys sorted (by UTF-16 code unit), no whitespace, so equal values give equal text
 * whatever order their keys were written in. Follows JSON.stringify otherwise: `undefined`, functions and
 * symbols are dropped from objects and become `null` in arrays, non-finite numbers become `null`, `toJSON` is
 * honored. Typed arrays are written as arrays of numbers. Throws on bigint, on cycles, and on Map and Set
 * (JSON.stringify would write them as `{}` and lose their content: convert them to arrays first).
 */
export function canonicalJson(value: unknown): string {
  const out = write(value, []);
  return out === undefined ? 'null' : out;
}

function write(value: unknown, stack: object[]): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not supported');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  const obj = value as object;
  const withToJson = obj as { toJSON?: unknown };
  if (typeof withToJson.toJSON === 'function') {
    return write((withToJson.toJSON as () => unknown).call(obj), stack);
  }
  if (obj instanceof Map || obj instanceof Set) {
    throw new TypeError('canonicalJson: Map and Set are not supported; convert them to arrays first');
  }
  if (stack.includes(obj)) throw new TypeError('canonicalJson: cyclic structure');
  stack.push(obj);
  let text: string;
  if (Array.isArray(obj) || ArrayBuffer.isView(obj)) {
    const items = Array.from(obj as unknown as ArrayLike<unknown>, (item) => write(item, stack) ?? 'null');
    text = `[${items.join(',')}]`;
  } else {
    const record = obj as Record<string, unknown>;
    const fields: string[] = [];
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      const v = write(record[key], stack);
      if (v !== undefined) fields.push(`${JSON.stringify(key)}:${v}`);
    }
    text = `{${fields.join(',')}}`;
  }
  stack.pop();
  return text;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
