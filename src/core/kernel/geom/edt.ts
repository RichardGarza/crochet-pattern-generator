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
// in a Float32Array, up to 2^24). With other spacings or real-valued costs the results are exact up to
// floating-point rounding. Ties are broken the same way on every run (§5.8).

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
   * Receives, for every sample, the index of a seed q that attains the minimum (−1 where no seed exists).
   * Must have one entry per sample.
   */
  nearest?: Int32Array;
}

export interface SignedEdtOptions extends EdtOptions<number> {
  /**
   * What the distance is measured to.
   *
   * `'boundary'` (default): the boundary between inside and outside, taken halfway between an inside sample
   * and the outside sample next to it (the face between the two cells). An inside sample gets
   * +(distance to the nearest outside sample − spacing/2), an outside sample −(distance to the nearest inside
   * sample − spacing/2). Across a straight boundary the values run …, −1.5, −0.5, +0.5, +1.5, … (× spacing):
   * slope 1, zero exactly on the cell faces, which is what marching cubes and bilinear sampling need. Against
   * the true distance to a smooth outline the error is within ±spacing/2, and has no bias next to the
   * outline.
   *
   * `'samples'`: the nearest sample of the other kind — the textbook difference of two plain transforms:
   * +(distance to the nearest outside sample), −(distance to the nearest inside sample). No value lies in
   * (−spacing, +spacing): the field jumps by 2·spacing across the boundary, and every value is between 0 and
   * 1 spacing too large in magnitude (half a spacing next to the outline).
   */
  measureTo?: 'boundary' | 'samples';
}

function checkSpacing(s: number): number {
  if (!(s > 0) || !Number.isFinite(s)) throw new RangeError(`spacing must be a positive number, got ${s}`);
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
 * parabolas of the envelope tie, the one with the lower p). `f[p]` is finite, or +Infinity / NaN for "no
 * seed"; the line must hold at least one seed.
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
      p = v[k];
      cross = (gq - (f[p] + w2 * p * p)) / (2 * w2 * (q - p));
    }
    k++;
    v[k] = q;
    z[k] = cross;
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
 * The separable transform over the axes `firstAxis…` of a grid with the given dimensions (x fastest), in
 * place. `nearest`, when given, is carried through the passes (it needs `firstAxis` = 0).
 *
 * A line along an axis starts at `hi + lo` (hi: a multiple of stride·n, lo < stride) and steps by `stride`.
 */
