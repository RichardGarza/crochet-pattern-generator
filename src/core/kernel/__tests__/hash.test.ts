import { describe, expect, it } from 'vitest';
import { canonicalJson, CODE_VERSION, createFnv1a64, fnv1a32, fnv1a64, fnv1a64Hex } from '../hash';
import { mulberry32 } from '../prng';

/** The definition, written with BigInt: slow, but obviously right. */
function referenceFnv1a64(bytes: ArrayLike<number>): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

function referenceFnv1a32(bytes: ArrayLike<number>): number {
  let h = 0x811c9dc5n;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * 0x01000193n) & 0xffffffffn;
  }
  return Number(h);
}

function randomBytes(n: number, seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

describe('fnv1a64', () => {
  it('matches the published test vectors', () => {
    expect(fnv1a64('')).toBe(0xcbf29ce484222325n);
    expect(fnv1a64('a')).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64('foobar')).toBe(0x85944171f73967e8n);
    expect(fnv1a64(new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]))).toBe(0x85944171f73967e8n);
  });

  it('matches the BigInt definition on random bytes of many lengths', () => {
    for (let n = 0; n < 200; n++) {
      const bytes = randomBytes(n, 1000 + n);
      expect(fnv1a64(bytes)).toBe(referenceFnv1a64(bytes));
    }
    const big = randomBytes(100_000, 42);
    expect(fnv1a64(big)).toBe(referenceFnv1a64(big));
  });

  it('survives runs of 0xff and 0x00 bytes (carries between the two halves)', () => {
    for (const fill of [0xff, 0x00, 0x80]) {
      const bytes = new Uint8Array(4096).fill(fill);
      expect(fnv1a64(bytes)).toBe(referenceFnv1a64(bytes));
    }
  });

  it('hashes strings as UTF-8', () => {
    expect(fnv1a64('é')).toBe(fnv1a64(new Uint8Array([0xc3, 0xa9])));
    expect(fnv1a64('→')).toBe(fnv1a64(new Uint8Array([0xe2, 0x86, 0x92])));
  });

  it('hashes a plain array of bytes, and refuses a plain array of anything else', () => {
    expect(fnv1a64([0x66, 0x6f, 0x6f])).toBe(fnv1a64('foo'));
    expect(fnv1a64([])).toBe(fnv1a64(''));
    // Keeping only the low 8 bits would make [6] and [262] collide, so non-bytes throw.
    expect(() => fnv1a64([262])).toThrow(RangeError);
    expect(() => fnv1a64([0x66, -1])).toThrow(/element 1 is -1/);
    expect(() => fnv1a64([0.5])).toThrow(RangeError);
    expect(() => fnv1a64([Number.NaN])).toThrow(RangeError);
    expect(() => fnv1a32([256])).toThrow(RangeError);
    expect(() => createFnv1a64().update([1, 2, 300])).toThrow(RangeError);
  });

  it('hashes typed arrays as the bytes they hold', () => {
    expect(fnv1a64(new Uint8ClampedArray([0x66, 0x6f, 0x6f]))).toBe(fnv1a64('foo'));
    expect(fnv1a64(new Int8Array([-1, 0x66]))).toBe(fnv1a64([0xff, 0x66]));
    // multi-byte elements: every byte counts (little-endian memory order)
    expect(fnv1a64(new Uint16Array([0x0201, 0x0403]))).toBe(fnv1a64([1, 2, 3, 4]));
    expect(fnv1a64(new Uint16Array([6]))).not.toBe(fnv1a64(new Uint16Array([262])));
    expect(fnv1a64(new Int32Array([6, 12, 18]))).not.toBe(fnv1a64(new Int32Array([6, 12, 274])));
    expect(fnv1a64(new Float32Array([0.1, 0.2]))).not.toBe(fnv1a64(new Float32Array([0.7, -0.9])));
    const floats = new Float32Array([1.5, -2.25]);
    expect(fnv1a64(floats)).toBe(fnv1a64(new Uint8Array(floats.buffer)));
    expect(fnv1a32(new Uint16Array([0x0201]))).toBe(fnv1a32([1, 2]));
  });

  it('hashes exactly the window of a view, an ArrayBuffer as a whole, and a DataView', () => {
    const whole = new Uint8Array([9, 1, 2, 3, 9]);
    expect(fnv1a64(whole.subarray(1, 4))).toBe(fnv1a64([1, 2, 3]));
    expect(fnv1a64(whole.buffer)).toBe(fnv1a64([9, 1, 2, 3, 9]));
    expect(fnv1a64(new DataView(whole.buffer, 1, 3))).toBe(fnv1a64([1, 2, 3]));
    const wide = new Int16Array([7, 8, 9, 10]);
    expect(fnv1a64(wide.subarray(1, 3))).toBe(fnv1a64(new Int16Array([8, 9])));
  });

  it('refuses values that are not bytes at all', () => {
    expect(() => fnv1a64({ length: 2, 0: 1, 1: 2 } as unknown as number[])).toThrow(TypeError);
    expect(() => fnv1a64(42 as unknown as string)).toThrow(TypeError);
    expect(() => fnv1a64(null as unknown as string)).toThrow(TypeError);
  });

  it('gives 16 lowercase hex digits, zero-padded', () => {
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('foobar')).toBe('85944171f73967e8');
    for (let n = 0; n < 300; n++) {
      const bytes = randomBytes(n % 17, n);
      const hex = fnv1a64Hex(bytes);
      expect(hex).toMatch(/^[0-9a-f]{16}$/);
      expect(BigInt(`0x${hex}`)).toBe(referenceFnv1a64(bytes));
    }
  });
});

