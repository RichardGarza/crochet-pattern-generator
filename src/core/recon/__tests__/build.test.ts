// T3.2 — the geometry build of GeomApi.build (DESIGN.md §2.9.2–2.9.5, §6.3 T3).
import { describe, expect, it } from 'vitest';
import { manifoldReport } from '../../kernel/geom/manifold';
import { countZeroAreaTriangles, edgeStats, eulerCharacteristic, meshBounds } from '../../kernel/geom/meshMeasures';
import { sampleSdfVolume } from '../../kernel/geom/sdfVolume';
import { validateModel } from '../../model/schema';
import { Superseded } from '../../../workers/rpc';
import type { ReconResult, Vec3 } from '../../../types/geometry';
import { buildRecon, ReconError, reconErrorCode, RECON_ISSUES } from '../build';
import { GAUGE, request } from './helpers/requests';
import { centered, solidBounds, sphere, TEDDY } from './helpers/views';

const HEAVY = { timeout: 120_000 };
const teddy = centered(TEDDY);
const tb = solidBounds(teddy);
const teddySize: Vec3 = [tb.max[0] - tb.min[0], tb.max[1] - tb.min[1], tb.max[2] - tb.min[2]];

function only(r: ReconResult) {
  const [ref] = Object.keys(r.meshes);
  return { ref, mesh: r.meshes[ref], sdf: r.sdfs[ref], part: r.model.parts[0] };
}

/** Model-space bounds of the one mesh part. */
function modelBounds(r: ReconResult): { min: Vec3; max: Vec3 } {
  const { mesh, part } = only(r);
  const b = meshBounds(mesh.positions);
  return { min: [0, 1, 2].map((k) => b.min[k] + part.position[k]) as Vec3, max: [0, 1, 2].map((k) => b.max[k] + part.position[k]) as Vec3 };
}

async function expectValidResult(r: ReconResult, heightIn: number): Promise<void> {
  const v = validateModel(r.model);
  expect(v.ok, JSON.stringify(v)).toBe(true);
  expect(r.model.parts).toHaveLength(1);
  const { ref, mesh, sdf, part } = only(r);
  expect(part).toMatchObject({ id: 'body', type: 'mesh', dims: { meshRef: ref }, color: 'main' });
  expect(part.attach).toBeUndefined();
  expect(r.model.source?.stage).toBe('recon');
  expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  // Watertight, χ = 2, no zero-area triangle; manifold-3d: 1 part, genus 0.
  const e = edgeStats(mesh.indices);
  expect([e.boundaryEdges, e.nonManifoldEdges, e.misorientedEdges, e.degenerateTriangles]).toEqual([0, 0, 0, 0]);
  expect(eulerCharacteristic(mesh.indices)).toBe(2);
  expect(countZeroAreaTriangles(mesh)).toBe(0);
  expect(await manifoldReport(mesh)).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
  expect(r.report).toMatchObject({ parts: 1, genus: 0 });
  // Inches: lowest point y = 0, the height is the target; part-local mesh centered on its box.
  const mb = modelBounds(r);
  expect(Math.abs(mb.min[1])).toBeLessThan(1e-4);
  expect(mb.max[1] - mb.min[1]).toBeCloseTo(heightIn, 3);
  expect(r.model.finishedSize.height).toBeCloseTo(heightIn, 6);
  const local = meshBounds(mesh.positions);
  for (let k = 0; k < 3; k++) expect(Math.abs(local.min[k] + local.max[k])).toBeLessThan(1e-4);
  expect(mesh.labels.length).toBe(mesh.positions.length / 3);
  expect(mesh.labels.every((l) => l === 255)).toBe(true);
  // The stored part volume (part-local inches): inside at the center, ≈ 0 on the surface (Taubin moves the mesh a
  // fraction of a voxel).
  expect(sampleSdfVolume(sdf, [0, 0, 0])).toBeGreaterThan(0);
  let worst = 0;
  for (let i = 0; i < mesh.positions.length; i += 3 * 37) {
    worst = Math.max(worst, Math.abs(sampleSdfVolume(sdf, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]])));
  }
  expect(worst).toBeLessThan(1.5 * sdf.voxel);
  expect(r.labelImages).toEqual({});
  expect(r.photoPalette).toEqual([]);
}

