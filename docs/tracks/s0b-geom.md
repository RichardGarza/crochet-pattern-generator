# Step 0b — geometry kernels (`src/core/kernel/geom`)

Branch `s0b/geom`, made from the Step 0a commit. Scope: `src/core/kernel/geom/**` only (`DESIGN.md` §5.1, §6.2
item 5): the indexed marching cubes, Taubin smoothing, the Felzenszwalb–Huttenlocher distance transforms and the
manifold-3d loader, plus the mesh measures and the `SdfVolume` helpers that those four need. Shared by T3
(photos → 3D) and T5 (mesh tools); nothing here depends on the DOM, React or any other track.

All numbers below were measured on this machine (Apple M3 Pro, 12 cores, Node 22.23.3, single thread) — the same
kind of machine as the design budgets (research 04 §11).

## What was delivered

| File | Contents |
|---|---|
| `marchingCubes.ts` | `marchingCubes` (any numeric field, positive inside → indexed mesh), `marchingCubesSdf` (a stored `SdfVolume` → mesh in inches) |
| `taubin.ts` | `taubinSmooth` (λ\|μ pairs, in place), `vertexAdjacency` (unique edge neighbors, compressed rows) |
| `edt.ts` | generalized squared transforms `edtSquared1d/2d/3d` (seeded, optional nearest-seed output), mask transforms `edt1d/2d/3d`, signed mask transforms `signedEdt1d/2d/3d`, `extendSignedDistance3d` (narrow band → whole grid) |
| `manifold.ts` | `getManifold` (the §5.4 loader), `manifoldFromMesh` (a mesh → a manifold-3d solid or its error status), `manifoldReport` (status / parts / genus / volume) |
| `meshMeasures.ts` | signed volume, area, edge census, Euler characteristic, components, pinched vertices, degenerate triangles, bounds |
| `sdfVolume.ts` | the layout and placement of `SdfVolume`, `encodeSdfVolume`, `decodeSdfVolume`, `sampleSdfVolume` |
| `__tests__/` | 22 test files: 8 written with the kernels, 13 kept from the independent review (see "Review"), and `fields.test.ts` (the test helpers); `fields.ts` holds the analytic test solids (sphere, nine-ellipsoid teddy, torus, two spheres), the `HEAVY` test options and the `firstByteDifference` helper |

`meshMeasures.ts` and `sdfVolume.ts` are not named in §5.1 (see "Deviations").

Two switches for the test suite: `GEOM_VERBOSE=1 npm test -- src/core/kernel/geom` prints the measurements the
reference tests take; `GEOM_FULL=1` also runs the three exhaustive enumerations (all 3 × 2¹⁸ four-cell patterns,
closed, open, and through manifold-3d; 42 s, 9 s and 49 s), which are skipped otherwise. Timeouts, skipped tests
and timing tests: see "The test suite".

## Conventions every caller relies on

- **Positive inside** (D11). A sample exactly on the level counts as inside.
- **Layout:** `field[x + nx·(y + ny·z)]`, x fastest. 2D: `i = x + width·y` (row-major, like masks and `RgbaImage`).
- **A sample is a point:** sample (x, y, z) sits at `origin + voxel·(x, y, z)`. `origin` is the position of sample
  (0, 0, 0), not the corner of a cell; the lattice spans `origin … origin + voxel·(dims − 1)`. This holds for the
  marching cubes options and for `SdfVolume` (whose frozen type does not say).
- **`SdfVolume.data`:** Int16, `value / 256` voxels = `value·voxel / 256` inches, saturating at ±127.996 voxels.
- **Winding:** counter-clockwise seen from outside, right-handed axes; `signedVolume` > 0. manifold-3d accepts an
  inside-out mesh as `NoError`, so "volume > 0" stays a separate check (§2.9.5 step 5).
- **Connectivity of the mesher:** inside samples that are diagonal neighbors on a cell face (voxels sharing an
  edge) are joined; inside samples on a body diagonal are not; outside samples are connected through lattice edges
  only. The number of pieces of a mesh is (18-connected inside components) + (6-connected outside components) − 1.
  `cleanVolume` (§2.9.5 item 1) should therefore flood the outside 6-connected.
- **Non-finite values:** marching cubes reads +Infinity as deep inside, −Infinity and NaN as outside. The squared
  transforms read +Infinity and NaN as "no seed" and reject −Infinity. `encodeSdfVolume` and
  `extendSignedDistance3d` reject NaN.
- **Units:** every function takes the sample spacing (`voxel`, `spacing`) and returns world units; nothing assumes
  inches except `SdfVolume`.
- **Malformed input throws `RangeError`** (wrong buffer length, dimensions, spacing, an index that is not a vertex)
  before anything is written.

## Public API

Signatures are exact. "In place" means the first argument is modified and returned.

### `marchingCubes.ts`

```ts
const MC_T_MIN = 0.01, MC_T_MAX = 0.99;      // clamp of t = (iso − f0)/(f1 − f0)
const MC_ZERO_REPLACEMENT = 1e-6;            // what an exact zero of f − iso becomes (inside)
type GridDims = readonly [number, number, number];
interface IndexedMesh { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> }
interface MarchingCubesOptions {
  iso?: number;                              // level, in field units; default 0
  origin?: Readonly<Vec3>;                   // world position of sample (0,0,0); default [0,0,0]
  voxel?: number | Readonly<Vec3>;           // sample spacing, one number or per axis; default 1
  border?: 'closed' | 'open';                // default 'closed'
}
function marchingCubes(field: ArrayLike<number>, dims: GridDims, options?: MarchingCubesOptions): IndexedMesh;
function marchingCubesSdf(volume: SdfVolume, options?: Pick<MarchingCubesOptions, 'iso' | 'border'>): IndexedMesh;
```

