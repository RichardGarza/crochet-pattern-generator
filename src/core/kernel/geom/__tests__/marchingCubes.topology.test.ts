// The topology of marchingCubes.ts. From the independent review of Step 0b.
//
// Nothing here uses meshMeasures.ts: the edge census, the vertex-fan walk, the winding number and the lattice
// flood below are written from scratch.
//
// The two exhaustive runs over all 3 × 2^18 four-cell patterns take under a minute each (measured on an M3 Pro
// under load: 42 s closed, 9 s open) and run only with GEOM_FULL=1; without it a seeded sample of the same
// patterns runs.
import { triTable } from 'three/addons/objects/MarchingCubes.js';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../prng';
import { type IndexedMesh, marchingCubes } from '../marchingCubes';
import { HEAVY, note } from './fields';

const FULL = process.env.GEOM_FULL === '1';

// ---- independent mesh census -------------------------------------------------------------------------------

interface Census {
  edges: number;
  /** Undirected edges used by exactly one triangle. */
  boundary: number;
  /** Undirected edges used by three or more triangles. */
  nonManifold: number;
  /** Undirected edges used by two triangles in the same direction. */
  misoriented: number;
  /** Triangles with a repeated vertex index. */
  repeatedIndex: number;
  /** Link arcs that leave or enter a link vertex twice (an edge used twice in one direction, seen from a vertex). */
  twisted: number;
  /** Vertices whose link is more than one path or cycle. */
  pinched: number;
  /** Vertices that no triangle refers to. */
  unused: number;
  /** Flat list of the vertex pairs of the boundary edges. */
  boundaryEdges: number[];
}

function census(mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }): Census {
  const V = mesh.positions.length / 3;
  const idx = mesh.indices;
  if (!Number.isInteger(V) || idx.length % 3 !== 0) throw new Error('malformed buffers');
  const directed = new Map<number, number>();
  // The link of vertex p: every triangle (p, q, r) is an arc q → r. Keys are p·V + q.
  const next = new Map<number, number>();
  const hasPrev = new Set<number>();
  const used = new Uint8Array(V);
  let repeatedIndex = 0;
  let twisted = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t + 1], idx[t + 2]];
    for (const v of tri) {
      if (!(Number.isInteger(v) && v >= 0 && v < V)) throw new Error(`index ${v} outside ${V} vertices`);
      used[v] = 1;
    }
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) {
      repeatedIndex++;
      continue;
    }
    for (let e = 0; e < 3; e++) {
      const p = tri[e];
      const q = tri[(e + 1) % 3];
      const r = tri[(e + 2) % 3];
      directed.set(p * V + q, (directed.get(p * V + q) ?? 0) + 1);
      if (next.has(p * V + q)) twisted++;
      else next.set(p * V + q, r);
      if (hasPrev.has(p * V + r)) twisted++;
      else hasPrev.add(p * V + r);
    }
  }
  const out: Census = { edges: 0, boundary: 0, nonManifold: 0, misoriented: 0, repeatedIndex, twisted, pinched: 0, unused: 0, boundaryEdges: [] };
  for (const [key, forward] of directed) {
    const q = key % V;
    const p = (key - q) / V;
    const backward = directed.get(q * V + p) ?? 0;
    if (backward > 0 && p > q) continue; // counted when the loop reaches (q, p)
    out.edges++;
    const uses = forward + backward;
    if (uses === 1) {
      out.boundary++;
      out.boundaryEdges.push(p, q);
    } else if (uses > 2) out.nonManifold++;
    else if (backward !== 1) out.misoriented++;
  }
  // Fans: walk the paths of every link first (their first arc has no predecessor), then the cycles.
  const fans = new Int32Array(V);
  const walked = new Set<number>();
  const walk = (start: number): void => {
    const p = Math.floor(start / V);
    fans[p]++;
    let at = start;
    while (next.has(at) && !walked.has(at)) {
      walked.add(at);
      at = p * V + (next.get(at) as number);
    }
  };
  for (const key of next.keys()) if (!hasPrev.has(key)) walk(key);
  for (const key of next.keys()) if (!walked.has(key)) walk(key);
  for (let v = 0; v < V; v++) {
    if (fans[v] > 1) out.pinched++;
    if (used[v] === 0) out.unused++;
  }
  return out;
}

