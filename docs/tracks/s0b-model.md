# Step 0b — the 3D model kernels (`core/model`, `fixtures/models`)

Branch `s0b/model`, made from the Step 0a commit. Scope: `src/core/model/**` except `revisions.ts` (another 0b
agent), and `fixtures/models/**`. Spec: `DESIGN.md` §0.1, §2.9.7, §3.3, §3.4.1, §3.5, §3.6, §3.7.3, §3.7.6, §4.2,
§5.2.1, §5.8, golden G23.

## What was delivered

| File | What it is |
|---|---|
| `schema.ts` | The zod mirror of §3.5.1 as a discriminated union on `type`, strict objects everywhere, `x-*` keys kept on the model and on parts, the limits of §3.5.2, readable errors, and the canonical writer of model files |
| `limits.ts` | `MODEL_LIMITS` (§3.5.2), apart from zod so geometry code can use it |
| `builder.ts` | `buildModel` = `builder-v1` (§3.4.1) in TypeScript, plus the pieces the other kernels need from the builder geometry |
| `transforms.ts` | Euler XYZ ↔ matrix, rigid and 4×4 compose / decompose, part frames, bounding boxes and centers from the builder geometry, grounding, rounding |
| `sdf.ts` | Analytic signed distance functions (positive inside), `overlapVolume`, `surfaceGap`, part volumes |
| `attach.ts` | `inferAttach` (one attach tree, D21), `inferMirrorPairs`, attach-graph helpers |
| `naming.ts` | `nameParts` (§2.9.7 step 6) |
| `place.ts` | `placeChildOnSurface` (§3.3 step 3) and re-anchoring (§4.2) |
| `proportions.ts` | `LIMB_TEMPLATE`, `readProportions`, `applyProportions` (§4.2, G23) |
| `scale.ts` | `scaleModel` (about the ground center) |
| `dims.ts` | Internal: the dims the geometry kernels read from a part that has not been validated |
| `fixtures/models/teddy.canonical.json` | The observed Claude Design teddy, normalized, grounded, one attach tree, mirror pairs |
| `fixtures/models/every-type.json` | One part of every type (two tori, six flat shapes), every region kind, every feature kind, every enum value of `attach.method` / `openEnd` / `stuffing` / the crochet hints, a paint field, `x-*` keys |
| `fixtures/models/every-type.mesh.json` | The buffer of that model's mesh part (`{ "<meshRef>": { positions, indices, labels } }`, plain arrays) |

Tests: `src/core/model/__tests__/*.test.ts` (11 files) with helpers in `__tests__/helpers/`:
`teddy.ts` (the generator of the canonical teddy), `everyType.ts` (the generator of the other two fixtures),
`geometry.ts` (brute-force mesh geometry, independent of the kernels: point–triangle distance, ray parity, mesh
volume; `readSpecExample()` reads the §3.6 example out of `DESIGN.md` itself).

Both fixtures are generated: `fixtures.test.ts` regenerates them and compares the bytes. After an intended change:
`UPDATE_FIXTURES=1 npm test -- src/core/model/__tests__/fixtures.test.ts`, then review the diff.

## Public API

All lengths are inches; `Vec3 = [x, y, z]`; "part-local" = the part's own frame; "model space" = world. Nothing
mutates its arguments. Functions typed with a frozen `…Fn` type have exactly the §5.2.1 signature.

### `schema.ts`

