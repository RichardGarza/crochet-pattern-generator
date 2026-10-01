// manifold.ts on real meshes: "manifold-3d accepts every marching-cubes mesh", the semantics of the report, and
// the WASM heap. From the independent review of Step 0b; the piece count, volumes and genus it compares with
// are computed here, not by meshMeasures.ts.
//
// The run over all 3 × 2^18 four-cell patterns through manifold-3d needs GEOM_FULL=1 (under a minute: 49 s
// measured on an M3 Pro under load).
import Module from 'manifold-3d';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../prng';
import { getManifold, manifoldReport } from '../manifold';
import { type IndexedMesh, marchingCubes } from '../marchingCubes';
import { HEAVY, note } from './fields';

const FULL = process.env.GEOM_FULL === '1';

/**
 * The loader exactly as DESIGN.md §5.4 prints it. Never called: only the type checker reads it. If manifold-3d's
 * typings accepted `{}`, the directive below would be unused and `npm run typecheck` would fail (TS2578) — so a
 * green typecheck confirms the author's claim that the printed snippet does not compile.
 */
export function loaderAsPrintedInDesign54(isNode: boolean, wasmUrl: string): Promise<unknown> {
  // @ts-expect-error TS2345: `{}` is not assignable to `{ locateFile: () => string }`
  return Module(isNode ? {} : { locateFile: () => wasmUrl });
}

// ---- helpers (independent of meshMeasures.ts) --------------------------------------------------------------------

interface Piece {
  volume: number;
  /** 1 − χ/2 of this closed piece. */
  genus: number;
}

/** Connected pieces of a closed mesh with their signed volume and genus. */
function pieces(m: IndexedMesh): Piece[] {
  const V = m.positions.length / 3;
  const parent = Int32Array.from({ length: V }, (_, i) => i);
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (let t = 0; t < m.indices.length; t += 3) {
    parent[find(m.indices[t])] = find(m.indices[t + 1]);
    parent[find(m.indices[t])] = find(m.indices[t + 2]);
  }
  const byRoot = new Map<number, { vertices: number; triangles: number; six: number }>();
  for (let v = 0; v < V; v++) {
    const entry = byRoot.get(find(v)) ?? { vertices: 0, triangles: 0, six: 0 };
    entry.vertices++;
    byRoot.set(find(v), entry);
  }
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const entry = byRoot.get(find(m.indices[t])) as { vertices: number; triangles: number; six: number };
    const a = 3 * m.indices[t];
    const b = 3 * m.indices[t + 1];
    const c = 3 * m.indices[t + 2];
    entry.triangles++;
    entry.six += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  // closed triangle mesh: E = 3F/2, so χ = V − F/2
  return [...byRoot.values()].map((e) => ({ volume: e.six / 6, genus: 1 - (e.vertices - e.triangles / 2) / 2 }));
}

function patternMesh(bits: number, dims: [number, number, number]): IndexedMesh {
  const n = dims[0] * dims[1] * dims[2];
  const field = new Float32Array(n);
  for (let i = 0; i < n; i++) field[i] = (bits >> i) & 1 ? 1 : -1;
  return marchingCubes(field, dims);
}

async function expectAccepted(m: IndexedMesh, label: string): Promise<void> {
  const report = await manifoldReport(m);
  const mine = pieces(m);
  const volume = mine.reduce((sum, piece) => sum + piece.volume, 0);
  if (report.status !== 'NoError' || report.parts !== mine.length || Math.abs(report.volume - volume) > 1e-6 * Math.max(1, Math.abs(volume))) {
    throw new Error(`${label}: ${JSON.stringify(report)}, expected ${mine.length} parts, volume ${volume}`);
  }
}

const TET = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const TET_FACES = [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2];

// ---- manifold-3d accepts what marching cubes makes ---------------------------------------------------------------