function defects(c: Census): number {
  return c.boundary + c.nonManifold + c.misoriented + c.repeatedIndex + c.twisted + c.pinched + c.unused;
}

function signedVolumeOf(m: IndexedMesh): number {
  const p = m.positions;
  let six = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = 3 * m.indices[t];
    const b = 3 * m.indices[t + 1];
    const c = 3 * m.indices[t + 2];
    six += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return six / 6;
}

/** Twice the smallest triangle area, by Heron-free cross product in doubles. */
function smallestArea(m: IndexedMesh): number {
  const p = m.positions;
  let min = Infinity;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = 3 * m.indices[t];
    const b = 3 * m.indices[t + 1];
    const c = 3 * m.indices[t + 2];
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (!(area >= min)) min = area;
    if (area !== area) return NaN;
  }
  return min;
}

/** Winding number of a closed mesh around a point: the sum of the signed solid angles over 4π. */
function windingNumber(m: IndexedMesh, px: number, py: number, pz: number): number {
  const p = m.positions;
  let total = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = 3 * m.indices[t];
    const b = 3 * m.indices[t + 1];
    const c = 3 * m.indices[t + 2];
    const ax = p[a] - px;
    const ay = p[a + 1] - py;
    const az = p[a + 2] - pz;
    const bx = p[b] - px;
    const by = p[b + 1] - py;
    const bz = p[b + 2] - pz;
    const cx = p[c] - px;
    const cy = p[c + 1] - py;
    const cz = p[c + 2] - pz;
    const la = Math.hypot(ax, ay, az);
    const lb = Math.hypot(bx, by, bz);
    const lc = Math.hypot(cx, cy, cz);
    const det = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    const den = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (bx * cx + by * cy + bz * cz) * la + (cx * ax + cy * ay + cz * az) * lb;
    total += 2 * Math.atan2(det, den);
  }
  return total / (4 * Math.PI);
}

function meshComponents(m: IndexedMesh): number {
  const V = m.positions.length / 3;
  const parent = Int32Array.from({ length: V }, (_, i) => i);
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  let count = V;
  const join = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[ra] = rb;
      count--;
    }
  };
  for (let t = 0; t < m.indices.length; t += 3) {
    join(m.indices[t], m.indices[t + 1]);
    join(m.indices[t], m.indices[t + 2]);
  }
  return count;
}

// ---- self-test of the checkers (so a failure below is the kernel's, not the checker's) -------------------------

describe('the independent checkers themselves', () => {
  const tetPositions = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1);
  const tet = { positions: tetPositions, indices: Uint32Array.of(0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2) };

  it('census: closed, open, flipped, fins, bow tie, unused vertex', () => {
    expect(defects(census(tet))).toBe(0);
    expect(census(tet).edges).toBe(6);
    const open = census({ positions: tetPositions, indices: tet.indices.slice(0, 9) });
    expect([open.boundary, open.nonManifold, open.misoriented, open.pinched]).toEqual([3, 0, 0, 0]);
    const flipped = census({ positions: tetPositions, indices: Uint32Array.of(0, 1, 2, 0, 1, 3, 1, 2, 3, 0, 3, 2) });
    expect(flipped.misoriented).toBe(3);
    const fins = census({ positions: new Float32Array(15), indices: Uint32Array.of(0, 1, 2, 0, 1, 3, 0, 1, 4) });
    expect([fins.nonManifold, fins.boundary]).toEqual([1, 6]);
    const bowTie = census({ positions: new Float32Array(15), indices: Uint32Array.of(0, 1, 2, 0, 3, 4) });
    expect([bowTie.pinched, bowTie.boundary]).toEqual([1, 6]);
    // Two tetrahedra glued at vertex 0: every edge is fine, vertex 0 has two fans.
    const second = Array.from(tet.indices, (i) => (i === 0 ? 0 : i + 3));
    const pinched = census({ positions: new Float32Array(21), indices: Uint32Array.from([...tet.indices, ...second]) });
    expect([pinched.boundary, pinched.nonManifold, pinched.misoriented, pinched.pinched]).toEqual([0, 0, 0, 1]);
    expect(census({ positions: new Float32Array(15), indices: tet.indices }).unused).toBe(1);
    // An open fan around vertex 0 is one fan.
    expect(census({ positions: new Float32Array(15), indices: Uint32Array.of(0, 1, 2, 0, 2, 3, 0, 3, 4) }).pinched).toBe(0);
  });

  it('winding number and volume of a tetrahedron', () => {
    expect(signedVolumeOf(tet)).toBeCloseTo(1 / 6, 12);
    expect(windingNumber(tet, 0.1, 0.1, 0.1)).toBeCloseTo(1, 9);
    expect(windingNumber(tet, 1, 1, 1)).toBeCloseTo(0, 9);
    expect(windingNumber(tet, -0.2, 0.1, 0.1)).toBeCloseTo(0, 9);
    const insideOut = { positions: tetPositions, indices: Uint32Array.of(0, 1, 2, 0, 3, 1, 1, 3, 2, 0, 2, 3) };
    expect(windingNumber(insideOut, 0.1, 0.1, 0.1)).toBeCloseTo(-1, 9);
    expect(meshComponents(tet)).toBe(1);
  });
});