| Export | Signature | What it does |
|---|---|---|
| `crochetModelSchema` | `z.ZodType<CrochetModelV1, unknown>` | The strict schema of a whole model. `parse(x)` deep-equals `x` for a valid model; `x-*` keys on the model and on parts are kept; any other unknown key, a broken reference, a duplicate id or an attach cycle is an error |
| `validateModel` | `(input: unknown) => { ok: true; model } \| { ok: false; issues: ModelIssue[] }` | Validates without throwing |
| `parseModel` | `(input: unknown) => CrochetModelV1` | Validates; throws `ModelValidationError` whose message has one line per problem |
| `ModelIssue` | `{ path: string; message: string }` | `path` reads `parts[3] (arm_l).dims.length` |
| `ModelValidationError` | `class extends Error { issues: ModelIssue[] }` | |
| `withExtensions` | `<S extends z.ZodType>(schema: S) => ZodType<z.output<S> & { [k: \`x-${string}\`]: unknown }>` | Lifts `x-*` keys out, parses the rest strictly, puts them back (§3.5.1) |
| `partSchema` | zod schema | One part, `x-*` keys kept |
| `partCoreSchema`, `crochetModelCoreSchema` | zod schemas | The same without extension keys and without the document checks: strict objects only, so `z.toJSONSchema` can represent them (T7's `gen-schema.ts`; parts come out as `oneOf` branches with `type` const and `additionalProperties: false`) |
| `regionSchema`, `featureSchema`, `paletteColorSchema` | zod schemas | The leaves |
| `MODEL_LIMITS` | const (also from `limits.ts`) | `maxParts 60, maxPalette 16, maxRegionsPerPart 24, maxFeatures 60, min/maxProfilePoints 3/64, min/maxPolygonPoints 3/64, minDimIn 0.05, maxDimIn 48, maxHeightIn 60, maxTextChars 2000, maxBytes 2·1024·1024, maxDepth 12` |
| `PART_ID_PATTERN`, `COLOR_ID_PATTERN`, `HEX_PATTERN`, `VERSION_PATTERN` | `RegExp` | The patterns of §3.5.1 |
| `isExtensionKey` | `(key: string) => key is \`x-${string}\`` | |
| `canonicalizeModel` | `(model: CrochetModelV1) => CrochetModelV1` | Keys in the canonical order (below); values unchanged |
| `stringifyModel` | `(model: CrochetModelV1) => string` | The canonical text of a model: canonical key order, 2-space indent, arrays of plain values on one line, final newline. The byte format of `fixtures/models/*.json` |
| `SchemaMatchesTypes` | type | Compile-time guard: `npm run typecheck` fails when the schema and `src/types/model.ts` drift apart (types, enums, required and optional keys of every object) |

### `builder.ts`

| Export | Signature | What it does |
|---|---|---|
| `buildModel` | `(spec: CrochetModelV1, unitScale = 0.0254, meshes?: Record<string, ColoredMesh>) => THREE.Group` | `builder-v1`. One `Mesh` per part (`mesh.name` = part id, `material.name` = color id or `<id>_painted`, `mesh.userData.crochet` = the part, `group.userData.crochetModel` = the spec). **The app passes `unitScale = 1`**; the default is the stage's meters, as in §3.4.1. `meshes` (by meshRef) supplies mesh parts |
| `partGeometry` | `(part: Part, unitScale = 1, meshes?) => THREE.BufferGeometry` | `geometryFor` of §3.4.1: the part in its local frame |
| `tessellatePart` | `(p: Part, meshes?) => PartTessellation` | The builder geometry as ArrayBuffer-backed copies, part-local inches: `{ positions: Float32Array, indices: Uint32Array }` |
| `vertexColorIds` | `(g: BufferGeometry, p: Part, unitScale = 1, o?: { paletteIds?: readonly string[]; mesh?: ColoredMesh }) => string[] \| null` | `paint()` of §3.4.1 returning the palette id of every vertex (regions in order, then the paint field / mesh labels); `null` for a solid part |
| `uv64Cell` | `(azimuthDeg: number, t: number) => number` | The cell of the 64 × 64 paint grid: `row · 64 + column`, `row = ⌊t·64⌋` (0 = bottom), `column = ⌊(az/360 + 0.5)·64⌋` |
| `decodeUv64` / `encodeUv64` | `(data: string) => Uint8Array \| null` / `(cells: Uint8Array) => string` | `paint.data` ↔ 4096 palette indices (255 = none) |
| `flatLayout` | `(dims: FlatDims) => FlatLayout` | A flat part as the builder places it: `outline` (closed polygon, centered like the builder's `.center()`), `half` extents with the bevel, unique `vertices`. Cached by dims |
| `flatBevelSize` | `(dims: FlatDims) => number` | `min(0.3·thickness, 0.1·min(w, h))`: how far the builder grows the outline at mid-thickness |
| `BUILDER_VERSION`, `UNIT_SCALE_INCHES`, `UNIT_SCALE_METERS`, `UV64_SIZE`, `UV64_NONE` | consts | `'builder-v1'`, `1`, `0.0254`, `64`, `255` |

### `transforms.ts`

| Export | Signature | What it does |
|---|---|---|
| `eulerXYZToMat3` | `(rotationDeg: Vec3 \| undefined) => Mat3` | Rx·Ry·Rz, three.js `'XYZ'` |
| `mat3ToEulerXYZ` | `(m: Mat3) => Vec3` | Degrees; three's algorithm (gimbal lock: z = 0); never −0 |
| `Rigid` | `{ rotation: Mat3; position: Vec3 }` | `p ↦ R·p + position` |
| `composeRigid` / `decomposeRigid` | `(position, rotationDeg?) => Rigid` / `(t) => { position, rotationDeg }` | |
| `multiplyRigid` | `(a: Rigid, b: Rigid) => Rigid` | a·b (b first). `World(child) = multiplyRigid(World(parent), composeRigid(pos, rot))` (§3.7.3) |
| `invertRigid`, `applyRigid` | | |
| `Mat4`, `composeMat4`, `decomposeMat4`, `multiplyMat4`, `rigidFromMat4` | 16 numbers, column-major | As three.js `Matrix4.compose` / `decompose` and glTF `node.matrix` (T·R·S; a mirroring matrix gets a negative x scale) |
| `partTransform`, `localToWorld`, `worldToLocal`, `partAxis` | `(part[, p])` | A part's frame; `partAxis(part, 1)` is the world direction of its local Y |
| `Bounds`, `boundsSize`, `boundsCenter`, `unionBounds` | `{ min: Vec3; max: Vec3 }` | |
| `localBounds` | `(part: Part, mesh?: ColoredMesh) => Bounds` | The box of the builder geometry in the part's frame |
| `worldBounds` | `(part: Part, mesh?: ColoredMesh) => Bounds` | The TIGHT box of the rotated solid in model space |
| `localCenter` | `(part, mesh?) => Vec3` | `c_local`: zero except a lathe and a torus arc |
| `partCenter` | `(part, mesh?) => Vec3` | `position + R·c_local` (§0.1) |
| `positionForCenter` | `(part, center, mesh?) => Vec3` | The `position` that puts the center at `center` |
| `modelBounds`, `modelHeight` | `(model, meshes?) => Bounds / number` | The finished height is `modelHeight` |
| `groundCenter` | `(model, meshes?) => Vec3` | `(0, lowest y, 0)` |
| `groundModel` | `(model, meshes?) => { model; dy }` | Lowest point to y = 0; `dy` was added to every y. Not rounded |
| `translatePart` | `(part, d) => part` | |
| `roundCoord`, `roundVec3` | `(x, decimals = 6)` | Half away from zero, never −0 |
| `roundModel`, `roundPart` | `(model \| part, decimals = 6)` | Rounds positions, rotations, dims, `crochet.seed`, region lengths, feature sizes, `finishedSize` |
| `COORD_DECIMALS` | `6` | |

### `sdf.ts`

| Export | Signature | What it does |
|---|---|---|
| `partSdf` | `PartSdfFn`: `(part, mesh?: (pLocal: Vec3) => number) => (pWorld: Vec3) => number` | Signed distance in model space, **positive inside**. `mesh` = the part-local SDF of a mesh part |
| `worldSdf` | `(part, mesh?) => (x, y, z) => number` | The same without allocating: for loops |
| `localSdf` | `(part, mesh?) => (x, y, z) => number` | In the part's own frame |
| `overlapVolume` | `OverlapVolumeFn`: `(a, b, o?: { meshSdf?: Record<string, MeshSdf> }) => number` | in³, on the grid of §3.7.6 |
| `overlapVolumeWith` | `(a, b, o?: { meshSdf?; maxSamples?: number; skip?: boolean }) => number` | The same with a sample cap and the reference (non-skipping) mode |
| `surfaceGap` | `SurfaceGapFn`: `(child, parent) => number` | Distance from the nearest child builder vertex to the parent's surface; **≤ 0 when the child touches or enters the parent** |
| `surfaceGapWith` | `(child, parent, meshSdf?) => number` | With the SDFs of mesh parts |
| `gapOfVertices`, `gapProbe`, `partWorldVertices` | | The pieces of `surfaceGap` for callers that measure many pairs |
| `partVolume` | `(part) => number` | Analytic volume, in³ |
| `sdfNormal` | `(f: WorldSdf, p: Vec3, h = 1e-4) => Vec3` | Outward unit normal by central differences |
| `meshSdfOf` | `(part, meshSdf?: Record<string, MeshSdf>) => MeshSdf \| undefined` | Looks up by `dims.meshRef`, then by part id |
| `LocalSdf`, `WorldSdf`, `MeshSdf` | types | |
| `OVERLAP_SPACING_IN`, `OVERLAP_MAX_SAMPLES` | `0.025`, `2_000_000` | |

### `attach.ts`

| Export | Signature | What it does |
|---|---|---|
| `inferAttach` | `InferAttachFn`: `(m, o?: { meshSdf? }) => { model; repairs: Repair[] }` | Completes the attach tree: always ONE tree. Returns the same model object when nothing changes |
| `inferMirrorPairs` | `InferMirrorPairsFn`: `(m, o?: { tolerance? }) => { model; repairs }` | Sets `mirrorOf` on right-side twins |
| `attachGraph` | `(parts: readonly Part[]) => AttachGraph` | `{ index, parent, children, roots, isTree }` by part index |
| `isOneTree` | `(model) => boolean` | What `generateAmigurumi` requires |
| `attachRoot` | `(model) => Part \| undefined` | The root when the links form one tree |
| `subtreeIds` | `(model, id) => string[]` | The part and everything attached to it, breadth first |
| `childrenOf` | `(model, id) => Part[]` | Direct children |
| `chooseRoot` | `(parts) => number` | The index the root rule of §3.7.6 names |
| `leftTwinId` | `(id: string) => string \| null` | `ear_r_inner` → `ear_l_inner`, `leg_fr` → `leg_fl`, `wing_right` → `wing_left` |
| `GAP_WARN_IN`, `GAP_FLOAT_IN` | `0.1`, `0.25` | The `W_GAP` and "floats" thresholds |

`attach-inferred` repairs carry `part`, a message and `data`: `{ to, overlapIn3 }` for a link by overlap,
`{ to, gapIn }` for a link to the nearest part, `{ root: true }` for a root that lost a bad link.
`mirror-inferred` repairs carry `data: { mirrorOf }`.

### `naming.ts`

| Export | Signature | What it does |
|---|---|---|
| `nameParts` | `NamePartsFn`: `(m, o?: { keepIds?: ReadonlySet<string> }) => { model; renames: Record<string, string> }` | Template ids by geometry; rewrites `attach.to`, `mirrorOf`, `features[].on`, `assembly[].part` / `.to` |

### `place.ts`

| Export | Signature | What it does |
|---|---|---|
| `placeChildOnSurface` | `PlaceChildOnSurfaceFn`: `(parent, child, at: { dir } \| { hit, normal }, overlapIn = 0.10, o?: { meshSdf? }) => Part` | The child with a new `position`; rotation, dims and `attach` untouched |
| `placeChildOnSurfaceWith` | `(parent, child, at, overlapIn = 0.10, sources?: SurfaceSources) => Part` | The same with the surfaces of mesh parts (SDFs or triangle buffers, by meshRef) |
| `overlapAlongRay` | `(parent, child, sources?) => number` | How far the child's surface has entered the parent's along the ray between their centers (negative = gap): what T7's seed test calls "overlaps its parent by 0.05–0.15 in along its stacking ray" |
| `surfaceExit` | `(part, origin, dir, sources?) => number \| null` | Distance to the outermost surface point on a ray |
| `captureAnchor` | `(parent, child, sources?) => AttachAnchor` | A child's anchor in its parent's frame: `{ azimuthDeg, elevationDeg, offsetIn, point }` |
| `anchorPoint` | `(parent, anchor, sources?) => Vec3` | Re-projects an anchor onto a (changed) parent |
| `reanchorChildren` | `(before: CrochetModelV1, after: CrochetModelV1, parentId: string, o?: { before?: SurfaceSources; after?: SurfaceSources }) => CrochetModelV1` | §4.2 re-anchoring: translates the attach subtree of every direct child of `parentId` in `after` by its anchor's displacement |
| `SurfaceSources` | `{ meshSdf?: Record<string, MeshSdf>; meshes?: Record<string, ColoredMesh> }` | |
| `DEFAULT_OVERLAP_IN` | `0.1` | |

### `proportions.ts`

| Export | Signature | What it does |
|---|---|---|
| `LIMB_TEMPLATE` | `LimbTemplate` | `quadruped 0.25 / 0.20, quadruped-standing 0.30 / 0.30, biped 0.30 / 0.30, creature 0.15 / 0.15` (arm / leg) |
| `LIMB_FACTORS` | `Record<LimbLength, number>` | `nubs 0.6, short 1, medium 1.5, long 2.2` |
| `limbTemplateRow` | `(m: { category?; pose? }) => keyof LimbTemplate` | quadruped + `pose: 'standing'` → `quadruped-standing`; `biped` / `person` → `biped`; `creature` → `creature`; anything else → `quadruped` |
| `readProportions` | `ReadProportionsFn` | `{ headBody?, limbs?, disabled }` |
| `applyProportions` | `ApplyProportionsFn`: `(m, { headBody?, limbs? }, meshes?) => { model; meshes? }` | §4.2 |
| `resizeLimbs` | `(model, lengths: Record<partId, number>, meshes?) => CrochetModelV1` | The limb edit alone, before any rescale (each limb keeps its proximal pole; children re-anchored) |
| `NO_HEAD_REASON` | `'one-piece body: no separate head'` | |
| `LimbLength`, `LimbTemplate`, `ProportionsReading` | types | Re-exported from `types/entryPoints` |

### `scale.ts`

| Export | Signature | What it does |
|---|---|---|
| `scaleModel` | `ScaleModelFn`: `(m, factor, meshes?) => { model; meshes? }` | Uniform scale about the ground center; throws `RangeError` unless `factor` is finite and > 0 |
| `scalePartDims` | `(part, factor) => part` | One part's lengths about its local origin (`position` untouched) |
| `scaleMesh` | `(mesh: ColoredMesh, factor) => ColoredMesh` | New `positions`; indices and labels shared |

## The canonical teddy: the recipe T7 must reproduce (G12)

`__tests__/helpers/teddy.ts` is the generator. From `fixtures/claude-design/teddy-bear/teddy-bear.crochet-model.json`:

1. **Dialect (§3.7.3).** `dimensions` → `dims` (`radius → r`, `radiusTop/radiusBottom → rTop/rBottom`,
   `height → h`); capsule `length := length + 2·radius`. `palette` object → array in the object's key order,
   `{ id: slug(name) cut to 16 characters (deduped with _2, _3 …), hex: the key as written, name }`. Part `color`
   → palette id by case-insensitive hex. `name` → `label`. World transform =
   `multiplyRigid(World(parent), composeRigid(position, rotationDeg))`, then `decomposeRigid`; `rotationDeg` is
   written for every part whose source had one (here: all). `parent` → `attach: { to, method: 'sewn' }`.
   Eye-like parts (§2.10.1 rule 1) get `crochet: { make: 'safety_eye' }`. Header: `revision: 0`,
   `axes.left: '+X'`, `source: { tool: 'claude-design', stage: 'refined' }`, **`name: 'Imported model'`** (the
   dialect has no name; the spec gives no default — this is ours), top-level `notes` → `assumptions: [notes]`.
2. **Units (§3.7.6).** The bounding-box height is 9.878905 against the stated 10 (ratio 0.988, within 15%): the
   geometry is kept and **the measured height is recorded: `finishedSize: { height: 9.878905 }`**.
3. **Ground:** `groundModel` (dy = +0.078905).
4. **Round:** `roundModel` (1e-6; `[82, 0, −12.000000000000002]` → `[82, 0, −12]`).
5. `inferAttach`, then `inferMirrorPairs`.
6. Write with `stringifyModel`.

Key order (`canonicalizeModel`): model — `schema, version, revision, units, axes, name, description, category,
style, audience, finishedSize, pose, flatBase, yarn, palette, parts, features, assembly, assumptions, source`, then
`x-*`; part — `id, label, type, dims, position, rotationDeg, color, regions, attach, mirrorOf, stuffing, flatten,
notes, crochet, paint`, then `x-*`.

## Measured (M-class laptop, Node 22, single thread)

| What | Budget | Measured |
|---|---|---|
| `inferAttach`, teddy from the dialect (6 links) | ≤ 500 ms | ≈ 23 ms |
| `inferAttach`, teddy with no links at all (16 links) | ≤ 500 ms | ≈ 37 ms |
| `inferAttach`, 60 parts that all overlap one another | — | ≈ 1.2 s (97 s before the work budget) |
| `applyProportions` teddy, head 1:1 / 1:3 | ≤ 200 ms | ≈ 3 ms |
| `applyProportions` teddy, limbs "long" | ≤ 200 ms | ≈ 15 ms |
| `applyProportions` teddy, head 1:1 and limbs "long" together | ≤ 200 ms | ≈ 12 ms |

Teddy goldens (§3.7.3, §3.7.6): positions before grounding match to 1e-3 (muzzle `[0, 6.6, 1.9]`, nose
`[0, 6.9, 2.42]`, eye_l `[0.78, 7.45, 2.02]` at azimuth 22.1° / elevation 6.9°, ear_l `[1.6, 8.95, −0.1]`,
ear_l_inner `[1.5765, 8.9059, 0.16]`, foot_pad_l `[1.4411, 0.9706, 2.6061]` rot `[82, 0, −12]`, leg length 3.1);
grounding +0.0789; volumes body 43.45, head 47.55 in³; overlaps head 0.0654, legs 1.3425, arms 0.6415, tail 0.1134,
head–muzzle 1.4312 in³; world box x ±2.9059, z −2.25 … 2.8202 (research 08 measured the same on the OBJ).

G23 on the teddy: head 1:1 → fraction 0.49997, 1:3 → 0.25002, height 9.878905 → 9.878905/6; ears enter the head
by 0.66 / 0.92 in (gap ≤ 0); limbs "long" → arm 0.55004·H, leg 0.44003·H; proximal poles moved 7e-7 in before the
rescale; `arm_r` is the exact mirror of `arm_l`; `readProportions(teddy)` = `{ headBody: 1.3, limbs: 'short' }`.

## Deviations from the spec, with reasons

1. **`buildModel` has a third parameter and paints more.** `meshes` supplies the buffers of `mesh` parts (the
   normative code has no `mesh` case and would throw on the app's own models); a mesh part without a buffer is
   drawn as the ellipsoid inscribed in `bboxIn`. The `paint` field of primitives and the vertex labels of mesh
   parts are painted on top of the regions (§2.11.1 priority). None of this reaches Claude Design. For specs
   without mesh parts and paint the output is the normative one.
2. **The builder never throws on, or hands NaN to three.js for, a part with broken numbers** (`dims.ts`): a
   non-finite number counts as 0, a negative length as its size, a polygon without points as a rectangle, a
   one-point lathe profile as its ring. It still throws `unknown part type …` like the normative code. Color
   lookups go through a `Map` (see request 9).
3. **SDF solids where the builder leaves a surface open** (§3.7.6 says only "torus arcs … as noted"):
   `cylinder.open` is ignored (solid); a lathe whose profile does not start or end on the axis is closed by a
   flat disc; a torus arc is the tube with round ends (the bent capsule of §2.10.4), which reach `r` past the
   flat ends of the builder's open tube.
4. **A mesh part without a supplied SDF is the ellipsoid inscribed in its `bboxIn` box** — for `partSdf`,
   `overlapVolume`, `surfaceGap`, `placeChildOnSurface`, `inferAttach`.
5. **`overlapVolume` caps its grid at 2 000 000 cells**; a larger intersection gets proportionally larger cells.
   `inferAttach` additionally shares 40 000 000 cells between the pairs of touching boxes (never less than
   32 768 per pair), so its cap drops below 2 000 000 only for models with more than 20 such pairs whose
   intersections are large. Ordinary models (the teddy) get exactly the grid of §3.7.6.
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
   of the root above the root's center holding ≥ 15% of its volume; pairs that reach the ground are ordered back
   to front (so a standing quadruped's back pair is `leg`, its front pair `arm`, matching §4.2's "arms (its front
   legs)"); only the highest pair above the head's center becomes `ear`; among several single children in front
   of the head / behind the body the largest is `muzzle` / `tail`. It does not write labels or `mirrorOf`.
10. **`placeChildOnSurface`:** "the parent's surface" on the ray is its OUTERMOST point on that ray (a concave
    lathe, a torus). A ray that misses the parent (through a torus) starts from the parent's center. `o.meshSdf`
    belongs to the mesh part of the pair — the parent's when both are meshes. The position is rounded to 1e-6.
11. **Re-anchoring uses its own contact point.** §4.2 refers to the attach anchor of §2.12 step 1, which is T4's
    (it needs trimming). Here the anchor follows the centroid of the volume the child shares with its parent
    (measured on a 21³ grid in the child's frame, so mirror twins get mirrored anchors), or the child's layer
    nearest the parent when they do not touch; the direction is from the parent's center, the offset along the
    parent's surface normal. A mesh parent known only by its triangles uses the child's center.
12. **`applyProportions`:**
    - one bisection on the height ratio of the edit instead of one on k; for the head alone it solves the same
      equation as §4.2 (k stays within [0.2, 5]); head and limbs given together are solved jointly;
    - a control that is disabled, or a value that is not usable, is ignored (the model comes back unchanged)
      rather than throwing;
    - after the rescale the model's lowest point is put back where it was (long arms can reach below the feet);
    - `mirrorOf` twins that were exact mirrors stay exact mirrors;
    - a capsule limb never gets shorter than its two caps (teddy legs "nubs": 0.152·H instead of 0.12·H).
13. **`readProportions`:** `headBody` is rounded to two decimals (teddy: 1.3); `limbs` is read from the arms
    (geometric mean of length / (height × template)), from the legs when there are no arms; `limb<n>_*` uses the
    arm template; limb ids match `/^(arm|leg|limb\d+)(_|$)/`.
14. **`scaleModel`:** the ground center is `(0, lowest y, 0)`, not the middle of the footprint: mirror pairs stay
    mirrored across x = 0, and a grounded model has every coordinate multiplied by the factor (so it also serves
    unit conversion). It also scales region lengths (`widthIn`, `radiusIn`, `scaleIn`), feature sizes (`sizeIn`
    and `sizeMm`), `crochet.seed` and `finishedSize`. **A dimension never falls below 0.05 in** (a teddy scaled to
    3 in keeps its 0.036 in inner-ear thickness at 0.05), so a valid model stays valid; nothing is limited at the
    top (the caller keeps results within 48 in / 60 in).
15. **Rounding.** Every kernel that derives coordinates (`placeChildOnSurface`, `reanchorChildren`,
    `applyProportions`, `scaleModel`) rounds them to 1e-6 (half away from zero; −0 becomes 0). `groundModel`,
    the transforms and `inferAttach` do not round.
16. **Part centers:** `localCenter` is also non-zero for a torus arc (its builder geometry is not centered
    either); §0.1 says "`c_local` = 0 except lathe".
17. **Bounding boxes are the exact extents of the builder solid** (analytic support functions), not of its
    tessellated vertices — the spec's own golden (grounding +0.0789) is the analytic one. Flat parts use the
    builder's vertices, bevel included.
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
| Angles | `azimuthDeg` −360…360, `elevationDeg` −90…90, `spanDeg` (0, 360], `arcDeg` (0, 360]; `from ≤ to` |
| References | Part, palette and feature ids unique; `color`, region colors, feature colors must be palette ids; `attach.to`, `mirrorOf`, `feature.on` must be parts; no self links; no attach cycle. **Several roots are valid** (the tree is completed by `inferAttach`). `assembly[].part` / `.to` are free text |
| Feature ids | Same pattern as part ids |
| §3.7.6 "prototype keys" | `__proto__`, `constructor`, `prototype` as a KEY anywhere in the document is an error (they are fine as values) |
| §3.7.6 overlap grid "smallest extent / 8" | The smallest extent of the intersection box |
| §3.7.6 root rule "largest by volume" | Analytic volumes (`partVolume`); a flat part = outline × thickness; a mesh part = its inscribed ellipsoid |
| §3.7.6 "ties within 1% → larger c, then id" | Among the pairs within 1% of the largest overlap: the larger `c`, then the lower id, then the larger overlap, then the tree part that joined first |
| §3.7.6 units "record the measured height" | `finishedSize.height :=` the measured bounding-box height |
| §2.11.1 paint grid | Row-major, `row = ⌊v·64⌋`, `column = ⌊u·64⌋` (`uv64Cell`) |
| `meshSdf` records | Keyed by `dims.meshRef` (like `ImportResult.meshes`), else by part id; the functions are part-local |
| §4.2 limb "proximal end" with no SDF for a mesh parent | The pole nearer the parent's center |
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
   T4 snaps to the sizes that exist) and that dims stop at the schema minimum.
7. **§0.1:** `c_local` of a torus arc (deviation 16).
8. **§2.11.1:** pin the uv64 cell layout (T3 writes it, T4 and T6 read it): `uv64Cell` in `builder.ts`.
9. **§3.4.1, normative JS (T7's `builderSource`):** `pal` and `mats` are plain objects, and `constructor` is a
   valid palette id by `/^[a-z0-9_]{1,16}$/`: `pal['constructor'] ?? '#cccccc'` yields the `Object` function for
   an unknown id. Use `Object.create(null)` (or a `Map`) in the embedded JS. A `polygon` without `points` throws
   there.
10. **§3.4.1 flat parts, for T4:** the builder's bevel grows the outline by `min(0.3·t, 0.1·min(w, h))` at
    mid-thickness, so the mesh holds 8–36% more volume than outline × thickness, and a `teardrop` of width `w` is
    only 0.79·w wide (the Bézier of `shape2D`). The SDF ignores the bevel, as §3.7.6 says.
11. **`W_GAP`:** `inferAttach` returns repairs, not issues (frozen type). A link made by gap carries
    `data.gapIn`; whoever builds `Issue`s raises `W_GAP` above `GAP_WARN_IN`.
12. **T6:** `reanchorChildren(before, after, parentId)` is the §4.2 re-anchoring; the T6 golden ("scaling the
    teddy head 1.2× keeps each ear's gap ≤ 0.1 in and its (az, el) within 1°") is already a test here.
13. **`Repair.code`:** there is no code for "a bad attach link was removed"; `attach-inferred` is used.

## Not done, not verified

- `revisions.ts` (`carryOver`) is another agent's.
- No browser run: everything was exercised in the vitest `node` environment only (three.js geometry classes need
  no DOM; no renderer is created).
- The plain-JS form of the builder that the prompt embeds is T7's (`core/qa/builderSource`); it was not written
  or compared here.
- `docs/schema/crochet-model-1.0.schema.json` is T7's; only that `z.toJSONSchema(crochetModelCoreSchema)` works
  and gives `oneOf` branches with `additionalProperties: false` was checked.
