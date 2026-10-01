// Uniform scaling of a model (DESIGN.md §4.2 "Scale model to height", §5.2.1). Step 0 kernel: pure.
//
// `scaleModel` is the one kernel behind the editor's Scale model to height, the Yarn & size panel and the final
// rescale of `applyProportions`: every part is scaled about the ground center (positions, dims, lathe profiles,
// polygon points, mesh vertices), so the model keeps its shape, its lowest point and its mirror plane.
import type { ScaleModelFn } from '../../types/entryPoints';
import type { ColoredMesh } from '../../types/geometry';
import type { Part, Region, Vec3 } from '../../types/model';
import { MODEL_LIMITS } from './limits';
import { groundCenter, roundCoord } from './transforms';

/**
 * The part with every length multiplied by `factor` about its LOCAL ORIGIN: dims (profile and polygon points
 * included, a mesh part's `bboxIn`), region lengths (`widthIn`, `radiusIn`, `scaleIn`) and `crochet.seed`.
 * `position`, the rotation, angles, fractions and the paint field are unchanged. Lengths are rounded to 1e-6 in.
 *
 * A dimension that would fall below the schema minimum (0.05 in, §3.5.2) stays at that minimum, a capsule stays
 * at least as long as its two caps, and a lathe profile whose largest radius or height would fall below it is
 * scaled by the smallest larger factor that keeps both (its shape is kept), so a valid model is still valid after
 * it was scaled down. Polygon points are scaled freely (the schema bounds them only at ±48 in). Nothing is limited
 * at the upper end: a caller that scales up keeps the result within 48 in per dimension and 60 in of height.
 */
export function scalePartDims<P extends Part>(part: P, factor: number): P {
  const s = (x: number): number => roundCoord(x * factor);
  /** A dimension the schema keeps at 0.05 in or more. */
  const d = (x: number): number => {
    const scaled = s(x);
    return x >= MODEL_LIMITS.minDimIn && scaled < MODEL_LIMITS.minDimIn ? MODEL_LIMITS.minDimIn : scaled;
  };
  let out: Part;
  switch (part.type) {
    case 'sphere':
      out = { ...part, dims: { ...part.dims, r: d(part.dims.r) } };
      break;
    case 'ellipsoid':
      out = { ...part, dims: { ...part.dims, rx: d(part.dims.rx), ry: d(part.dims.ry), rz: d(part.dims.rz) } };
      break;
    case 'capsule': {
      const r = d(part.dims.r);
      const length = d(part.dims.length);
      out = { ...part, dims: { ...part.dims, r, length: part.dims.length >= 2 * part.dims.r && length < 2 * r ? roundCoord(2 * r) : length } };
      break;
    }
    case 'cylinder':
      out = { ...part, dims: { ...part.dims, rTop: d(part.dims.rTop), rBottom: d(part.dims.rBottom), h: d(part.dims.h) } };
      break;
    case 'cone':
      out = { ...part, dims: { ...part.dims, r: d(part.dims.r), h: d(part.dims.h) } };
      break;
    case 'torus':
      out = { ...part, dims: { ...part.dims, R: d(part.dims.R), r: d(part.dims.r) } };
      break;
    case 'lathe':
      out = { ...part, dims: { ...part.dims, profile: scaleProfile(part.dims.profile, factor) } };
      break;
    case 'flat': {
      const dims = { ...part.dims, w: d(part.dims.w), h: d(part.dims.h), thickness: d(part.dims.thickness) };
      if (part.dims.points) dims.points = part.dims.points.map(([x, y]): [number, number] => [s(x), s(y)]);
      out = { ...part, dims };
      break;
    }
    case 'box':
      out = { ...part, dims: { ...part.dims, w: d(part.dims.w), h: d(part.dims.h), d: d(part.dims.d) } };
      break;
    case 'mesh': {
      const b = part.dims.bboxIn;
      out = { ...part, dims: { ...part.dims, bboxIn: [s(b[0]), s(b[1]), s(b[2])] } };
      break;
    }
    default:
      out = part;
  }
  if (part.regions) {
    out.regions = part.regions.map((r): Region => {
      if (r.kind === 'stripes') return { ...r, widthIn: s(r.widthIn) };
      if (r.kind === 'spot') return { ...r, radiusIn: s(r.radiusIn) };
      if (r.kind === 'pattern' && r.scaleIn !== undefined) return { ...r, scaleIn: s(r.scaleIn) };
      return r;
    });
  }
  if (part.crochet?.seed) {
    const seed = part.crochet.seed;
    out.crochet = { ...part.crochet, seed: [s(seed[0]), s(seed[1]), s(seed[2])] };
  }
  return out as P;
}