// ---- the table, cell by cell: a proof that does not go through the mesher ------------------------------------

// Bourke numbering, written down independently of the kernel's comments.
const CORNER: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const EDGE: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/** The faces (axis, side) that contain cube edge e. */
function facesOfEdge(e: number): string[] {
  const [a, b] = EDGE[e];
  const out: string[] = [];
  for (let axis = 0; axis < 3; axis++) {
    if (CORNER[a][axis] === CORNER[b][axis]) out.push(`${axis}${CORNER[a][axis]}`);
  }
  return out;
}

/** A cube edge that lies in face (axis, side), named by its two corners in the face's own (u, v) coordinates. */
function faceLocalEdge(e: number, axis: number): string {
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const name = (corner: number): number => CORNER[corner][u] + 2 * CORNER[corner][v];
  const [a, b] = EDGE[e];
  return [name(a), name(b)].sort().join('');
}

describe('the three.js triTable, cell by cell', HEAVY, () => {
  it('interior sides are used twice in opposite directions; a side in a face is used once', () => {
    for (let cube = 0; cube < 256; cube++) {
      const uses = new Map<string, number>();
      for (let k = 16 * cube; triTable[k] !== -1; k += 3) {
        for (let e = 0; e < 3; e++) {
          const from = triTable[k + e];
          const to = triTable[k + ((e + 1) % 3)];
          expect(from).not.toBe(to);
          uses.set(`${from}>${to}`, (uses.get(`${from}>${to}`) ?? 0) + 1);
        }
      }
      for (const [key, count] of uses) {
        const [from, to] = key.split('>').map(Number);
        const shared = facesOfEdge(from).filter((f) => facesOfEdge(to).includes(f));
        const back = uses.get(`${to}>${from}`) ?? 0;
        if (shared.length === 0) {
          // an interior side of the cell's patch
          expect([cube, key, count, back]).toEqual([cube, key, 1, 1]);
        } else {
          // a side that lies in a cell face: the neighbor cell must supply the opposite half-edge
          expect([cube, key, count, back]).toEqual([cube, key, 1, 0]);
        }
      }
    }
  });

  it('the directed sides on a face depend only on the four corners of that face, and the two cells that share it use opposite directions', () => {
    // sides[axis][side][pattern] = the directed sides (in face-local edge names) every cube with that corner
    // pattern on that face produces there.
    const seen = new Map<string, Set<string>>();
    let ambiguousCutsOffOutside = 0;
    let ambiguousFaces = 0;
    for (let cube = 0; cube < 256; cube++) {
      const outside = (corner: number): number => (cube >> corner) & 1;
      const onFace = new Map<string, string[]>();
      for (let k = 16 * cube; triTable[k] !== -1; k += 3) {
        for (let e = 0; e < 3; e++) {
          const from = triTable[k + e];
          const to = triTable[k + ((e + 1) % 3)];
          for (const f of facesOfEdge(from)) {
            if (!facesOfEdge(to).includes(f)) continue;
            const axis = Number(f[0]);
            const list = onFace.get(f) ?? [];
            list.push(`${faceLocalEdge(from, axis)}>${faceLocalEdge(to, axis)}`);
            onFace.set(f, list);
          }
        }
      }
      for (let axis = 0; axis < 3; axis++) {
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        for (const side of [0, 1]) {
          // pattern bit (u + 2v) = outside flag of the face corner (u, v)
          let pattern = 0;
          for (let corner = 0; corner < 8; corner++) {
            if (CORNER[corner][axis] === side && outside(corner)) pattern |= 1 << (CORNER[corner][u] + 2 * CORNER[corner][v]);
          }
          const sides = (onFace.get(`${axis}${side}`) ?? []).sort();
          const key = `${axis}|${side}|${pattern}`;
          const set = seen.get(key) ?? new Set<string>();
          set.add(sides.join(' '));
          seen.set(key, set);
          // The number of sides is what the corner pattern demands: 0, 1 or (alternating corners) 2.
          const crossings = [0, 1, 3, 2].filter((c, i, ring) => ((pattern >> c) & 1) !== ((pattern >> ring[(i + 1) % 4]) & 1)).length;
          expect(sides.length).toBe(crossings / 2);
          if (pattern === 0b0110 || pattern === 0b1001) {
            ambiguousFaces++;
            // Each side joins two face edges that meet in a face corner; that corner must be OUTSIDE.
            for (const s of sides) {
              const [from, to] = s.split('>');
              const common = [...from].filter((ch) => to.includes(ch));
              expect(common.length).toBe(1);
              if ((pattern >> Number(common[0])) & 1) ambiguousCutsOffOutside++;
              else throw new Error(`cube ${cube}, face ${axis}${side}: a side cuts off an INSIDE corner`);
            }
          }
        }
      }
    }
    expect(ambiguousFaces).toBeGreaterThan(100);
    expect(ambiguousCutsOffOutside).toBe(2 * ambiguousFaces);
    for (let axis = 0; axis < 3; axis++) {
      for (let pattern = 0; pattern < 16; pattern++) {
        const low = seen.get(`${axis}|0|${pattern}`) as Set<string>;
        const high = seen.get(`${axis}|1|${pattern}`) as Set<string>;
        // one answer per pattern, whatever the other four corners of the cube are
        expect(low.size).toBe(1);
        expect(high.size).toBe(1);
        const reversed = [...low][0]
          .split(' ')
          .filter((s) => s !== '')
          .map((s) => s.split('>').reverse().join('>'))
          .sort()
          .join(' ');
        expect(reversed).toBe([...high][0]);
      }
    }
  });
});

