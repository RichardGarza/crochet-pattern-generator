// Track T5 (DESIGN.md §5.4, §2.9.8, §2.10.7): the REAL mesh.worker in Chromium under `npm run dev`.
//   - every MeshApi method in one worker: fromPart → voxelize → sculpt → undo → redo → cut, merge, pathB, fit;
//   - two instances at once (the editor's and ami.worker's private one): independent ids, concurrent Path B;
//   - cancellation: a supersede stops a running Path B job within one gate slice; the app client's latest-wins
//     channel resolves only the last request;
// with no console errors in the page or the workers. Nothing is stored.
import { expect, test, type Page } from '@playwright/test';
import { budget } from '../../src/test/timing';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('worker', (w) => w.on('console', (m) => m.type() === 'error' && errors.push(`worker console: ${m.text()}`)));
  return errors;
}

const GAUGE = { cell: { w: 0.195, h: 0.195 / 1.05 }, wSc: 0.195, hSc: 0.19, lscIn: 1, hookMm: 3.5, stretch: 1.05, tol: 0.1, source: 'default' };
const SETTINGS = { style: 'exact', spiral: true, crispStripes: false, decMethod: 'invdec', dialect: 'compact', terms: 'us', hand: 'right', eyes: 'auto', defaultStuffing: 'firm', leanStPerRnd: 0.25 };

