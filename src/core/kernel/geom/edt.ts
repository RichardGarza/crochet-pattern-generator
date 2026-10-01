// Exact Euclidean distance transforms (DESIGN.md §2.9.3, §2.9.7, §2.9.8) [04 §4.4]. Step 0 kernel: pure, no DOM.
//
// Algorithm: Felzenszwalb & Huttenlocher, "Distance Transforms of Sampled Functions" (Theory of Computing 8,
// 2012): the lower envelope of parabolas, one axis at a time, linear in the number of samples.
//
// One layout everywhere — 1D `i = x`; 2D `i = x + width·y` (row-major, like masks and `RgbaImage`); 3D
// `i = x + nx·(y + ny·z)` (like `SdfVolume` and marching cubes) — and three layers:
//
//   1. `edtSquared1d/2d/3d` — the generalized transform of a sampled function (the "seeded" form): every
//      sample q starts with a cost s(q) — 0 for a plain seed, +Infinity for "no seed", any finite number
//      otherwise — and every sample p gets  D(p) = min over q of ‖p − q‖² + s(q).  Costs and results are
//      SQUARED distances. In place. Optionally reports which seed q won.
//   2. `edt1d/2d/3d` — the plain transform of a mask: the distance (not squared) from every sample to the
//      nearest sample whose mask value is non-zero.
//   3. `signedEdt1d/2d/3d` — the signed transform of a mask, POSITIVE INSIDE (D11; inside = non-zero), and
//      `extendSignedDistance3d`, which completes a narrow band of exact signed distances to the whole grid
//      (§2.9.8).
//
// Every function takes `spacing`, the distance between neighboring samples (default 1), in its options;
// distances come out in the units of `spacing`. The squared and the plain transforms also accept one spacing
// per axis.
//
// Exactness: with spacing 1 and mask input every squared distance is an integer and is computed exactly (also
// in a Float32Array, up to 2^24). With the same spacing h on every axis the squared transforms work in units
// of h², so plain seeds (cost 0) give h² × an exact integer at any h. With per-axis spacings or non-zero costs
// at h ≠ 1 the results are exact up to floating-point rounding.
// Ties go to the lowest index (§5.8) for every true tie when the spacing is the same on every axis and the
// costs are 0 (plain seeds), or whole numbers at spacing 1. Otherwise rounded crossing points decide: two
// seeds at the same true distance (offsets along different axes with per-axis spacings, a cost divided by
// h²) can come out one rounding apart, or tie and go either way — the same way on every run.

/** A work or result array of the squared transforms. */
export type EdtArray = Float32Array | Float64Array;

/** Sample spacing of a 2D grid: one number, or [along x, along y]. */
export type Spacing2 = number | readonly [number, number];
/** Sample spacing of a 3D grid: one number, or [along x, along y, along z]. */
export type Spacing3 = number | readonly [number, number, number];

export interface EdtOptions<S = number> {
  /** Distance between neighboring samples. Default 1. */
  spacing?: S;
}

export interface EdtSquaredOptions<S = number> extends EdtOptions<S> {
  /**
   * Receives, for every sample, the index of a seed q that attains the minimum — the lowest such index when
   * several tie exactly (§5.8; guaranteed for plain seeds at any spacing that is the same on every axis and
   * for whole-number costs at spacing 1; see the file header for the other cases) — or −1 where no seed exists.
   * Must have one entry per sample.
   */
  nearest?: Int32Array;
}

export interface SignedEdtOptions extends EdtOptions<number> {
  /**
   * What the distance is measured to.
   *
   * `'samples'` (default) — the exact signed transform of §2.9.3: +(distance to the nearest outside sample)
   * on inside samples, −(distance to the nearest inside sample) on outside samples; the difference of two
   * plain transforms. `Math.max(sd, 0)` is the "inside EDT" of the inflation formula. No value lies in
   * (−spacing, +spacing): across the boundary the field steps from −spacing to +spacing.
   *
   * `'boundary'` — the same, moved half a spacing toward 0: +(… − spacing/2) and −(… − spacing/2). The zero
   * level then lies on the faces between inside and outside cells and the field has slope 1 across them
   * (…, −1.5, −0.5, +0.5, +1.5, … × spacing), like a true signed distance. Use it when the field is meshed at
   * a level other than 0 or mixed with true distances.
   *
   * Marching cubes at level 0 gives the same mesh for both on the transform's own grid (every crossed edge
   * holds ±1 or ±½ spacing). They differ by half a spacing everywhere else, and which one is closer to the
   * true distance to a smooth outline depends on where one looks. Measured on discs of radius 8–120 px:
   * `'samples'` is 0…1 px too large (0.54 on average within a pixel of the outline, 0.13–0.27 deeper than
   * 5 px); `'boundary'` errs by −0.5…+0.5 px (0.04 near the outline, −0.24…−0.37 deeper than 5 px). An
   * outline that curves within a pixel or two breaks both ranges.
   */
  measureTo?: 'samples' | 'boundary';
}

