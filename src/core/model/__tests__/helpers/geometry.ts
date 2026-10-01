// Test helper: brute-force geometry on triangle meshes, independent of the kernels under test. Used to check
// the analytic SDFs, bounds, volumes and placements against the builder's own tessellation.
import { readFileSync } from 'node:fs';
import type { CrochetModelV1, Part, Vec3 } from '../../../../types/model';
import { tessellatePart } from '../../builder';
import { localToWorld } from '../../transforms';

export interface TriMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

/** The builder mesh of a part in model space. */
export function worldMesh(part: Part): TriMesh {
  const { positions, indices } = tessellatePart(part);
  const world = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const p = localToWorld(part, [positions[i], positions[i + 1], positions[i + 2]]);
    world[i] = p[0];
    world[i + 1] = p[1];
    world[i + 2] = p[2];
  }
  return { positions: world, indices };
}

/** The builder mesh of a part in its local frame. */
export function localMesh(part: Part): TriMesh {
  return tessellatePart(part);
}

/** Distance from p to the triangle abc (Ericson, Real-Time Collision Detection §5.1.5). */
function pointTriangleDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  let closest: Vec3;
  if (d1 <= 0 && d2 <= 0) closest = a;
  else {
    const bp: Vec3 = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) closest = b;
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3 || 1);
        closest = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
      } else {
        const cp: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        const d5 = dot(ab, cp);
        const d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) closest = c;
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6 || 1);
            closest = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6) || 1);
              closest = [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
            } else {
              const denom = 1 / (va + vb + vc || 1);
              const v = vb * denom;
              const w = vc * denom;
              closest = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
            }
          }
        }
      }
    }
  }
  return Math.hypot(p[0] - closest[0], p[1] - closest[1], p[2] - closest[2]);
}

const vertex = (m: TriMesh, i: number): Vec3 => [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]];

/** The (unsigned) distance from p to the mesh surface: the minimum over every triangle. */
export function distanceToMesh(m: TriMesh, p: Vec3): number {
  let best = Infinity;
  for (let k = 0; k + 2 < m.indices.length; k += 3) {
    const d = pointTriangleDistance(p, vertex(m, m.indices[k]), vertex(m, m.indices[k + 1]), vertex(m, m.indices[k + 2]));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Every t ≥ 0 at which the ray origin + t·dir crosses a triangle of the mesh, ascending. `eps` widens every
 * triangle a little: use it to find the nearest or farthest hit of a ray that may run through a vertex (a hit
 * is then reported once per triangle around it); leave it at 0 for parity counts.
 */
export function rayHits(m: TriMesh, origin: Vec3, dir: Vec3, eps = 0): number[] {
  const hits: number[] = [];
  for (let k = 0; k + 2 < m.indices.length; k += 3) {
    const a = vertex(m, m.indices[k]);
    const b = vertex(m, m.indices[k + 1]);
    const c = vertex(m, m.indices[k + 2]);
    const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const px = dir[1] * e2[2] - dir[2] * e2[1];
    const py = dir[2] * e2[0] - dir[0] * e2[2];
    const pz = dir[0] * e2[1] - dir[1] * e2[0];
    const det = e1[0] * px + e1[1] * py + e1[2] * pz;
    if (Math.abs(det) < 1e-15) continue;
    const inv = 1 / det;
    const s: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
    const u = (s[0] * px + s[1] * py + s[2] * pz) * inv;
    if (u < -eps || u > 1 + eps) continue;
    const qx = s[1] * e1[2] - s[2] * e1[1];
    const qy = s[2] * e1[0] - s[0] * e1[2];
    const qz = s[0] * e1[1] - s[1] * e1[0];
    const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
    if (v < -eps || u + v > 1 + eps) continue;
    const t = (e2[0] * qx + e2[1] * qy + e2[2] * qz) * inv;
    if (t >= 0) hits.push(t);
  }
  return hits.sort((x, y) => x - y);
}

const PARITY_DIRECTIONS: Vec3[] = [
  [0.3617, 0.8129, 0.4561],
  [-0.7071, 0.1203, 0.6968],
  [0.2113, -0.5432, -0.8126],
];

/** Inside a closed mesh: ray parity, by majority over three skew directions (a ray through an edge can miscount). */
export function insideMesh(m: TriMesh, p: Vec3): boolean {
  let votes = 0;
  for (const d of PARITY_DIRECTIONS) if (rayHits(m, p, d).length % 2 === 1) votes++;
  return votes >= 2;
}

/** The volume enclosed by a closed mesh (divergence theorem); the sign follows the triangle winding. */
export function meshVolume(m: TriMesh): number {
  let six = 0;
  for (let k = 0; k + 2 < m.indices.length; k += 3) {
    const a = vertex(m, m.indices[k]);
    const b = vertex(m, m.indices[k + 1]);
    const c = vertex(m, m.indices[k + 2]);
    six += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return six / 6;
}

export function meshBounds(m: TriMesh): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], m.positions[i + k]);
      max[k] = Math.max(max[k], m.positions[i + k]);
    }
  }
  return { min, max };
}