type Profile = readonly (readonly [number, number])[];

const largestRadius = (profile: Profile): number => profile.reduce((m, [r]) => (r > m ? r : m), 0);
const profileHeight = (profile: Profile): number => (profile.length > 1 ? profile[profile.length - 1][1] - profile[0][1] : 0);

/**
 * A lathe profile scaled by `factor` about the local origin (lengths rounded to 1e-6 in) — unless that would take
 * its largest radius or its height (last y − first y) below the schema minimum of 0.05 in (§3.5.2) when it was not
 * below it already: then by the smallest larger factor that keeps both, so the profile keeps its shape. The
 * height's two ends are rounded separately, so it gets a margin of 2e-6 in.
 */
function scaleProfile(profile: Profile, factor: number): [number, number][] {
  const at = (f: number): [number, number][] => profile.map(([r, y]): [number, number] => [roundCoord(r * f), roundCoord(y * f)]);
  const min = MODEL_LIMITS.minDimIn;
  const scaled = at(factor);
  let f = factor;
  const r0 = largestRadius(profile);
  if (r0 >= min && largestRadius(scaled) < min) f = Math.max(f, min / r0);
  const h0 = profileHeight(profile);
  if (h0 >= min && profileHeight(scaled) < min) f = Math.max(f, (min + 2e-6) / h0);
  return f === factor ? scaled : at(f);
}

/** A mesh with every vertex multiplied by `factor` (part-local, about the local origin). Indices and labels are shared, not copied. */
export function scaleMesh(mesh: ColoredMesh, factor: number): ColoredMesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = mesh.positions[i] * factor;
  return { ...mesh, positions };
}

/**
 * Scales the whole model uniformly by `factor` about its ground center (§4.2): every position, every dimension
 * and lathe profile, region lengths, feature sizes, `finishedSize`, and — when `meshes` is passed — the vertex
 * buffers of mesh parts (returned as new `positions` arrays; the input is never modified). The bounding-box
 * height scales by exactly `factor` (up to the 1e-6 in rounding of the results).
 *
 * The ground center is (0, the model's lowest y, 0): mirror pairs stay mirrored across x = 0, the lowest point
 * stays where it is, and a grounded model simply has every coordinate multiplied by `factor`.
 * Throws a RangeError unless `factor` is a finite number above 0.
 */
export const scaleModel: ScaleModelFn = (m, factor, meshes) => {
  if (!(typeof factor === 'number' && Number.isFinite(factor) && factor > 0)) {
    throw new RangeError(`scaleModel: factor must be a finite number above 0, got ${String(factor)}`);
  }
  if (factor === 1) return meshes === undefined ? { model: m } : { model: m, meshes };
  const g = groundCenter(m, meshes);
  const s = (x: number): number => roundCoord(x * factor);
  const parts = m.parts.map((p) => {
    const scaled = scalePartDims(p, factor);
    const position: Vec3 = [
      roundCoord(g[0] + (p.position[0] - g[0]) * factor),
      roundCoord(g[1] + (p.position[1] - g[1]) * factor),
      roundCoord(g[2] + (p.position[2] - g[2]) * factor),
    ];
    return { ...scaled, position };
  });
  const finishedSize = { ...m.finishedSize, height: s(m.finishedSize.height) };
  if (m.finishedSize.width !== undefined) finishedSize.width = s(m.finishedSize.width);
  if (m.finishedSize.depth !== undefined) finishedSize.depth = s(m.finishedSize.depth);
  const model = { ...m, finishedSize, parts };
  if (m.features) {
    model.features = m.features.map((f) => {
      const out = { ...f };
      if (f.sizeIn !== undefined) out.sizeIn = s(f.sizeIn);
      if (f.sizeMm !== undefined) out.sizeMm = s(f.sizeMm);
      return out;
    });
  }
  if (meshes === undefined) return { model };
  const scaled = Object.fromEntries(Object.entries(meshes).map(([key, mesh]) => [key, scaleMesh(mesh, factor)]));
  return { model, meshes: scaled };
};