/**
 * The accepted spacings. The mask transforms return float32 and `extendSignedDistance3d` keeps squared world
 * distances in float32 work arrays, so a spacing must keep spacing² (the smallest non-zero squared distance)
 * and (spacing · grid diagonal)² normal float32 numbers, with room for grids of 10⁴ samples per axis. (The
 * first version accepted 1e-100 … 1e100, the double range: at 1e-50 a signed transform came out all 0, at
 * 1e50 a distance came out +Infinity, and the far field lost its sign at 1e-30 and its values at 1e20.)
 */
const MIN_SPACING = 1e-15;
const MAX_SPACING = 1e15;

function checkSpacing(s: number): number {
  if (!(s >= MIN_SPACING && s <= MAX_SPACING)) {
    throw new RangeError(`spacing must be a positive number between ${MIN_SPACING} and ${MAX_SPACING}, got ${s}`);
  }
  return s;
}

function spacing2(s: Spacing2 | undefined): [number, number] {
  if (s === undefined) return [1, 1];
  return typeof s === 'number' ? [checkSpacing(s), s] : [checkSpacing(s[0]), checkSpacing(s[1])];
}

function spacing3(s: Spacing3 | undefined): [number, number, number] {
  if (s === undefined) return [1, 1, 1];
  return typeof s === 'number' ? [checkSpacing(s), s, s] : [checkSpacing(s[0]), checkSpacing(s[1]), checkSpacing(s[2])];
}

function checkDim(n: number, name: string): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`${name} must be an integer >= 1, got ${n}`);
}

function checkDims3(dims: readonly [number, number, number]): number {
  checkDim(dims[0], 'nx');
  checkDim(dims[1], 'ny');
  checkDim(dims[2], 'nz');
  return dims[0] * dims[1] * dims[2];
}

function checkLength(length: number, expected: number, what: string): void {
  if (length !== expected) throw new RangeError(`${what} has ${length} entries, expected ${expected}`);
}

interface Scratch {
  /** The costs of one line. */
  f: Float64Array;
  /** The transformed line. */
  out: Float64Array;
  /** The winning position for every sample of the line. */
  arg: Int32Array;
  /** Positions of the parabolas of the lower envelope. */
  v: Int32Array;
  /** Boundaries between consecutive parabolas of the envelope. */
  z: Float64Array;
  /** `nearest` of the line before the pass. */
  src: Int32Array;
}

function makeScratch(n: number): Scratch {
  return {
    f: new Float64Array(n),
    out: new Float64Array(n),
    arg: new Int32Array(n),
    v: new Int32Array(n),
    z: new Float64Array(n + 1),
    src: new Int32Array(n),
  };
}

/**
 * One line: out[q] = min over p of w2·(q − p)² + f[p], and arg[q] = the p that attains it (where two
 * parabolas of the envelope cross exactly at a sample, the one with the lower p). `f[p]` is finite, or
 * +Infinity / NaN for "no seed"; the line must hold at least one seed.
 *
 * With w2 = 1 and whole-number costs every crossing is an exact rational, so an exact tie lands exactly on
 * the sample and goes to the lower p. Otherwise the crossing is rounded and decides a tie whichever way it
 * rounds (the same way on every run): `squaredTransform` therefore runs isotropic grids in sample units.
 */
