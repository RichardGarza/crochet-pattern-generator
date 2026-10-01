// Track T5 — plane cut of a part volume (DESIGN.md §2.9.8, §4.2 Cut, §2.9.7 step 2 neck split).
//
// With the plane's signed distance d(p) = n̂·(p − point) (positive on the side the normal points to):
//   f_a = min(f, −d)   the piece BEHIND the plane (opposite the normal)
//   f_b = min(f, d)    the piece IN FRONT of the plane (the normal's side)
// Each is meshed with marching cubes + 10 Taubin pairs; the model recipe (T6) names them `<id>_a`, `<id>_b`, with
// b attached to a. Labels are carried from the part's current mesh by nearest vertex.
import { countComponents, signedVolume } from '../kernel/geom/meshMeasures';
import type { ColoredMesh, Vec3 } from '../../types/geometry';
import { coloredRemesh, FINAL_TAUBIN_PAIRS } from './remesh';
import { checkVolume, hasInside, MeshToolError, type FieldVolume } from './volume';

export interface CutPlane {
  point: Vec3;
  normal: Vec3;
}

export interface CutPiece {
  volume: FieldVolume;
  mesh: ColoredMesh;
  /** in³, of the smoothed mesh. */
  volumeIn3: number;
  /** Connected pieces of the mesh (a plane through a U shape leaves two on one side). */
  components: number;
}

function unitNormal(n: Vec3): Vec3 {
  if (!Array.isArray(n) || n.length !== 3 || !n.every((c) => Number.isFinite(c))) throw new RangeError(`bad plane normal ${String(n)}`);
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 0)) throw new RangeError('the plane normal has no length');
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** The two fields of the cut (new buffers; `v` is not modified). */
export function cutVolume(v: FieldVolume, plane: CutPlane): { a: FieldVolume; b: FieldVolume } {
  checkVolume(v);
  const n = unitNormal(plane.normal);
  const p = plane.point;
  if (!Array.isArray(p) || p.length !== 3 || !p.every((c) => Number.isFinite(c))) throw new RangeError(`bad plane point ${String(p)}`);
  const [nx, ny, nz] = v.dims;
  const fa = new Float32Array(v.field.length);
  const fb = new Float32Array(v.field.length);
  let i = 0;
  for (let z = 0; z < nz; z++) {
    const dz = n[2] * (v.origin[2] + z * v.voxel - p[2]);
    for (let y = 0; y < ny; y++) {
      const dyz = dz + n[1] * (v.origin[1] + y * v.voxel - p[1]);
      for (let x = 0; x < nx; x++, i++) {
        const d = dyz + n[0] * (v.origin[0] + x * v.voxel - p[0]);
        const f = v.field[i];
        fa[i] = Math.min(f, -d);
        fb[i] = Math.min(f, d);
      }
    }
  }
  const frame = { dims: [nx, ny, nz] as [number, number, number], voxel: v.voxel };
  return {
    a: { field: fa, ...frame, origin: [v.origin[0], v.origin[1], v.origin[2]] },
    b: { field: fb, ...frame, origin: [v.origin[0], v.origin[1], v.origin[2]] },
  };
}

/**
 * Cuts a part volume with a plane and meshes both pieces. Throws `MeshToolError('cut-misses')` when the plane
 * leaves all of the part on one side, or only a sliver smaller than one voxel³ on one side.
 */
export function cutPart(v: FieldVolume, plane: CutPlane, labelsFrom?: ColoredMesh, o: { pairs?: number } = {}): [CutPiece, CutPiece] {
  const { a, b } = cutVolume(v, plane);
  if (!hasInside(a) || !hasInside(b)) throw new MeshToolError('cut-misses', 'the plane does not cut this part');
  const pairs = o.pairs ?? FINAL_TAUBIN_PAIRS;
  const piece = (vol: FieldVolume): CutPiece => {
    const mesh = coloredRemesh(vol, labelsFrom, { pairs });
    return { volume: vol, mesh, volumeIn3: signedVolume(mesh), components: countComponents(mesh.indices) };
  };
  const pa = piece(a);
  const pb = piece(b);
  // A plane that only grazes the part leaves a sliver smaller than one voxel: not a piece anyone can crochet.
  const minPiece = v.voxel * v.voxel * v.voxel;
  if (!(pa.volumeIn3 >= minPiece) || !(pb.volumeIn3 >= minPiece)) throw new MeshToolError('cut-misses', 'the plane does not cut this part');
  return [pa, pb];
}