- `marchingCubes` — meshes the level set of a sampled field (Float32Array, Float64Array, Int16Array, number[] …;
  never modified). One vertex per crossed lattice edge, `t` clamped to [0.01, 0.99], exact zeros replaced by 1e-6,
  two z-slices in memory at a time. Exact-length ArrayBuffer-backed buffers; byte-identical on repeated runs.
- `marchingCubesSdf` — the same for a stored part volume; positions in the volume's frame (inches); `iso` is a
  signed distance in inches (positive = surface moved inward).
- **Border.** `'closed'` (default): the field is treated as surrounded by one more layer of far-outside samples,
  so the solid is cut flat at the lattice box and the mesh is always closed; the cap lies 0.01 voxel beyond the
  outermost samples. Callers need to do nothing. `'open'`: only real cells are meshed; where the inside reaches
  the lattice box the mesh has a hole (boundary edges on the box). A caller that wants a closed mesh in `'open'`
  mode must make every border sample outside. Both modes give the same buffers when no border sample is inside.
- **Guarantee (closed border):** for every input the result is an oriented 2-manifold — each edge in exactly two
  triangles that agree on the outside, one fan per vertex, no zero-area triangle, every vertex used, positive
  volume. See "Verification".
- **Float32 limit.** A lattice whose largest |coordinate| / voxel reaches 131 072 is refused (`RangeError`):
  float32 positions could no longer hold the 0.01-voxel clamp.

### `taubin.ts`

```ts
const TAUBIN_PAIRS = 10, TAUBIN_LAMBDA = 0.6307, TAUBIN_MU = -0.6732;
interface TaubinOptions { pairs?: number; lambda?: number; mu?: number }
interface VertexAdjacency { offsets: Uint32Array<ArrayBuffer>; neighbors: Uint32Array<ArrayBuffer> }
function taubinSmooth<P extends Float32Array | Float64Array>(positions: P, indices: ArrayLike<number>, options?: TaubinOptions): P;
function vertexAdjacency(indices: ArrayLike<number>, vertexCount: number): VertexAdjacency;
```

- `taubinSmooth` — in place; `pairs` λ|μ pairs of the uniform umbrella Laplacian over unique edge neighbors,
  simultaneous updates, double precision inside. Never writes the index buffer. Sculpting passes `{ pairs: 3 }`
  during a stroke (§2.9.8).
- `vertexAdjacency` — the neighbors of vertex v are `neighbors[offsets[v] … offsets[v + 1])`, each once, ascending;
  valid for open, non-manifold and duplicated triangles.

### `edt.ts`

```ts
type EdtArray = Float32Array | Float64Array;
type Spacing2 = number | readonly [number, number];
type Spacing3 = number | readonly [number, number, number];
interface EdtOptions<S = number> { spacing?: S }                            // default 1; 1e-100 … 1e100
interface EdtSquaredOptions<S = number> extends EdtOptions<S> { nearest?: Int32Array }
interface SignedEdtOptions extends EdtOptions<number> { measureTo?: 'samples' | 'boundary' }   // default 'samples'

function edtSquared1d<T extends EdtArray>(values: T, options?: EdtSquaredOptions<number>): T;
function edtSquared2d<T extends EdtArray>(values: T, width: number, height: number, options?: EdtSquaredOptions<Spacing2>): T;
function edtSquared3d<T extends EdtArray>(values: T, dims: readonly [number, number, number], options?: EdtSquaredOptions<Spacing3>): T;

function edt1d(mask: ArrayLike<number>, options?: EdtOptions<number>): Float32Array<ArrayBuffer>;
function edt2d(mask: ArrayLike<number>, width: number, height: number, options?: EdtOptions<Spacing2>): Float32Array<ArrayBuffer>;
function edt3d(mask: ArrayLike<number>, dims: readonly [number, number, number], options?: EdtOptions<Spacing3>): Float32Array<ArrayBuffer>;

function signedEdt1d(mask: ArrayLike<number>, options?: SignedEdtOptions): Float32Array<ArrayBuffer>;
function signedEdt2d(mask: ArrayLike<number>, width: number, height: number, options?: SignedEdtOptions): Float32Array<ArrayBuffer>;
function signedEdt3d(mask: ArrayLike<number>, dims: readonly [number, number, number], options?: SignedEdtOptions): Float32Array<ArrayBuffer>;

function extendSignedDistance3d<T extends EdtArray>(sdf: T, dims: readonly [number, number, number], options?: EdtOptions<Spacing3>): T;
```

- `edtSquared*` — the seeded form, in place: `values[p] ← min over q of ‖(p − q)·spacing‖² + values[q]`. Entries are
  squared-distance costs: 0 = plain seed, +Infinity (or NaN) = no seed, any finite number otherwise. `nearest`
  receives the index of a winning seed per sample — the lowest index on an exact tie — or −1 where there is none.
- `edt*` — distance (not squared) from every sample to the nearest non-zero mask sample; +Infinity everywhere for
  an empty mask, 0 everywhere for a full one. For the distance to the nearest ZERO sample, pass the inverted mask.
- `signedEdt*` — positive inside (inside = non-zero). `'samples'` (default) is the exact signed transform of
  §2.9.3: +(distance to the nearest outside sample), −(distance to the nearest inside sample); `Math.max(sd, 0)` is
  the "inside EDT". `'boundary'` is the same moved half a spacing toward 0, so that the zero level lies on the
  faces between inside and outside cells (see "Ambiguities"). All inside → +Infinity everywhere; empty → −Infinity;
  only the samples of the grid exist (the image frame is not a boundary).
- `extendSignedDistance3d` — in place, §2.9.8 step 3: finite entries are exact and kept; +Infinity / −Infinity mark
  unknown inside / outside samples. Each gets, with its sign, the smaller of two upper bounds on its distance to
  the surface: the distance to the nearest crossing (the zero between two neighboring known samples on different
  sides), and `‖p − q‖ + |sdf[q]|` for the known sample q that wins the seeded squared transform.

### `manifold.ts`