function lowerEnvelope(s: Scratch, n: number, w2: number): void {
  const { f, out, arg, v, z } = s;
  let k = -1;
  for (let q = 0; q < n; q++) {
    const fq = f[q];
    if (!(fq < Infinity)) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    // Where parabola q overtakes the last parabola of the envelope; drop the ones it hides completely.
    const gq = fq + w2 * q * q;
    let p = v[k];
    let cross = (gq - (f[p] + w2 * p * p)) / (2 * w2 * (q - p));
    while (cross <= z[k]) {
      k--;
      // (A crossing of −Infinity — a cost difference beyond the double range — hides every parabola.)
      if (k < 0) break;
      p = v[k];
      cross = (gq - (f[p] + w2 * p * p)) / (2 * w2 * (q - p));
    }
    k++;
    v[k] = q;
    z[k] = k === 0 ? -Infinity : cross;
    z[k + 1] = Infinity;
  }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const p = v[j];
    const d = q - p;
    out[q] = w2 * d * d + f[p];
    arg[q] = p;
  }
}

/**
 * Whether every finite cost divided by `w2` — the costs in units of spacing² — stays a seed with its sign: the
 * quotient must be finite, and non-zero where the cost is, in the precision of `values`.
 */
function fitsSampleUnits(values: EdtArray, w2: number): boolean {
  const single = values instanceof Float32Array;
  for (let i = 0; i < values.length; i++) {
    const c = values[i];
    if (!(c - c === 0) || c === 0) continue;
    const u = single ? Math.fround(c / w2) : c / w2;
    if (!(u - u === 0) || u === 0) return false;
  }
  return true;
}

/**
 * The separable transform over the listed axes of a grid with the given dimensions (x fastest), in place.
 *
 * When the spacing is the same along every listed axis, the transform runs in sample units — costs divided
 * by spacing² before, results multiplied by it after — so that plain seeds (cost 0) give whole numbers through
 * every pass: every value is exact until the final product, and seeds at the same true distance tie exactly,
 * whatever the spacing and whichever axes their offsets lie along, and the lowest index wins (§5.8). In world
 * units the passes round, and a tie between offsets such as (3, 4, 0) and (0, 0, 5) at spacing 0.3 could come
 * out one rounding apart. (Costs that the division would push out of the range of `values` take the
 * world-unit path.)
 */
function squaredTransform(
  values: EdtArray,
  dims: readonly number[],
  spacing: readonly number[],
  axes: readonly number[],
  nearest?: Int32Array,
): void {
  if (axes.length === 0) return;
  const h = spacing[axes[0]];
  const w2 = h * h;
  if (w2 !== 1 && axes.every((axis) => spacing[axis] === h) && fitsSampleUnits(values, w2)) {
    envelopePasses(
      values,
      dims,
      dims.map(() => 1),
      axes,
      nearest,
      w2,
    );
    return;
  }
  envelopePasses(values, dims, spacing, axes, nearest, 1);
}

/**
 * The work of `squaredTransform`, with the spacing as given: one pass of `lowerEnvelope` along every line of
 * each listed axis, in the order given. `nearest`, when given, is set by the first pass and carried through
 * the others. The first pass divides what it reads by `unit`, the last one multiplies what it writes by it
 * (1: neither).
 *
 * A line along an axis starts at `hi + lo` (hi: a multiple of stride·n, lo < stride) and steps by `stride`.
 */
function envelopePasses(
  values: EdtArray,
  dims: readonly number[],
  spacing: readonly number[],
  axes: readonly number[],
  nearest: Int32Array | undefined,
  unit: number,
): void {
  let total = 1;
  let longest = 1;
  const strides: number[] = [];
  for (const n of dims) {
    strides.push(total);
    total *= n;
    if (n > longest) longest = n;
  }
  const s = makeScratch(longest);
  const { f, out, arg, src } = s;
  let firstPass = true;
  for (let pass = 0; pass < axes.length; pass++) {
    const axis = axes[pass];
    const n = dims[axis];
    const stride = strides[axis];
    const block = stride * n;
    const w2 = spacing[axis] * spacing[axis];
    const divide = firstPass && unit !== 1;
    const multiply = pass === axes.length - 1 && unit !== 1;
    for (let hi = 0; hi < total; hi += block) {
      for (let lo = 0; lo < stride; lo++) {
        const base = hi + lo;
        let any = false;
        if (divide) {
          for (let k = 0, at = base; k < n; k++, at += stride) {
            const x = values[at] / unit;
            f[k] = x;
            if (x < Infinity) any = true;
          }
        } else {
          for (let k = 0, at = base; k < n; k++, at += stride) {
            const x = values[at];
            f[k] = x;
            if (x < Infinity) any = true;
          }
        }
        if (!any) {
          // No seed on this line: every value is +Infinity (a NaN, which means "no seed", becomes +Infinity).
          for (let k = 0, at = base; k < n; k++, at += stride) values[at] = Infinity;
          if (nearest !== undefined && firstPass) {
            for (let k = 0, at = base; k < n; k++, at += stride) nearest[at] = -1;
          }
          continue;
        }
        lowerEnvelope(s, n, w2);
        if (multiply) for (let k = 0, at = base; k < n; k++, at += stride) values[at] = out[k] * unit;
        else for (let k = 0, at = base; k < n; k++, at += stride) values[at] = out[k];
        if (nearest !== undefined) {
          if (firstPass) {
            // The winning seed is on this very line.
            for (let k = 0, at = base; k < n; k++, at += stride) nearest[at] = base + arg[k] * stride;
          } else {
            // The winner of sample k is whatever seed had won at the position of its parabola.
            for (let k = 0, at = base; k < n; k++, at += stride) src[k] = nearest[at];
            for (let k = 0, at = base; k < n; k++, at += stride) nearest[at] = src[arg[k]];
          }
        }
      }
    }
    firstPass = false;
  }
}

