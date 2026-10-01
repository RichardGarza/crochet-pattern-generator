// Uniform scaling of a model (DESIGN.md §4.2 "Scale model to height", §5.2.1). Step 0 kernel: pure.
//
// `scaleModel` is the one kernel behind the editor's Scale model to height, the Yarn & size panel and the final
// rescale of `applyProportions`: every part is scaled about the ground center (positions, dims, lathe profiles,
// polygon points, mesh vertices), so the model keeps its shape, its lowest point and its mirror plane.
import type { ScaleModelFn } from '../../types/entryPoints';
import type { ColoredMesh } from '../../types/geometry';
import type { Part, Region, Vec3 } from '../../types/model';
import { groundCenter, roundCoord } from './transforms';

/**
 * The part with every length multiplied by `factor` about its LOCAL ORIGIN: dims (profile and polygon points
 * included, a mesh part's `bboxIn`), region lengths (`widthIn`, `radiusIn`, `scaleIn`) and `crochet.seed`.
 * `position`, the rotation, angles, fractions and the paint field are unchanged. Lengths are rounded to 1e-6 in.
 */
export function scalePartDims<P extends Part>(part: P, factor: number): P {
  const s = (x: number): number => roundCoord(x * factor);
  let out: Part;
  switch (part.type) {
    case 'sphere':
      out = { ...part, dims: { ...part.dims, r: s(part.dims.r) } };
      break;
    case 'ellipsoid':
      out = { ...part, dims: { ...part.dims, rx: s(part.dims.rx), ry: s(part.dims.ry), rz: s(part.dims.rz) } };
      break;
    case 'capsule':
      out = { ...part, dims: { ...part.dims, r: s(part.dims.r), length: s(part.dims.length) } };
      break;
    case 'cylinder':
      out = { ...part, dims: { ...part.dims, rTop: s(part.dims.rTop), rBottom: s(part.dims.rBottom), h: s(part.dims.h) } };
      break;
    case 'cone':
      out = { ...part, dims: { ...part.dims, r: s(part.dims.r), h: s(part.dims.h) } };
      break;
    case 'torus':
      out = { ...part, dims: { ...part.dims, R: s(part.dims.R), r: s(part.dims.r) } };
      break;
    case 'lathe':
      out = { ...part, dims: { ...part.dims, profile: part.dims.profile.map(([r, y]): [number, number] => [s(r), s(y)]) } };
      break;
    case 'flat': {
      const dims = { ...part.dims, w: s(part.dims.w), h: s(part.dims.h), thickness: s(part.dims.thickness) };
      if (part.dims.points) dims.points = part.dims.points.map(([x, y]): [number, number] => [s(x), s(y)]);
      out = { ...part, dims };
      break;
    }
    case 'box':
      out = { ...part, dims: { ...part.dims, w: s(part.dims.w), h: s(part.dims.h), d: s(part.dims.d) } };
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
