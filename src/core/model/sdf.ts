// Analytic signed distance functions of the crochet-model primitives (DESIGN.md §3.7.6). Step 0 kernel.
//
// POSITIVE INSIDE, inches, builder semantics (§3.4.1): each function describes the solid that `buildModel`
// tessellates. Exact distances for sphere, capsule, cylinder, cone, box, lathe (2D distance to the profile in
// the meridian half-plane) and torus; the ellipsoid uses the standard bound k0·(k0 − 1)/k1 (exact sign, first
// order near the surface); a flat part is its 2D outline extruded by its thickness (the builder's bevel, which
// grows the outline by at most `flatBevelSize` at mid-thickness, is ignored).
//
// Solids where the builder leaves a surface open:
//   - `cylinder.open` is ignored: an open tube is a solid for contact, overlap and trimming;
//   - a lathe whose profile does not start or end on the axis is closed there by a flat disc;
//   - a torus arc is the tube swept along the arc with ROUND ends (a bent capsule, §2.10.4), which reach
//     `r` past the flat ends of the builder's open tube.
// Mesh parts take their SDF from the caller (part-local, positive inside, usually the stored voxel volume);
// without one they are the ellipsoid inscribed in their `bboxIn` box.
import type { OverlapVolumeFn, PartSdfFn, SurfaceGapFn } from '../../types/entryPoints';
import type { Part, Vec3 } from '../../types/model';
import { DEG2RAD } from '../kernel/vec';
import { flatLayout, tessellatePart } from './builder';
import { sanePart } from './dims';
import { eulerXYZToMat3, worldBounds } from './transforms';

/** A signed distance in a part's local frame, positive inside. */
export type LocalSdf = (x: number, y: number, z: number) => number;
/** A signed distance in model space, positive inside; takes plain numbers, so it never allocates. */
export type WorldSdf = (x: number, y: number, z: number) => number;
/** The SDF a caller supplies for a mesh part: part-local inches, positive inside. */
export type MeshSdf = (pLocal: Vec3) => number;

/** Grid spacing of `overlapVolume` (§3.7.6): min(0.025 in, smallest extent of the intersection box / 8). */
export const OVERLAP_SPACING_IN = 0.025;
/** `overlapVolume` never samples more points than this; larger boxes get proportionally larger cells. */
export const OVERLAP_MAX_SAMPLES = 2_000_000;

const tiny = (x: number): number => (x > 1e-9 ? x : 1e-9);

// Math.sqrt of a sum of squares, not Math.hypot: these run millions of times per overlap grid, and V8's hypot is
// several times slower. The magnitudes here (inches) are nowhere near overflow or underflow.

function sphereSdf(r: number): LocalSdf {
  return (x, y, z) => r - Math.sqrt(x * x + y * y + z * z);
}

function ellipsoidSdf(rxIn: number, ryIn: number, rzIn: number): LocalSdf {
  const rx = tiny(rxIn);
  const ry = tiny(ryIn);
  const rz = tiny(rzIn);
  const smallest = Math.min(rx, ry, rz);
  const ix = 1 / rx;
  const iy = 1 / ry;
  const iz = 1 / rz;
  return (x, y, z) => {
    const ax = x * ix;
    const ay = y * iy;
    const az = z * iz;
    const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
    const bx = ax * ix;
    const by = ay * iy;
    const bz = az * iz;
    const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
    if (k1 < 1e-12) return smallest; // the center
    return (k0 * (1 - k0)) / k1;
  };
}

function capsuleSdf(r: number, totalLength: number): LocalSdf {
  const s = Math.max(0, totalLength / 2 - r); // half the straight section, as the builder clamps it
  return (x, y, z) => {
    const dy = y < -s ? y + s : y > s ? y - s : 0;
    return r - Math.sqrt(x * x + dy * dy + z * z);
  };
}

/**
 * The solid of revolution of a profile `[radius, y]` about the local Y axis: the region between the axis and
 * the polyline, closed by a flat disc at an end that is not on the axis. Exact: the nearest surface point of a
 * surface of revolution lies in the query point's own meridian half-plane.
 */
