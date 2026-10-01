# Step 0b — geometry kernels (`src/core/kernel/geom`)

Branch `s0b/geom`, made from the Step 0a commit. Scope: `src/core/kernel/geom/**` only (`DESIGN.md` §5.1, §6.2
item 5): the indexed marching cubes, Taubin smoothing, the Felzenszwalb–Huttenlocher distance transforms and the
manifold-3d loader, plus the mesh measures and the `SdfVolume` helpers that those four need. Shared by T3
(photos → 3D) and T5 (mesh tools); nothing here depends on the DOM, React or any other track.

All numbers below were measured on this machine (Apple M3 Pro, Node 22.23.3, single thread), the machine the
design budgets were measured on.

## What was delivered

| File | Contents |
|---|---|
| `marchingCubes.ts` | `marchingCubes` (any numeric field, positive inside → indexed mesh), `marchingCubesSdf` (a stored `SdfVolume` → mesh in inches) |
| `taubin.ts` | `taubinSmooth` (λ\|μ pairs, in place), `vertexAdjacency` (unique edge neighbors, compressed rows) |
| `edt.ts` | generalized squared transforms `edtSquared1d/2d/3d` (seeded, optional nearest-seed output), mask transforms `edt1d/2d/3d`, signed mask transforms `signedEdt1d/2d/3d`, `extendSignedDistance3d` (narrow band → whole grid) |
| `manifold.ts` | `getManifold` (the §5.4 loader), `manifoldReport` (status / parts / genus / volume of a mesh) |
| `meshMeasures.ts` | signed volume, area, edge census, Euler characteristic, components, pinched vertices, degenerate triangles, bounds |
| `sdfVolume.ts` | the layout and placement of `SdfVolume`, `encodeSdfVolume`, `decodeSdfVolume`, `sampleSdfVolume` |
| `__tests__/` | 8 test files, 122 tests; `fields.ts` holds the analytic test solids (sphere, nine-ellipsoid teddy, torus, two spheres) |

The last two files are not named in §5.1 (see "Deviations").

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
  only. `cleanVolume` (§2.9.5 item 1) should therefore flood the outside 6-connected.
- **Non-finite values:** marching cubes reads +Infinity as deep inside, −Infinity and NaN as outside. The squared
  transforms read +Infinity and NaN as "no seed" and reject −Infinity. `encodeSdfVolume` and
  `extendSignedDistance3d` reject NaN.
- **Units:** every function takes the sample spacing (`voxel`, `spacing`) and returns world units; nothing assumes
  inches except `SdfVolume`.

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
interface EdtOptions<S = number> { spacing?: S }                            // default 1
interface EdtSquaredOptions<S = number> extends EdtOptions<S> { nearest?: Int32Array }
interface SignedEdtOptions extends EdtOptions<number> { measureTo?: 'boundary' | 'samples' }   // default 'boundary'

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
  receives the index of a winning seed per sample (−1 where there is none).
- `edt*` — distance (not squared) from every sample to the nearest non-zero mask sample; +Infinity everywhere for
  an empty mask, 0 everywhere for a full one. For the distance to the nearest ZERO sample, pass the inverted mask.
- `signedEdt*` — positive inside (inside = non-zero). `'boundary'` (default): ±(distance to the nearest sample of
  the other kind − spacing/2), so the zero level lies on the faces between inside and outside cells.
  `'samples'`: the textbook `dIn − dOut`. All inside → +Infinity everywhere; empty → −Infinity; only the samples
  of the grid exist (the image frame is not a boundary).
- `extendSignedDistance3d` — in place, §2.9.8 step 3: finite entries are exact and kept; +Infinity / −Infinity mark
  unknown inside / outside samples, which get `±(‖p − q‖ + |sdf[q]|)` for the known sample q of their own side
  that wins the seeded squared transform.

### `manifold.ts`

```ts
const getManifold: GetManifoldFn;            // () => Promise<ManifoldToplevel>
interface ManifoldReport { status: string; parts: number; genus: number; volume: number }
function manifoldReport(mesh: MeshLike): Promise<ManifoldReport>;
```