/** Validates the input of a squared transform before anything is written. */
function checkSquared(values: EdtArray, total: number, nearest: Int32Array | undefined): void {
  checkLength(values.length, total, 'the value array');
  if (nearest !== undefined) checkLength(nearest.length, total, '`nearest`');
  for (let i = 0; i < total; i++) {
    if (values[i] === -Infinity) throw new RangeError(`edtSquared: sample ${i} is -Infinity`);
  }
}

/**
 * Generalized squared distance transform of a line, in place:
 * `values[p] ← min over q of (spacing·(p − q))² + values[q]`.
 *
 * Entries are squared-distance costs: 0 for a plain seed, +Infinity for "no seed" (NaN counts as no seed
 * too), any finite number otherwise; −Infinity throws, before anything is written. Without any seed the
 * result is all +Infinity. Returns `values`.
 */
export function edtSquared1d<T extends EdtArray>(values: T, options: EdtSquaredOptions<number> = {}): T {
  checkSquared(values, values.length, options.nearest);
  const spacing = checkSpacing(options.spacing ?? 1);
  if (values.length > 0) squaredTransform(values, [values.length], [spacing], [0], options.nearest);
  return values;
}

/** Generalized squared distance transform of a `width`×`height` grid (row-major), in place; see `edtSquared1d`. */
export function edtSquared2d<T extends EdtArray>(values: T, width: number, height: number, options: EdtSquaredOptions<Spacing2> = {}): T {
  checkDim(width, 'width');
  checkDim(height, 'height');
  checkSquared(values, width * height, options.nearest);
  squaredTransform(values, [width, height], spacing2(options.spacing), [0, 1], options.nearest);
  return values;
}

/** Generalized squared distance transform of an nx×ny×nz grid (x fastest), in place; see `edtSquared1d`. */
export function edtSquared3d<T extends EdtArray>(
  values: T,
  dims: readonly [number, number, number],
  options: EdtSquaredOptions<Spacing3> = {},
): T {
  checkSquared(values, checkDims3(dims), options.nearest);
  squaredTransform(values, dims, spacing3(options.spacing), [0, 1, 2], options.nearest);
  return values;
}

/**
 * First pass of a mask transform, written directly: `out[i]` ← the squared distance ALONG X, in samples, from
 * sample i to the nearest feature sample of its row; +Infinity for a row without one. A sample is a feature
 * when `(mask[i] !== 0) === featureIsSet`.
 */
function rowDistancesSquared(mask: ArrayLike<number>, featureIsSet: boolean, out: Float32Array, width: number): void {
  for (let base = 0; base < out.length; base += width) {
    let run = Infinity;
    for (let x = 0, at = base; x < width; x++, at++) {
      run = (mask[at] !== 0) === featureIsSet ? 0 : run + 1;
      out[at] = run;
    }
    run = Infinity;
    for (let at = base + width - 1; at >= base; at--) {
      run = (mask[at] !== 0) === featureIsSet ? 0 : run + 1;
      const d = run < out[at] ? run : out[at];
      out[at] = d * d;
    }
  }
}

