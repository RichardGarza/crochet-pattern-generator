// Stable sorting and tie-breaking (DESIGN.md §2.4.1, §5.8 "stable sorts; ties → lowest index"). Step 0 kernel.
//
// These are our own merge sorts, so the order of equal elements never depends on the JavaScript engine. A
// comparator that returns NaN is treated as "equal" (0).

export type Compare<T> = (a: T, b: T) => number;

/** Returns a new array sorted by `compare`; elements that compare equal keep their input order. */
export function stableSort<T>(items: ArrayLike<T>, compare: Compare<T>): T[] {
  const n = items.length;
  let src: T[] = Array.from(items);
  if (n < 2) return src;
  let dst: T[] = src.slice();
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n);
      const hi = Math.min(lo + 2 * width, n);
      let i = lo;
      let j = mid;
      let k = lo;
      // Take from the right run only when it is strictly smaller: ties keep the left (earlier) element first.
      while (i < mid && j < hi) dst[k++] = compare(src[j], src[i]) < 0 ? src[j++] : src[i++];
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    const swap = src;
    src = dst;
    dst = swap;
  }
  return src;
}

/** Sorts `items` in place, stably; returns the same array. */
export function stableSortInPlace<T>(items: T[], compare: Compare<T>): T[] {
  const sorted = stableSort(items, compare);
  for (let i = 0; i < sorted.length; i++) items[i] = sorted[i];
  return items;
}

/**
 * The permutation that sorts `keys` ascending (or descending): `keys[result[0]]` is the smallest (largest).
 * Equal keys keep their index order, so ties go to the lowest index in both directions. NaN keys sort last.
 * The result is a plain array, so `argsort(keys).map((i) => keys[i])` gives the sorted keys.
 */
export function argsort(keys: ArrayLike<number>, order: 'asc' | 'desc' = 'asc'): number[] {
  const sign = order === 'desc' ? -1 : 1;
  const indices: number[] = [];
  for (let i = 0; i < keys.length; i++) indices.push(i);
  return stableSort(indices, (a, b) => {
    const ka = keys[a];
    const kb = keys[b];
    if (Number.isNaN(ka)) return Number.isNaN(kb) ? 0 : 1;
    if (Number.isNaN(kb)) return -1;
    return ka < kb ? -sign : ka > kb ? sign : 0;
  });
}

/** Index of the smallest value; ties → lowest index; NaN is never chosen. −1 for an empty or all-NaN input. */
export function argmin(values: ArrayLike<number>): number {
  let best = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (best < 0 || v < values[best]) best = i;
  }
  return best;
}

/** Index of the largest value; ties → lowest index; NaN is never chosen. −1 for an empty or all-NaN input. */
export function argmax(values: ArrayLike<number>): number {
  let best = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (best < 0 || v > values[best]) best = i;
  }
  return best;
}