describe('multi-view build', HEAVY, () => {
  for (const N of [64, 128] as const) {
    it(`teddy, four views, N = ${N}: a valid one-part model in inches`, async () => {
      const r = await buildRecon(request(teddy, ['front', 'left', 'top', 'back'], { N, targetHeightIn: 9 }, 7));
      expect(r.jobId).toBe(7);
      await expectValidResult(r, 9);
      for (const iou of Object.values(r.report.iouPerView)) expect(iou).toBeGreaterThan(0.95);
      expect(Object.keys(r.report.iouPerView).sort()).toEqual(['back', 'front', 'left', 'top']);
      // Proportions of the teddy (width and depth relative to the height) within 3%.
      const s = r.model.finishedSize;
      expect(Math.abs((s.width as number) / s.height / (teddySize[0] / teddySize[1]) - 1)).toBeLessThan(0.03);
      expect(Math.abs((s.depth as number) / s.height / (teddySize[2] / teddySize[1]) - 1)).toBeLessThan(0.05);
    });
  }

  it('front + left (two photos) is enough; front + top constrain X, Y, Z too', async () => {
    for (const labels of [['front', 'left'], ['front', 'top']] as const) {
      const r = await buildRecon(request(teddy, [...labels], { N: 64 }));
      await expectValidResult(r, 8);
    }
  });

  it('a wrongly scaled top view triggers the mismatch warning on that photo', async () => {
    const r = await buildRecon(request(teddy, ['front', 'left', { label: 'top', cam: { stretchU: 1.15 } }], { N: 64 }));
    const scale = r.issues.filter((i) => i.code === 'W_VIEW_SCALE');
    expect(scale).toHaveLength(1);
    expect(scale[0].where).toEqual({ view: 'top' });
    const ok = await buildRecon(request(teddy, ['front', 'left', 'top'], { N: 64 }));
    expect(ok.issues.map((i) => i.code)).not.toContain('W_VIEW_SCALE');
  });

  it('front + back alone: the inflation of the united silhouette (F3 "add a back photo")', async () => {
    const r = await buildRecon(request(teddy, ['front', 'back'], { N: 64, kappa: 0.9 }));
    await expectValidResult(r, 8);
    expect(r.issues.map((i) => i.code)).not.toContain('E_VIEWS');
    expect(r.report.iouPerView.front).toBeGreaterThan(0.97);
    // Symmetric about the photo plane z = 0.
    const mb = modelBounds(r);
    expect(Math.abs(mb.min[2] + mb.max[2])).toBeLessThan(0.02 * 8);
  });

  it('top photos alone cannot be built: ReconError E_VIEWS (the code survives a worker boundary)', async () => {
    const error = await buildRecon(request(teddy, ['top', 'bottom'], { N: 64 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReconError);
    expect((error as ReconError).code).toBe('E_VIEWS');
    expect(reconErrorCode({ message: (error as Error).message })).toBe('E_VIEWS');
    expect(reconErrorCode(new Error('boom'))).toBeNull();
  });

  it('drops a detached piece with a warning, and "Merge touching parts" keeps it', async () => {
    const two = [sphere(0.3, [-0.25, 0, 0]), sphere(0.18, [0.255, 0, 0])];
    const r = await buildRecon(request(two, ['front', 'left', 'top'], { N: 128 }));
    expect(r.issues.map((i) => i.code)).toContain(RECON_ISSUES.detached);
    const merged = await buildRecon(request(two, ['front', 'left', 'top'], { N: 128, mergeTouching: true }));
    expect(merged.issues.map((i) => i.code)).not.toContain(RECON_ISSUES.detached);
    expect(merged.model.finishedSize.width as number).toBeGreaterThan((r.model.finishedSize.width as number) * 1.2);
  });

  it('notes thin parts ("crochet flat")', async () => {
    // A flat disc: 0.04 units thick at N = 64 (voxel ≈ 0.016) — two samples.
    const disc = [{ c: [0, 0, 0] as Vec3, r: [0.5, 0.5, 0.02] as Vec3 }];
    const r = await buildRecon(request(disc, ['front', 'left', 'top'], { N: 64 }));
    expect(r.issues.map((i) => i.code)).toContain(RECON_ISSUES.thin);
    const ball = await buildRecon(request([sphere(0.5)], ['front', 'left', 'top'], { N: 64 }));
    expect(ball.issues.map((i) => i.code)).not.toContain(RECON_ISSUES.thin);
    // The teddy's ears are 4 voxels thick even at N = 64: preview and final agree (no note).
    for (const N of [64, 128] as const) {
      const t = await buildRecon(request(teddy, ['front', 'left', 'top'], { N }));
      expect(t.issues.map((i) => i.code)).not.toContain(RECON_ISSUES.thin);
    }
  });

  it('a fish seen head-on keeps its length (front rounding stretched along z)', async () => {
    const fish = [{ c: [0, 0, 0] as Vec3, r: [0.2, 0.45, 1.0] as Vec3 }];
    for (const labels of [['front', 'left', 'top'], ['front', 'left']] as const) {
      const r = await buildRecon(request(fish, labels.map((label) => ({ label, cam: { pxPerUnit: 200 } })), { N: 128 }));
      const s = r.model.finishedSize;
      expect(Math.abs((s.depth as number) / s.height / (2 / 0.9) - 1)).toBeLessThan(0.05);
      for (const iou of Object.values(r.report.iouPerView)) expect(iou).toBeGreaterThan(0.95);
      expect(r.issues.map((i) => i.code)).not.toContain(RECON_ISSUES.iou);
    }
  });

  it('a view the final shape does not match raises W_RECON_IOU on that photo', async () => {
    // The side photo shows a box-like object deeper at the top: the front rounding (round cross-sections) cannot
    // follow a side outline that is a thin bar at the bottom and a wide block at the top.
    const w = 512;
    const rect = (x0: number, x1: number, y0: number, y1: number, m = new Uint8Array(w * w)): Uint8Array<ArrayBuffer> => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[x + w * y] = 1;
      return m;
    };
    const side = rect(56, 456, 100, 200, rect(236, 276, 200, 400));
    const r = await buildRecon(request([], [{ label: 'front', mask: rect(206, 306, 100, 400) }, { label: 'left', mask: side }], { N: 64 }));
    const low = Object.entries(r.report.iouPerView).filter(([, v]) => v < 0.9);
    expect(low.length).toBeGreaterThan(0);
    const flagged = r.issues.filter((i) => i.code === RECON_ISSUES.iou).map((i) => i.where?.view);
    expect(flagged.sort()).toEqual(low.map(([id]) => id).sort());
  });

  it('front + back that disagree are flagged (W_VIEW_IOU on the plane-only path too)', async () => {
    const r = await buildRecon(request(teddy, ['front', { label: 'back', cam: { stretchU: 1.3 } }], { N: 64 }));
    expect(r.issues.filter((i) => i.code === 'W_VIEW_IOU').length).toBeGreaterThan(0);
  });

  it('empty masks: all empty is E_MASK_EMPTY; a top photo with only empty companions builds alone', async () => {
    const empty = new Uint8Array(512 * 512);
    const none = (await buildRecon(request(teddy, [{ label: 'front', mask: empty }, { label: 'left', mask: empty }], { N: 64 })).catch((e: unknown) => e)) as ReconError;
    expect(none.code).toBe('E_MASK_EMPTY');
    const top = await buildRecon(request(teddy, [{ label: 'front', mask: empty }, 'top'], { N: 64, targetHeightIn: 6 }));
    expect(Math.max(top.model.finishedSize.width as number, top.model.finishedSize.depth as number)).toBeCloseTo(6, 3);
    expect(top.issues.map((i) => i.code)).toContain('W_VIEW_EMPTY');
  });

  it('a shape that would exceed the 48 in part limit is E_RECON_SIZE; a target above 60 in is a RangeError', async () => {
    const rod = [{ c: [0, 0, 0] as Vec3, r: [0.1, 0.1, 0.7] as Vec3 }];
    const error = (await buildRecon(request(rod, [{ label: 'left', cam: { pxPerUnit: 300 } }], { N: 64, photoView: 'left', targetHeightIn: 8 })).catch((e: unknown) => e)) as ReconError;
    expect(error.code).toBe(RECON_ISSUES.size);
    const ok = await buildRecon(request(rod, [{ label: 'left', cam: { pxPerUnit: 300 } }], { N: 64, photoView: 'left', targetHeightIn: 2 }));
    expect(validateModel(ok.model).ok).toBe(true);
    await expect(buildRecon(request(teddy, ['front', 'left'], { N: 64, targetHeightIn: 61 }))).rejects.toThrow(RangeError);
  });

  it('keepHoles: a ring keeps its hole (genus 1, accepted: no warning)', async () => {
    // A ring in the XY plane: the front view is an annulus.
    const w = 512;
    const ring = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - 256, y + 0.5 - 256);
        if (d <= 190 && d >= 90) ring[x + w * y] = 1;
      }
    }
    const rect = (wPx: number, hPx: number): Uint8Array<ArrayBuffer> => {
      const m = new Uint8Array(w * w);
      for (let y = 256 - hPx / 2; y < 256 + hPx / 2; y++) for (let x = 256 - wPx / 2; x < 256 + wPx / 2; x++) m[x + w * y] = 1;
      return m;
    };
    const views = [
      { label: 'front' as const, mask: ring },
      { label: 'left' as const, mask: rect(100, 380) },
      { label: 'top' as const, mask: rect(380, 100) },
    ];
    const kept = await buildRecon(request([], views, { N: 64, keepHoles: true }));
    expect(kept.report.genus).toBe(1);
    expect(kept.issues.map((i) => i.code)).not.toContain(RECON_ISSUES.genus);
    const filled = await buildRecon(request([], views, { N: 64, keepHoles: false }));
    expect(filled.report.genus).toBe(0);
  });
});

