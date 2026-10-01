// The test helpers of fields.ts that other files of this folder assert with. A byte comparison that always said
// "equal" would make their determinism checks pass without checking anything, and HEAVY only helps if vitest
// hands a suite's timeout on to the tests in it.
import { describe, expect, it } from 'vitest';
import { firstByteDifference, HEAVY } from './fields';

describe('firstByteDifference', () => {
  it('is −1 for the same bytes and otherwise names the first differing byte', () => {
    expect(firstByteDifference(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(-1);
    expect(firstByteDifference(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 9, 3))).toBe(1);
    expect(firstByteDifference(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(2);
    // A length difference counts: the shorter buffer ends where the longer one goes on.
    expect(firstByteDifference(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(2);
    expect(firstByteDifference(new Uint8Array(0), new Uint8Array(0))).toBe(-1);
  });

  it('compares bytes, not values: element types, views, −0 and NaN', () => {
    // 256 and 512 differ in the second byte of the second Int32 (little-endian): byte 5.
    expect(firstByteDifference(Int32Array.of(1, 256), Int32Array.of(1, 512))).toBe(5);
    // +0 and −0 are equal numbers but not the same bytes (the sign bit is in the last byte of a float64).
    expect(firstByteDifference(Float64Array.of(0), Float64Array.of(-0))).toBe(7);
    // The same NaN is the same bytes.
    expect(firstByteDifference(Float32Array.of(NaN, 1), Float32Array.of(NaN, 1))).toBe(-1);
    // A view is read from its own offset, and only the bytes matter, not the element type.
    expect(firstByteDifference(Uint8Array.of(9, 1, 2, 3).subarray(1), Uint8Array.of(1, 2, 3))).toBe(-1);
    expect(firstByteDifference(Float32Array.of(1.5), new Uint8Array(Float32Array.of(1.5).buffer))).toBe(-1);
  });
});

describe('HEAVY', HEAVY, () => {
  it('gives the tests of a suite its timeout', ({ task }) => {
    expect(task.timeout).toBe(120_000);
  });

  describe('a nested suite', () => {
    it('passes it on as well', ({ task }) => {
      expect(task.timeout).toBe(HEAVY.timeout);
    });
  });

  // The form the GEOM_FULL runs use: the timeout as the third argument.
  it(
    "a test's own timeout wins",
    ({ task }) => {
      expect(task.timeout).toBe(123_456);
    },
    123_456,
  );

  it('so does a timeout in the options', { timeout: 98_765 }, ({ task }) => {
    expect(task.timeout).toBe(98_765);
  });
});