// ---- exhaustive sign patterns through the mesher -------------------------------------------------------------

function patternField(bits: number, n: number, target: Float32Array): Float32Array {
  for (let i = 0; i < n; i++) target[i] = (bits >> i) & 1 ? 1 : -1;
  return target;
}

/** True when both ends of every boundary edge lie in one face of the lattice box [0, dims − 1]. */
function boundaryOnBox(m: IndexedMesh, c: Census, dims: readonly [number, number, number]): boolean {
  for (let i = 0; i < c.boundaryEdges.length; i += 2) {
    const p = 3 * c.boundaryEdges[i];
    const q = 3 * c.boundaryEdges[i + 1];
    let ok = false;
    for (let a = 0; a < 3; a++) {
      for (const wall of [0, dims[a] - 1]) {
        if (m.positions[p + a] === wall && m.positions[q + a] === wall) ok = true;
      }
    }
    if (!ok) return false;
  }
  return true;
}

describe('every inside/outside pattern', HEAVY, () => {
  it('two cells that share a face (3 × 4096), closed and open border', () => {
    let meshes = 0;
    for (const dims of [
      [3, 2, 2],
      [2, 3, 2],
      [2, 2, 3],
    ] as [number, number, number][]) {
      const field = new Float32Array(12);
      for (let bits = 0; bits < 4096; bits++) {
        patternField(bits, 12, field);
        const closed = marchingCubes(field, dims);
        const c = census(closed);
        if (defects(c) !== 0) throw new Error(`closed ${dims.join('×')} pattern ${bits}: ${JSON.stringify(c)}`);
        if (closed.indices.length > 0 && !(signedVolumeOf(closed) > 0)) throw new Error(`closed ${dims.join('×')} pattern ${bits}: volume`);
        const open = marchingCubes(field, dims, { border: 'open' });
        const o = census(open);
        if (o.nonManifold + o.misoriented + o.repeatedIndex + o.twisted + o.pinched + o.unused !== 0 || !boundaryOnBox(open, o, dims)) {
          throw new Error(`open ${dims.join('×')} pattern ${bits}: ${JSON.stringify(o)}`);
        }
        meshes += 2;
      }
    }
    expect(meshes).toBe(2 * 3 * 4096);
  });

  const fourCells = (border: 'closed' | 'open', patterns: (dims: [number, number, number]) => Iterable<number>): { meshes: number; smallest: number } => {
    let meshes = 0;
    let smallest = Infinity;
    for (const dims of [
      [3, 3, 2],
      [3, 2, 3],
      [2, 3, 3],
    ] as [number, number, number][]) {
      const field = new Float32Array(18);
      for (const bits of patterns(dims)) {
        patternField(bits, 18, field);
        const m = marchingCubes(field, dims, { border });
        const c = census(m);
        const bad =
          border === 'closed'
            ? defects(c) !== 0 || (m.indices.length > 0 && !(signedVolumeOf(m) > 0))
            : c.nonManifold + c.misoriented + c.repeatedIndex + c.twisted + c.pinched + c.unused !== 0 || !boundaryOnBox(m, c, dims);
        if (bad) throw new Error(`${border} ${dims.join('×')} pattern ${bits}: ${JSON.stringify({ ...c, boundaryEdges: undefined })}`);
        if (m.indices.length > 0) smallest = Math.min(smallest, smallestArea(m));
        meshes++;
      }
    }
    return { meshes, smallest };
  };

  it('four cells around a lattice edge, seeded sample (closed and open)', () => {
    const rng = mulberry32(0xa11ce);
    const sample = function* (): Generator<number> {
      for (let i = 0; i < 4000; i++) yield Math.floor(rng() * (1 << 18));
    };
    expect(fourCells('closed', sample).meshes).toBe(12000);
    expect(fourCells('open', sample).meshes).toBe(12000);
  });

  it.runIf(FULL)(
    'four cells around a lattice edge, ALL 3 × 2^18 patterns, closed border',
    () => {
      const all = function* (): Generator<number> {
        for (let bits = 0; bits < 1 << 18; bits++) yield bits;
      };
      const { meshes, smallest } = fourCells('closed', all);
      expect(meshes).toBe(3 * (1 << 18));
      // ±1 samples put the inner vertices at edge midpoints, but the cap against the virtual outside layer
      // (−1e30) is clamped to t = 0.01: the smallest triangle is the corner cut of the clamp, √3/2 · 0.01².
      expect(Math.abs(smallest / ((Math.sqrt(3) / 2) * 0.01 ** 2) - 1)).toBeLessThan(1e-4);
      note(`closed border: ${meshes} four-cell meshes, 0 defects, smallest triangle ${smallest}`);
    },
    600_000,
  );

  it.runIf(FULL)(
    'four cells around a lattice edge, ALL 3 × 2^18 patterns, open border',
    () => {
      const all = function* (): Generator<number> {
        for (let bits = 0; bits < 1 << 18; bits++) yield bits;
      };
      const { meshes } = fourCells('open', all);
      expect(meshes).toBe(3 * (1 << 18));
      note(`open border: ${meshes} four-cell meshes, 0 non-manifold defects, every boundary edge on the box`);
    },
    600_000,
  );
});