/** Squared distances in samples (spacing 1 on every axis) from each sample to the nearest feature sample. */
function maskTransformUnit(mask: ArrayLike<number>, featureIsSet: boolean, dims: readonly number[]): Float32Array<ArrayBuffer> {
  const out = new Float32Array(mask.length);
  rowDistancesSquared(mask, featureIsSet, out, dims[0]);
  // The x pass is done; the envelope passes run over the remaining axes.
  const rest: number[] = [];
  for (let axis = 1; axis < dims.length; axis++) rest.push(axis);
  squaredTransform(
    out,
    dims,
    dims.map(() => 1),
    rest,
  );
  return out;
}

/** The plain transform of a mask with per-axis spacing: distances, not squared. */
function maskDistances(mask: ArrayLike<number>, dims: readonly number[], spacing: readonly number[]): Float32Array<ArrayBuffer> {
  let total = 1;
  for (const n of dims) total *= n;
  checkLength(mask.length, total, 'the mask');
  if (spacing.every((s) => s === spacing[0])) {
    // Integer squared distances in samples, exact; scaled once at the end.
    const out = maskTransformUnit(mask, true, dims);
    const scale = spacing[0];
    for (let i = 0; i < out.length; i++) out[i] = scale * Math.sqrt(out[i]);
    return out;
  }
  const work = new Float64Array(total);
  for (let i = 0; i < total; i++) work[i] = mask[i] !== 0 ? 0 : Infinity;
  squaredTransform(
    work,
    dims,
    spacing,
    dims.map((_, axis) => axis),
  );
  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) out[i] = Math.sqrt(work[i]);
  return out;
}

/**
 * Distance from every sample of a line to the nearest sample whose mask value is non-zero (0 on those
 * samples; +Infinity everywhere when the mask is empty).
 */
export function edt1d(mask: ArrayLike<number>, options: EdtOptions<number> = {}): Float32Array<ArrayBuffer> {
  const spacing = checkSpacing(options.spacing ?? 1);
  if (mask.length === 0) return new Float32Array(0);
  return maskDistances(mask, [mask.length], [spacing]);
}

/**
 * Distance from every pixel of a `width`×`height` mask (row-major) to the nearest pixel whose mask value is
 * non-zero, measured between pixel centers (0 on those pixels; +Infinity everywhere when the mask is empty).
 */
export function edt2d(mask: ArrayLike<number>, width: number, height: number, options: EdtOptions<Spacing2> = {}): Float32Array<ArrayBuffer> {
  checkDim(width, 'width');
  checkDim(height, 'height');
  return maskDistances(mask, [width, height], spacing2(options.spacing));
}

/**
 * Distance from every voxel of an nx×ny×nz mask (x fastest) to the nearest voxel whose mask value is non-zero,
 * measured between voxel centers (0 on those voxels; +Infinity everywhere when the mask is empty).
 */
export function edt3d(mask: ArrayLike<number>, dims: readonly [number, number, number], options: EdtOptions<Spacing3> = {}): Float32Array<ArrayBuffer> {
  checkDims3(dims);
  return maskDistances(mask, dims, spacing3(options.spacing));
}

function signedMaskDistances(mask: ArrayLike<number>, dims: readonly number[], options: SignedEdtOptions): Float32Array<ArrayBuffer> {
  let total = 1;
  for (const n of dims) total *= n;
  checkLength(mask.length, total, 'the mask');
  const spacing = checkSpacing(options.spacing ?? 1);
  const measureTo = options.measureTo ?? 'samples';
  if (measureTo !== 'samples' && measureTo !== 'boundary') {
    throw new RangeError(`measureTo must be 'samples' or 'boundary', got ${String(measureTo)}`);
  }
  const half = measureTo === 'boundary' ? 0.5 : 0;
  // Squared distances in samples: to the nearest outside sample (used on inside samples) and vice versa.
  const toOutside = maskTransformUnit(mask, false, dims);
  const toInside = maskTransformUnit(mask, true, dims);
  for (let i = 0; i < total; i++) {
    toOutside[i] = mask[i] !== 0 ? spacing * (Math.sqrt(toOutside[i]) - half) : -spacing * (Math.sqrt(toInside[i]) - half);
  }
  return toOutside;
}

/**
 * Signed distance of a line mask, POSITIVE INSIDE (inside = non-zero); see `SignedEdtOptions.measureTo`. A
 * mask that is all inside gives +Infinity everywhere, an empty mask −Infinity.
 */
