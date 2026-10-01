// Is the marching-cubes surface embedded (no triangle passes through another)? From the independent review of
// Step 0b.
//
// The kernel promises an abstract oriented 2-manifold; nothing in its header says the triangles do not cross each
// other in space. This file looks for crossings with a brute-force test of every pair of triangles: none on 800
// random fields when the review ran it; a seeded 300 of them run here.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../prng';
import { type IndexedMesh, marchingCubes } from '../marchingCubes';
import { HEAVY, note } from './fields';

type P3 = [number, number, number];

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const TOL = 1e-7;

/** True when the open segment pq passes through the interior of triangle abc (not coplanar, not through its rim). */
function segmentPiercesTriangle(p: P3, q: P3, a: P3, b: P3, c: P3): boolean {
  const dir = sub(q, p);
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const h = cross(dir, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return false;
  const s = sub(p, a);
  const u = dot(s, h) / det;
  if (u <= TOL || u >= 1 - TOL) return false;
  const qv = cross(s, e1);
  const v = dot(dir, qv) / det;
  if (v <= TOL || u + v >= 1 - TOL) return false;
  const t = dot(e2, qv) / det;
  return t > TOL && t < 1 - TOL;
}

/** True when the open segments pq and rs cross each other in one interior point. */
function segmentsCross(p: P3, q: P3, r: P3, s: P3): boolean {
  const d1 = sub(q, p);
  const d2 = sub(s, r);
  const w = sub(p, r);
  const n = cross(d1, d2);
  const nn = dot(n, n);
  if (nn < 1e-18) return false; // parallel
  // coplanar?
  if (Math.abs(dot(w, n)) > 1e-9 * Math.sqrt(nn)) return false;
  const t = dot(cross(sub(r, p), d2), n) / nn;
  const u = dot(cross(sub(r, p), d1), n) / nn;
  return t > TOL && t < 1 - TOL && u > TOL && u < 1 - TOL;
}

function crossings(m: IndexedMesh): { piercings: number; edgeCrossings: number; example: string } {
  const vertex = (v: number): P3 => [m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]];
  const T = m.indices.length / 3;
  const tris: number[][] = [];
  for (let t = 0; t < T; t++) tris.push([m.indices[3 * t], m.indices[3 * t + 1], m.indices[3 * t + 2]]);
  let piercings = 0;
  let example = '';
  for (let i = 0; i < T; i++) {
    for (let j = 0; j < T; j++) {
      if (i === j) continue;
      const [a, b, c] = tris[j];
      for (let e = 0; e < 3; e++) {
        const p = tris[i][e];
        const q = tris[i][(e + 1) % 3];
        // an edge that touches triangle j in a shared vertex cannot pierce its interior
        if (p === a || p === b || p === c || q === a || q === b || q === c) continue;
        if (segmentPiercesTriangle(vertex(p), vertex(q), vertex(a), vertex(b), vertex(c))) {
          piercings++;
          if (example === '') example = `edge ${p}-${q} [${vertex(p)}]→[${vertex(q)}] pierces triangle ${a},${b},${c} [${vertex(a)}] [${vertex(b)}] [${vertex(c)}]`;
        }
      }
    }
  }
  // edges crossing edges (the case the strict test above lets through)
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  for (const tri of tris) {
    for (let e = 0; e < 3; e++) {
      const p = Math.min(tri[e], tri[(e + 1) % 3]);
      const q = Math.max(tri[e], tri[(e + 1) % 3]);
      if (!seen.has(`${p},${q}`)) {
        seen.add(`${p},${q}`);
        edges.push([p, q]);
      }
    }
  }
  let edgeCrossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [p, q] = edges[i];
      const [r, s] = edges[j];
      if (p === r || p === s || q === r || q === s) continue;
      if (segmentsCross(vertex(p), vertex(q), vertex(r), vertex(s))) {
        edgeCrossings++;
        if (example === '') example = `edge ${p}-${q} [${vertex(p)}]→[${vertex(q)}] crosses edge ${r}-${s} [${vertex(r)}]→[${vertex(s)}]`;
      }
    }
  }
  return { piercings, edgeCrossings, example };
}

describe('the crossing tests themselves', () => {
  it('find a pierced triangle and two crossing edges, and accept a tetrahedron', () => {
    const tri: P3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    expect(segmentPiercesTriangle([0.2, 0.2, -1], [0.2, 0.2, 1], tri[0], tri[1], tri[2])).toBe(true);
    expect(segmentPiercesTriangle([0.2, 0.2, 0.1], [0.2, 0.2, 1], tri[0], tri[1], tri[2])).toBe(false);
    expect(segmentPiercesTriangle([2, 2, -1], [2, 2, 1], tri[0], tri[1], tri[2])).toBe(false);
    expect(segmentsCross([0, 0, 0], [1, 1, 0], [1, 0, 0], [0, 1, 0])).toBe(true);
    expect(segmentsCross([0, 0, 0], [1, 1, 0], [1, 0, 0.1], [0, 1, 0.1])).toBe(false);
    expect(segmentsCross([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0])).toBe(false);
    const tet: IndexedMesh = { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1), indices: Uint32Array.of(0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2) };
    expect(crossings(tet)).toMatchObject({ piercings: 0, edgeCrossings: 0 });
    // two tetrahedra pushed into each other
    const two: IndexedMesh = {
      positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.1, 0.1, -0.5, 1.1, 0.1, -0.5, 0.1, 1.1, -0.5, 0.1, 0.1, 0.5),
      indices: Uint32Array.of(0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2, 4, 6, 5, 4, 5, 7, 5, 6, 7, 4, 7, 6),
    };
    expect(crossings(two).piercings).toBeGreaterThan(0);
  });
});

describe('is the surface embedded?', HEAVY, () => {
  it('no triangle passes through another, and no two edges cross, on 300 random fields (noise, ±1, integers with zeros, wide range)', () => {
    let fields = 0;
    let crossed = 0;
    let first = '';
    const byKind: Record<string, number> = {};
    for (let seed = 1; seed <= 300; seed++) {
      const rng = mulberry32(seed * 271 + 3);
      const dims: [number, number, number] = [2 + Math.floor(rng() * 3), 2 + Math.floor(rng() * 3), 2 + Math.floor(rng() * 3)];
      const kind = ['noise', 'sign', 'integers', 'wide range'][seed % 4];
      const field = Float32Array.from({ length: dims[0] * dims[1] * dims[2] }, () => {
        const r = rng() * 2 - 1;
        if (kind === 'noise') return r;
        if (kind === 'sign') return r < 0 ? -1 : 1;
        if (kind === 'integers') return Math.round(r * 2);
        return r * [1e-3, 1, 1e3][Math.floor(rng() * 3)];
      });
      const m = marchingCubes(field, dims);
      if (m.indices.length === 0) continue;
      fields++;
      const c = crossings(m);
      if (c.piercings + c.edgeCrossings > 0) {
        crossed++;
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        if (first === '') first = `seed ${seed} [${dims.join('×')}] ${kind}: ${c.piercings} piercings, ${c.edgeCrossings} edge crossings; ${c.example}`;
      }
    }
    note(`self-intersection: ${crossed} of ${fields} random fields have crossing triangles ${JSON.stringify(byKind)}${first ? `\n  first: ${first}` : ''}`);
    expect(fields).toBeGreaterThan(250);
    // Not a proof (sampling; coplanar overlaps and mere touching are not looked for), but no counterexample.
    expect(crossed).toBe(0);
  });
});