describe('manifold-3d on marching-cubes meshes', HEAVY, () => {
  it('accepts every two-cell pattern (3 × 4096) with the right number of parts and volume', async () => {
    for (const dims of [
      [3, 2, 2],
      [2, 3, 2],
      [2, 2, 3],
    ] as [number, number, number][]) {
      for (let bits = 1; bits < 4096; bits++) await expectAccepted(patternMesh(bits, dims), `${dims.join('×')} pattern ${bits}`);
    }
  });

  it('accepts a seeded sample of the four-cell patterns', async () => {
    const rng = mulberry32(0xbead);
    for (const dims of [
      [3, 3, 2],
      [3, 2, 3],
      [2, 3, 3],
    ] as [number, number, number][]) {
      for (let i = 0; i < 3000; i++) {
        const bits = 1 + Math.floor(rng() * ((1 << 18) - 1));
        await expectAccepted(patternMesh(bits, dims), `${dims.join('×')} pattern ${bits}`);
      }
    }
  });

  it.runIf(FULL)(
    'accepts ALL 3 × 2^18 four-cell patterns',
    async () => {
      let meshes = 0;
      for (const dims of [
        [3, 3, 2],
        [3, 2, 3],
        [2, 3, 3],
      ] as [number, number, number][]) {
        for (let bits = 1; bits < 1 << 18; bits++) {
          await expectAccepted(patternMesh(bits, dims), `${dims.join('×')} pattern ${bits}`);
          meshes++;
        }
      }
      note(`manifold-3d accepted ${meshes} four-cell meshes; parts and volume agree every time`);
    },
    1_800_000,
  );

  it('random hostile fields: status, parts, volume and the genus of the largest part agree with an independent count', async () => {
    let checked = 0;
    let withHandles = 0;
    let severalParts = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rng = mulberry32(seed * 613);
      const dims: [number, number, number] = [1 + Math.floor(rng() * 9), 1 + Math.floor(rng() * 9), 1 + Math.floor(rng() * 9)];
      const kind = seed % 6;
      const field = Float32Array.from({ length: dims[0] * dims[1] * dims[2] }, () => {
        const r = rng() * 2 - 1;
        if (kind === 0) return r;
        if (kind === 1) return r < 0 ? -1 : 1;
        if (kind === 2) return Math.round(2 * r);
        if (kind === 3) return rng() < 0.1 ? NaN : rng() < 0.1 ? Infinity : rng() < 0.1 ? -Infinity : rng() < 0.1 ? 0 : r;
        if (kind === 4) return r * [1e-12, 1e-6, 1e-3, 1, 1e6, 1e12][Math.floor(rng() * 6)];
        return r + 0.35;
      });
      const m = marchingCubes(field, dims, { origin: [rng() * 8 - 4, rng() * 8 - 4, rng() * 8 - 4], voxel: [0.2 + rng(), 0.2 + rng(), 0.2 + rng()] });
      if (m.indices.length === 0) continue;
      const report = await manifoldReport(m);
      const mine = pieces(m).sort((a, b) => Math.abs(b.volume) - Math.abs(a.volume));
      const volume = mine.reduce((sum, piece) => sum + piece.volume, 0);
      expect(report.status).toBe('NoError');
      expect(report.parts).toBe(mine.length);
      expect(Math.abs(report.volume / volume - 1)).toBeLessThan(1e-5);
      const tie = mine.length > 1 && Math.abs(mine[1].volume) > Math.abs(mine[0].volume) * (1 - 1e-6);
      if (!tie) expect(report.genus).toBe(mine[0].genus);
      if (mine[0].genus > 0) withHandles++;
      if (mine.length > 1) severalParts++;
      checked++;
    }
    expect(checked).toBeGreaterThan(350);
    expect(withHandles).toBeGreaterThan(50);
    expect(severalParts).toBeGreaterThan(100);
  });

  it('a lattice that float32 positions cannot resolve never reaches manifold-3d: marching cubes refuses it', () => {
    // (The review found that at an origin of 1e7 the 0.01-voxel clamp was rounded away — manifold-3d still said
    // NoError but dropped the collapsed pieces, so `parts` was no longer the number of pieces — and that an
    // origin of 1e39 gave a mesh that manifold-3d rejects as NonFiniteVertex.)
    const rng = mulberry32(5);
    const dims: [number, number, number] = [6, 6, 6];
    const field = Float32Array.from({ length: 216 }, () => Math.round((rng() * 2 - 1) * 2));
    expect(() => marchingCubes(field, dims, { origin: [1e7, 1e7, 1e7] })).toThrow(RangeError);
    expect(() => marchingCubes(field, dims, { origin: [1e39, 0, 0] })).toThrow(RangeError);
  });
});