test.describe('T5 mesh.worker', () => {
  test.describe.configure({ timeout: 180_000 });
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = watchErrors(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'What would you like to make?' })).toBeVisible();
  });

  test.afterEach(() => {
    expect(errors, 'no console errors and no page errors').toEqual([]);
  });

  test('every MeshApi method answers in a real worker', async ({ page }, info) => {
    const r = await page.evaluate(
      async ({ GAUGE, SETTINGS }) => {
        const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
        const { wrap } = await load('/node_modules/comlink/dist/esm/comlink.mjs');
        const worker = new Worker('/src/workers/mesh.worker.ts?worker_file&type=module', { type: 'module' });
        const mesh = wrap(worker);
        const vol = (m: any): number => {
          let s = 0;
          const P = m.positions;
          const I = m.indices;
          for (let t = 0; t < I.length; t += 3) {
            const [a, b, c] = [3 * I[t], 3 * I[t + 1], 3 * I[t + 2]];
            s += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
          }
          return s / 6;
        };
        try {
          const palette = ['caramel', 'cream'];
          const part = (id: string, r: number, y: number, color: string) => ({ id, type: 'sphere', dims: { r }, position: [0, y, 0], rotationDeg: [0, 0, 0], color });
          const t0 = performance.now();
          const ball = await mesh.fromPart(part('ball', 1, 0, 'cream'), { paletteIds: palette, N: 48 });
          const { volumeId } = await mesh.voxelize(ball, 48);
          const up = await mesh.sculpt(volumeId, { tool: 'inflate', points: [[0, 0, 1]], radius: 0.4, strength: 0.8, mirrorX: false });
          const undone = await mesh.undoSculpt(up.undoId);
          const redone = await mesh.redoSculpt(up.undoId);
          const [a, b] = await mesh.cut(volumeId, { point: [0, 0, 0], normal: [0, 1, 0] });
          const merged = await mesh.merge([{ part: part('body', 1, 0, 'caramel') }, { part: part('head', 0.8, 1.5, 'cream') }], { paletteIds: palette, N: 64 });
          const big = await mesh.fromPart(part('b', 1.25, 0, 'cream'), { paletteIds: palette, N: 64 });
          const tp = performance.now();
          const rounds = await mesh.pathB({ jobId: 1, mesh: big, partId: 'b', frame: {}, gauge: GAUGE, settings: SETTINGS });
          const pathBMs = performance.now() - tp;
          let fit = 'resolved';
          try {
            await mesh.fit(ball);
          } catch (e) {
            fit = (e as Error).name;
          }
          let wrongId = '';
          try {
            await mesh.sculpt('elsewhere-v1', { tool: 'inflate', points: [[0, 0, 1]], radius: 0.4, strength: 0.8, mirrorX: false });
          } catch (e) {
            wrongId = `${(e as Error).name}: ${(e as Error).message}`;
          }
          return {
            ms: performance.now() - t0,
            pathBMs,
            ballVol: vol(ball),
            upVol: vol(up.mesh),
            undoneSame: undone.mesh.positions.length === ball.positions.length && undone.mesh.positions.every((x: number, i: number) => x === ball.positions[i]),
            redoneVol: vol(redone.mesh),
            undoId: up.undoId,
            volumeId,
            cutVols: [vol(a), vol(b)],
            mergedGenus: merged.genus,
            mergedVol: merged.volumeIn3,
            mergedLabels: [...new Set(merged.mesh.labels)].sort(),
            sdfDims: merged.sdf.dims,
            path: rounds.path,
            counts: rounds.counts,
            regularized: rounds.regularized,
            labels: [...new Set(rounds.stitchLabels.flatMap((l: Uint8Array) => [...l]))],
            ringsOk: rounds.rings.length === rounds.counts.length && rounds.rings.every((g: any) => g.polyline instanceof Float32Array),
            opsOk: rounds.ops.length === rounds.counts.length,
            issues: rounds.issues.map((i: any) => i.code),
            fit,
            wrongId,
          };
        } finally {
          worker.terminate();
        }
      },
      { GAUGE, SETTINGS },
    );
    await info.attach('mesh-worker', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
    expect(r.ballVol).toBeGreaterThan(4.0);
    expect(r.upVol).toBeGreaterThan(r.ballVol);
    expect(r.undoneSame).toBe(true);
    expect(r.redoneVol).toBeCloseTo(r.upVol, 3);
    expect(r.undoId.startsWith(`${r.volumeId}:`)).toBe(true);
    expect(Math.abs((r.cutVols[0] + r.cutVols[1]) / r.redoneVol - 1)).toBeLessThan(0.02);
    expect(r.mergedGenus).toBe(0);
    expect(r.mergedLabels).toEqual([0, 1]);
    expect(Math.max(...r.sdfDims)).toBe(64);
    expect(r.path).toBe('B');
    expect(r.regularized).toBe(true);
    expect(r.counts[0]).toBeGreaterThanOrEqual(5);
    expect(Math.max(...r.counts)).toBeGreaterThanOrEqual(37); // 2π·1.25 / 0.205 = 38.4
    expect(Math.max(...r.counts)).toBeLessThanOrEqual(39);
    expect(r.labels).toEqual([1]);
    expect(r.ringsOk && r.opsOk).toBe(true);
    expect(r.issues).toEqual([]);
    expect(['NotImplementedError', 'resolved']).toContain(r.fit);
    expect(r.wrongId).toMatch(/^MeshToolError: no sculpt volume elsewhere-v1/);
    expect(r.pathBMs).toBeLessThan(budget(2000));
  });

  test('two instances at once: independent volumes, concurrent Path B', async ({ page }) => {
    const r = await page.evaluate(
      async ({ GAUGE, SETTINGS }) => {
        const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
        const { wrap } = await load('/node_modules/comlink/dist/esm/comlink.mjs');
        const spawn = () => new Worker('/src/workers/mesh.worker.ts?worker_file&type=module', { type: 'module' });
        const [w1, w2] = [spawn(), spawn()];
        const [m1, m2] = [wrap(w1), wrap(w2)];
        try {
          const part = { id: 'b', type: 'sphere', dims: { r: 1 }, position: [0, 0, 0], rotationDeg: [0, 0, 0], color: 'c' };
          const ball = await m1.fromPart(part, { paletteIds: ['c'], N: 48 });
          const v1 = (await m1.voxelize(ball, 48)).volumeId;
          const v2 = (await m2.voxelize(ball, 48)).volumeId;
          let cross = '';
          try {
            await m2.cut(v1, { point: [0, 0, 0], normal: [0, 1, 0] });
          } catch (e) {
            cross = (e as Error).name;
          }
          const req = (jobId: number) => ({ jobId, mesh: ball, partId: 'b', frame: {}, gauge: GAUGE, settings: SETTINGS });
          const [a, b] = await Promise.all([m1.pathB(req(1)), m2.pathB(req(1))]);
          return { v1, v2, cross, same: JSON.stringify(a.counts) === JSON.stringify(b.counts), counts: a.counts };
        } finally {
          w1.terminate();
          w2.terminate();
        }
      },
      { GAUGE, SETTINGS },
    );
    expect(r.v1).not.toBe(r.v2);
    expect(r.cross).toBe('MeshToolError');
    expect(r.same).toBe(true);
    expect(r.counts.length).toBeGreaterThan(10);
  });

  test('a supersede stops a running Path B job within a gate slice; the client keeps the latest request', async ({ page }) => {
    const r = await page.evaluate(
      async ({ GAUGE, SETTINGS }) => {
        const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
        const { wrap } = await load('/node_modules/comlink/dist/esm/comlink.mjs');
        const worker = new Worker('/src/workers/mesh.worker.ts?worker_file&type=module', { type: 'module' });
        const mesh = wrap(worker);
        const part = { id: 'b', type: 'sphere', dims: { r: 3 }, position: [0, 0, 0], rotationDeg: [0, 0, 0], color: 'c' };
        const lags: number[] = [];
        let state = '';
        try {
          const big = await mesh.fromPart(part, { paletteIds: ['c'], N: 96 });
          const req = (jobId: number) => ({ jobId, mesh: big, partId: 'b', frame: {}, gauge: GAUGE, settings: SETTINGS });
          // Stop the job at several points of its run (re-mesh, heat, rows): each time the rejection comes within
          // one synchronous stretch of the supersede.
          for (const [k, delay] of [10, 150, 300, 450, 600].entries()) {
            const job = mesh.pathB(req(10 * k + 1)).then(
              () => ({ name: 'finished', at: performance.now() }),
              (e: Error) => ({ name: e.name, at: performance.now() }),
            );
            await new Promise((res) => setTimeout(res, delay));
            const sent = performance.now();
            await mesh.supersede(10 * k + 2);
            const out = await job;
            if (out.name === 'Superseded') lags.push(out.at - sent);
            else state += `${delay}: ${out.name}; `;
          }
        } finally {
          worker.terminate();
        }
        // The app's client: two rapid requests on the latest-wins channel, only the last resolves.
        const { workers, isSuperseded } = await load('/src/workers/client.ts');
        try {
          const big = await workers.mesh.fromPart({ ...part, dims: { r: 1.25 } }, { paletteIds: ['c'], N: 48 });
          const calls = [1, 2].map(() => workers.mesh.pathB({ mesh: big, partId: 'b', frame: {}, gauge: GAUGE, settings: SETTINGS }));
          const settled = await Promise.allSettled(calls);
          return {
            lags,
            state,
            client: settled.map((s: any) => (s.status === 'fulfilled' ? `ok ${s.value.counts.length}` : isSuperseded(s.reason) ? 'superseded' : String(s.reason))),
          };
        } finally {
          workers.terminate();
        }
      },
      { GAUGE, SETTINGS },
    );
    expect(r.lags.length, r.state).toBeGreaterThanOrEqual(4);
    // the longest synchronous stretch is ≈ 50 ms (node measurement in pathB.perf.test.ts); here plus message hops
    expect(Math.max(...r.lags)).toBeLessThan(budget(120));
    expect(r.client[0]).toBe('superseded');
    expect(r.client[1]).toMatch(/^ok \d+$/);
  });
});