- `getManifold` — one initialization per thread, `setup()` already called; every call returns the same promise.
- `manifoldReport` — builds a Manifold from an indexed mesh and reports `status` (`'NoError'`, `'NotManifold'`,
  `'NonFiniteVertex'`, `'VertexOutOfBounds'`, …; a rejected mesh is a status, not an exception), `parts`
  (`decompose().length`), `genus` of the largest part by |volume|, and the signed `volume`. Frees every WASM object.

### `meshMeasures.ts`

```ts
interface MeshLike { positions: ArrayLike<number>; indices: ArrayLike<number> }   // ColoredMesh and IndexedMesh fit
interface EdgeStats { edges: number; boundaryEdges: number; nonManifoldEdges: number; misorientedEdges: number }
function signedVolume(mesh: MeshLike): number;                      // > 0 for outward winding
function surfaceArea(mesh: MeshLike): number;
function countZeroAreaTriangles(mesh: MeshLike, maxArea?: number): number;   // area ≤ maxArea (default 0)
function minTriangleArea(mesh: MeshLike): number;
function edgeStats(indices: ArrayLike<number>): EdgeStats;
function isWatertight(indices: ArrayLike<number>): boolean;         // no boundary, non-manifold or misoriented edge
function countUsedVertices(indices: ArrayLike<number>): number;
function eulerCharacteristic(indices: ArrayLike<number>): number;   // V_used − E + F
function countComponents(indices: ArrayLike<number>): number;
function countNonManifoldVertices(indices: ArrayLike<number>): number;   // vertices with more than one fan
function meshBounds(positions: ArrayLike<number>): { min: Vec3; max: Vec3 };
```

### `sdfVolume.ts`

```ts
const SDF_UNITS_PER_VOXEL = 256;
function encodeSdfVolume(field: ArrayLike<number>, dims: readonly [number, number, number], origin: Readonly<Vec3>, voxel: number): SdfVolume;
function decodeSdfVolume(volume: SdfVolume): Float32Array<ArrayBuffer>;   // inches
function sampleSdfVolume(volume: SdfVolume, p: Readonly<Vec3>): number;   // inches, trilinear
```

- `encodeSdfVolume` — quantizes a field in inches; saturates; a negative value never becomes 0, so the stored
  volume has exactly the inside/outside samples of the field.
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

| Item | Result |
|---|---|
| MC, sphere r = 0.8 in [−1.1, 1.1]³, N = 64 | pass — 9 936 vertices, 19 868 triangles; 0 boundary, 0 non-manifold, 0 misoriented edges; χ = 2; 0 zero-area triangles (smallest 8.66e-5 voxel²); volume 0.99891 × analytic |
| MC, sphere, N = 128 | pass — 40 248 / 80 492; same counts of defects (0); χ = 2; volume 0.99974 × analytic (within 1%) |
| MC, union of nine ellipsoids, N = 64 and 128 | pass — 6 646 / 13 288 and 27 278 / 54 552; watertight, χ = 2, one piece; the two volumes differ by 0.31%; N = 128 is within 0.04% of the inside-voxel count |
| MC, torus R 0.6 r 0.25, N = 64 / 128 | pass — χ = 0, watertight, volume 0.99619 / 0.99906 × analytic |
| MC, two separate spheres, N = 64 | pass — χ = 4, 2 pieces, watertight, volume 0.99328 × analytic |
| MC at the grid border | pass — documented above; a sphere r = 1.3 cut by all six faces: closed mode watertight, χ = 2, volume 0.99988 × the analytic clipped sphere; open mode χ = −4 with every boundary vertex on the box |
| Taubin, 10 pairs | pass — sphere volume +0.023% (N = 128), +0.087% (N = 64); teddy +0.085%; index buffer untouched. Noise of ±0.3 voxel on the N = 128 sphere: RMS radial error 0.1735 → 0.0581 voxel, RMS umbrella length 0.484 → 0.047 voxel (3 pairs: 0.0781 and 0.104). Twenty plain Laplacian steps lose 3.0% of the N = 64 sphere |
| EDT vs brute force | pass — 1D/2D/3D, seeded random grids: integer costs bit-exact in Float64 and Float32; real costs and per-axis spacing within 1e-12; `nearest` always names a winning seed; masks bit-exact; both signed forms bit-exact against their definitions; empty / full masks as documented |
| `getManifold` in node | pass — unit cube: `NoError`, genus 0, 1 part; second call returns the same promise and module |
| MC sphere → manifold-3d | pass — `NoError`, 1 part, genus 0 at N = 64 and 128, before and after Taubin; torus genus 1; two spheres 2 parts |
| Timing, MC, N = 128 | 21 ms (sphere, 40 k vertices), 16 ms (teddy, 27 k vertices); budget 91 ms. N = 192: 68 ms / 55 ms |
| Timing, Taubin × 10 | 14 ms (sphere), 9.7 ms (teddy); budget 33 ms for 21 k vertices. 3 pairs: 6 ms / 4 ms |
| Timing, 3D EDT, N = 128 | 52 ms unsigned, 109 ms signed (sphere mask). 2D signed, 512²: 7.6 ms (research: 21 ms). `extendSignedDistance3d`, N = 96: 65 ms |
| Determinism | pass — byte-identical positions and indices on repeated runs; node and a Chromium worker give the same counts and volume |

