import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../prng';
import { argmax, argmin, argsort, stableSort, stableSortInPlace } from '../stable';

interface Row {
  key: number;
  id: number;
}

function randomRows(n: number, keys: number, seed: number): Row[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, id) => ({ key: Math.floor(rng() * keys), id }));
}

describe('stableSort', () => {
  it('sorts and keeps the input order of equal elements', () => {
    for (const n of [0, 1, 2, 3, 7, 8, 9, 64, 100, 1000]) {
      const rows = randomRows(n, 5, n + 1);
      const sorted = stableSort(rows, (a, b) => a.key - b.key);
      expect(sorted.length).toBe(n);
      for (let i = 1; i < n; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        expect(prev.key <= cur.key).toBe(true);
        if (prev.key === cur.key) expect(prev.id < cur.id).toBe(true);
      }
    }
  });

  it('agrees with a total-order sort', () => {
    const rows = randomRows(500, 20, 99);
    const expected = [...rows].sort((a, b) => a.key - b.key || a.id - b.id);
    expect(stableSort(rows, (a, b) => a.key - b.key)).toEqual(expected);
  });

  it('returns a new array and leaves the input alone', () => {
    const input = [3, 1, 2];
    const out = stableSort(input, (a, b) => a - b);
    expect(out).toEqual([1, 2, 3]);
    expect(input).toEqual([3, 1, 2]);
    expect(out).not.toBe(input);
    const single = [5];
    expect(stableSort(single, (a, b) => a - b)).not.toBe(single);
  });

  it('accepts typed arrays and other array-likes', () => {
    expect(stableSort(new Float64Array([2.5, -1, 9]), (a, b) => a - b)).toEqual([-1, 2.5, 9]);
    expect(stableSort({ length: 3, 0: 'b', 1: 'c', 2: 'a' }, (a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(['a', 'b', 'c']);
  });

  it('sorts descending with ties still in input order', () => {
    const rows = randomRows(200, 4, 5);
    const sorted = stableSort(rows, (a, b) => b.key - a.key);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1].key >= sorted[i].key).toBe(true);
      if (sorted[i - 1].key === sorted[i].key) expect(sorted[i - 1].id < sorted[i].id).toBe(true);
    }
  });

  it('treats a NaN comparison as a tie', () => {
    const out = stableSort(['a', 'b', 'c'], () => Number.NaN);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('stableSortInPlace sorts the same array', () => {
    const rows = randomRows(50, 3, 8);
    const copy = [...rows];
    const out = stableSortInPlace(rows, (a, b) => a.key - b.key);
    expect(out).toBe(rows);
    expect(rows).toEqual(stableSort(copy, (a, b) => a.key - b.key));
    // every position is rewritten, the first and the last included
    const numbers = [9, 1, 5, 3, 0];
    expect(stableSortInPlace(numbers, (a, b) => a - b)).toBe(numbers);
    expect(numbers).toEqual([0, 1, 3, 5, 9]);
    expect(stableSortInPlace([2, 1], (a, b) => a - b)).toEqual([1, 2]);
    expect(stableSortInPlace([] as number[], (a, b) => a - b)).toEqual([]);
  });

  it('sorts every arrangement of a small multiset correctly and stably', () => {
    // all 4^6 sequences over four key values: every merge pattern of a 6-element sort
    for (let code = 0; code < 4 ** 6; code++) {
      const rows = Array.from({ length: 6 }, (_, id) => ({ key: Math.floor(code / 4 ** id) % 4, id }));
      const sorted = stableSort(rows, (a, b) => a.key - b.key);
      for (let i = 1; i < 6; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (prev.key > cur.key || (prev.key === cur.key && prev.id > cur.id)) {
          throw new Error(`not sorted stably: ${JSON.stringify(rows.map((r) => r.key))}`);
        }
      }
    }
  });
});

describe('argsort', () => {
  it('orders ascending with ties → lowest index', () => {
    expect(argsort([3, 1, 2, 1, 3])).toEqual([1, 3, 2, 0, 4]);
    expect(argsort(new Float32Array([0.5, 0.25, 0.5]))).toEqual([1, 0, 2]);
  });

  it('orders descending with ties → lowest index', () => {
    expect(argsort([3, 1, 2, 1, 3], 'desc')).toEqual([0, 4, 2, 1, 3]);
  });

  it('puts NaN last in both directions', () => {
    expect(argsort([Number.NaN, 2, 1, Number.NaN, 3])).toEqual([2, 1, 4, 0, 3]);
    expect(argsort([Number.NaN, 2, 1, Number.NaN, 3], 'desc')).toEqual([4, 1, 2, 0, 3]);
    expect(argsort([Number.NaN, Number.NaN])).toEqual([0, 1]);
  });

  it('returns a plain array, so mapping it back to the keys keeps fractions', () => {
    const keys = [0.5, 0.25, 0.75];
    const order = argsort(keys);
    expect(Array.isArray(order)).toBe(true);
    expect(order.map((i) => keys[i])).toEqual([0.25, 0.5, 0.75]);
    expect(argsort(keys, 'desc').map((i) => keys[i])).toEqual([0.75, 0.5, 0.25]);
  });

  it('handles infinities and negative numbers', () => {
    expect(argsort([0, Number.NEGATIVE_INFINITY, -3, Number.POSITIVE_INFINITY, 2])).toEqual([1, 2, 0, 4, 3]);
    expect(argsort([0, Number.NEGATIVE_INFINITY, -3, Number.POSITIVE_INFINITY, 2], 'desc')).toEqual([3, 4, 0, 2, 1]);
  });

  it('sorts every arrangement of a small multiset, in both directions', () => {
    for (let code = 0; code < 3 ** 7; code++) {
      const keys = Array.from({ length: 7 }, (_, i) => Math.floor(code / 3 ** i) % 3);
      const identity = keys.map((_, i) => i);
      const asc = [...identity].sort((a, b) => keys[a] - keys[b] || a - b);
      const desc = [...identity].sort((a, b) => keys[b] - keys[a] || a - b);
      if (String(argsort(keys)) !== String(asc) || String(argsort(keys, 'desc')) !== String(desc)) {
        throw new Error(`argsort is wrong for ${JSON.stringify(keys)}`);
      }
    }
  });

  it('returns a permutation for random input and matches a total-order sort', () => {
    const rng = mulberry32(31);
    const keys = Array.from({ length: 777 }, () => Math.floor(rng() * 50));
    const order = argsort(keys);
    const expected = keys.map((_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);
    expect(order).toEqual(expected);
    const expectedDesc = keys.map((_, i) => i).sort((a, b) => keys[b] - keys[a] || a - b);
    expect(argsort(keys, 'desc')).toEqual(expectedDesc);
  });

  it('handles empty and single inputs', () => {
    expect(argsort([])).toEqual([]);
    expect(argsort([7])).toEqual([0]);
  });
});

describe('argmin and argmax', () => {
  it('break ties toward the lowest index', () => {
    expect(argmin([2, 1, 3, 1])).toBe(1);
    expect(argmax([2, 3, 1, 3])).toBe(1);
    expect(argmin(new Float64Array([5, 5, 5]))).toBe(0);
    expect(argmax(new Float64Array([5, 5, 5]))).toBe(0);
  });

  it('skip NaN and return −1 when nothing is left', () => {
    expect(argmin([Number.NaN, 4, 2])).toBe(2);
    expect(argmax([Number.NaN, 4, 2])).toBe(1);
    expect(argmin([])).toBe(-1);
    expect(argmax([])).toBe(-1);
    expect(argmin([Number.NaN])).toBe(-1);
    expect(argmax([Number.NaN, Number.NaN])).toBe(-1);
  });

  it('handle infinities', () => {
    expect(argmin([1, Number.NEGATIVE_INFINITY, 0])).toBe(1);
    expect(argmax([1, Number.POSITIVE_INFINITY, 0])).toBe(1);
  });
});