describe('single photo (§2.9.3 view turns)', HEAVY, () => {
  it('front: width and height from the photo, depth from κ, symmetric about z = 0', async () => {
    const r = await buildRecon(request(teddy, ['front'], { N: 64, photoView: 'front', kappa: 0.9 }));
    await expectValidResult(r, 8);
    const s = r.model.finishedSize;
    expect(Math.abs((s.width as number) / s.height / (teddySize[0] / teddySize[1]) - 1)).toBeLessThan(0.03);
    const mb = modelBounds(r);
    expect(Math.abs(mb.min[2] + mb.max[2])).toBeLessThan(0.02 * 8);
    expect(r.model.name).toBe('Toy from one photo');
  });

  for (const view of ['left', 'right'] as const) {
    it(`${view} side: the photo becomes the object's side — front +Z (muzzle), symmetric about x = 0`, async () => {
      const r = await buildRecon(request(teddy, [view], { N: 64, photoView: view }));
      await expectValidResult(r, 8);
      const s = r.model.finishedSize;
      // The photo's width is the object's depth (Z).
      expect(Math.abs((s.depth as number) / s.height / (teddySize[2] / teddySize[1]) - 1)).toBeLessThan(0.03);
      const mb = modelBounds(r);
      expect(Math.abs(mb.min[0] + mb.max[0])).toBeLessThan(0.02 * 8);
      // The frontmost point (largest z) is the muzzle, at head height (the teddy's muzzle is at +Z, y ≈ 0.18 of
      // a 1-unit-tall body whose box center is 0) — not a foot or the back.
      const { mesh, part } = only(r);
      let best = -Infinity;
      let yAt = 0;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        if (mesh.positions[i + 2] > best) {
          best = mesh.positions[i + 2];
          yAt = mesh.positions[i + 1] + part.position[1];
        }
      }
      expect(yAt / s.height).toBeGreaterThan(0.55);
      expect(yAt / s.height).toBeLessThan(0.85);
    });
  }

  it('top: the longest extent in the photo plane is the target; the photo bottom is the object’s front', async () => {
    const r = await buildRecon(request(teddy, ['top'], { N: 64, photoView: 'top', targetHeightIn: 6 }));
    expect(validateModel(r.model).ok).toBe(true);
    const s = r.model.finishedSize;
    expect(Math.max(s.width as number, s.depth as number)).toBeCloseTo(6, 3);
    expect(Math.abs((s.depth as number) / (s.width as number) / (teddySize[2] / teddySize[0]) - 1)).toBeLessThan(0.04);
    // The muzzle (+Z) sticks out at x ≈ 0: the frontmost point is near the middle in x.
    const { mesh, part } = only(r);
    let best = -Infinity;
    let xAt = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i + 2] > best) {
        best = mesh.positions[i + 2];
        xAt = mesh.positions[i] + part.position[0];
      }
    }
    expect(Math.abs(xAt) / (s.width as number)).toBeLessThan(0.1);
  });

  it('uses only the orientation of align (an offset or scale cannot move the photo plane off x = 0)', async () => {
    const plain = await buildRecon(request(teddy, ['left'], { N: 64, photoView: 'left' }));
    const moved = await buildRecon(request(teddy, [{ label: 'left', align: { dx: 0.3, dy: -0.2, scale: 1.1 } }], { N: 64, photoView: 'left' }));
    expect(only(moved).part.position).toEqual(only(plain).part.position);
    await expect(buildRecon(request(teddy, [{ label: 'left', align: { dx: Number.NaN } }], { N: 64 }))).rejects.toThrow(RangeError);
    await expect(buildRecon(request(teddy, [{ label: 'left', align: { mirror: 1 as unknown as boolean } }], { N: 64 }))).rejects.toThrow(RangeError);
  });

  it('an empty mask is E_MASK_EMPTY on that photo', async () => {
    const req = request(teddy, [{ label: 'front', id: 'p1', mask: new Uint8Array(512 * 512) }], { N: 64 });
    const error = (await buildRecon(req).catch((e: unknown) => e)) as ReconError;
    expect(error.code).toBe('E_MASK_EMPTY');
    expect(error.issues[0].where).toEqual({ view: 'p1' });
  });
});