The timing tests assert 300 ms (MC), 150 ms (Taubin), 500 ms / 1 s (3D EDT, unsigned / signed) and 150 ms (2D),
best of a few runs, retried twice.

## Verification beyond the unit tests

- **Marching cubes is manifold for every input.** A mesh edge lies in one cell or on the face between two cells,
  and a vertex is surrounded by the four cells around its lattice edge. All 3 × 2¹⁸ = 786 432 inside/outside
  patterns of the four cells around a lattice edge (three orientations) were meshed with the closed border: 0
  boundary edges, 0 non-manifold edges, 0 misoriented edges, 0 pinched vertices, 0 zero-area triangles, volume
  always positive, no unused vertex. With the open border: the same, except for the boundary edges on the box.
  (21 s for both runs; the unit suite runs the two-cell version, 3 × 4096 patterns, and a seeded sample of the
  four-cell one.) 300 random-noise meshes were all accepted by manifold-3d.
- **Against a textbook implementation.** A per-cell, unindexed marching cubes written in the test file from the
  three.js tables gives exactly the same triangles (as position triples) on smooth and random fields.
- **The kernels together, on T3's first acceptance item.** Three 512² disc masks → `signedEdt2d` in world units
  → an N×N table per view → `min` over N³ → marching cubes: the hull of the r = 0.8 sphere has 1.1184 × the sphere's
  volume at N = 128 (theory 1.1188; T3 must reach 1.119 ± 0.01), watertight, χ = 2; 1.1186 after Taubin. With
  `measureTo: 'samples'` it is 1.1186.
- **In a real worker.** A temporary page (not committed) ran `getManifold`, marching cubes, Taubin and
  `manifoldReport` inside a module worker in headless Chromium, under `npm run dev` and from a production build
  served by `vite preview`, on port 5268 with a temp projects folder: unit cube `NoError` / genus 0 / 1 part, the
  N = 128 sphere `NoError` / genus 0, one navigation, no console errors. In the worker: MC 18 ms, Taubin 14 ms,
  3D EDT 50 ms. The worker bundle was 67 kB plus the 541 kB wasm: only the tables of three.js are bundled.

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
4. **§2.9.8 step 3, far field.** `extendSignedDistance3d` returns `‖p − q‖ + |d(q)|` for the winning band sample q,
   not the square root of the seeded squared transform. With a band of ±2 voxels the square-root form is up to
   1.95 voxels too small (1.4–1.7 on average; sphere, box, torus, capsule at N = 96), which would fail T5's own
   acceptance ("within 1 voxel" of a brute-force SDF). The additive form is never too small and at most 0.60
   voxel too large (0.03–0.09 on average). The plain seeded transform is still exported for whoever wants it.