```ts
const getManifold: GetManifoldFn;            // () => Promise<ManifoldToplevel>
type ManifoldFromMesh = { status: 'NoError'; solid: Manifold } | { status: Exclude<ErrorStatus, 'NoError'>; solid?: undefined };
interface ManifoldReport { status: ErrorStatus; parts: number; genus: number; volume: number }
function manifoldFromMesh(mesh: MeshLike): Promise<ManifoldFromMesh>;
function manifoldReport(mesh: MeshLike): Promise<ManifoldReport>;
```

- `getManifold` — one initialization per thread, `setup()` already called; every call returns the same promise. A
  failed initialization is not kept: the next call starts again.
- `manifoldFromMesh` — builds a manifold-3d solid from an indexed mesh; the caller owns `solid` and must
  `delete()` it. A mesh that manifold-3d rejects is a status (`'NotManifold'`, `'NonFiniteVertex'`,
  `'VertexOutOfBounds'`, …), not an exception, and leaves nothing in the WASM heap. **Use this instead of
  `new Manifold(mesh)`**: manifold-3d 3.5.4's own constructor wrapper throws on a bad status without freeing the
  object it has just built (about half a kilobyte per rejected mesh, never returned).
- `manifoldReport` — `status`, `parts` (`decompose().length`), `genus` of the largest part by |volume|, and the
  signed `volume`; frees every WASM object.

### `meshMeasures.ts`

```ts
interface MeshLike { positions: ArrayLike<number>; indices: ArrayLike<number> }   // ColoredMesh and IndexedMesh fit
interface EdgeStats { edges: number; degenerateTriangles: number; boundaryEdges: number; nonManifoldEdges: number; misorientedEdges: number }
function signedVolume(mesh: MeshLike): number;                      // > 0 for outward winding
function surfaceArea(mesh: MeshLike): number;
function countZeroAreaTriangles(mesh: MeshLike, maxArea?: number): number;   // area ≤ maxArea (default 0)
function minTriangleArea(mesh: MeshLike): number;
function edgeStats(indices: ArrayLike<number>): EdgeStats;
function isWatertight(indices: ArrayLike<number>): boolean;         // no boundary, non-manifold or misoriented edge, no degenerate triangle
function countUsedVertices(indices: ArrayLike<number>): number;
function eulerCharacteristic(indices: ArrayLike<number>): number;   // V − E + F of the surface
function countComponents(indices: ArrayLike<number>): number;
function countNonManifoldVertices(indices: ArrayLike<number>): number;   // vertices with more than one fan
function meshBounds(positions: ArrayLike<number>): { min: Vec3; max: Vec3 };
```

A triangle that names a vertex twice is counted in `degenerateTriangles` and otherwise ignored by `edgeStats`,
`eulerCharacteristic`, `countComponents` and `countNonManifoldVertices`. The index-only measures allocate by the
largest index in the buffer.

### `sdfVolume.ts`

```ts
const SDF_UNITS_PER_VOXEL = 256;
function encodeSdfVolume(field: ArrayLike<number>, dims: readonly [number, number, number], origin: Readonly<Vec3>, voxel: number): SdfVolume;
function decodeSdfVolume(volume: SdfVolume): Float32Array<ArrayBuffer>;   // inches
function sampleSdfVolume(volume: SdfVolume, p: Readonly<Vec3>): number;   // inches, trilinear
```

- `encodeSdfVolume` — quantizes a field in inches (halves away from zero); saturates; a negative value never
  becomes 0, so the stored volume has exactly the inside/outside samples of the field.
- `sampleSdfVolume` — `p` in the volume's frame; outside the lattice box: the value at the nearest box point minus
  the distance to it (the lowest value a distance field could have there). `(p) => sampleSdfVolume(v, p)` is the
  `mesh` function that `partSdf` and `inferAttach` take.

## How the callers use it

```ts
// T3 §2.9.3 — per-view signed distance in world units; d = max(sd, 0) is the "inside EDT" of the inflation
const sd = signedEdt2d(mask, maskW, maskH, { spacing: worldPerPixel });

// T3 §2.9.5 — volume (Float32Array, N³, positive inside) → mesh → validate
const mesh = marchingCubes(f, [N, N, N], { origin: boxMin, voxel });
taubinSmooth(mesh.positions, mesh.indices);                    // 10 pairs
const report = await manifoldReport(mesh);                     // want status 'NoError', genus 0, volume > 0
const built = await manifoldFromMesh(mesh);                    // or the solid itself, to decompose and keep the largest part
if (built.status === 'NoError') { /* built.solid.decompose() … */ built.solid.delete(); }

// T3 §2.9.7 — 3D opening for the limb split: two plain transforms (pass the inverted mask for "distance to outside")
const toOutside = edt3d(outsideMask, [N, N, N], { spacing: voxel });

// T3 §2.9.7 step 3 / T5 — store a part volume, mesh it again, sample it anywhere
const stored = encodeSdfVolume(partField, dims, origin, voxel);
const again = marchingCubesSdf(stored);
const meshSdf = (p: Vec3) => sampleSdfVolume(stored, p);       // for partSdf / inferAttach

// T5 §2.9.8 — voxelizer step 3: band values exact, the rest +Infinity (inside) or −Infinity (outside) from the parity scan
extendSignedDistance3d(sdf, dims, { spacing: voxel });

// T5 §2.9.8 — during a sculpt stroke; cut and merge mesh f_a = min(f, −plane), f = max(f_a, f_b, …) the same way
const live = marchingCubes(field, dims, { origin, voxel });
taubinSmooth(live.positions, live.indices, { pairs: 3 });
```

A `ColoredMesh` is the result plus labels: `{ ...mesh, labels: new Uint8Array(mesh.positions.length / 3).fill(255) }`.

## Acceptance, with measured numbers

