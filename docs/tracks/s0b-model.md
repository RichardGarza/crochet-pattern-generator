# Step 0b — the 3D model kernels (`core/model`, `fixtures/models`)

Branch `s0b/model`, made from the Step 0a commit `ca1a96f`. Scope: `src/core/model/**` except `revisions.ts` (the
state kernel's), and `fixtures/models/**`. Spec: `DESIGN.md` §0.1, §2.9.7, §2.10.1, §2.13 (G23), §3.3, §3.4.1, §3.5,
§3.6, §3.7.3, §3.7.5, §3.7.6, §4.2, §5.2.1, §5.8; research `05` §3–4 and `08`.

Status: **done** — every scope item and every acceptance item of the brief is implemented and tested (numbers
below). `npm run typecheck`, `npm run lint` and `npm test` pass (twice in a row at the last commit).

## What was delivered

| File | What it is |
|---|---|
| `schema.ts` | The zod mirror of §3.5.1: a discriminated union on `type`, strict objects everywhere, `x-*` keys kept on the model and on parts, the limits and semantics of §3.5.2, readable errors, the canonical writer of model files, a compile-time guard against drift from `src/types/model.ts` |
| `limits.ts` | `MODEL_LIMITS` (§3.5.2), apart from zod so the geometry kernels can use it |
| `builder.ts` | `buildModel` = `builder-v1` (§3.4.1) in TypeScript, plus the builder geometry the other kernels need (tessellation, flat-part layout, uv64 paint grid) |
| `transforms.ts` | Euler XYZ ↔ matrix, rigid and 4×4 compose / decompose, part frames, bounding boxes and centers from the builder geometry, grounding, rounding |
| `sdf.ts` | Analytic signed distance functions (positive inside), `overlapVolume`, `surfaceGap`, part volumes |
| `attach.ts` | `inferAttach` (one attach tree, D21), `inferMirrorPairs`, attach-graph helpers |
| `naming.ts` | `nameParts` (§2.9.7 step 6) |
| `place.ts` | `placeChildOnSurface` (§3.3 step 3, Add part) and the re-anchoring of §4.2 |
| `proportions.ts` | `LIMB_TEMPLATE`, `readProportions`, `applyProportions` (§4.2, G23) |
| `scale.ts` | `scaleModel` (about the ground center) |
| `dims.ts` | Internal: the dims the geometry kernels read from a part that has not been validated |
| `fixtures/models/teddy.canonical.json` | The observed Claude Design teddy, normalized, grounded, rounded, one attach tree, mirror pairs (G12 target for T7) |
| `fixtures/models/every-type.json` | A valid, grounded, one-tree model: one part of every type (two tori — a ring and an arc — and all six flat shapes), every region kind, every feature kind, every value of `attach.method`, `attach.openEnd`, `stuffing`, `crochet.make` / `start` / `axis` / `style`, `crochet.seed` and `seamAzimuthDeg`, a uv64 paint field, `x-*` keys on the model and on parts |
| `fixtures/models/every-type.mesh.json` | The buffer of that model's mesh part: `{ "<meshRef>": { positions, indices, labels } }` as plain arrays (a closed UV ellipsoid whose box is exactly `bboxIn`) |

Tests: 12 files in `src/core/model/__tests__/` (288 tests), with helpers in `__tests__/helpers/`:
`teddy.ts` (the generator of the canonical teddy), `everyType.ts` (the generator of the other two fixtures),
`geometry.ts` (brute-force mesh geometry independent of the kernels — point–triangle distance, ray parity, mesh
volume — and `readSpecExample()`, which reads the §3.6 example out of `DESIGN.md` itself), `options.ts` (`HEAVY`:
the generous timeout of the suites that do real geometry work). `claudeDesign.test.ts` checks the kernels against
the real Claude Design exports (GLB node matrices, OBJ vertices) and `buildModel` against the §3.4.1 code block
evaluated from `DESIGN.md`.

Both fixtures are generated: `fixtures.test.ts` regenerates them and compares the bytes. After an intended change:
`UPDATE_FIXTURES=1 npm test -- src/core/model/__tests__/fixtures.test.ts`, then review the diff.

## Public API

All lengths are inches; `Vec3 = [x, y, z]`; "part-local" = the part's own frame; "model space" = world. Nothing
mutates its arguments; every kernel is deterministic (no `Math.random`, no `Date`). Functions typed with a frozen
`…Fn` type of `src/types/entryPoints.ts` have exactly the §5.2.1 signature. `Mat3` is `core/kernel/vec`'s row-major
9-tuple. `FlatDims` below means `Extract<Part, { type: 'flat' }>['dims']`. There is no barrel: import from the file.

### `schema.ts`

| Export | Signature | What it does |
|---|---|---|
| `crochetModelSchema` | `z.ZodType<CrochetModelV1, unknown>` | The whole model, strictly. `parse(x)` deep-equals `x` for a valid model; `x-*` keys on the model and on parts are kept; any other unknown key, a broken reference, a duplicate id, an attach cycle, a forbidden key, too deep or too large is an error |
| `validateModel` | `(input: unknown) => { ok: true; model: CrochetModelV1 } \| { ok: false; issues: ModelIssue[] }` | Validates without throwing |
| `parseModel` | `(input: unknown) => CrochetModelV1` | Validates; throws `ModelValidationError` |
| `ModelIssue` | `interface { path: string; message: string }` | `path` reads `parts[3] (arm_l).dims.length` (empty for the document itself) |
| `ModelValidationError` | `class extends Error { readonly issues: ModelIssue[]; constructor(issues: ModelIssue[]) }` | `name` `'ModelValidationError'`; message `invalid crochet-model:` + one `- path: message` line per issue |
| `withExtensions` | `<S extends z.ZodType>(schema: S) => ZodType` whose output is `z.output<S> & { [k: \`x-${string}\`]: unknown }` | Lifts `x-*` keys off a plain object, parses the rest with `schema`, puts them back (§3.5.1). A transform, so `z.toJSONSchema` cannot represent it |
| `partSchema` | zod schema, output `Part` | One part, `x-*` keys kept |
| `partCoreSchema` | zod discriminated union on `type` | One part without extension keys: strict objects only |
| `crochetModelCoreSchema` | zod strict object | The model without extension keys and without the document checks (references, uniqueness, depth, size): what `z.toJSONSchema` can represent — parts come out as `oneOf` branches with a `type` const and `additionalProperties: false` (T7's `gen-schema.ts`) |
| `regionSchema` | zod discriminated union on `kind` | One region (strict) |
| `featureSchema` | zod strict object | One feature |
| `paletteColorSchema` | zod strict object | One palette color |
| `MODEL_LIMITS` | const (re-exported from `limits.ts`) | `{ maxParts: 60, maxPalette: 16, maxRegionsPerPart: 24, maxFeatures: 60, minProfilePoints: 3, maxProfilePoints: 64, minPolygonPoints: 3, maxPolygonPoints: 64, minDimIn: 0.05, maxDimIn: 48, maxHeightIn: 60, maxTextChars: 2000, maxBytes: 2097152, maxDepth: 12 }` |
| `PART_ID_PATTERN` | `RegExp` | `/^[a-z][a-z0-9_]{0,31}$/` (part ids, feature ids, `attach.to`, `mirrorOf`, `feature.on`) |
| `COLOR_ID_PATTERN` | `RegExp` | `/^[a-z0-9_]{1,16}$/` |
| `HEX_PATTERN` | `RegExp` | `/^#[0-9a-fA-F]{6}$/` |
| `VERSION_PATTERN` | `RegExp` | `/^1\.\d+$/` |
| `isExtensionKey` | `(key: string) => key is \`x-${string}\`` | True for `x-…` |
| `canonicalizeModel` | `(model: CrochetModelV1) => CrochetModelV1` | A copy with keys in the canonical order (below), `undefined` properties dropped; values unchanged |
| `stringifyModel` | `(model: CrochetModelV1) => string` | The canonical text: canonical key order, 2-space indent, arrays of plain values on one line, final newline. The byte format of `fixtures/models/*.json` |
| `SchemaMatchesTypes` | type | Compile-time guard: `npm run typecheck` fails when the schema and `src/types/model.ts` drift apart (types, enums, required and optional keys of every object, per part type and per region kind) |

Canonical key order — model: `schema, version, revision, units, axes, name, description, category, style,
audience, finishedSize, pose, flatBase, yarn, palette, parts, features, assembly, assumptions, source`; part: `id,
label, type, dims, position, rotationDeg, color, regions, attach, mirrorOf, stuffing, flatten, notes, crochet,
paint`; any other key next in code-unit order; `x-*` keys last.

### `limits.ts`

| Export | Signature | What it does |
|---|---|---|
| `MODEL_LIMITS` | `as const` object | The limits of §3.5.2 (values above) |

### `builder.ts`

| Export | Signature | What it does |
|---|---|---|
| `buildModel` | `(spec: CrochetModelV1, unitScale = 0.0254, meshes?: Record<string, ColoredMesh>) => THREE.Group` | `builder-v1`: a `Group` named `spec.name \|\| 'model'` with one `Mesh` per part in parts order (`mesh.name` = part id, `mesh.userData.crochet` = the part, `material.name` = color id or `<color>_painted`, `group.userData.crochetModel` = the spec). **The app passes `unitScale = 1`** (inches); the default is the stage's meters, as in §3.4.1. `meshes` (keyed by `meshRef`) supplies the buffers of mesh parts |
| `partGeometry` | `(part: Part, unitScale = 1, meshes?: Record<string, ColoredMesh>) => THREE.BufferGeometry` | `geometryFor` of §3.4.1: the part in its local frame (a lathe not re-centered). Throws `unknown part type …` like the normative code |
| `tessellatePart` | `(p: Part, meshes?: Record<string, ColoredMesh>) => PartTessellation` | The builder geometry at `unitScale = 1` as ArrayBuffer-backed copies (an unindexed geometry gets the trivial index); an unknown type gives empty buffers |
| `PartTessellation` | `interface { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> }` | Part-local inches |
| `vertexColorIds` | `(g: BufferGeometry, p: Part, unitScale = 1, o?: { paletteIds?: readonly string[]; mesh?: ColoredMesh }) => string[] \| null` | `paint()` of §3.4.1 returning the palette id of every vertex of `g`: base color → regions in order (band, stripes, patch, spot; `pattern` is the app's) → the paint field (a primitive's uv64, a mesh part's vertex labels; both need `paletteIds`). `null` for a part with no regions and no paint |
| `uv64Cell` | `(azimuthDeg: number, t: number) => number` | The cell of the 64 × 64 paint grid: `row · 64 + column`, `row = ⌊t·64⌋` (0 = bottom), `column = ⌊(az/360 + 0.5)·64⌋` (0 = the back seam, 32 = the front), both clamped to 0…63 |
| `decodeUv64` | `(data: string) => Uint8Array<ArrayBuffer> \| null` | `paint.data` → 4096 palette indices (255 = none); `null` unless base64 of exactly 4096 bytes |
| `encodeUv64` | `(cells: Uint8Array) => string` | 4096 palette indices → `paint.data`; throws `RangeError` for another length |
| `flatLayout` | `(dims: FlatDims) => FlatLayout` | A flat part as the builder places it; cached by dims (64 entries) |
| `FlatLayout` | `interface { outline: Float64Array<ArrayBuffer>; half: [number, number, number]; vertices: Float32Array<ArrayBuffer> }` | `outline`: the closed front-face polygon `[x0, y0, x1, y1, …]` (first point not repeated), shifted like the builder's `.center()`; `half`: half extents of the geometry's box, bevel included; `vertices`: every vertex of the geometry, part-local, without duplicates |
| `flatBevelSize` | `(d: FlatDims) => number` | `min(0.3·thickness, 0.1·min(w, h))`: how far the builder's bevel grows the outline at mid-thickness |
| `BUILDER_VERSION` | `'builder-v1'` | |
| `UNIT_SCALE_INCHES`, `UNIT_SCALE_METERS` | `1`, `0.0254` | Scene units per inch |
| `UV64_SIZE`, `UV64_NONE` | `64`, `255` | Paint grid side; "no paint here" |

### `transforms.ts`

| Export | Signature | What it does |
|---|---|---|
| `eulerXYZToMat3` | `(rotationDeg: Vec3 \| undefined) => Mat3` | Rx·Ry·Rz, three.js `'XYZ'`; identity for `undefined` |
| `mat3ToEulerXYZ` | `(m: Mat3) => Vec3` | Degrees, three.js's algorithm: y ∈ [−90°, 90°]; at gimbal lock z = 0; never −0 |
| `Rigid` | `interface { rotation: Mat3; position: Vec3 }` | `p ↦ rotation·p + position` |
| `composeRigid` | `(position: Vec3, rotationDeg?: Vec3) => Rigid` | T·R |
| `decomposeRigid` | `(t: Rigid) => { position: Vec3; rotationDeg: Vec3 }` | |
| `multiplyRigid` | `(a: Rigid, b: Rigid) => Rigid` | a·b (b first). `World(child) = multiplyRigid(World(parent), composeRigid(pos, rot))` (§3.7.3) |
| `invertRigid` | `(t: Rigid) => Rigid` | |
| `applyRigid` | `(t: Rigid, p: Vec3) => Vec3` | |
| `Mat4` | `number[]` | 16 numbers, column-major (three.js `Matrix4.elements`, glTF `node.matrix`) |
| `composeMat4` | `(position: Vec3, rotationDeg?: Vec3, scale: Vec3 = [1, 1, 1]) => Mat4` | T·R·S as `Matrix4.compose` |
| `decomposeMat4` | `(m: readonly number[]) => { position: Vec3; rotationDeg: Vec3; scale: Vec3 }` | As `Matrix4.decompose` (no shear): a mirroring matrix gets a negative x scale; a zero scale does not give NaN |
| `multiplyMat4` | `(a: readonly number[], b: readonly number[]) => Mat4` | a·b |
| `rigidFromMat4` | `(m: readonly number[]) => Rigid` | The rigid part (scale dropped) |
| `partTransform` | `(part: Pick<Part, 'position' \| 'rotationDeg'>) => Rigid` | A part's local → world transform |
| `localToWorld` | `(part: Pick<Part, 'position' \| 'rotationDeg'>, pLocal: Vec3) => Vec3` | |
| `worldToLocal` | `(part: Pick<Part, 'position' \| 'rotationDeg'>, pWorld: Vec3) => Vec3` | |
| `partAxis` | `(part: Pick<Part, 'rotationDeg'>, axis: 0 \| 1 \| 2 = 1) => Vec3` | World direction of a local axis (1 = Y, the axis of round primitives) |
| `Bounds` | `interface { min: Vec3; max: Vec3 }` | Axis-aligned box |
| `boundsSize`, `boundsCenter` | `(b: Bounds) => Vec3` | |
| `unionBounds` | `(a: Bounds, b: Bounds) => Bounds` | |
| `localBounds` | `(part: Part, mesh?: ColoredMesh) => Bounds` | The exact box of the builder solid in the part's frame: centered on the origin except a lathe (y spans `[y_min, y_max]` of its profile) and a torus arc; a mesh part uses `mesh`'s vertices, else ±`bboxIn`/2 |
| `localCenter` | `(part: Part, mesh?: ColoredMesh) => Vec3` | `c_local` of §0.1: the local box center (zero except a lathe, a torus arc, a mesh with its vertices) |
| `partCenter` | `(part: Part, mesh?: ColoredMesh) => Vec3` | `position + R·c_local` (§0.1) |
| `positionForCenter` | `(part: Part, center: Vec3, mesh?: ColoredMesh) => Vec3` | The `position` that puts the part's center at `center` (§3.3: `position = center − R·c_local`) |
| `worldBounds` | `(part: Part, mesh?: ColoredMesh) => Bounds` | The TIGHT world box of the rotated solid (support functions, not the box around a rotated box) |
| `modelBounds` | `(model: Pick<CrochetModelV1, 'parts'>, meshes?: Record<string, ColoredMesh>) => Bounds` | Union of the parts' world boxes (`meshes` by `meshRef`); `{0,0,0}…{0,0,0}` for no parts |
| `modelHeight` | `(model: Pick<CrochetModelV1, 'parts'>, meshes?: Record<string, ColoredMesh>) => number` | The finished height (§4.2): the box height |
| `groundCenter` | `(model: Pick<CrochetModelV1, 'parts'>, meshes?: Record<string, ColoredMesh>) => Vec3` | `(0, lowest y, 0)` |
| `groundModel` | `<M extends Pick<CrochetModelV1, 'parts'>>(model: M, meshes?: Record<string, ColoredMesh>) => { model: M; dy: number }` | Translates every part so the lowest point is at y = 0; `dy` was added to every y (0 and the same model when already grounded or not finite). Not rounded |
| `translatePart` | `<P extends Part>(part: P, d: Vec3) => P` | A copy moved by `d` |
| `roundCoord` | `(x: number, decimals = 6) => number` | Half away from zero (so `roundCoord(−x) = −roundCoord(x)`), never −0; non-finite values pass through |
| `roundVec3` | `(v: Vec3, decimals = 6) => Vec3` | |
| `roundModel` | `<M extends CrochetModelV1>(model: M, decimals = 6) => M` | Rounds positions, rotations, every dims number (profiles and polygon points; not `sharp`), `crochet.seed`, `widthIn` / `radiusIn` / `scaleIn`, feature `sizeIn` / `sizeMm` and `finishedSize`; fractions and angles of regions and features are left alone |
| `roundPart` | `<P extends Part>(part: P, decimals = 6) => P` | `roundModel` for one part |
| `COORD_DECIMALS` | `6` | |

### `sdf.ts`

| Export | Signature | What it does |
|---|---|---|
| `partSdf` | `PartSdfFn` = `(part: Part, mesh?: (p: Vec3) => number) => (pWorld: Vec3) => number` | Signed distance in model space, **positive inside**. `mesh` = the part-local SDF of a mesh part (ignored for primitives) |
| `worldSdf` | `(part: Part, mesh?: MeshSdf) => WorldSdf` | The same on plain numbers, without allocating: for loops |
| `localSdf` | `(given: Part, mesh?: MeshSdf) => LocalSdf` | In the part's own frame; `() => −Infinity` for an unknown type |
| `LocalSdf`, `WorldSdf` | `(x: number, y: number, z: number) => number` | |
| `MeshSdf` | `(pLocal: Vec3) => number` | A caller's mesh-part SDF: part-local, positive inside |
| `meshSdfOf` | `(part: Part, meshSdf?: Record<string, MeshSdf>) => MeshSdf \| undefined` | Looks a mesh part's SDF up by `dims.meshRef`, then by part id |
| `overlapVolume` | `OverlapVolumeFn` = `(a: Part, b: Part, o?: { meshSdf?: Record<string, (p: Vec3) => number> }) => number` | Shared volume, in³: cell centers of a regular grid over the intersection of the two world boxes, spacing `min(0.025, smallest extent / 8)`; 0 when the boxes do not intersect |
| `overlapVolumeWith` | `(a: Part, b: Part, o?: { meshSdf?: Record<string, MeshSdf>; maxSamples?: number; skip?: boolean }) => number` | The same with a cap on the grid cells (default 2 000 000) and `skip: false` = the reference grid without row skipping |
| `surfaceGap` | `SurfaceGapFn` = `(child: Part, parent: Part) => number` | From the child's builder vertices: the distance from the nearest one to the parent's surface; **≤ 0 when the child touches or enters the parent** (minus the deepest vertex's depth) |
| `surfaceGapWith` | `(child: Part, parent: Part, meshSdf?: Record<string, MeshSdf>) => number` | With the SDFs of mesh parts; a mesh child on a primitive parent is measured the other way round |
| `gapOfVertices` | `(vertices: ArrayLike<number>, solid: WorldSdf) => number` | `−max sdf` over `[x, y, z, …]`; `Infinity` for none |
| `gapProbe` | `(child: Part, parent: Part) => 'child' \| 'parent'` | Whose vertices `surfaceGap` uses |
| `partWorldVertices` | `(part: Part) => Float64Array<ArrayBuffer>` | The builder vertices in model space (a flat part's without duplicates) |
| `sdfNormal` | `(f: WorldSdf, p: Vec3, h = 1e-4) => Vec3` | Outward unit normal by central differences; `[0, 1, 0]` without a gradient |
| `partVolume` | `(given: Part) => number` | Analytic volume, in³ (flat = outline area × thickness; torus arc = tube without caps; mesh = inscribed ellipsoid of `bboxIn`) |
| `OVERLAP_SPACING_IN`, `OVERLAP_MAX_SAMPLES` | `0.025`, `2_000_000` | |

### `attach.ts`

| Export | Signature | What it does |
|---|---|---|
| `inferAttach` | `InferAttachFn` = `(m: CrochetModelV1, o?: { meshSdf?: Record<string, (p: Vec3) => number> }) => { model: CrochetModelV1; repairs: Repair[] }` | Completes the attach tree: always ONE tree. Keeps valid links, drops dangling / self / cyclic ones, picks the root, grows the tree from it by largest overlap, then smallest gap. Returns the same model object when nothing changes |
| `inferMirrorPairs` | `InferMirrorPairsFn` = `(m: CrochetModelV1, o?: { tolerance?: number }) => { model: CrochetModelV1; repairs: Repair[] }` | Sets `mirrorOf: X_l` on right-side twins. Same object when nothing changes |
| `AttachGraph` | `interface { index: Map<string, number>; parent: (number \| null)[]; children: number[][]; roots: number[]; isTree: boolean }` | By part index; `parent` is `null` without `attach` or for a dangling / self link; parts on a cycle are not roots |
| `attachGraph` | `(parts: readonly Part[]) => AttachGraph` | |
| `isOneTree` | `(model: Pick<CrochetModelV1, 'parts'>) => boolean` | One root and every part reachable from it (what `generateAmigurumi` requires) |
| `attachRoot` | `(model: Pick<CrochetModelV1, 'parts'>) => Part \| undefined` | The root when the links form one tree |
| `subtreeIds` | `(model: Pick<CrochetModelV1, 'parts'>, id: string) => string[]` | The part and everything attached below it, breadth first; `[]` for an unknown id |
| `childrenOf` | `(model: Pick<CrochetModelV1, 'parts'>, id: string) => Part[]` | Direct children, in parts order |
| `chooseRoot` | `(parts: readonly Part[]) => number` | The index the root rule of §3.7.6 names (−1 for no parts) |
| `leftTwinId` | `(id: string) => string \| null` | The last `_`-separated right-side token becomes its left form: `ear_r_inner` → `ear_l_inner`, `leg_fr` → `leg_fl`, `wing_right` → `wing_left`; `null` without one |
| `GAP_WARN_IN`, `GAP_FLOAT_IN` | `0.1`, `0.25` | The `W_GAP` and "floats" thresholds |

`attach-inferred` repairs carry `part`, a message and `data`: `{ to, overlapIn3 }` for a link by overlap,
`{ to, gapIn }` for a link to the nearest part (`gapIn: null` when no gap could be measured), `{ root: true }` for a
root that lost a bad link. Messages: `head attached to body: they overlap by 0.0654 in³`, `… the nearest part (they
touch)`, `… the nearest part: gap 0.2 in`, `… this part floats 1 in from body`, plus ` (it was attached to …)` for a
re-linked part. `mirror-inferred` repairs carry `data: { mirrorOf }`.

### `naming.ts`

| Export | Signature | What it does |
|---|---|---|
| `nameParts` | `NamePartsFn` = `(m: CrochetModelV1, o?: { keepIds?: ReadonlySet<string> }) => { model: CrochetModelV1; renames: Record<string, string> }` | Template ids by geometry (§2.9.7 step 6) on a model that has its tree; rewrites `attach.to`, `mirrorOf`, `features[].on`, `assembly[].part` / `.to`. `renames` maps each changed id to its new one. Ids in `keepIds` are never changed and never given to another part. Idempotent; the same object when nothing changes |

### `place.ts`

| Export | Signature | What it does |
|---|---|---|
| `placeChildOnSurface` | `PlaceChildOnSurfaceFn` = `(parent: Part, child: Part, at: { dir: Vec3 } \| { hit: Vec3; normal: Vec3 }, overlapIn?: number, o?: { meshSdf?: (p: Vec3) => number }) => Part` | The child with a new `position` (rounded to 1e-6): its center on the ray from the parent's center along `dir` (normalized here), or on the line through `hit` along `normal`, where its surface enters the parent's by `overlapIn` (default 0.10; negative = a gap). Rotation, dims and `attach` untouched. `o.meshSdf` is the mesh part's of the pair (the parent's when both are meshes) |
| `placeChildOnSurfaceWith` | `(parent: Part, child: Part, at: { dir: Vec3 } \| { hit: Vec3; normal: Vec3 }, overlapIn = 0.1, sources?: SurfaceSources) => Part` | The same with the surfaces of any mesh parts |
| `SurfaceSources` | `interface { meshSdf?: Record<string, MeshSdf>; meshes?: Record<string, ColoredMesh> }` | Mesh-part surfaces by `meshRef`: SDFs, or triangle buffers (ray-cast) |
| `surfaceExit` | `(part: Part, origin: Vec3, dir: Vec3, sources?: SurfaceSources) => number \| null` | Distance from `origin` along `dir` (normalized) to the OUTERMOST surface point on that ray; `null` when the ray misses |
| `overlapAlongRay` | `(parent: Part, child: Part, sources?: SurfaceSources) => number` | How far the child's surface has entered the parent's along the ray between their centers (negative = gap): the `overlapIn` that would leave the child where it is (T7's "overlaps its parent by 0.05–0.15 in along its stacking ray") |
| `AttachAnchor` | `interface { azimuthDeg: number; elevationDeg: number; offsetIn: number; point: Vec3 }` | A child's anchor in its parent's frame: direction from the parent's center (azimuth 0° = parent +Z, +90° = +X; elevation +90° = +Y), signed offset along the surface normal (negative = inside), and the model-space point it names |
| `captureAnchor` | `(parent: Part, child: Part, sources?: SurfaceSources) => AttachAnchor` | The anchor of the child's contact point (deviation 11) |
| `anchorPoint` | `(parent: Part, anchor: Pick<AttachAnchor, 'azimuthDeg' \| 'elevationDeg' \| 'offsetIn'>, sources?: SurfaceSources) => Vec3` | Re-projects an anchor onto a (changed) parent; on the unchanged parent it is exactly `anchor.point` |
| `reanchorChildren` | `(before: CrochetModelV1, after: CrochetModelV1, parentId: string, o?: { before?: SurfaceSources; after?: SurfaceSources }) => CrochetModelV1` | §4.2 re-anchoring: each direct child of `parentId` (tree of `before`) has its whole subtree in `after` translated by its anchor's displacement; rotations kept, nothing else moves, positions rounded to 1e-6. Returns `after` itself when nothing moves |
| `DEFAULT_OVERLAP_IN` | `0.1` | |

### `proportions.ts`

| Export | Signature | What it does |
|---|---|---|
| `readProportions` | `ReadProportionsFn` = `(m: CrochetModelV1) => ProportionsReading` | `{ headBody?, limbs?, disabled: { headBody?, limbs? } }`: b of "head : body = 1 : b" to two decimals (not clamped to 1…3), the chip nearest to the arms (the legs without arms), and the reasons a control is disabled |
| `applyProportions` | `ApplyProportionsFn` = `(m: CrochetModelV1, o: { headBody?: number; limbs?: LimbLength }, meshes?: Record<string, ColoredMesh>) => { model: CrochetModelV1; meshes?: Record<string, ColoredMesh> }` | §4.2 (G23), ending with a uniform rescale to the original height; `meshes` comes back (scaled) only when it was passed. A disabled control or an unusable value is ignored (the same model comes back) |
| `resizeLimbs` | `(model: CrochetModelV1, lengths: Readonly<Record<string, number>>, meshes?: Record<string, ColoredMesh>) => CrochetModelV1` | The limb edit alone, before any rescale: each named limb gets its total length with its proximal pole kept, parents before children, mirror twins alike, children re-anchored |
| `LIMB_TEMPLATE` | `LimbTemplate` | `quadruped { arm: 0.25, leg: 0.2 }`, `quadruped-standing { 0.3, 0.3 }`, `biped { 0.3, 0.3 }`, `creature { 0.15, 0.15 }` (fractions of the model height) |
| `LIMB_FACTORS` | `Readonly<Record<LimbLength, number>>` | `{ nubs: 0.6, short: 1, medium: 1.5, long: 2.2 }` |
| `limbTemplateRow` | `(m: Pick<CrochetModelV1, 'category' \| 'pose'>) => keyof LimbTemplate` | quadruped + `pose: 'standing'` → `quadruped-standing`; `biped` / `person` → `biped`; `creature` → `creature`; anything else (or none) → `quadruped` |
| `NO_HEAD_REASON` | `'one-piece body: no separate head'` | |
| `LimbLength`, `LimbTemplate`, `ProportionsReading` | types | Re-exported from `types/entryPoints` |

Disabled reasons: head — `NO_HEAD_REASON` (no part `head` / label "Head", or it is the root); limbs — `Fit primitive
on <id> first` (a limb is a mesh part), `limbs must be capsules or cylinders (<id> is a <type>)`, `no arms or legs:
limbs are capsule or cylinder parts named arm_*, leg_* or limb<n>_*`, `the model has no height`.

### `scale.ts`

| Export | Signature | What it does |
|---|---|---|
| `scaleModel` | `ScaleModelFn` = `(m: CrochetModelV1, factor: number, meshes?: Record<string, ColoredMesh>) => { model: CrochetModelV1; meshes?: Record<string, ColoredMesh> }` | Uniform scale about the ground center `(0, lowest y, 0)`: positions, dims, profiles, polygon points, `bboxIn`, region lengths, `crochet.seed`, feature `sizeIn` / `sizeMm`, `finishedSize`, and new mesh `positions` when `meshes` is passed. Rounded to 1e-6. `factor === 1` returns the input; throws `RangeError` unless `factor` is finite and > 0 |
| `scalePartDims` | `<P extends Part>(part: P, factor: number) => P` | One part's lengths about its local origin (`position` untouched), with the 0.05 in floor of deviation 14 |
| `scaleMesh` | `(mesh: ColoredMesh, factor: number) => ColoredMesh` | New `positions`; `indices`, `labels`, `partId` shared |

### `dims.ts` (internal)

| Export | Signature | What it does |
|---|---|---|
| `sanePart` | `<P extends Part>(part: P) => P` | The part itself when its dims are finite and its lengths not negative; else a copy the geometry kernels can use (non-finite → 0, negative length → its size, broken points dropped, missing dims → a zero-size shape) |

### Test helpers T7 may want to read (not API)

`__tests__/helpers/teddy.ts`: `readObservedTeddy()`, `normalizeObservedDialect(raw)` (the teddy's subset of §3.7.3),
`buildCanonicalTeddy()` → `{ normalized, model, groundDy, measuredHeight, repairs }`, `DEFAULT_MODEL_NAME`, the
fixture URLs. `__tests__/helpers/everyType.ts`: `buildEveryType()`, `readEveryType()`, `readEveryTypeMeshes()`,
`uvEllipsoid(rx, ry, rz, segments?, rings?)`.

## The canonical teddy: the recipe T7 must reproduce (G12)

`__tests__/helpers/teddy.ts` is the generator. From `fixtures/claude-design/teddy-bear/teddy-bear.crochet-model.json`:

1. **Dialect (§3.7.3).** `dimensions` → `dims` (`radius → r`, `radiusTop/radiusBottom → rTop/rBottom`,
   `height → h`); capsule `length := length + 2·radius`. `palette` object → array in the object's key order,
   `{ id: slug(name) cut to 16 characters (deduped with _2, _3 …), hex: the key as written, name }`. Part `color`
   → palette id by case-insensitive hex. `name` → `label`. World transform =
   `multiplyRigid(World(parent), composeRigid(position, rotationDeg))`, then `decomposeRigid`; `rotationDeg` is
   written for every part whose source had one (here: all). `parent` → `attach: { to, method: 'sewn' }`.
   Eye-like parts (§2.10.1 rule 1: id/label contains "eye", or a sphere/ellipsoid ≤ 0.6 in across with OKLab
   L < 0.25 that has a parent) get `crochet: { make: 'safety_eye' }` (here eye_l, eye_r; the nose is 0.64 in
   across). Header: `revision: 0`, `axes.left: '+X'`, `source: { tool: 'claude-design', stage: 'refined' }`,
   **`name: 'Imported model'`** (the dialect has no name; the spec gives no default — this is ours), top-level
   `notes` → `assumptions: [notes]` (one `unknown-key` repair).
2. **Units (§3.7.6).** The bounding-box height is 9.878905 against the stated 10 (ratio 0.988, within 15%): the
   geometry is kept and **the measured height is recorded: `finishedSize: { height: 9.878905 }`** (one `units`
   repair).
3. **Ground:** `groundModel` (dy = +0.078905, one `ground` repair).
4. **Round:** `roundModel` (1e-6; `[82, 0, −12.000000000000002]` → `[82, 0, −12]`).
5. `inferAttach` (6 `attach-inferred`), then `inferMirrorPairs` (6 `mirror-inferred`).
6. Write with `stringifyModel`.

## Acceptance, measured (M-class laptop, Node 22, idle machine)

| Brief item | Where | Measured |
|---|---|---|
| `schema.parse(x)` deep-equals `x` | `schema.test.ts` | §3.6 example (read from `DESIGN.md`), `teddy.canonical.json`, `every-type.json`: equal, input unchanged, second pass equal |
| Invalid models fail with useful messages | `schema.test.ts` | e.g. `parts[4] (arm_l).dims.length: capsule length is the TOTAL length including both caps: 0.5 is less than 2·r = 0.64`; unknown keys at every level, broken references, duplicates, self links and cycles, missing fields |
| §3.5.2 limits enforced | `schema.test.ts` | 60/61 parts, 16/17 colors, 24/25 regions, 60/61 features, 3/64 profile and polygon points, dims 0.05/48, height 60, text 2 000, depth 12 (incl. `x-*` values, cyclic objects), 2 MB (bytes, not characters), prototype keys |
| `buildModel`: one named mesh per part, finite geometry | `builder.test.ts` | All three models at `unitScale` 1 and 0.0254: names = ids in order, no NaN, positions × unitScale, rotation order `XYZ` |
| Lathe mesh spans exactly `[y_min, y_max]`, origin at `position` | `builder.test.ts` | Box y equals the profile's min and max to the last float32 digit (§3.6 body, every-type body, an offset profile) |
| Same scene as the normative code | `claudeDesign.test.ts` | 0 differing numbers in positions and vertex colors (> 40 000 each case) for the §3.6 example, the teddy, every-type without its mesh/paint, and regions without `from`/`to` |
| Euler ↔ matrix round-trips (incl. gimbal), = three.js `'XYZ'`; compose/decompose | `transforms.test.ts` | Matrices equal three.js to 1e-12; angles equal three.js's `setFromRotationMatrix` to 1e-9 (incl. y = ±90°); `Matrix4.compose`/`decompose` to 1e-12 |
| Each analytic SDF vs brute-force distance to the builder mesh, seeded, stated tolerance, right sign | `sdf.test.ts` | max \| \|sdf\| − d \| over 500 points (tolerance): sphere 2.99e-3 (3.6e-3), capsule 2.72e-3 (3.0e-3), short capsule 4.14e-3 (4.5e-3), cylinder 1.71e-3 (2.0e-3), tapered 1.71e-3 (2.0e-3), cone 1.49e-3 (1.75e-3), torus 4.22e-3 (4.52e-3), box 1.7e-8 (1e-6), lathe 2.57e-3 (3.0e-3), lathe with corners 2.14e-3 (2.5e-3); torus arcs 90°/200°/300° between their ends 2.65e-3 / 3.06e-3 / 3.68e-3 (4.52e-3); flat shapes 0.085–0.127 (bevel ignored, tolerance bevel·√2 + 0.005); ellipsoid bound: 0 sign errors, never above the mesh distance outside. 0 wrong signs everywhere |
| `inferAttach` on the teddy | `attach.test.ts`, `fixtures.test.ts` | One tree rooted at `body`; head, arms, legs, tail → body (6 links: leg_l, leg_r, arm_l, arm_r, tail, head); head keeps muzzle, eyes, ears; overlaps head 0.0654, legs 1.3425, arms 0.6415, tail 0.1134 in³ (§3.7.3: 0.07 / 1.34 / 0.64 / 0.11); from no links at all (OBJ carrier): the same tree, 16 links |
| No cycles on any input; idempotent; frozen `Repair` codes | `attach.test.ts` | 60 seeded random models with random, dangling, self and cyclic links: one tree each, idempotent, deterministic, only `attach-inferred`; broken numbers never throw |
| `inferAttach` ≤ 500 ms on the teddy | `attach.test.ts` | 18 ms from the dialect, 36 ms from no links (median of 5); 40 / 60 mutually overlapping parts: 1.0 / 1.2 s |
| `inferMirrorPairs` links `X_l`/`X_r`; idempotent | `attach.test.ts` | Teddy: eye_r, ear_r, ear_r_inner, arm_r, leg_r, foot_pad_r → their `_l` twins (6 repairs); second pass returns the same object |
| `nameParts` on anonymous parts; `keepIds` | `naming.test.ts` | The parentless, label-less teddy with ids `p00…p16` → body, head, muzzle, ear_l/ear_r, arm_l/arm_r, leg_l/leg_r, tail, part_1…part_7 by volume; kept ids stay and are not reused |
| `placeChildOnSurface`, every parent type | `place.test.ts` | 9 primitive types, plain and rotated, 9 directions (a torus: 3 in its ring plane, its axis, world +Y): kernel overlap 0.1 ± 8.5e-7; measured on the builder meshes 0.1 ± 0.0034 (flat parents: plus the bevel the SDF ignores, ≤ 0.095); `{ hit, normal }` on every type; mesh parents by SDF and by triangles; every child type |
| G23 head 1:1 / 1:3 | `proportions.test.ts` | Head fraction 0.50005 / 0.24996 (targets 0.5 / 0.25); height 9.878906 / 9.878905 vs 9.878905 (< 1e-5 %); ear gaps −0.655 / −0.918 in (they enter the head) |
| G23 limbs "long" | `proportions.test.ts` | arm_l, arm_r 0.55004·H, legs 0.44003·H; proximal poles moved 7.5e-7 in before the rescale; `arm_r` is the exact mirror of `arm_l` |
| G23 `readProportions(teddy)` | `proportions.test.ts` | `{ headBody: 1.3, limbs: 'short', disabled: {} }` (raw 1.2974; arms 3.0/9.879 = 0.304 = 1.21 × 0.25) |
| Disabled reasons of §4.2 | `proportions.test.ts` | Above, each tested |
| `applyProportions` ≤ 200 ms | `proportions.test.ts` | 2.8 ms (1:1), 2.2 ms (1:3), 14.5 ms (long), 11.7 ms (both) |
| `scaleModel` | `scale.test.ts` | Every dimension, position, profile, polygon point, region length, feature size, `finishedSize` and mesh buffer scales about the ground center; heights × factor to 1e-5; a valid model stays valid down to keychain size |
| Fixture generator byte for byte | `fixtures.test.ts` | Both fixtures and the mesh file reproduced exactly |

Teddy goldens (§3.7.3, §3.7.6): positions before grounding match to 1e-3 (muzzle `[0, 6.6, 1.9]`, nose
`[0, 6.9, 2.42]`, eye_l `[0.78, 7.45, 2.02]` at azimuth 22.1° / elevation 6.9°, ear_l `[1.6, 8.95, −0.1]`,
ear_l_inner `[1.5765, 8.9059, 0.16]`, foot_pad_l `[1.4411, 0.9706, 2.6061]` rot `[82, 0, −12]`, leg length 3.1);
grounding +0.078905; volumes body 43.455, head 47.551 in³; head–muzzle overlap 1.4312 in³; world box
x ±2.9059, z −2.25 … 2.8202 (research 08 measured the same on the OBJ, and every one of its 38 165 vertices lies on
the analytic surface of its part to 1e-5 in).

## Deviations from the spec, with reasons

1. **`buildModel` has a third parameter and paints more.** `meshes` supplies the buffers of `mesh` parts (the
   normative code has no `mesh` case and would throw on the app's own models); a mesh part without a buffer is
   drawn as the ellipsoid inscribed in `bboxIn`. The `paint` field of primitives and the vertex labels of mesh
   parts are painted on top of the regions (§2.11.1 priority). None of this reaches Claude Design. For specs
   without mesh parts and paint the output is the normative one, number for number (tested).
2. **The builder never throws on, or hands NaN to three.js for, a part with broken numbers** (`dims.ts`): a
   non-finite number counts as 0, a negative length as its size, a polygon without points as a rectangle, a
   one-point lathe profile as its ring. It still throws `unknown part type …` like the normative code. Regions
   without `from` / `to` are read as 0 / 1, as the normative code reads them. Colors and materials are looked up
   in `Map`s (see request 9).
3. **SDF solids where the builder leaves a surface open** (§3.7.6 says only "torus arcs … as noted"):
   `cylinder.open` is ignored (solid); a lathe whose profile does not start or end on the axis is closed by a flat
   disc; a torus arc is the tube with round ends (the bent capsule of §2.10.4), which reach `r` past the flat ends
   of the builder's open tube.
4. **A mesh part without a supplied SDF is the ellipsoid inscribed in its `bboxIn` box** — for `partSdf`,
   `overlapVolume`, `surfaceGap`, `placeChildOnSurface`, `inferAttach`.
5. **`overlapVolume` caps its grid at 2 000 000 cells**; a larger intersection gets proportionally larger cells.
   `inferAttach` additionally shares 40 000 000 cells between the pairs of touching boxes (never less than
   32 768 per pair), so its cap drops below 2 000 000 only for models with more than 20 such pairs whose
   intersections are large. Ordinary models (the teddy) get exactly the grid of §3.7.6. Rows are walked with
   exact skipping (every analytic SDF is a lower bound of the distance outside), so the count equals the full
   grid's (tested on 60 random pairs).
6. **`surfaceGap` is signed**: positive = gap; zero or negative = the child touches or enters the parent (minus
   the depth of its deepest vertex). `> 0.1` still means `W_GAP`.
7. **`inferAttach` repairs bad links itself** (the spec puts "a dangling or cyclic link is removed first" in
   the importer's step before it): a link to a missing part or to the part itself is dropped; a cycle is broken
   at the member the root rule would choose; those parts are linked again. A root that lost such a link gets
   one `attach-inferred` repair with `data.root`. So "no cycles on any input" holds without the importer.
8. **`inferMirrorPairs`:** `o.tolerance` (relative, for dims) also loosens the other two: positions agree within
   `max(0.001 in, tolerance × largest extent)`, rotations within `max(0.5°, tolerance × 90°)` — with a fixed
   0.001 in no reconstructed pair would ever match. Rotations also match when they are the same rotation written
   with other Euler angles. Twin ids are found by `_`-separated token (`r`, `right`, `fr`, `br`), anywhere in
   the id — the golden needs `ear_r_inner` → `ear_l_inner`.
9. **`nameParts`:** mirror pairs are found by geometry (existing `mirrorOf` links, else siblings of similar size —
   largest extents within ×1.5 — whose centers mirror each other within 35% of their size across the plane
   x = the root's x); the head is the part already called `head` (id, else label), else the largest single child
   of the root above the root's center holding ≥ 15% of its volume; pairs that reach the lowest 15% are ordered
   back to front (so a standing quadruped's back pair is `leg`, its front pair `arm`, matching §4.2's "arms (its
   front legs)"); only the highest pair above the head's center becomes `ear` (ids must stay unique); among
   several single children in front of the head / behind the body the largest is `muzzle` / `tail`. It does not
   write labels or `mirrorOf`.
10. **`placeChildOnSurface`:** "the parent's surface" on the ray is its OUTERMOST point on that ray (a concave
    lathe, a torus). A ray that misses the parent (through a torus) starts from the parent's center. `o.meshSdf`
    belongs to the mesh part of the pair — the parent's when both are meshes. The position is rounded to 1e-6.
    The bisection runs to 1e-9 in (the spec asks for 1e-4).
11. **Re-anchoring uses its own contact point.** §4.2 refers to the attach anchor of §2.12 step 1, which is T4's
    (it needs trimming). Here the anchor follows the centroid of the volume the child shares with its parent
    (measured on a 21³ grid in the child's frame, so mirror twins get mirrored anchors), or the child's layer
    nearest the parent when they do not touch; the direction is from the parent's center, the offset along the
    parent's surface normal. A mesh parent known only by its triangles uses the child's center.
12. **`applyProportions`:**
    - one bisection on the height ratio of the edit instead of one on k; for the head alone it solves the same
      equation as §4.2 (k stays within [0.2, 5]); head and limbs given together are solved jointly; it stops
      within 0.02% (the spec asks for 0.1%);
    - a control that is disabled, or a value that is not usable, is ignored (the model comes back unchanged)
      rather than throwing;
    - after the rescale the model's lowest point is put back where it was (long arms can reach below the feet);
    - `mirrorOf` twins that were exact mirrors stay exact mirrors;
    - a capsule limb never gets shorter than its two caps (teddy legs "nubs": 0.152·H instead of 0.12·H).
13. **`readProportions`:** `headBody` is rounded to two decimals (teddy: 1.3); `limbs` is read from the arms
    (geometric mean of length / (height × template), nearest chip in log scale), from the legs when there are no
    arms; `limb<n>_*` uses the arm template; limb ids match `/^(arm|leg|limb\d+)(_|$)/`.
14. **`scaleModel`:** the ground center is `(0, lowest y, 0)`, not the middle of the footprint: mirror pairs stay
    mirrored across x = 0, and a grounded model has every coordinate multiplied by the factor (so it also serves
    unit conversion). It also scales region lengths (`widthIn`, `radiusIn`, `scaleIn`), feature sizes (`sizeIn`
    and `sizeMm`), `crochet.seed` and `finishedSize`. **A dimension never falls below 0.05 in** when it was not
    below it already (a teddy scaled to 3 in keeps its 0.036 in inner-ear thickness at 0.05), a capsule stays as
    long as its caps, and a lathe profile whose largest radius or height would fall below 0.05 in is scaled by
    the smallest larger factor that keeps both (shape kept), so a valid model stays valid; nothing is limited at
    the top (the caller keeps results within 48 in / 60 in).
15. **Rounding.** Every kernel that derives coordinates (`placeChildOnSurface`, `reanchorChildren`,
    `applyProportions`, `scaleModel`) rounds them to 1e-6 (half away from zero; −0 becomes 0). `groundModel`,
    the transforms and `inferAttach` do not round.
16. **Part centers:** `localCenter` is also non-zero for a torus arc (its builder geometry is not centered
    either); §0.1 says "`c_local` = 0 except lathe".
17. **Bounding boxes are the exact extents of the builder solid** (analytic support functions), not of its
    tessellated vertices — the spec's own golden (grounding +0.0789) is the analytic one (the OBJ's tessellated
    legs stop at −0.0780). Flat parts use the builder's vertices, bevel included.
18. **Extra files:** `limits.ts`, `dims.ts`, `fixtures/models/every-type.mesh.json`.

## Ambiguities resolved

| Where | Reading |
|---|---|
| §3.5.2 "dims 0.05–48 in" | Every linear dimension of every primitive. Lathe: each radius 0…48 and each y −48…48, the largest radius ≥ 0.05, the height (last y − first y) 0.05…48. Polygon points −48…48. `mesh.bboxIn`: each > 0 and ≤ 48 (no 0.05 floor: it is measured, not authored). `finishedSize.width/depth`: > 0 |
| §3.5.1 capsule "TOTAL length incl. caps (≥ 2r)" | Enforced by the schema. The builder and the SDF treat a shorter capsule as its sphere |
| §3.5.1 `flat.points?` | Required for `shape: 'polygon'` (3–64), allowed and ignored for other shapes |
| §3.5.2 "nesting depth ≤ 12" | Objects and arrays, the model object being level 1, `x-*` values included |
| §3.5.2 "whole document ≤ 2 MB" | UTF-8 bytes of `JSON.stringify`, 2·1024·1024 |
| §3.5.2 text fields | Every free string ≤ 2 000 characters; `paint.data` is not a text field: base64 of exactly 4096 bytes |
| Angles | `azimuthDeg` −360…360, `elevationDeg` −90…90, `spanDeg` (0, 360], `arcDeg` (0, 360], `seamAzimuthDeg` −360…360; `from ≤ to` |
| References | Part, palette and feature ids unique; `color`, region colors, feature colors must be palette ids; `attach.to`, `mirrorOf`, `feature.on` must be parts; no self links; no attach cycle. **Several roots are valid** (the tree is completed by `inferAttach`). `assembly[].part` / `.to` are free text |
| Feature ids | Same pattern as part ids (request 14) |
| §3.7.6 "prototype keys" | `__proto__`, `constructor`, `prototype` as a KEY anywhere in the document is an error (they are fine as values) |
| §3.7.6 overlap grid "smallest extent / 8" | The smallest extent of the intersection box |
| §3.7.6 root rule "largest by volume" | Analytic volumes (`partVolume`); a flat part = outline × thickness; a mesh part = its inscribed ellipsoid |
| §3.7.6 "ties within 1% → larger c, then id" | Among the pairs within 1% of the largest overlap: the larger `c`, then the lower `c` id, then the larger overlap, then the tree part that joined first |
| §3.7.6 units "record the measured height" | `finishedSize.height :=` the measured bounding-box height |
| §2.11.1 paint grid | Row-major, `row = ⌊v·64⌋`, `column = ⌊u·64⌋` (`uv64Cell`); values index `model.palette` |
| `meshSdf` records | Keyed by `dims.meshRef` (like `ImportResult.meshes`), else by part id; the functions are part-local |
| §4.2 limb "proximal end" with no SDF for a mesh parent | The pole nearer the parent's center |
| §4.2 limb chip for creatures | `creature` arms and legs both 0.15 (DESIGN v1.3); `limb<n>_*` limbs use the arm value |
| `withExtensions` | A transform (as the spec describes), so `z.toJSONSchema(crochetModelSchema)` cannot work: use the `…CoreSchema` exports |

## Requests for integration

1. **0c:** add the model entry points to `src/types/__checks__/entryPoints.check.ts` and
   `src/test/__tests__/entryPoints.test.ts` (`partSdf`, `overlapVolume`, `surfaceGap`, `inferAttach`,
   `inferMirrorPairs`, `nameParts`, `placeChildOnSurface`, `readProportions`, `applyProportions`, `scaleModel`;
   `LIMB_TEMPLATE` against `LimbTemplate`). They are annotated with the `…Fn` types here, so they will pass.
2. **§2.9.7 steps 5–6 (T3) and §3.7.5 (T7):** `inferMirrorPairs` works on ids (`X_l` / `X_r`), so on generic ids
   it finds nothing. Order must be `inferAttach` → `nameParts` → `inferMirrorPairs`.
3. **§3.7.3 (T7):** say what `name` a normalized dialect model gets; the fixture uses `'Imported model'`. T7 should
   end its normalization with `roundModel` and write with `stringifyModel` (recipe above).
4. **§3.7.6:** confirm "record the measured height" = `finishedSize.height` (the fixture has 9.878905, not 10).
5. **§4.2 / §5.2.1:** define the ground center. Chosen: `(0, lowest y, 0)`. The middle of the footprint would move
   the mirror plane of a model that is wider on one side.
6. **§4.2:** say whether `scaleModel` scales `Feature.sizeMm` (it does: an 18 mm eye on a toy twice the size;
   T4 snaps to the sizes that exist) and that dims stop at the schema minimum (deviation 14).
7. **§0.1:** `c_local` of a torus arc (deviation 16).
8. **§2.11.1:** pin the uv64 cell layout (T3 writes it, T4 and T6 read it): `uv64Cell` in `builder.ts`.
9. **§3.4.1, normative JS (T7's `builderSource`):** `pal` and `mats` are plain objects, and `constructor` and
   `__proto__` are valid palette ids by `/^[a-z0-9_]{1,16}$/`: `pal['constructor'] ?? '#cccccc'` yields the
   `Object` function for an unknown id, and `mats[id] ??= …` returns `Object` / `Object.prototype` instead of a
   material for either id even when the palette defines it. Use `Object.create(null)` (or a `Map`) in the
   embedded JS. A `polygon` without `points` throws there.
10. **§3.4.1 flat parts, for T4:** the builder's bevel grows the outline by `min(0.3·t, 0.1·min(w, h))` at
    mid-thickness, so the mesh holds 8–36% more volume than outline × thickness, and a `teardrop` of width `w` is
    only 0.79·w wide (the Bézier of `shape2D`). The SDF ignores the bevel, as §3.7.6 says — so a child placed on
    a flat parent along its plane sits up to the bevel (≤ 0.09 in for t = 0.3) deeper in the builder mesh.
11. **`W_GAP`:** `inferAttach` returns repairs, not issues (frozen type). A link made by gap carries
    `data.gapIn`; whoever builds `Issue`s raises `W_GAP` above `GAP_WARN_IN`.
12. **T6:** `reanchorChildren(before, after, parentId)` is the §4.2 re-anchoring; the T6 golden ("scaling the
    teddy head 1.2× keeps each ear's gap ≤ 0.1 in and its (az, el) within 1°") is already a test here.
13. **`Repair.code`:** there is no code for "a bad attach link was removed"; `attach-inferred` is used.
14. **§3.5.1 feature ids:** the spec gives no pattern; the schema applies the part-id pattern (they share the
    `eye_l` style and are referenced like part ids). Say so in §3.5.1, and let the importer's "ids: slugify,
    dedupe" repair (§3.7.6) cover feature ids too, or a Claude Design feature id like `Eye-L` fails validation.

## Not done, not verified

- `revisions.ts` (`carryOver`) is the state kernel's.
- No browser run: everything was exercised in the vitest `node` environment only (three.js geometry classes need
  no DOM; no renderer is created).
- The plain-JS form of the builder that the prompt embeds is T7's (`core/qa/builderSource`); it was not written
  here (the §3.4.1 block itself is evaluated from `DESIGN.md` and compared with `buildModel`).
- `docs/schema/crochet-model-1.0.schema.json` is T7's; only that `z.toJSONSchema(crochetModelCoreSchema)` works
  and gives `oneOf` branches with `additionalProperties: false` was checked.
- The "97 s" for `inferAttach` on 60 mutually overlapping parts without the work budget was measured before the
  budget existed and was not re-measured.

## Commits

`2343fb6` kernels; `69c02e5` bounded overlap grids, valid dims after scaling, kernels total over unvalidated parts;
`326848e` notes, schema key-set guard, full eye rule; `bbef767` checks against the real Claude Design exports and
the normative builder; then the completion commit (normative region defaults, lathe floor in `scaleModel`, torus
arc against the builder mesh, every hint value in `every-type.json`, explicit timeouts for the heavy suites, these
notes).