5. **`manifoldReport`** is not in the spec. Both T3 (§2.9.5 step 5) and T5 (`merge` returns `genus`) need the same
   dozen lines around `new Manifold(mesh)`, including the `delete()` calls that are easy to forget in a
   long-lived worker.

## Ambiguities resolved

| Where | Reading |
|---|---|
| `SdfVolume.origin` (§5.2) — a cell corner or a sample? | The position of sample (0, 0, 0); samples are points. Same rule as the marching cubes `origin`. |
| §2.9.3 "exact signed EDT … inside positive" — measured to what? | Default `measureTo: 'boundary'`: the pixel-center distance minus half a pixel, so that the zero level lies between the inside and the outside pixel. Exact for straight axis-aligned outlines; on a disc the error against the true distance is within ±0.5 px with no bias at the outline (measured +0.04 px), while the textbook `dIn − dOut` (`'samples'`) is 0…1 px too large (+0.54 px at the outline) and jumps from −1 to +1 across it. `d = max(sd, 0)` is the "inside EDT" of §2.9.3 and §2.9.4. |
| §2.9.5 item 2 "replace exact zeros by 1e-6" — zeros of what? | Of `field − iso`, in field units; the field itself is not modified. The sample counts as inside. |
| Border of the grid (§2.9.5 does not say) | Closed by default, as above. |
| NaN and ±Infinity in a field | Marching cubes: +Infinity deep inside, −Infinity and NaN outside. |
| Image frame in the 2D signed transform | Not a boundary: only the pixels of the mask exist. §2.9.1 already rejects masks that touch the frame. |
| Taubin on an open mesh | Boundary vertices are smoothed like the others (not pinned). Every mesh of the pipeline is closed. |
| `ManifoldReport.genus` for several parts | The genus of the largest part by \|volume\| (§2.9.5 step 5 keeps the largest part). |

## Requests for integration

1. **§5.2 `SdfVolume`:** add to the comment that sample (x, y, z) is the point `origin + voxel·(x, y, z)`, x
   fastest, and that the values saturate at ±127.996 voxels.
2. **§5.4:** replace `Module(isNode ? {} : { locateFile: () => wasmUrl })` by `Module(isNode ? undefined : …)`
   (the printed form is a type error), and mention the retry after a failed initialization.
3. **§2.9.8 step 3:** say that the far field is `‖p − q‖ + |d(q)|` for the band sample q found by the seeded
   transform (`extendSignedDistance3d`), not the square root of that transform; and that the band is the set of
   voxels whose computed distance is ≤ 2 voxels (a voxel inside a large triangle's grown bbox can hold a distance
   that is not the distance to the nearest triangle).
4. **§2.9.3:** name the signed-EDT convention (`measureTo: 'boundary'`).
5. **§2.9.5 item 1:** say that the outside flood of `cleanVolume` is 6-connected, to match the mesher.
6. **§5.1:** list `core/kernel/geom/{meshMeasures,sdfVolume}.ts` as S0 files.
7. **`src/types/__checks__/entryPoints.check.ts`** (0c): add
   `Check<SameSignature<typeof import('../../core/kernel/geom/manifold').getManifold, E.GetManifoldFn>>`.
8. **§2.9.8 budget line / §5.8:** the measured kernel times above can replace the research estimates if wanted
   (MC 21 ms, Taubin 14 ms at N = 128 on 40 k vertices).

## Not done, not verified

- Sub-block re-meshing for sculpting (research 04 §2 mentions a dirty sub-block): not in the spec, and not
  needed for the 10 Hz of §2.9.8 — a whole N = 96 volume re-meshes (marching cubes + 3 Taubin pairs) in 9 ms
  (teddy, 15 k vertices) to 13 ms (sphere, 22 k vertices).
- Safari / JavaScriptCore timings: not measured (Node 22 and headless Chromium only).
- The 3 × 2¹⁸ enumeration is not part of the unit suite (15 s).