// ---- manifoldReport itself ---------------------------------------------------------------------------------------

describe('manifoldReport semantics', () => {
  it('a hollow ball: 2 parts (the cavity wall is a part with negative volume), genus 0, volume = outer − inner', async () => {
    const n = 24;
    const c = (n - 1) / 2;
    const field = new Float32Array(n * n * n);
    let i = 0;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field[i++] = Math.min(9 - Math.hypot(x - c, y - c, z - c), Math.hypot(x - c, y - c, z - c) - 5);
    const m = marchingCubes(field, [n, n, n]);
    const report = await manifoldReport(m);
    expect(report).toMatchObject({ status: 'NoError', parts: 2, genus: 0 });
    const expected = (4 / 3) * Math.PI * (9 ** 3 - 5 ** 3);
    expect(Math.abs(report.volume / expected - 1)).toBeLessThan(0.02);
    expect(pieces(m).map((p) => Math.sign(p.volume)).sort()).toEqual([-1, 1]);
  });

  it('two tetrahedra that share one vertex are 2 parts for manifold-3d (it splits the pinched vertex)', async () => {
    const positions = [...TET, 0, 0, -1, 0, -1, 0, -1, 0, 0];
    const second = [0, 4, 5, 0, 6, 4, 0, 5, 6, 4, 6, 5];
    const report = await manifoldReport({ positions, indices: [...TET_FACES, ...second] });
    expect(report.status).toBe('NoError');
    expect(report.parts).toBe(2);
  });

  it('gives a status, not an exception, for malformed buffers', async () => {
    const results: Record<string, string> = {};
    const attempt = async (label: string, mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }): Promise<void> => {
      try {
        results[label] = (await manifoldReport(mesh)).status;
      } catch (error) {
        results[label] = `THROWS ${String(error)}`;
      }
    };
    await attempt('positions length 10', { positions: TET.slice(0, 10), indices: TET_FACES });
    // (The second review found a 13th value silently dropped by manifold-3d: the tetrahedron came back 'NoError'.)
    await attempt('positions length 13', { positions: [...TET, 5], indices: TET_FACES });
    await attempt('indices length 11', { positions: TET, indices: TET_FACES.slice(0, 11) });
    await attempt('negative index', { positions: TET, indices: [...TET_FACES.slice(0, 11), -1] });
    await attempt('fractional index 2.9', { positions: TET, indices: [...TET_FACES.slice(0, 11), 2.9] });
    await attempt('NaN index', { positions: TET, indices: [...TET_FACES.slice(0, 11), NaN] });
    await attempt('no positions', { positions: [], indices: TET_FACES });
    await attempt('Infinity position', { positions: [...TET.slice(0, 11), Infinity], indices: TET_FACES });
    await attempt('position beyond float32', { positions: [...TET.slice(0, 11), 1e39], indices: TET_FACES });
    await attempt('index 2^32', { positions: TET, indices: [...TET_FACES.slice(0, 11), 2 ** 32] });
    note(`manifoldReport on malformed buffers: ${JSON.stringify(results, null, 1)}`);
    // An index that is not an integer in [0, 2^32) is never handed to Uint32Array.from, which would turn 2.9
    // into 2 and NaN into 0 and so validate a mesh that was not passed in (the review found 'NoError' for 2.9).
    expect(results).toEqual({
      'positions length 10': 'PropertiesWrongLength',
      'positions length 13': 'PropertiesWrongLength',
      'indices length 11': 'NotManifold',
      'negative index': 'VertexOutOfBounds',
      'fractional index 2.9': 'VertexOutOfBounds',
      'NaN index': 'VertexOutOfBounds',
      'no positions': 'NotManifold',
      'Infinity position': 'NonFiniteVertex',
      'position beyond float32': 'NonFiniteVertex',
      'index 2^32': 'VertexOutOfBounds',
    });
  });
});