// ---- random hostile fields -----------------------------------------------------------------------------------

type FieldArray = Float32Array | Float64Array | Int16Array | number[];

interface Hostile {
  field: FieldArray;
  dims: [number, number, number];
  iso: number;
  /** 1 where the documented rule says "inside": value ≥ iso (NaN and −Infinity are outside). */
  inside: Uint8Array;
}

function hostileField(seed: number, maxDim: number): Hostile {
  const rng = mulberry32(seed * 7919 + 13);
  const dim = (): number => 1 + Math.floor(rng() * maxDim);
  const dims: [number, number, number] = [dim(), dim(), dim()];
  const n = dims[0] * dims[1] * dims[2];
  const kind = seed % 7;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rng() * 2 - 1;
    if (kind === 0) values[i] = r;
    else if (kind === 1) values[i] = r < 0 ? -1 : 1;
    else if (kind === 2) values[i] = Math.round(r * 2);
    else if (kind === 3) values[i] = r * [1e-12, 1e-6, 1e-3, 1, 1e6, 1e12][Math.floor(rng() * 6)];
    else if (kind === 4) {
      // specials sprinkled over noise
      const pick = rng();
      values[i] = pick < 0.08 ? NaN : pick < 0.16 ? Infinity : pick < 0.24 ? -Infinity : pick < 0.32 ? 0 : pick < 0.4 ? -0 : r;
    } else if (kind === 5) values[i] = Math.round(r * 300);
    else values[i] = r + 0.4; // mostly inside: the solid touches the border everywhere
  }
  const iso = seed % 5 === 0 ? 0.25 : seed % 11 === 0 ? -1 : 0;
  const type = seed % 4;
  let field: FieldArray;
  if (kind === 5 && type === 1) field = Int16Array.from(values);
  else if (type === 0) field = Float32Array.from(values);
  else if (type === 2) field = Array.from(values);
  else field = values;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = field[i] >= iso ? 1 : 0;
  return { field, dims, iso, inside };
}