Session 3 (see "Sessions") measured every row again with its own harness (a temporary test file, not committed)
and with the tests' `GEOM_VERBOSE=1` output: every count, ratio and defect number in this table came out
identical. Session 3 also measured N = 128 for the two spheres: χ = 4, 2 pieces, watertight, volume 0.99835 ×
analytic. The timing rows give both sessions: session 1 on a quiet machine, session 3 with other agents' test
suites running (load average 6.6–7.8 on 12 cores).

| Item | Result |
|---|---|
| MC, sphere r = 0.8 in [−1.1, 1.1]³, N = 64 | pass — 9 936 vertices, 19 868 triangles; 0 boundary, 0 non-manifold, 0 misoriented edges; χ = 2; 0 zero-area triangles (smallest 8.66e-5 voxel²); volume 0.99891 × analytic |
| MC, sphere, N = 128 | pass — 40 248 / 80 492; same counts of defects (0); χ = 2; volume 0.99974 × analytic (within 1%) |
| MC, union of nine ellipsoids, N = 64 and 128 | pass — 6 646 / 13 288 and 27 278 / 54 552; watertight, χ = 2, one piece; volume 0.99591 and 0.99896 × the integrated volume (0.70355) |
| MC, torus R 0.6 r 0.25, N = 64 / 128 | pass — χ = 0, watertight, volume 0.99619 / 0.99906 × analytic |
| MC, two separate spheres, N = 64 | pass — χ = 4, 2 pieces, watertight, volume 0.99328 × analytic |
| MC at the grid border | pass — documented above; a sphere r = 1.3 cut by all six faces: closed mode watertight, χ = 2, volume 0.99988 × the analytic clipped sphere; open mode χ = −4 with every boundary vertex on the box |
| Taubin, 10 pairs | pass — sphere volume +0.023% (N = 128), +0.087% (N = 64); teddy +0.085%; index buffer untouched. Noise of ±0.3 voxel on the N = 128 sphere: RMS radial error 0.1735 → 0.0581 voxel, RMS umbrella length 0.484 → 0.047 voxel (3 pairs: 0.0781 and 0.104). Twenty plain Laplacian steps lose 3.0% of the N = 64 sphere |
| EDT vs brute force | pass — 1D/2D/3D, seeded random grids: integer costs bit-exact in Float64 and Float32; real costs and per-axis spacing within 1e-12; `nearest` always names a winning seed; masks bit-exact; both signed forms bit-exact against their definitions; the narrow-band extension equals its definition; empty / full masks as documented. Session 3's own harness, 300 seeded grids (1D 1–40, 2D up to 12², 3D up to 7³): masks 0 mismatches, signed (both conventions) 0 of 600, seeded integer costs 0, seeded real costs with per-axis spacing 2.7e-15 relative, per-axis-spacing masks 5.9e-8 (the float32 result); empty mask +Infinity, full mask 0, signed all-inside +Infinity / empty −Infinity, no seed +Infinity |
| `getManifold` in node | pass — unit cube: `NoError`, genus 0, 1 part; second call returns the same promise and module |
| MC sphere → manifold-3d | pass — `NoError`, 1 part, genus 0 at N = 64 and 128, before and after Taubin; torus genus 1; two spheres 2 parts |
| Timing, MC, N = 128 | Session 1: 22 ms (sphere, 40 k vertices), 17 ms (teddy, 27 k vertices); budget 91 ms. N = 192: 68 ms / 55 ms; N = 256 (teddy): 140 ms. Worst case, noise at N = 128 (6.8 M triangles): 247 ms. Session 3 (best / median of 15): sphere 24.8 / 25.2 ms, teddy 18.8 / 18.9 ms |
| Timing, Taubin × 10 | Session 1: 14 ms (sphere), 9.7 ms (teddy); budget 33 ms for 21 k vertices. 3 pairs: 6 ms / 4 ms. Session 3 (best / median of 15): sphere 19.0 / 19.2 ms, teddy 13.0 / 13.2 ms; 3 pairs 8.2 ms (sphere) |
| Timing, 3D EDT, N = 128 | Session 1: 51 ms unsigned, 110 ms signed (sphere mask). 2D signed, 512²: 7.0 ms (research: 21 ms). `extendSignedDistance3d`, N = 96: 90 ms. Session 3 (best / median of 7): 54.2 / 54.9 ms unsigned, 114.6 / 115.7 ms signed; `manifoldReport` of the N = 128 sphere (80 k triangles): 57 ms |
| Determinism | pass — byte-identical positions and indices on repeated runs and across three processes; node and a Chromium worker give the same counts and volume (session 1). Session 3: the FNV-1a 64 hashes of positions, indices and the Taubin result (sphere, teddy, torus at N = 128) and of `edt3d` / `signedEdt3d` (N = 128 sphere mask) were the same twice in one process and in two separate processes |

The timing tests assert 300 ms (MC), 150 ms (Taubin), 500 ms / 1 s (3D EDT, unsigned / signed) and 150 ms (2D),
best of a few runs, retried twice.

## Verification beyond the unit tests