function revolvedSdf(profile: ReadonlyArray<readonly [number, number]>): LocalSdf {
  const n = profile.length;
  if (n === 0) return () => -Infinity;
  const pr = profile.map((p) => Math.max(0, p[0]));
  const py = profile.map((p) => p[1]);
  // Boundary segments in the (ρ, y) half-plane: the profile, plus the caps.
  const ax: number[] = [];
  const ay: number[] = [];
  const ex: number[] = [];
  const ey: number[] = [];
  const push = (x0: number, y0: number, x1: number, y1: number): void => {
    ax.push(x0);
    ay.push(y0);
    ex.push(x1 - x0);
    ey.push(y1 - y0);
  };
  if (pr[0] > 0) push(0, py[0], pr[0], py[0]);
  for (let i = 0; i + 1 < n; i++) push(pr[i], py[i], pr[i + 1], py[i + 1]);
  if (pr[n - 1] > 0) push(pr[n - 1], py[n - 1], 0, py[n - 1]);
  if (ax.length === 0) push(pr[0], py[0], pr[0], py[0]); // a single point on the axis
  const m = ax.length;
  return (x, y, z) => {
    const rho = Math.sqrt(x * x + z * z);
    let best = Infinity;
    for (let i = 0; i < m; i++) {
      const wx = rho - ax[i];
      const wy = y - ay[i];
      const len2 = ex[i] * ex[i] + ey[i] * ey[i];
      let t = len2 > 0 ? (wx * ex[i] + wy * ey[i]) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const bx = wx - ex[i] * t;
      const by = wy - ey[i] * t;
      const d2 = bx * bx + by * by;
      if (d2 < best) best = d2;
    }
    // Inside when a ray toward +ρ crosses the profile an odd number of times (half-open rule in y).
    let inside = false;
    for (let i = 0; i + 1 < n; i++) {
      const y0 = py[i];
      const y1 = py[i + 1];
      if (y0 > y !== y1 > y) {
        const xi = pr[i] + ((y - y0) / (y1 - y0)) * (pr[i + 1] - pr[i]);
        if (xi > rho) inside = !inside;
      }
    }
    const d = Math.sqrt(best);
    return inside ? d : -d;
  };
}

function torusSdf(R: number, r: number, arcDeg: number | undefined): LocalSdf {
  const arc = Math.min(360, Math.max(0, arcDeg ?? 360)) * DEG2RAD;
  const ring = (x: number, y: number, z: number): number => {
    const q = Math.sqrt(x * x + y * y) - R;
    return r - Math.sqrt(q * q + z * z);
  };
  if (arc >= 2 * Math.PI - 1e-12) return ring;
  const e1x = R * Math.cos(arc);
  const e1y = R * Math.sin(arc);
  return (x, y, z) => {
    let theta = Math.atan2(y, x);
    if (theta < 0) theta += 2 * Math.PI;
    if (theta <= arc) return ring(x, y, z);
    // Past the ends: the nearer end of the center line.
    return r - Math.min(Math.hypot(x - R, y, z), Math.hypot(x - e1x, y - e1y, z));
  };
}

function boxSdf(hx: number, hy: number, hz: number): LocalSdf {
  return (x, y, z) => {
    const a = hx - Math.abs(x);
    const b = hy - Math.abs(y);
    const c = hz - Math.abs(z);
    if (a >= 0 && b >= 0 && c >= 0) return a < b ? (a < c ? a : c) : b < c ? b : c;
    const oa = a < 0 ? a : 0;
    const ob = b < 0 ? b : 0;
    const oc = c < 0 ? c : 0;
    return -Math.sqrt(oa * oa + ob * ob + oc * oc);
  };
}

/** Signed distance to a closed 2D polygon [x0, y0, x1, y1, …], positive inside (even-odd rule). */
function polygonSdf(outline: ArrayLike<number>): (x: number, y: number) => number {
  const n = outline.length >> 1;
  if (n === 0) return () => -Infinity;
  return (x, y) => {
    let best = Infinity;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = outline[2 * i];
      const yi = outline[2 * i + 1];
      const xj = outline[2 * j];
      const yj = outline[2 * j + 1];
      const ex = xj - xi;
      const ey = yj - yi;
      const wx = x - xi;
      const wy = y - yi;
      const len2 = ex * ex + ey * ey;
      let t = len2 > 0 ? (wx * ex + wy * ey) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const bx = wx - ex * t;
      const by = wy - ey * t;
      const d2 = bx * bx + by * by;
      if (d2 < best) best = d2;
      if (yi > y !== yj > y && x < xi + ((y - yi) / (yj - yi)) * (xj - xi)) inside = !inside;
    }
    const d = Math.sqrt(best);
    return inside ? d : -d;
  };
}