describe('createFnv1a64 (incremental)', () => {
  it('hashing parts equals hashing the concatenation', () => {
    const a = randomBytes(1000, 1);
    const b = randomBytes(37, 2);
    const whole = new Uint8Array(a.length + b.length);
    whole.set(a, 0);
    whole.set(b, a.length);
    expect(createFnv1a64().update(a).update(b).digest()).toBe(fnv1a64(whole));
    expect(createFnv1a64().update('foo').update('bar').hex()).toBe(fnv1a64Hex('foobar'));
    expect(createFnv1a64().update('').update('foobar').update('').digest()).toBe(fnv1a64('foobar'));
  });

  it('builds a seed as input bytes ‖ canonical JSON of settings ‖ CODE_VERSION (§5.8)', () => {
    const image = randomBytes(64, 5);
    const seed = (settings: unknown) =>
      createFnv1a64().update(image).update(canonicalJson(settings)).update(CODE_VERSION).seed32();
    expect(seed({ maxColors: 8, detail: 'balanced' })).toBe(seed({ detail: 'balanced', maxColors: 8 }));
    expect(seed({ maxColors: 8, detail: 'balanced' })).not.toBe(seed({ maxColors: 6, detail: 'balanced' }));
  });

  it('folds to an unsigned 32-bit seed', () => {
    const h = createFnv1a64().update('foobar');
    expect(h.seed32()).toBe((0x85944171 ^ 0xf73967e8) >>> 0);
    expect(Number.isInteger(h.seed32())).toBe(true);
    expect(h.seed32()).toBeGreaterThanOrEqual(0);
    expect(h.seed32()).toBeLessThan(2 ** 32);
  });

  it('can be read more than once and continued', () => {
    const h = createFnv1a64().update('foo');
    expect(h.digest()).toBe(fnv1a64('foo'));
    expect(h.digest()).toBe(fnv1a64('foo'));
    expect(h.update('bar').digest()).toBe(fnv1a64('foobar'));
  });
});

describe('fnv1a32', () => {
  it('matches the published test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('matches the BigInt definition on random bytes', () => {
    for (let n = 0; n < 100; n++) {
      const bytes = randomBytes(n, 7000 + n);
      expect(fnv1a32(bytes)).toBe(referenceFnv1a32(bytes));
    }
  });

  it('seeds one generator per part id, as §2.11.1 does', () => {
    const a = mulberry32(fnv1a32('ear_l'));
    const b = mulberry32(fnv1a32('ear_l'));
    const c = mulberry32(fnv1a32('ear_r'));
    const first = a();
    expect(b()).toBe(first);
    expect(c()).not.toBe(first);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('follows JSON.stringify for scalars', () => {
    expect(canonicalJson('a"b\n→')).toBe(JSON.stringify('a"b\n→'));
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(Number.NaN)).toBe('null');
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('drops undefined and functions from objects and writes null for them in arrays', () => {
    expect(canonicalJson({ a: undefined, b: 1, c: () => 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
    expect(canonicalJson({ widthIn: undefined })).toBe(canonicalJson({}));
  });

  it('gives the same text as JSON.stringify for sorted plain data', () => {
    const value = { a: [1, 2, { b: null, c: 'x' }], d: { e: false, f: 0.25 }, g: '' };
    expect(canonicalJson(value)).toBe(JSON.stringify(value));
  });

  it('writes typed arrays as arrays and honors toJSON', () => {
    expect(canonicalJson({ labels: new Uint8Array([1, 2, 255]) })).toBe('{"labels":[1,2,255]}');
    expect(canonicalJson({ at: new Date('2026-10-01T12:00:00Z') })).toBe('{"at":"2026-10-01T12:00:00.000Z"}');
  });

  it('orders keys by code unit, not by locale', () => {
    expect(canonicalJson({ a: 1, B: 2, _x: 3, 'x-cpg': 4 })).toBe('{"B":2,"_x":3,"a":1,"x-cpg":4}');
  });

  it('throws on bigint, Map, Set and on cycles', () => {
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
    expect(() => canonicalJson({ m: new Map([['a', 1]]) })).toThrow(/Map and Set/);
    expect(() => canonicalJson(new Set([1]))).toThrow(/Map and Set/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
    // The same object twice (not a cycle) is fine.
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});

describe('CODE_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof CODE_VERSION).toBe('string');
    expect(CODE_VERSION.length).toBeGreaterThan(0);
  });
});