function squaredTransform(values: EdtArray, dims: readonly number[], spacing: readonly number[], nearest: Int32Array | undefined, firstAxis: number): void {
  let total = 1;
  let longest = 1;
  for (const n of dims) {
    total *= n;
    if (n > longest) longest = n;
  }
  const s = makeScratch(longest);
  const { f, out, arg, src } = s;
  let stride = 1;
  let firstPass = true;
  for (let axis = 0; axis < dims.length; axis++) {
    const n = dims[axis];
    const block = stride * n;
    if (axis >= firstAxis) {
      const w2 = spacing[axis] * spacing[axis];
      for (let hi = 0; hi < total; hi += block) {
        for (let lo = 0; lo < stride; lo++) {
          const base = hi + lo;
          let any = false;
          for (let k = 0, at = base; k < n; k++, at += stride) {
            const x = values[at];
            if (x === -Infinity) throw new RangeError(`edtSquared: sample ${at} is -Infinity`);
            f[k] = x;
            if (x < Infinity) any = true;
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
          for (let k = 0, at = base; k < n; k++, at += stride) values[at] = out[k];
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
    stride = block;
  }
}

function checkSquared(values: EdtArray, total: number, nearest: Int32Array | undefined): void {
  checkLength(values.length, total, 'the value array');
  if (nearest !== undefined) checkLength(nearest.length, total, '`nearest`');
}

/**
 * Generalized squared distance transform of a line, in place:
 * `values[p] ← min over q of (spacing·(p − q))² + values[q]`.
 *
 * Entries are squared-distance costs: 0 for a plain seed, +Infinity for "no seed" (NaN counts as no seed
 * too), any finite number otherwise; −Infinity throws. A line without seeds becomes all +Infinity. Returns
 * `values`.
 */
export function edtSquared1d<T extends EdtArray>(values: T, options: EdtSquaredOptions<number> = {}): T {
  checkSquared(values, values.length, options.nearest);
  const spacing = checkSpacing(options.spacing ?? 1);
  if (values.length > 0) squaredTransform(values, [values.length], [spacing], options.nearest, 0);
  return values;
}

/** Generalized squared distance transform of a `width`×`height` grid (row-major), in place; see `edtSquared1d`. */
export function edtSquared2d<T extends EdtArray>(values: T, width: number, height: number, options: EdtSquaredOptions<Spacing2> = {}): T {
  checkDim(width, 'width');
  checkDim(height, 'height');
  checkSquared(values, width * height, options.nearest);
  squaredTransform(values, [width, height], spacing2(options.spacing), options.nearest, 0);
  return values;
}

/** Generalized squared distance transform of an nx×ny×nz grid (x fastest), in place; see `edtSquared1d`. */
export function edtSquared3d<T extends EdtArray>(
  values: T,
  dims: readonly [number, number, number],
  options: EdtSquaredOptions<Spacing3> = {},
): T {
  checkSquared(values, checkDims3(dims), options.nearest);
  squaredTransform(values, dims, spacing3(options.spacing), options.nearest, 0);
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
  squaredTransform(
    out,
    dims,
    dims.map(() => 1),
    undefined,
    1,
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
  squaredTransform(work, dims, spacing, undefined, 0);
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
  const measureTo = options.measureTo ?? 'boundary';
  if (measureTo !== 'boundary' && measureTo !== 'samples') {
    throw new RangeError(`measureTo must be 'boundary' or 'samples', got ${String(measureTo)}`);
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
 * Signed distance of a line mask, POSITIVE INSIDE (inside = non-zero); see `SignedEdtOptions.measureTo` for
 * where the zero level lies. A mask that is all inside gives +Infinity everywhere, an empty mask −Infinity.
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
 * Completes a narrow band of exact signed distances to the whole grid, in place (§2.9.8 step 3: "fill the far
 * field … seeded from the band, separately inside and outside").
 *
 * `sdf` (positive inside, x fastest) holds a signed distance wherever it is finite; those entries are kept.
 * +Infinity marks an inside sample whose distance is not known yet, −Infinity an outside one. Every unknown
 * sample p gets `±(‖p − q‖ + |sdf[q]|)`, where q is the known sample of p's own side that minimizes
 * `‖p − q‖² + sdf[q]²` (one seeded squared transform per side). A known 0 seeds both sides.
 *
 * Why the sum and not the square root of that minimum, as a literal reading of §2.9.8 suggests: a band sample
 * q at distance d from the surface lies on the way from p to the surface, so the true distance is ‖p − q‖ + d,
 * and √(‖p − q‖² + d²) is shorter than that by almost d — with a band of ±2 voxels the far field comes out up
 * to 2 voxels too small. The sum is exact when q lies on the straight line from p to its nearest surface point
 * and is never too small (triangle inequality). Measured against the exact distance on a sphere, a box, a
 * torus and a capsule (N = 96, band ±2 voxels): at most 0.60 voxel too large, 0.03–0.09 voxel on average;
 * the square-root form is up to 1.95 voxels too small, 1.4–1.7 on average.
 *
 * A side that has unknown samples but no known one keeps them at ±Infinity. NaN throws. Returns `sdf`.
 */
export function extendSignedDistance3d<T extends EdtArray>(sdf: T, dims: readonly [number, number, number], options: EdtOptions<Spacing3> = {}): T {
  const total = checkDims3(dims);
  checkLength(sdf.length, total, 'the field');
  const [sx, sy, sz] = spacing3(options.spacing);
  const nx = dims[0];
  const ny = dims[1];
  for (let i = 0; i < total; i++) {
    if (sdf[i] !== sdf[i]) throw new RangeError(`extendSignedDistance3d: sample ${i} is NaN`);
  }
  const work = new Float32Array(total);
  const nearest = new Int32Array(total);
  for (const side of [1, -1]) {
    // Costs: the squared distance of every known sample of this side; no seed elsewhere.
    let unknown = 0;
    let known = 0;
    for (let i = 0; i < total; i++) {
      const d = side * sdf[i];
      if (d >= 0 && d < Infinity) {
        work[i] = d * d;
        known++;
      } else {
        work[i] = Infinity;
        if (d === Infinity) unknown++;
      }
    }
    if (unknown === 0 || known === 0) continue;
    squaredTransform(work, dims, [sx, sy, sz], nearest, 0);
    let i = 0;
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (side * sdf[i] !== Infinity) continue;
          const q = nearest[i];
          const row = Math.floor(q / nx);
          const dx = (x - (q - row * nx)) * sx;
          const dy = (y - (row % ny)) * sy;
          const dz = (z - Math.floor(row / ny)) * sz;
          sdf[i] = side * (Math.sqrt(dx * dx + dy * dy + dz * dz) + side * sdf[q]);
        }
      }
    }
  }
  return sdf;
}