/** The complete example of DESIGN.md §3.6, read from the spec itself. */
export function readSpecExample(): CrochetModelV1 {
  const spec = readFileSync(new URL('../../../../../docs/DESIGN.md', import.meta.url), 'utf8');
  const start = spec.indexOf('### 3.6 Complete example');
  if (start < 0) throw new Error('DESIGN.md §3.6 not found');
  const open = spec.indexOf('```json', start);
  const close = spec.indexOf('```', open + 7);
  if (open < 0 || close < 0) throw new Error('DESIGN.md §3.6 has no json block');
  return JSON.parse(spec.slice(open + 7, close)) as CrochetModelV1;
}

/** A part with defaults, for tests that only care about its shape. */
export function part<T extends Part['type']>(
  type: T,
  dims: Extract<Part, { type: T }>['dims'],
  rest: Partial<Omit<Part, 'type' | 'dims'>> = {},
): Extract<Part, { type: T }> {
  return { id: rest.id ?? type, position: [0, 0, 0], color: 'c1', ...rest, type, dims } as unknown as Extract<Part, { type: T }>;
}

/** A minimal valid model around a list of parts. */
export function modelOf(parts: Part[], rest: Partial<CrochetModelV1> = {}): CrochetModelV1 {
  return {
    schema: 'crochet-model',
    version: '1.0',
    revision: 0,
    units: 'in',
    axes: { up: '+Y', front: '+Z', left: '+X' },
    name: 'test',
    finishedSize: { height: 1 },
    palette: [
      { id: 'c1', hex: '#C8A27A' },
      { id: 'c2', hex: '#F4EBDD' },
    ],
    parts,
    ...rest,
  };
}

/** One sample part of every primitive type, with dims that exercise each formula (no two radii equal). */
export function samplePrimitives(): Part[] {
  return [
    part('sphere', { r: 0.9 }),
    part('ellipsoid', { rx: 1.2, ry: 0.8, rz: 0.6 }),
    part('capsule', { r: 0.4, length: 2.2 }),
    part('cylinder', { rTop: 0.5, rBottom: 0.8, h: 1.4 }),
    part('cone', { r: 0.7, h: 1.5 }),
    part('torus', { R: 1.1, r: 0.3 }),
    part('lathe', {
      profile: [
        [0, 0],
        [0.7, 0.03],
        [0.97, 0.22],
        [1, 0.42],
        [0.82, 0.7],
        [0.55, 0.92],
        [0, 1],
      ].map(([r, y]): [number, number] => [r * 1.2, y * 2.4]),
    }),
    part('box', { w: 1.4, h: 0.9, d: 0.6 }),
    part('flat', { shape: 'oval', w: 1.6, h: 1.1, thickness: 0.3 }),
  ];
}
