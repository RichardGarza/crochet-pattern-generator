import { describe, expect, it } from 'vitest';
import type { GetManifoldFn } from '../../../../types/entryPoints';
import { mulberry32 } from '../../prng';
import { getManifold, manifoldReport } from '../manifold';
import { marchingCubes } from '../marchingCubes';
import { signedVolume } from '../meshMeasures';
import { taubinSmooth } from '../taubin';
import { sampleField, sphere, sphereVolume, teddy, torus, twoSpheres } from './fields';

const TET = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const TET_FACES = [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2];

function mesh(n: number, f: Parameters<typeof sampleField>[1]): ReturnType<typeof marchingCubes> {
  const s = sampleField(n, f);
  return marchingCubes(s.field, s.dims, { origin: s.origin, voxel: s.voxel });
}

describe('getManifold (§5.4)', () => {
  it('has the frozen signature', () => {
    const frozen: GetManifoldFn = getManifold;
    expect(typeof frozen).toBe('function');
  });

  it('a unit cube: status NoError, genus 0, 1 part', async () => {
    const { Manifold } = await getManifold();
    const cube = Manifold.cube(1);
    const parts = cube.decompose();
    try {
      expect(cube.status()).toBe('NoError');
      expect(cube.genus()).toBe(0);
      expect(parts.length).toBe(1);
      expect(cube.volume()).toBeCloseTo(1, 12);
      expect(cube.numTri()).toBe(12);
    } finally {
      for (const part of parts) part.delete();
      cube.delete();
    }
  });

  it('called twice, returns the same promise and the same module', async () => {
    const first = getManifold();
    const second = getManifold();
    expect(second).toBe(first);
    expect(await second).toBe(await first);
    expect(await getManifold()).toBe(await first);
  });
});

describe('manifoldReport', () => {
  it('accepts the marching-cubes sphere as a manifold of genus 0, before and after Taubin', async () => {
    for (const n of [64, 128]) {
      const m = mesh(n, sphere(0.8));
      const raw = await manifoldReport(m);
      expect(raw).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
      expect(raw.volume).toBeCloseTo(signedVolume(m), 5);
      expect(Math.abs(raw.volume / sphereVolume(0.8) - 1)).toBeLessThan(0.002);
      taubinSmooth(m.positions, m.indices);
      const smooth = await manifoldReport(m);
      expect(smooth).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
      expect(smooth.volume).toBeCloseTo(signedVolume(m), 5);
    }
  });

  it('teddy: 1 part, genus 0; torus: genus 1; two spheres: 2 parts', async () => {
    expect(await manifoldReport(mesh(64, teddy))).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
    expect(await manifoldReport(mesh(128, teddy))).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
    expect(await manifoldReport(mesh(64, torus(0.6, 0.25)))).toMatchObject({ status: 'NoError', parts: 1, genus: 1 });
    expect(await manifoldReport(mesh(64, twoSpheres))).toMatchObject({ status: 'NoError', parts: 2, genus: 0 });
  });

  it('reports the genus of the largest part', async () => {
    // A torus and a much smaller sphere inside its hole.
    const both = mesh(64, (x, y, z) => Math.max(torus(0.7, 0.25)(x, y, z), sphere(0.2)(x, y, z)));
    expect(await manifoldReport(both)).toMatchObject({ status: 'NoError', parts: 2, genus: 1 });
  });

  it('accepts every random-field mesh that marching cubes closes', async () => {
    let checked = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const rng = mulberry32(seed);
      const dims: [number, number, number] = [2 + Math.floor(rng() * 7), 2 + Math.floor(rng() * 7), 2 + Math.floor(rng() * 7)];
      const field = Float32Array.from({ length: dims[0] * dims[1] * dims[2] }, () => {
        const r = rng() * 2 - 1;
        return seed % 3 === 0 ? r : seed % 3 === 1 ? Math.sign(r) : Math.round(2 * r);
      });
      const m = marchingCubes(field, dims);
      if (m.indices.length === 0) continue;
      const report = await manifoldReport(m);
      expect(report.status).toBe('NoError');
      expect(report.volume / signedVolume(m)).toBeCloseTo(1, 3);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('names what is wrong with a bad mesh instead of throwing', async () => {
    expect(await manifoldReport({ positions: TET, indices: TET_FACES })).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
    // a hole
    expect(await manifoldReport({ positions: TET, indices: TET_FACES.slice(0, 9) })).toEqual({ status: 'NotManifold', parts: 0, genus: 0, volume: 0 });
    // one triangle wound the other way
    expect((await manifoldReport({ positions: TET, indices: [0, 1, 2, 0, 1, 3, 1, 2, 3, 0, 3, 2] })).status).toBe('NotManifold');
    // a NaN coordinate, an index beyond the vertices
    expect((await manifoldReport({ positions: [...TET.slice(0, 11), NaN], indices: TET_FACES })).status).toBe('NonFiniteVertex');
    expect((await manifoldReport({ positions: TET, indices: [...TET_FACES.slice(0, 11), 7] })).status).toBe('VertexOutOfBounds');
    // nothing at all
    expect(await manifoldReport({ positions: [], indices: [] })).toEqual({ status: 'NoError', parts: 0, genus: 0, volume: 0 });
  });

  it('an inside-out mesh passes as NoError: the negative volume is the only sign', async () => {
    const insideOut = await manifoldReport({ positions: TET, indices: [0, 1, 2, 0, 3, 1, 1, 3, 2, 0, 2, 3] });
    expect(insideOut.status).toBe('NoError');
    expect(insideOut.volume).toBeCloseTo(-1 / 6, 12);
  });

  it('does not modify the buffers it is given', async () => {
    const m = mesh(24, teddy);
    const positions = Float32Array.from(m.positions);
    const indices = Uint32Array.from(m.indices);
    await manifoldReport(m);
    expect(m.positions).toEqual(positions);
    expect(m.indices).toEqual(indices);
  });
});