Sessions 1 and 2 ran most of these with scratch scripts that were not committed. What the suite holds was re-run
in session 3 (marked **[s3]**, with session 3's numbers where they differ); the rest is carried over unchanged
and was not re-run (marked **[s1–2]**).

- **Marching cubes is manifold for every input.** A mesh edge lies in one cell or on the face between two cells,
  and a vertex is surrounded by the four cells around its lattice edge. All 3 × 2¹⁸ = 786 432 inside/outside
  patterns of the four cells around a lattice edge (three orientations) were meshed with the closed border: 0
  boundary edges, 0 non-manifold edges, 0 misoriented edges, 0 pinched vertices, 0 zero-area triangles, volume
  always positive, no unused vertex. With the open border: the same, except for the boundary edges on the box.
  **[s3]** These two runs are the `GEOM_FULL` tests of `marchingCubes.topology.test.ts`: passed again, 42 s and
  9 s; smallest triangle of the closed run 8.6602e-5 voxel² = √3/2 · 0.01² (the corner cut of the clamp). The
  default suite runs the two-cell version, all 3 × 4096 patterns, and a seeded sample of the four-cell one.
  **[s1–2]** A third run gave every sample a hostile magnitude (exact 0, ±1e-12, ±1e-6, ±1, ±1e12, ±Infinity):
  still 0 defects, no NaN, and the smallest triangle of all 786 432 meshes is the corner cut of the clamp,
  √3/2 · 0.01² voxel². A further 2.2 million random 3³ … 6×5×4 lattices: 0 defects. (The suite's 700 random
  hostile fields of `marchingCubes.topology.test.ts` cover the same rules on a smaller scale.)
- **manifold-3d accepts all of it.** Every one of those four-cell patterns, with ±1 values and with the hostile
  magnitudes (1 572 858 meshes), and 5 959 random meshes up to 10³ (3.8 M triangles) went through
  `new Manifold(mesh)`: none rejected; `decompose()` always agreed with `countComponents` and its volume with
  `signedVolume`. **[s3]** The ±1 run is the `GEOM_FULL` test of `manifold.meshes.test.ts` (786 429 non-empty
  meshes, parts and volume checked against an independent count): passed again, 49 s. **[s1–2]** the hostile
  magnitudes and the 5 959 random meshes.
- **[s3] Against a textbook implementation.** A per-cell, unindexed marching cubes written in the test file from the
  three.js tables gives exactly the same triangles (as position triples) on smooth and random fields; so does the
  review's own reference mesher (vertices in a Map keyed by lattice edge) on 600 hostile fields.
- **[s3] The mesh separates inside from outside.** The winding number of the mesh is 1 at every inside lattice
  point and 0 at every outside one, on random hostile fields; no triangle passes through another on 800 random
  fields (the suite holds 300 of them).
- **[s3] The kernels together, on T3's first acceptance item.** Three 512² disc masks → `signedEdt2d` in world units
  → an N×N table per view → `min` over N³ → marching cubes: the hull of the r = 0.8 sphere has 1.1186 × the sphere's
  volume at N = 128 (theory 1.1188; the exact distance field of the disc gives 1.1185 on the same lattice; T3 must
  reach 1.119 ± 0.01), watertight, χ = 2. With `measureTo: 'boundary'` it is 1.1184.
- **[s1–2] A rehearsal of T5's merge.** Two spheres stored as cropped `SdfVolume`s with different origins and voxel
  sizes (0.0625 and 0.05 in), sampled with `sampleSdfVolume` onto one 65 × 96 × 65 grid (40 ms), `max`, marching
  cubes, Taubin: one watertight piece, χ = 2, volume 0.99938 × the analytic union (G24 asks for 2%).
- **[s1–2] Larger brute-force runs of the transforms** than the unit suite holds: 120 3D grids up to 18³ and 40 2D
  masks up to 96 × 80 (225 000 samples), and every binary mask of the 4×4, 5×3, 16×1, 1×16, 3×3×2 and 2×2×4
  grids (557 056 masks): mask, signed (both conventions) and seeded transforms and `nearest` all agree with
  brute force; per-axis spacing to 6e-8 relative (the float32 result).
- **[s3] No WASM leak in `manifoldReport`.** 30 000 accepted and 30 000 rejected meshes do not grow the WASM memory
  (a unit test hooks `WebAssembly.Memory.prototype.grow`).
- **[s1–2] In a real worker.** A temporary page (not committed) ran `getManifold`, marching cubes, Taubin and
  `manifoldReport` inside a module worker in headless Chromium, under `npm run dev` and from a production build
  served by `vite preview`, on port 5268 with a temp projects folder: unit cube `NoError` / genus 0 / 1 part, the
  N = 128 sphere `NoError` / genus 0, one navigation, no console errors. In the worker: MC 18 ms, Taubin 14 ms,
  3D EDT 50 ms. The worker bundle was 67 kB plus the 541 kB wasm: only the tables of three.js are bundled. (Run
  with the first version of `manifold.ts`; the loader's `locateFile` path has not changed since.)

## The test suite

`npm test -- src/core/kernel/geom`: 22 files, 247 tests, of which 244 run and 3 are skipped on purpose; about
6–7 s wall on this machine (36 s of test time spread over the workers).

- **Timeouts.** Vitest's default is 5 s per test, and it fails a synchronous test that finishes after its timeout
  (the timer cannot fire while the test runs, so the runner compares the elapsed time when it returns). Many
  tests here do 0.1–5 s of work (brute-force references, exhaustive pattern runs, N = 96 … 128 volumes) while
  other agents' suites load the same machine: a cold first run of the whole suite failed five of them on the
  default (the `edt.largeGrids` determinism test, the real/extreme costs of `edt.reference`, the four-cell samples
  of `manifold.meshes` and `marchingCubes.topology`, the nine ellipsoids of `marchingCubes.acceptance`), each of
  which passes alone. Session 3 gave every `describe` block with a test over about 100 ms on a quiet run (27
  blocks, plus the loader block of `manifold.test.ts`, whose first test instantiates the WASM module: 28 blocks
  in 17 files) and the hub timing test of `taubin.reference.test.ts` the options `HEAVY` from `fields.ts`:
  `{ timeout: 120_000 }`. Vitest passes a suite's options on to its tests and nested suites, and a test's own
  timeout wins (the `GEOM_FULL` runs keep their 10 and 30 minutes); `fields.test.ts` checks all three. A long
  timeout costs nothing: it only matters to a test that is late. With two full suites running at once (load
  average 14) both passed; the slowest test took 12.9 s (`edt.extend`, N = 96), three geom tests took more than
  5 s (the old default), nine more than 3 s and seventeen more than 2 s.
- **Less matcher work.** `expect(a).toEqual(b)` walks a typed array element by element through the matcher:
  140 ms for 142 560 elements (a byte loop: 0.1 ms). Three heavy tests compared large buffers that way; they now
  use `firstByteDifference(a, b)` from `fields.ts` (−1 = the same bytes, else the first byte that differs; the
  same check, tested in `fields.test.ts`): the `edt.largeGrids` determinism test went from 2.0–2.7 s to 0.16 s,
  decode → encode of every Int16 value (`sdfVolume.reference`) from 0.9 s to 0.01 s, the Taubin sphere test from
  1.0 s to 0.34 s. Nothing else about the tests changed.
- **Timing tests** follow §6.1 rule 5 (generous bounds, retried twice): `perf.test.ts` (best of 2–3 runs; MC
  < 300 ms, Taubin < 150 ms, 3D EDT < 500 ms and signed < 1 s, 2D signed 512² < 150 ms) and the 200 000-neighbor
  hub of `taubin.reference.test.ts` (< 1 s; measured 20–62 ms; its `retry: 2` was added in session 3).
- **The three skipped tests are skipped on purpose**, by `it.runIf(process.env.GEOM_FULL === '1')`: the
  exhaustive runs over all 3 × 2¹⁸ inside/outside patterns of the four cells around a lattice edge — closed
  border and open border (`marchingCubes.topology.test.ts`) and through manifold-3d (`manifold.meshes.test.ts`).
  They take 42 s, 9 s and 49 s (session 3, under load), too long for a suite that every agent runs after every
  change; the default suite covers the same rules with all 3 × 4096 two-cell patterns (a mesh edge lies in one
  cell or on the face between two) and seeded samples of the four-cell patterns (3 × 4000 per border, 3 × 3000
  through manifold-3d, another 3 × 3000 in `marchingCubes.test.ts`).
  `GEOM_FULL=1 npm test -- src/core/kernel/geom` runs them; in session 3 all three passed: 786 432 closed meshes
  with 0 defects, 786 432 open meshes with 0 non-manifold defects and every boundary edge on the box, 786 429
  non-empty meshes accepted by manifold-3d with the right number of parts and volume.
- **The reviewers' files.** No `zz-review*` file is left: session 2 kept all 13 under proper names. Session 3 read
  each of them again — every one tests a documented rule of the kernels against an independent reference or an
  analytic value (the leak test of `manifold.meshes` checks manifold-3d itself, the reason `manifoldFromMesh`
  exists) — and kept them all.

## Review

Two independent reviewers attacked the first version (commit `7a2daa1`) with their own reference
implementations: one took marching cubes, Taubin, the measures and the manifold loader, the other the distance
transforms and the stored volume. A session limit cut both off before they reported; their test files and the
measurements those print were recovered, read, and — where they test real requirements — kept in the suite under
proper names (`*.reference.test.ts`, `marchingCubes.{topology,embedding,acceptance}.test.ts`,
`manifold.meshes.test.ts`, `manifoldSetupRetry.test.ts`, `edt.{signed,extend,largeGrids}.test.ts`). A third
reviewer then went over the result (below).

What the first review found, and what was done:

| Finding | Fix |
|---|---|
| `minTriangleArea` forgot a NaN triangle unless it came last, and then did not even return the minimum | NaN is returned as soon as one triangle has a NaN corner |
| `getManifold`: a failure inside `setup()` was cached forever (`.then(ok, reset)` does not see what `ok` throws) | any failed initialization clears the cache |
| `manifoldReport` lost about half a kilobyte of WASM heap per rejected mesh (16.8 MB → 217 MB over 300 000 rejections): manifold-3d's constructor wrapper throws without deleting | `manifoldFromMesh` uses the constructor underneath the wrapper, reads the status and deletes; a test fails if manifold-3d ever stops leaking, so the detour can go |
| `manifoldReport` validated another mesh than it was given when an index was 2.9 or NaN (`Uint32Array.from` coerces) | such an index is `'VertexOutOfBounds'` |
| Marching cubes: from \|coordinate\| / voxel = 2¹⁸ on, float32 rounded the 0.01-voxel clamp away (140 zero-area triangles in a 6³ test lattice), silently; an origin of 1e39 gave ±Infinity positions | such lattices are refused with a `RangeError` (from 2¹⁷ on) |
| Measures: the triangle (0, 0, 1) passed for a closed surface, (5, 5, 5) counted as a pinched vertex | a triangle that names a vertex twice is counted (`degenerateTriangles`) and otherwise ignored; `isWatertight` is false |
| `signedVolume` lost digits far from the origin (2.6e-6 relative at 1e4, useless at 1e6) | summed around the mesh's own first vertex |
| `edtSquared*`: a spacing of 1e160 gave NaN, 1e-170 wrong values (its square overflows / underflows) | spacings outside 1e-100 … 1e100 are refused |
| `edtSquared*`: a −Infinity cost threw after the first rows had been rewritten | validated before anything is written |
| `extendSignedDistance3d`: the documented "at most 0.60 voxel too large" did not hold — 0.84 on a rotated box, 0.89 on a plane tilted by 0.01; level sets 6 voxels beyond the band were off by up to 0.46 voxel (0.10 rms) | new method (crossings, plus the bound through a known sample); see "Deviations" 4 for the numbers |
| `extendSignedDistance3d`: a known value beyond 1.8e19 overflowed the float32 work array and produced NaN; only seeds of the own side were used, so a sample next to a known −0.3 got 9.4 | costs are capped; a known sample of either side bounds every unknown one (that sample now gets 1.3) |
| `encodeSdfVolume` stored a NaN origin; negative halves rounded toward zero (−1.5 → −1) while positive ones rounded away | origin validated; halves round away from zero on both sides |
| Signed transform: the default (`'boundary'` then) made an inflated disc 3.2% too small at a radius of 26 px (the spec's form: 1.9% too large), with no gain for the hull (1.1184 vs 1.1186) | the default is the spec's exact form, `'samples'`; `'boundary'` stays as an option; see "Ambiguities" |

What it confirmed with independent means: the triangles against its own reference mesher (600 hostile fields),
closed = open on the padded field, one vertex per crossed edge, the clamp and zero rules, the connectivity rule
(pieces = 18-connected inside components + 6-connected outside components − 1), winding numbers, no
self-intersection, two slices in memory (a 4 × 4 × 500 000 lattice), Taubin against a brute-force Jacobi
iteration, `vertexAdjacency` with a 200 000-neighbor hub (62 ms), all measures against Map- and Set-based
references on 600 random soups, the seeded transform with ties (lowest index wins), extreme costs and spacings,
array views, the signed definitions, `sampleSdfVolume` against a naive trilinear implementation (3e-15 voxel),
cropping a volume, and the acceptance list (with the teddy's volume integrated independently).

Information it produced for later tracks:

- Taubin, 10 pairs, by feature size (volume change): sphere of radius 16 voxels +0.2%, 8: +0.6%, 5: +1.5%,
  3: +2.4%, 2: −4.7%, 1.2: −46%; a rod of radius 1.5 voxels +1.4%; a disc 2 voxels thick +0.3%. The 2% of T3's
  acceptance holds from a radius of about 4 voxels.
- manifold-3d splits a pinched vertex: two tetrahedra that share one vertex are 2 parts. (Marching cubes never
  makes one.) A cavity is a part with negative volume.
- `manifoldReport` on the N = 128 sphere (80 k triangles): 62 ms; `edgeStats` 12 ms.

## Deviations from the spec, with reasons

1. **Two files beyond §5.1's list** (`{marchingCubes,taubin,edt,manifold}.ts`): `meshMeasures.ts` (asked for by the
   Step 0b brief) and `sdfVolume.ts`. Marching cubes has to accept an `SdfVolume`, so the placement of its
   samples had to be fixed somewhere; three tracks (T3, T5, T7) then need the same encode / decode / sample code.
2. **§5.4 loader, two changes.** (a) `Module(isNode ? undefined : { locateFile })` instead of `Module(isNode ? {} :
   …)`: the snippet as printed does not compile — manifold-3d types the argument as `{ locateFile: () => string }`
   (TS2345) — and Emscripten's `Module(moduleArg = {})` treats `undefined` as `{}`. (b) A failed initialization
   clears the cached promise, so the next call tries again instead of returning the same rejection forever.
3. **§2.9.5 item 2, "tables … (`edgeTable`, `triTable`)":** only `triTable` is imported. Crossed edges are found
   from the samples while the slices are scanned; a test proves `edgeTable` says the same.
4. **§2.9.8 step 3, far field.** Not "the EDT seeded from the band, separately inside and outside" read
   literally (the square root of the transform seeded with d², per side): that is up to 1.96 voxels too small
   with a band of ±2 voxels (1.4–1.7 on average), which would fail T5's own acceptance ("within 1 voxel" of a
   brute-force SDF). `extendSignedDistance3d` takes the smaller of two upper bounds — the distance to the nearest
   sub-voxel crossing between two known samples, and `‖p − q‖ + |d(q)|` for the known sample q that wins the
   seeded transform, of either side. Measured at N = 96, band ±2: −0.01 … +0.14 voxel on smooth solids (0.01 on
   average), within 0.11 voxel on planes at any tilt (0.103 at the steepest, N = 64), up to 0.58 voxel next to
   sharp edges (boxes, a thin plate; 0.04–0.06 on average; 0.68 on one rotated box in a session-2 scratch run).
   Marching cubes at ±6 voxels on the completed field of a sphere is within 0.06 voxel of the true level set
   (0.02 rms). (Session 3's `GEOM_VERBOSE=1` run of `edt.extend.test.ts` printed these numbers again.) The plain
   seeded transform is exported for whoever wants it.
5. **`manifoldFromMesh` and `manifoldReport`** are not in the spec. Both T3 (§2.9.5 step 5) and T5 (`merge`
   returns `genus`) need the same lines around `new Manifold(mesh)` — and those lines leak when written the
   obvious way (see "Review").
6. **Marching cubes refuses a lattice that float32 positions cannot resolve** (|coordinate| / voxel ≥ 2¹⁷). The
   spec does not mention it; without it the "no zero-area triangle" rule of §2.9.5 item 2 fails silently there.
   The app's lattices are below 10⁴.

## Ambiguities resolved

| Where | Reading |
|---|---|
| `SdfVolume.origin` (§5.2) — a cell corner or a sample? | The position of sample (0, 0, 0); samples are points. Same rule as the marching cubes `origin`. |
| §2.9.3 "exact signed EDT … inside positive" — measured to what? | To the nearest sample of the other kind (`measureTo: 'samples'`, the default): the textbook `dIn − dOut`, which is what "exact EDT" names and what makes `max(sd, 0)` the "inside EDT" of the inflation formula. Its values step from −1 to +1 pixel across the outline. `'boundary'` subtracts half a pixel so that the field is 0 on the pixel faces and has slope 1 there. Neither is the true distance to a smooth outline: `'samples'` is 0…1 px too large (0.54 px on average next to the outline, 0.13–0.27 px deeper than 5 px), `'boundary'` errs by ±0.5 px (0.04 next to the outline, −0.24…−0.37 deeper). In the spec's callers: the three-view hull gives 1.1186 / 1.1184 (both within 0.0002 of what the exact field gives); marching cubes on the transform's own grid gives the identical mesh; hull vertices from 512² masks at N = 128 are 0.056 / 0.042 voxel rms from the true surface; an inflated disc of radius 10 / 26 / 60 / 120 px has 1.050 / 1.019 / 1.008 / 1.003 × the hemisphere's volume with `'samples'` and 0.935 / 0.968 / 0.985 / 0.991 with `'boundary'`; an inflated strip is 5% / 9% too large (width 20 / 21 px) with `'samples'` and 3% too small / exact with `'boundary'`. |
| §2.9.5 item 2 "replace exact zeros by 1e-6" — zeros of what? | Of `field − iso`, in field units; the field itself is not modified. The sample counts as inside. |
| Border of the grid (§2.9.5 does not say) | Closed by default, as above. |
| NaN and ±Infinity in a field | Marching cubes: +Infinity deep inside, −Infinity and NaN outside. |
| Image frame in the 2D signed transform | Not a boundary: only the pixels of the mask exist. §2.9.1 already rejects masks that touch the frame. |
| Taubin on an open mesh | Boundary vertices are smoothed like the others (not pinned). Every mesh of the pipeline is closed. |
| `ManifoldReport.genus` for several parts | The genus of the largest part by \|volume\| (§2.9.5 step 5 keeps the largest part). |
| A triangle with a repeated vertex index | Not part of the surface: counted, otherwise ignored by the measures; `isWatertight` is false. |

## Requests for integration

1. **§5.2 `SdfVolume`:** add to the comment that sample (x, y, z) is the point `origin + voxel·(x, y, z)`, x
   fastest, and that the values saturate at ±127.996 voxels.
2. **§5.4:** replace `Module(isNode ? {} : { locateFile: () => wasmUrl })` by `Module(isNode ? undefined : …)`
   (the printed form is a type error), mention the retry after a failed initialization, and tell T3 and T5 to
   build solids with `manifoldFromMesh`, never with `new Manifold(mesh)` inside a `try` (manifold-3d 3.5.4 leaks
   the rejected object).
3. **§2.9.8 step 3:** name `extendSignedDistance3d` and what it computes; say that the band is the set of voxels
   whose computed distance is ≤ 2 voxels (a voxel inside a large triangle's grown bbox can hold a distance that
   is not the distance to the nearest triangle), and that every sign change must have both of its samples in the
   band (any band of ±1 voxel or more does).
4. **§2.9.3:** name the convention (`signedEdt2d`, default `measureTo: 'samples'`). T3 can ask for `'boundary'`
   in the hull tables (hull vertices 0.042 instead of 0.056 voxel rms from the true surface) and should keep
   `'samples'` for the inflation. The "hemisphere for a disc (±2%)" of §6.3 holds from a radius of about 25 px
   with `'samples'` (45 px with `'boundary'`): T3's test disc should be larger than that.
5. **§2.9.5 item 1:** say that the outside flood of `cleanVolume` is 6-connected, to match the mesher (whose
   inside is 18-connected).
6. **§2.9.5 item 3 / §6.3 T3:** "Taubin keeps volume within 2%" holds for features of radius ≥ 4 voxels (see
   "Review"); thinner ones are the "crochet flat" case of item 5.
7. **§5.1:** list `core/kernel/geom/{meshMeasures,sdfVolume}.ts` as S0 files.
8. **`src/types/__checks__/entryPoints.check.ts`** (0c): add
   `Check<SameSignature<typeof import('../../core/kernel/geom/manifold').getManifold, E.GetManifoldFn>>`.
9. **§2.9.8 budget line / §5.8:** the measured kernel times above can replace the research estimates if wanted
   (MC 22 ms, Taubin 14 ms at N = 128 on 40 k vertices on a quiet machine; 25 ms and 19 ms under load).
10. **§6.1 rule 5 / the vitest block of `vite.config.ts` (0c):** vitest fails a synchronous test that finishes
    after its timeout, and the default is 5 s; on this shared machine a cold full run took five of this kernel's
    tests past it, and with two full suites running at once three of its tests took longer than 5 s.
    This kernel gives its heavy blocks an explicit 120 s (`HEAVY`, "The test suite"); every track with heavy
    tests needs the same. A project-wide `testTimeout` (e.g. 30 s) in the vitest config would make the default
    safe for all tracks, if integration wants that; nothing here depends on it.

## Not done, not verified

- Sub-block re-meshing for sculpting (research 04 §2 mentions a dirty sub-block): not in the spec, and not
  needed for the 10 Hz of §2.9.8 — a whole N = 96 volume re-meshes (marching cubes + 3 Taubin pairs) in 9 ms
  (teddy, 15 k vertices) to 13 ms (sphere, 22 k vertices).
- Safari / JavaScriptCore timings: not measured (Node 22 and headless Chromium only).
- The browser (worker) check ran in session 1 only, before the review fixes; it was not repeated (see
  "Verification").
- The scratch verifications of sessions 1–2 marked [s1–2] in "Verification" were not re-run in session 3 (their
  scripts were not committed): the hostile-magnitude enumeration, the 2.2 million random lattices, the random
  meshes through manifold-3d, the larger brute-force runs of the transforms, the T5 merge rehearsal.
- The three exhaustive enumerations stay out of the default suite on purpose (`GEOM_FULL=1`, "The test suite");
  session 3 ran them and they passed.

## Sessions

1. `7a2daa1` — the kernels, their tests and these notes.
2. `c1722c2` — the fixes from two independent reviews (see "Review"), the new far field of
   `extendSignedDistance3d`, the reviewers' tests kept under proper names.
3. Session 3 (the commit after `c1722c2`; the earlier work was interrupted twice by usage limits before its
   final report) —
   the test suite made reliable under load ("The test suite": explicit timeouts, three cheaper byte comparisons,
   `fields.test.ts`, `retry: 2` on the hub timing test); the acceptance list measured again with an independent
   harness; the `GEOM_FULL` runs; these notes completed. No kernel changed behavior; one doc comment of
   `extendSignedDistance3d` was corrected (planes: within 0.11 voxel, not 0.1).

The two commits of sessions 1 and 2 end with the trailer `Co-Authored-By: Claude Fable 5.1
<noreply@anthropic.com>` instead of the `Claude Opus 5.5` line that the Step 0b rules ask for. They were left
as they are: rewriting them would change the hashes that other agents refer to.