export function signedEdt1d(mask: ArrayLike<number>, options: SignedEdtOptions = {}): Float32Array<ArrayBuffer> {
  if (mask.length === 0) {
    checkSpacing(options.spacing ?? 1);
    return new Float32Array(0);
  }
  return signedMaskDistances(mask, [mask.length], options);
}

/**
 * Signed distance of a `width`×`height` mask (row-major), POSITIVE INSIDE (inside = non-zero) — the per-view
 * transform of §2.9.3; pass the world size of a pixel as `spacing` to get world units.
 *
 * Only the pixels of the image exist: a mask that touches the image frame is not closed there, a mask that
 * is all inside gives +Infinity everywhere and an empty mask −Infinity. (Pad the mask with one ring of zeros
 * to treat the frame as outside.)
 */
export function signedEdt2d(mask: ArrayLike<number>, width: number, height: number, options: SignedEdtOptions = {}): Float32Array<ArrayBuffer> {
  checkDim(width, 'width');
  checkDim(height, 'height');
  return signedMaskDistances(mask, [width, height], options);
}

/** Signed distance of an nx×ny×nz voxel mask (x fastest), POSITIVE INSIDE; see `signedEdt2d`. */
export function signedEdt3d(mask: ArrayLike<number>, dims: readonly [number, number, number], options: SignedEdtOptions = {}): Float32Array<ArrayBuffer> {
  checkDims3(dims);
  return signedMaskDistances(mask, dims, options);
}

/**
 * First pass of the crossing transform: for every line along `axis`, `out` ← the squared distance (world
 * units; `h` is the spacing along the axis) from each sample to the nearest point where that line crosses
 * the surface; +Infinity on a line without a crossing. A crossing lies between two neighboring KNOWN (finite)
 * samples on different sides — a known 0 is inside — at the zero of the straight line through their two
 * values. Returns whether any line has a crossing.
 */
function crossingDistancesSquared(sdf: EdtArray, dims: readonly [number, number, number], axis: number, h: number, out: Float32Array): boolean {
  const total = dims[0] * dims[1] * dims[2];
  const n = dims[axis];
  const stride = axis === 0 ? 1 : axis === 1 ? dims[0] : dims[0] * dims[1];
  const block = stride * n;
  const crossings = new Float64Array(n);
  let any = false;
  for (let hi = 0; hi < total; hi += block) {
    for (let lo = 0; lo < stride; lo++) {
      const base = hi + lo;
      let count = 0;
      let a = sdf[base];
      for (let k = 0, at = base; k + 1 < n; k++, at += stride) {
        const b = sdf[at + stride];
        // `v - v === 0` is true for finite v only.
        if (a - a === 0 && b - b === 0 && a >= 0 !== b >= 0) crossings[count++] = k + a / (a - b);
        a = b;
      }
      if (count === 0) {
        for (let k = 0, at = base; k < n; k++, at += stride) out[at] = Infinity;
        continue;
      }
      any = true;
      // `crossings` is ascending; j is the last crossing at or before sample k (or the first one).
      let j = 0;
      for (let k = 0, at = base; k < n; k++, at += stride) {
        while (j + 1 < count && crossings[j + 1] <= k) j++;
        let d = Math.abs(k - crossings[j]);
        if (j + 1 < count && crossings[j + 1] - k < d) d = crossings[j + 1] - k;
        out[at] = d * d * h * h;
      }
    }
  }
  return any;
}