function prismSdf(outline: ArrayLike<number>, halfThickness: number): LocalSdf {
  const polygon = polygonSdf(outline);
  return (x, y, z) => {
    const a = polygon(x, y);
    const b = halfThickness - Math.abs(z);
    if (a >= 0 && b >= 0) return Math.min(a, b);
    return -Math.hypot(Math.min(a, 0), Math.min(b, 0));
  };
}

/**
 * The signed distance of a part in its own local frame, positive inside. `mesh` is the caller's SDF of a mesh
 * part (part-local); it is ignored for primitives.
 */
export function localSdf(given: Part, mesh?: MeshSdf): LocalSdf {
  const part = sanePart(given);
  switch (part.type) {
    case 'sphere':
      return sphereSdf(part.dims.r);
    case 'ellipsoid':
      return ellipsoidSdf(part.dims.rx, part.dims.ry, part.dims.rz);
    case 'capsule':
      return capsuleSdf(part.dims.r, part.dims.length);
    case 'cylinder': {
      const half = part.dims.h / 2;
      return revolvedSdf([
        [part.dims.rBottom, -half],
        [part.dims.rTop, half],
      ]);
    }
    case 'cone': {
      const half = part.dims.h / 2;
      return revolvedSdf([
        [part.dims.r, -half],
        [0, half],
      ]);
    }
    case 'torus':
      return torusSdf(part.dims.R, part.dims.r, part.dims.arcDeg);
    case 'lathe':
      return revolvedSdf(part.dims.profile);
    case 'box':
      return boxSdf(part.dims.w / 2, part.dims.h / 2, part.dims.d / 2);
    case 'flat':
      return prismSdf(flatLayout(part.dims).outline, part.dims.thickness / 2);
    case 'mesh': {
      if (mesh) return (x, y, z) => mesh([x, y, z]);
      const [bx, by, bz] = part.dims.bboxIn;
      return ellipsoidSdf(bx / 2, by / 2, bz / 2);
    }
    default:
      return () => -Infinity;
  }
}

/** `partSdf` taking plain numbers: the form the grid and vertex loops of the kernels use. */
export function worldSdf(part: Part, mesh?: MeshSdf): WorldSdf {
  const f = localSdf(part, mesh);
  const r = eulerXYZToMat3(part.rotationDeg);
  const [px, py, pz] = part.position;
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = r;
  if (r0 === 1 && r4 === 1 && r8 === 1) return (x, y, z) => f(x - px, y - py, z - pz);
  // Rᵀ·(p − position)
  return (x, y, z) => {
    const dx = x - px;
    const dy = y - py;
    const dz = z - pz;
    return f(r0 * dx + r3 * dy + r6 * dz, r1 * dx + r4 * dy + r7 * dz, r2 * dx + r5 * dy + r8 * dz);
  };
}

/**
 * The signed distance of a part in model space, positive inside (§3.7.6). `mesh` is the part-local SDF of a
 * mesh part (usually sampled from its stored `sdf:<meshRef>` volume).
 */
export const partSdf: PartSdfFn = (part, mesh) => {
  const f = worldSdf(part, mesh);
  return (pWorld) => f(pWorld[0], pWorld[1], pWorld[2]);
};

/** The caller's SDF for a mesh part: looked up by `dims.meshRef`, then by part id. */
export function meshSdfOf(part: Part, meshSdf?: Record<string, MeshSdf>): MeshSdf | undefined {
  if (part.type !== 'mesh' || !meshSdf) return undefined;
  const byRef = Object.hasOwn(meshSdf, part.dims.meshRef) ? meshSdf[part.dims.meshRef] : undefined;
  return byRef ?? (Object.hasOwn(meshSdf, part.id) ? meshSdf[part.id] : undefined);
}

/**
 * `overlapVolume` with its knobs. `maxSamples` caps the number of grid cells (default `OVERLAP_MAX_SAMPLES`;
 * `inferAttach` lowers it when a model has very many overlapping pairs). `skip: false` evaluates every cell —
 * the reference the tests compare the default against.
 *
 * The default walks each grid row and jumps over cells that cannot be inside: a cell is at least |f| away from
 * a solid whose signed distance there is f < 0, so the next ⌈|f| / cell⌉ − 1 cells are outside it too. The
 * count is exactly the one of the full grid, because every analytic SDF here is a lower bound of the distance
 * outside its solid (exact, or the ellipsoid bound). A caller-supplied mesh SDF is not trusted that far: rows
 * are never skipped on its account.
 */