// ---- WASM memory ---------------------------------------------------------------------------------------------------

describe('manifoldReport and the WASM heap', HEAVY, () => {
  /** Runs `fn` and returns how often the WASM memory had to grow, and its size after the last growth. */
  async function growthDuring(fn: () => Promise<void>): Promise<{ grows: number; bytes: number }> {
    const original = WebAssembly.Memory.prototype.grow;
    const seen = { grows: 0, bytes: 0 };
    WebAssembly.Memory.prototype.grow = function (this: WebAssembly.Memory, delta: number): number {
      seen.grows++;
      const result = original.call(this, delta);
      seen.bytes = this.buffer.byteLength;
      return result;
    };
    try {
      await fn();
    } finally {
      WebAssembly.Memory.prototype.grow = original;
    }
    return seen;
  }

  it('30 000 accepted meshes do not grow the WASM memory', async () => {
    await manifoldReport({ positions: TET, indices: TET_FACES });
    const seen = await growthDuring(async () => {
      for (let i = 0; i < 30_000; i++) await manifoldReport({ positions: TET, indices: TET_FACES });
    });
    expect(seen.grows).toBe(0);
  });

  it('30 000 rejected meshes do not grow it either', async () => {
    // manifold-3d's own `new Manifold(mesh)` throws on a bad status without deleting the object it made: about
    // half a kilobyte of WASM heap per rejected mesh, never returned (the review measured 16.8 MB → 217 MB over
    // 300 000 rejections through the first version of manifoldReport). manifoldFromMesh builds the object with
    // the constructor underneath that wrapper, reads the status and frees it.
    const hole = { positions: TET, indices: TET_FACES.slice(0, 9) };
    expect(await manifoldReport(hole)).toEqual({ status: 'NotManifold', parts: 0, genus: 0, volume: 0 });
    const seen = await growthDuring(async () => {
      for (let i = 0; i < 30_000; i++) await manifoldReport(hole);
    });
    note(`30 000 rejected meshes: WASM memory grew ${seen.grows} times`);
    expect(seen.grows).toBe(0);
  });

  it('the wrapper of manifold-3d itself does leak a rejected mesh (if this fails, manifoldFromMesh can use the plain constructor again)', async () => {
    const { Manifold, Mesh } = await getManifold();
    // Up to 200 000 rejections, in rounds, until the WASM memory has to grow (it did within the first rounds
    // when this was written: about half a kilobyte stays behind per rejected mesh).
    let grows = 0;
    for (let round = 0; round < 20 && grows === 0; round++) {
      const seen = await growthDuring(async () => {
        for (let i = 0; i < 10_000; i++) {
          try {
            new Manifold(new Mesh({ numProp: 3, vertProperties: Float32Array.from(TET), triVerts: Uint32Array.from(TET_FACES.slice(0, 9)) })).delete();
          } catch {
            // rejected, as expected: there is no object to delete — that is the leak
          }
        }
      });
      grows += seen.grows;
    }
    expect(grows).toBeGreaterThan(0);
  });

  it('the constructor underneath the wrapper returns the object whatever its status, so it can be freed', async () => {
    const { Manifold, Mesh } = await getManifold();
    const Raw = Object.getPrototypeOf(Manifold.prototype).constructor as new (mesh: InstanceType<typeof Mesh>) => InstanceType<typeof Manifold>;
    expect(Raw).not.toBe(Manifold);
    const seen = await growthDuring(async () => {
      for (let i = 0; i < 30_000; i++) {
        const solid = new Raw(new Mesh({ numProp: 3, vertProperties: Float32Array.from(TET), triVerts: Uint32Array.from(TET_FACES.slice(0, 9)) }));
        if (solid.status() !== 'NotManifold') throw new Error(solid.status());
        solid.delete();
      }
    });
    expect(seen.grows).toBe(0);
  });
});
