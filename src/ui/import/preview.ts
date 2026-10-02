// Track T7.4 — a flat front view of a model for the import screens: each part's builder geometry (§3.4.1, the Step 0
// `tessellatePart`) moved to model space and seen from the front (+Z toward the viewer, the toy's own left on the
// viewer's right), drawn as its outline filled with its yarn color, back to front. No WebGL: it is an SVG, so it
// shows before Accept, in light and dark, and in tests. Loaded on demand (the builder pulls in three.js).
import { tessellatePart } from '../../core/model/builder';
import { composeRigid, applyRigid } from '../../core/model/transforms';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1, Vec3 } from '../../types/model';

export interface Silhouette {
  part: string;
  /** SVG path in model inches, y up (the caller flips it). */
  d: string;
  fill: string;
  /** Mean depth (larger = nearer the viewer). */
  z: number;
}

export interface FrontView {
  shapes: Silhouette[];
  /** Model-space bounds of the view: [minX, minY, maxX, maxY]. */
  box: [number, number, number, number];
}

/** Andrew's monotone chain; points as flat [x0, y0, x1, y1, …]. Returns the hull counter-clockwise. */
export function convexHull(flat: ArrayLike<number>): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = flat[i];
    const y = flat[i + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
  }
  if (pts.length < 3) return pts;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

const r3 = (x: number): string => String(Math.round(x * 1000) / 1000);

/** The front view of `model` (mesh parts drawn from `meshes` when given, else as their bounding ellipsoid). */
export function frontView(model: CrochetModelV1, meshes?: Record<string, ColoredMesh>): FrontView {
  const hexOf = new Map(model.palette.map((c) => [c.id, c.hex]));
  const shapes: Silhouette[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const part of model.parts) {
    let positions: Float32Array;
    try {
      const mesh = part.type === 'mesh' ? meshes?.[part.dims.meshRef] : undefined;
      if (part.type === 'mesh' && !mesh) {
        // no buffers: its bounding ellipsoid stands in
        const [bx, by, bz] = part.dims.bboxIn;
        positions = tessellatePart({ ...part, type: 'ellipsoid', dims: { rx: bx / 2, ry: by / 2, rz: bz / 2 } }).positions;
      } else {
        positions = tessellatePart(part, meshes).positions;
      }
    } catch {
      continue;
    }
    if (positions.length < 9) continue;
    const t = composeRigid(part.position, part.rotationDeg);
    const flat = new Float64Array((positions.length / 3) * 2);
    let zSum = 0;
    for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
      const w: Vec3 = applyRigid(t, [positions[i], positions[i + 1], positions[i + 2]]);
      flat[j] = w[0];
      flat[j + 1] = w[1];
      zSum += w[2];
    }
    const hull = convexHull(flat);
    if (hull.length < 3) continue;
    for (const [x, y] of hull) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const d = `M${hull.map(([x, y]) => `${r3(x)} ${r3(y)}`).join('L')}Z`;
    shapes.push({ part: part.id, d, fill: hexOf.get(part.color) ?? '#9e9e9e', z: zSum / (positions.length / 3) });
  }
  shapes.sort((a, b) => a.z - b.z || (a.part < b.part ? -1 : 1));
  if (!Number.isFinite(minX)) return { shapes, box: [-1, 0, 1, 1] };
  return { shapes, box: [minX, minY, maxX, maxY] };
}