/**
 * Components of the samples with `value` in the lattice padded by one layer of outside samples. `reach` is how
 * many coordinates a step may change: 1 = through lattice edges (6 neighbors), 2 = also across face diagonals
 * (18), 3 = also across body diagonals (26).
 */
function latticeComponents(h: Hostile, value: 0 | 1, reach: 1 | 2 | 3): number {
  const [nx, ny, nz] = h.dims;
  const px = nx + 2;
  const py = ny + 2;
  const pz = nz + 2;
  const grid = new Uint8Array(px * py * pz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) grid[x + 1 + px * (y + 1 + py * (z + 1))] = h.inside[x + nx * (y + ny * z)];
    }
  }
  const steps: [number, number, number][] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const changed = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (changed >= 1 && changed <= reach) steps.push([dx, dy, dz]);
      }
    }
  }
  const seen = new Uint8Array(grid.length);
  let components = 0;
  for (let start = 0; start < grid.length; start++) {
    if (grid[start] !== value || seen[start]) continue;
    components++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const at = stack.pop() as number;
      const x = at % px;
      const y = Math.floor(at / px) % py;
      const z = Math.floor(at / (px * py));
      for (const [dx, dy, dz] of steps) {
        const X = x + dx;
        const Y = y + dy;
        const Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= px || Y >= py || Z >= pz) continue;
        const to = X + px * (Y + py * Z);
        if (grid[to] === value && !seen[to]) {
          seen[to] = 1;
          stack.push(to);
        }
      }
    }
  }
  return components;
}