export function overlapVolumeWith(a: Part, b: Part, o?: { meshSdf?: Record<string, MeshSdf>; maxSamples?: number; skip?: boolean }): number {
  const ba = worldBounds(a);
  const bb = worldBounds(b);
  const lo: Vec3 = [Math.max(ba.min[0], bb.min[0]), Math.max(ba.min[1], bb.min[1]), Math.max(ba.min[2], bb.min[2])];
  const hi: Vec3 = [Math.min(ba.max[0], bb.max[0]), Math.min(ba.max[1], bb.max[1]), Math.min(ba.max[2], bb.max[2])];
  const ext: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  if (!(ext[0] > 0 && ext[1] > 0 && ext[2] > 0)) return 0;
  if (!Number.isFinite(ext[0] + ext[1] + ext[2])) return 0;

  const maxSamples = Math.max(1, Math.floor(o?.maxSamples ?? OVERLAP_MAX_SAMPLES));
  const h = Math.min(OVERLAP_SPACING_IN, Math.min(ext[0], ext[1], ext[2]) / 8);
  const n = ext.map((e) => Math.min(4096, Math.max(1, Math.ceil(e / h - 1e-9))));
  const total = n[0] * n[1] * n[2];
  if (total > maxSamples) {
    const s = Math.cbrt(maxSamples / total);
    for (let k = 0; k < 3; k++) n[k] = Math.max(1, Math.floor(n[k] * s));
  }
  const cell: Vec3 = [ext[0] / n[0], ext[1] / n[1], ext[2] / n[2]];

  const sdfA = meshSdfOf(a, o?.meshSdf);
  const sdfB = meshSdfOf(b, o?.meshSdf);
  const fa = worldSdf(a, sdfA);
  const fb = worldSdf(b, sdfB);
  const skip = o?.skip !== false;
  const skipA = skip && sdfA === undefined;
  const skipB = skip && sdfB === undefined;
  // Cells to advance after a sample that is `d` outside: those nearer than d are outside too.
  const jump = (d: number): number => {
    const cells = Math.ceil((d / cell[0]) * (1 - 1e-9));
    return cells > 1 ? cells : 1;
  };
  let count = 0;
  for (let k = 0; k < n[2]; k++) {
    const z = lo[2] + (k + 0.5) * cell[2];
    for (let j = 0; j < n[1]; j++) {
      const y = lo[1] + (j + 0.5) * cell[1];
      let i = 0;
      while (i < n[0]) {
        const x = lo[0] + (i + 0.5) * cell[0];
        const va = fa(x, y, z);
        if (!(va >= 0)) {
          i += skipA && va < 0 ? jump(-va) : 1;
          continue;
        }
        const vb = fb(x, y, z);
        if (!(vb >= 0)) {
          i += skipB && vb < 0 ? jump(-vb) : 1;
          continue;
        }
        count++;
        i++;
      }
    }
  }
  return count * cell[0] * cell[1] * cell[2];
}

/**
 * The volume shared by two parts, in³ (§3.7.6): cell centers of a regular grid over the intersection of the two
 * world bounding boxes, spacing min(0.025 in, smallest extent / 8), counted when inside both. Deterministic; 0
 * when the boxes do not intersect. At most `OVERLAP_MAX_SAMPLES` cells are used: a larger intersection gets
 * proportionally larger cells. `o.meshSdf` holds the part-local SDFs of mesh parts, keyed by meshRef.
 */
export const overlapVolume: OverlapVolumeFn = (a, b, o) => overlapVolumeWith(a, b, o);

/** The builder vertices of a part in model space, [x, y, z, …] (a flat part: without duplicates). */
export function partWorldVertices(part: Part): Float64Array<ArrayBuffer> {
  const local = part.type === 'flat' ? flatLayout(part.dims).vertices : tessellatePart(part).positions;
  const r = eulerXYZToMat3(part.rotationDeg);
  const [px, py, pz] = part.position;
  const out = new Float64Array(local.length);
  for (let i = 0; i + 2 < local.length; i += 3) {
    const x = local[i];
    const y = local[i + 1];
    const z = local[i + 2];
    out[i] = r[0] * x + r[1] * y + r[2] * z + px;
    out[i + 1] = r[3] * x + r[4] * y + r[5] * z + py;
    out[i + 2] = r[6] * x + r[7] * y + r[8] * z + pz;
  }
  return out;
}

/** Minus the largest signed distance over a list of points [x, y, z, …]: how far the nearest one is from the solid. */
export function gapOfVertices(vertices: ArrayLike<number>, solid: WorldSdf): number {
  let deepest = -Infinity;
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const d = solid(vertices[i], vertices[i + 1], vertices[i + 2]);
    if (d > deepest) deepest = d;
  }
  return deepest === -Infinity ? Infinity : -deepest;
}