/**
 * Completes a narrow band of exact signed distances to the whole grid, in place (§2.9.8 step 3: "fill the far
 * field with the 3D EDT seeded from the band").
 *
 * `sdf` (positive inside, x fastest) holds a signed distance wherever it is finite; those entries are kept.
 * +Infinity marks an inside sample whose distance is not known yet, −Infinity an outside one. Every unknown
 * sample p gets, with its own sign, the smaller of two upper bounds on its distance to the surface:
 *
 *   1. The distance to the nearest CROSSING. Where two neighboring known samples lie on different sides, the
 *      surface crosses the lattice edge between them, at the zero of the line through their two values. Seeded
 *      along each axis in turn with the exact distance to the crossings of that axis' lines, the transform
 *      gives the distance to the nearest of all these points — a sampling of the surface itself, about one
 *      point per voxel face.
 *   2. Through the known sample q, of either side, that minimizes `‖p − q‖² + sdf[q]²`: `‖p − q‖ + |sdf[q]|`
 *      when q lies on the side of p (the surface is |sdf[q]| away from q: triangle inequality), and
 *      `‖p − q‖ − |sdf[q]|` when it lies on the other side (the segment from p to q crosses the surface at
 *      least |sdf[q]| from q). This bound also reaches sharp convex edges and corners, which no lattice edge
 *      crosses, and it is the only one when the known samples lie on one side. (Where the second form is ≤ 0
 *      the surface may pass through p itself; p then gets 1e-6 · the smallest spacing, with its sign. With
 *      exact known distances the other-side form is never below p's true distance.)
 *
 * Why not the square root of the transform seeded with sdf², as a literal reading of §2.9.8 suggests: a band
 * sample q at distance d from the surface lies on the way from p to the surface, so the true distance is
 * ‖p − q‖ + d, and √(‖p − q‖² + d²) is shorter than that by almost d — with a band of ±2 voxels the far field
 * comes out up to 2 voxels too small. Measured against exact distances at N = 96 with a band of ±2 voxels:
 * this function is within −0.01 … +0.14 voxel on smooth solids (sphere, torus, capsule, a hollow sphere; 0.01
 * on average), within 0.11 voxel on planes at any tilt, and up to 0.7 voxel too large next to sharp edges
 * (boxes, a thin plate, a cylinder's rims; 0.03–0.06 on average). The square-root form is up to 1.96 voxels
 * too small (1.4–1.7 on average).
 *
 * Only the surface that the known samples describe exists: where the true surface leaves the grid, samples
 * whose nearest surface point lies outside are measured to the nearest part inside. Without any known sample
 * nothing changes. NaN throws. Returns `sdf`.
 */
export function extendSignedDistance3d<T extends EdtArray>(sdf: T, dims: readonly [number, number, number], options: EdtOptions<Spacing3> = {}): T {
  const total = checkDims3(dims);
  checkLength(sdf.length, total, 'the field');
  const spacing = spacing3(options.spacing);
  const nx = dims[0];
  const ny = dims[1];
  let known = 0;
  let unknown = 0;
  for (let i = 0; i < total; i++) {
    const d = sdf[i];
    if (d !== d) throw new RangeError(`extendSignedDistance3d: sample ${i} is NaN`);
    if (d - d === 0) known++;
    else unknown++;
  }
  if (known === 0 || unknown === 0) return sdf;

  // Bound 1: squared distance to the nearest crossing, the smallest over the three axis choices.
  const crossing = new Float32Array(total).fill(Infinity);
  const work = new Float32Array(total);
  for (let axis = 0; axis < 3; axis++) {
    if (!crossingDistancesSquared(sdf, dims, axis, spacing[axis], work)) continue;
    squaredTransform(
      work,
      dims,
      spacing,
      [0, 1, 2].filter((other) => other !== axis),
    );
    for (let i = 0; i < total; i++) if (work[i] < crossing[i]) crossing[i] = work[i];
  }

  // Bound 2: the known sample that wins the transform seeded with the squared band distances.
  const nearest = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    const d = sdf[i];
    // (Capped so that an absurdly large known value stays a seed in the float32 work array.)
    work[i] = d - d === 0 ? Math.min(d * d, 1e38) : Infinity;
  }
  squaredTransform(work, dims, spacing, [0, 1, 2], nearest);

  // Where the bound through a known sample of the other side is ≤ 0, the surface may pass through p itself;
  // p keeps its sign with this small value (a normal float32 for every accepted spacing).
  const floor = 1e-6 * Math.min(spacing[0], spacing[1], spacing[2]);
  let i = 0;
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        const d = sdf[i];
        if (d - d === 0) continue;
        const q = nearest[i];
        const row = Math.floor(q / nx);
        const dx = (x - (q - row * nx)) * spacing[0];
        const dy = (y - (row % ny)) * spacing[1];
        const dz = (z - Math.floor(row / ny)) * spacing[2];
        const known = sdf[q];
        const apart = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // Same side: the surface is |known| beyond q. Other side: segment pq crosses it at least |known| from q.
        const viaSample = known >= 0 === d > 0 ? apart + Math.abs(known) : Math.max(apart - Math.abs(known), floor);
        const viaCrossing = Math.sqrt(crossing[i]);
        const best = viaCrossing < viaSample ? viaCrossing : viaSample;
        sdf[i] = d > 0 ? best : -best;
      }
    }
  }
  return sdf;
}