describe('random hostile fields (noise, ±1, zeros, NaN, ±Infinity, huge and tiny values, Int16, thin lattices)', HEAVY, () => {
  it('closed border: 0 defects, positive volume, finite positions — 700 fields', () => {
    let triangles = 0;
    for (let seed = 1; seed <= 700; seed++) {
      const h = hostileField(seed, 9);
      const m = marchingCubes(h.field, h.dims, { iso: h.iso });
      const c = census(m);
      if (defects(c) !== 0) throw new Error(`seed ${seed} [${h.dims.join('×')}]: ${JSON.stringify({ ...c, boundaryEdges: undefined })}`);
      for (let i = 0; i < m.positions.length; i++) if (!Number.isFinite(m.positions[i])) throw new Error(`seed ${seed}: non-finite position`);
      const anyInside = h.inside.some((v) => v === 1);
      expect(m.indices.length > 0).toBe(anyInside);
      if (anyInside && !(signedVolumeOf(m) > 0)) throw new Error(`seed ${seed}: volume ${signedVolumeOf(m)}`);
      if (anyInside && !(smallestArea(m) > 0)) throw new Error(`seed ${seed}: zero-area triangle`);
      triangles += m.indices.length / 3;
    }
    expect(triangles).toBeGreaterThan(50_000);
  });

  it('the mesh separates inside samples from outside samples: winding number 1 / 0 at every lattice point', () => {
    let points = 0;
    for (let seed = 1; seed <= 160; seed++) {
      const h = hostileField(seed, 5);
      const m = marchingCubes(h.field, h.dims, { iso: h.iso });
      const [nx, ny, nz] = h.dims;
      // every sample, and the first layer of virtual outside samples around the lattice
      for (let z = -1; z <= nz; z++) {
        for (let y = -1; y <= ny; y++) {
          for (let x = -1; x <= nx; x++) {
            const real = x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz;
            const expected = real ? h.inside[x + nx * (y + ny * z)] : 0;
            const w = windingNumber(m, x, y, z);
            if (Math.abs(w - expected) > 1e-6) {
              throw new Error(`seed ${seed} [${h.dims.join('×')}] sample (${x}, ${y}, ${z}): winding ${w}, expected ${expected}`);
            }
            points++;
          }
        }
      }
    }
    expect(points).toBeGreaterThan(10_000);
  });

  it('pieces of the mesh = 18-connected inside components + 6-connected outside components − 1', () => {
    // Every closed piece of surface separates one inside region from one outside region, and those regions form
    // a tree, so the number of pieces is (inside regions) + (outside regions, the unbounded one included) − 1.
    // The identity holds only if the mesher joins inside samples across face diagonals (and nothing more) and
    // outside samples across lattice edges only — the connectivity the kernel's header claims.
    let checked = 0;
    // How many fields tell the claimed rule apart from the other candidates (so the identity is not vacuous).
    const differs = { inside6outside18: 0, inside26outside6: 0, inside6outside6: 0 };
    for (let seed = 1; seed <= 700; seed++) {
      const h = hostileField(seed, 9);
      const m = marchingCubes(h.field, h.dims, { iso: h.iso });
      const pieces = meshComponents(m);
      const in6 = latticeComponents(h, 1, 1);
      const in18 = latticeComponents(h, 1, 2);
      const in26 = latticeComponents(h, 1, 3);
      const out6 = latticeComponents(h, 0, 1);
      const out18 = latticeComponents(h, 0, 2);
      const expected = in18 + out6 - 1;
      if (pieces !== expected) {
        throw new Error(`seed ${seed} [${h.dims.join('×')}]: ${pieces} pieces, (18, 6) predicts ${expected}, (6, 18) predicts ${in6 + out18 - 1}`);
      }
      if (in6 + out18 - 1 !== expected) differs.inside6outside18++;
      if (in26 + out6 - 1 !== expected) differs.inside26outside6++;
      if (in6 + out6 - 1 !== expected) differs.inside6outside6++;
      checked++;
    }
    expect(checked).toBe(700);
    // Measured: 512 fields would contradict (6, 18), 42 would contradict (26, 6), 508 would contradict (6, 6).
    note(`fields where another connectivity rule predicts a different count: ${JSON.stringify(differs)}`);
    expect(differs.inside6outside18).toBeGreaterThan(100);
    expect(differs.inside26outside6).toBeGreaterThan(20);
    expect(differs.inside6outside6).toBeGreaterThan(100);
  });

  it('open border: no non-manifold edge or vertex, consistent winding, no unused vertex, boundary only on the box', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const h = hostileField(seed, 9);
      const m = marchingCubes(h.field, h.dims, { iso: h.iso, border: 'open' });
      const c = census(m);
      if (c.nonManifold + c.misoriented + c.repeatedIndex + c.twisted + c.pinched + c.unused !== 0 || !boundaryOnBox(m, c, h.dims)) {
        throw new Error(`seed ${seed} [${h.dims.join('×')}]: ${JSON.stringify({ ...c, boundaryEdges: undefined })}`);
      }
      if (h.dims.some((d) => d === 1)) expect(m.indices.length).toBe(0);
    }
  });
});