describe('build contract', HEAVY, () => {
  it('is deterministic: byte-identical meshes, volumes and model', async () => {
    const a = await buildRecon(request(teddy, ['front', 'left', 'top'], { N: 64 }));
    const b = await buildRecon(request(teddy, ['front', 'left', 'top'], { N: 64 }));
    expect(Object.keys(a.meshes)).toEqual(Object.keys(b.meshes));
    const ma = only(a);
    const mb = only(b);
    expect(Buffer.from(ma.mesh.positions.buffer).equals(Buffer.from(mb.mesh.positions.buffer))).toBe(true);
    expect(Buffer.from(ma.mesh.indices.buffer).equals(Buffer.from(mb.mesh.indices.buffer))).toBe(true);
    expect(Buffer.from(ma.sdf.data.buffer).equals(Buffer.from(mb.sdf.data.buffer))).toBe(true);
    expect(a.model).toEqual(b.model);
  });

  it('checks the gate between stages and stops when superseded', async () => {
    let calls = 0;
    const seen: number[] = [];
    const counting = {
      check: async (jobId: number) => {
        seen.push(jobId);
        calls++;
      },
    };
    await buildRecon(request(teddy, ['front', 'left', 'top'], { N: 64 }, 3), { gate: counting });
    expect(calls).toBeGreaterThanOrEqual(6);
    expect(new Set(seen)).toEqual(new Set([3]));
    let n = 0;
    const stopping = {
      check: async (jobId: number) => {
        if (++n === 3) throw new Superseded(jobId);
      },
    };
    await expect(buildRecon(request(teddy, ['front', 'left', 'top'], { N: 64 }, 3), { gate: stopping })).rejects.toBeInstanceOf(Superseded);
  });

  it('fills per-stage timings when asked', async () => {
    const timings: Record<string, number> = {};
    await buildRecon(request(teddy, ['front', 'left', 'top'], { N: 64 }), { timings });
    for (const k of ['masks', 'tables', 'hull', 'rounding', 'clean', 'mesh', 'decimate', 'validate', 'model']) expect(timings[k]).toBeGreaterThanOrEqual(0);
  });

  it('rejects malformed requests with RangeError', async () => {
    const ok = request(teddy, ['front', 'left'], { N: 64 });
    await expect(buildRecon({ ...ok, settings: { ...ok.settings, N: 100 as 64 } })).rejects.toThrow(RangeError);
    await expect(buildRecon({ ...ok, settings: { ...ok.settings, targetHeightIn: 0 } })).rejects.toThrow(RangeError);
    await expect(buildRecon({ ...ok, settings: { ...ok.settings, kappa: Number.NaN } })).rejects.toThrow(RangeError);
    await expect(buildRecon({ ...ok, views: [] })).rejects.toThrow(RangeError);
    await expect(buildRecon({ ...ok, views: [{ ...ok.views[0], maskW: 10 }] })).rejects.toThrow(RangeError);
    await expect(buildRecon({ ...ok, gauge: { ...GAUGE, cell: { w: 0, h: 0.2 } } })).rejects.toThrow(RangeError);
  });

  it('the masks of the request are not modified', async () => {
    const req = request(teddy, ['front', 'left'], { N: 64 });
    const copy = req.views.map((v) => Uint8Array.from(v.mask));
    await buildRecon(req);
    req.views.forEach((v, k) => expect(Buffer.from(v.mask).equals(Buffer.from(copy[k]))).toBe(true));
  });
});