/**
 * Which of the two parts lends its builder vertices to the gap measurement: the child — except a mesh child
 * (whose own vertices are not at hand) on a primitive parent, which is measured the other way round, with the
 * parent's vertices against the child's SDF.
 */
export function gapProbe(child: Part, parent: Part): 'child' | 'parent' {
  return child.type === 'mesh' && parent.type !== 'mesh' ? 'parent' : 'child';
}

/** `surfaceGap` with the SDFs of mesh parts (part-local, keyed by meshRef). */
export function surfaceGapWith(child: Part, parent: Part, meshSdf?: Record<string, MeshSdf>): number {
  const swap = gapProbe(child, parent) === 'parent';
  const probe = swap ? parent : child;
  const solid = swap ? child : parent;
  return gapOfVertices(partWorldVertices(probe), worldSdf(solid, meshSdfOf(solid, meshSdf)));
}

/**
 * The gap between a child and its parent, in inches (§3.7.6), from the child's builder vertices: the distance
 * from the nearest child vertex to the parent's surface. Positive when the parts are apart; zero or negative
 * when a child vertex touches or enters the parent (then it is minus the deepest vertex's depth). `W_GAP`
 * fires above 0.1 in.
 */
export const surfaceGap: SurfaceGapFn = (child, parent) => surfaceGapWith(child, parent);

/**
 * The outward unit normal of a part's surface near `p` (model space): minus the SDF's gradient, by central
 * differences of step `h`. `[0, 1, 0]` where the gradient vanishes.
 */
export function sdfNormal(f: WorldSdf, p: Vec3, h = 1e-4): Vec3 {
  const gx = f(p[0] + h, p[1], p[2]) - f(p[0] - h, p[1], p[2]);
  const gy = f(p[0], p[1] + h, p[2]) - f(p[0], p[1] - h, p[2]);
  const gz = f(p[0], p[1], p[2] + h) - f(p[0], p[1], p[2] - h);
  const len = Math.hypot(gx, gy, gz);
  if (!(len > 1e-12)) return [0, 1, 0];
  return [-gx / len, -gy / len, -gz / len];
}

/**
 * The volume of a part's solid, in³ (analytic; used to rank parts, §3.7.6 and §2.9.7). A flat part is its
 * outline area times its thickness; a torus arc its tube without end caps; a mesh part is estimated as the
 * ellipsoid inscribed in its bounding box.
 */
export function partVolume(given: Part): number {
  const part = sanePart(given);
  switch (part.type) {
    case 'sphere':
      return (4 / 3) * Math.PI * part.dims.r ** 3;
    case 'ellipsoid':
      return (4 / 3) * Math.PI * part.dims.rx * part.dims.ry * part.dims.rz;
    case 'capsule': {
      const r = part.dims.r;
      return Math.PI * r * r * Math.max(0, part.dims.length - 2 * r) + (4 / 3) * Math.PI * r ** 3;
    }
    case 'cylinder': {
      const { rTop, rBottom, h } = part.dims;
      return (Math.PI * h * (rTop * rTop + rTop * rBottom + rBottom * rBottom)) / 3;
    }
    case 'cone':
      return (Math.PI * part.dims.r * part.dims.r * part.dims.h) / 3;
    case 'torus': {
      const arc = Math.min(360, Math.max(0, part.dims.arcDeg ?? 360)) * DEG2RAD;
      return Math.PI * part.dims.r * part.dims.r * part.dims.R * arc;
    }
    case 'lathe': {
      let v = 0;
      const p = part.dims.profile;
      for (let i = 0; i + 1 < p.length; i++) {
        const r0 = Math.max(0, p[i][0]);
        const r1 = Math.max(0, p[i + 1][0]);
        v += (Math.PI * (p[i + 1][1] - p[i][1]) * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;
      }
      return Math.abs(v);
    }
    case 'box':
      return part.dims.w * part.dims.h * part.dims.d;
    case 'flat': {
      const o = flatLayout(part.dims).outline;
      const n = o.length >> 1;
      let twice = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) twice += o[2 * j] * o[2 * i + 1] - o[2 * i] * o[2 * j + 1];
      return (Math.abs(twice) / 2) * part.dims.thickness;
    }
    case 'mesh':
      return (Math.PI / 6) * part.dims.bboxIn[0] * part.dims.bboxIn[1] * part.dims.bboxIn[2];
    default:
      return 0;
  }
}
