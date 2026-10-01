// T3.1 worker smoke test (DESIGN.md §5.4, §6.3 T3): under `npm run dev`,
//   - ml.worker creates an ONNX Runtime session from the tiny committed Identity model
//     (src/core/recon/__tests__/fixtures/identity/onnx/model.onnx) through transformers.js with the §5.4 ORT
//     config (wasm paths as an object of absolute URLs, useWasmCache) and runs it;
//   - geom.worker initialises manifold-3d through the Step 0 loader and validates a unit cube;
//   - geom.worker computes a classical mask of a synthetic photo (a PNG made in the page);
// with no console errors, in the page or in either worker.
//
// The real worker modules are spawned exactly as Vite serves them to the app (`?worker_file&type=module`) and
// driven with comlink, because their self-tests are not part of the frozen worker APIs.
import { expect, test, type ConsoleMessage, type Page, type TestInfo } from '@playwright/test';

/** Console errors and page errors of a page and of every worker it starts. */
function watchConsole(page: Page): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const onMessage = (where: string) => (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(`${where} console: ${m.text()}`);
    else if (m.type() === 'warning') warnings.push(`${where} console: ${m.text()}`);
  };
  page.on('console', onMessage('page'));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('worker', (w) => w.on('console', onMessage(`worker ${w.url()}`)));
  return { errors, warnings };
}

async function attachJson(info: TestInfo, name: string, value: unknown): Promise<void> {
  await info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

test.describe('T3 workers under npm run dev', () => {
  let seen: { errors: string[]; warnings: string[] };

  test.beforeEach(async ({ page }) => {
    seen = watchConsole(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'What would you like to make?' })).toBeVisible();
  });

  test.afterEach(async () => {
    await attachJson(test.info(), 'console-warnings', seen.warnings);
    expect(seen.errors, 'no console errors and no page errors').toEqual([]);
  });

  test('ml.worker creates an ONNX Runtime session from the Identity model and runs it', async ({ page }, info) => {
    // Every request of the page and its workers: the ORT pair must come from this dev server's /ort/ (the §5.4
    // object form), never from the CDN that transformers.js falls back to.
    const requests: string[] = [];
    page.context().on('request', (r) => requests.push(r.url()));
    const result = await page.evaluate(async () => {
      const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
      const { wrap } = await load('/node_modules/comlink/dist/esm/comlink.mjs');
      const worker = new Worker('/src/workers/ml.worker.ts?worker_file&type=module', { type: 'module' });
      const failed = new Promise<never>((_, reject) => {
        worker.addEventListener('error', (e) => reject(new Error(`ml.worker failed to load: ${e.message}`)));
      });
      try {
        const ml = wrap(worker);
        const t0 = performance.now();
        const report = await Promise.race([ml.ortSelfTest({ modelBase: '/src/core/recon/__tests__/fixtures/', modelId: 'identity' }), failed]);
        // The stubs of the frozen API still answer (T3.4 implements them).
        let status = 'resolved';
        try {
          await ml.status();
        } catch (error) {
          status = (error as Error).name;
        }
        return { ...report, ms: performance.now() - t0, status };
      } finally {
        worker.terminate();
      }
    });
    await attachJson(info, 'ort-self-test', result);
    expect(result.inputNames).toEqual(['x']);
    expect(result.outputNames).toEqual(['y']);
    expect(result.output).toEqual([1, 2, 3.5, -4]);
    expect(result.dims).toEqual([4]);
    expect(result.wasmPaths).toEqual({
      mjs: new URL('/ort/ort-wasm-simd-threaded.asyncify.mjs', page.url()).href,
      wasm: new URL('/ort/ort-wasm-simd-threaded.asyncify.wasm', page.url()).href,
    });
    expect(result.status).toBe('NotImplementedError');
    const origin = new URL(page.url()).origin;
    const httpRequests = requests.filter((u) => u.startsWith('http'));
    expect(httpRequests).toContain(`${origin}/ort/ort-wasm-simd-threaded.asyncify.wasm`);
    expect(httpRequests).toContain(`${origin}/ort/ort-wasm-simd-threaded.asyncify.mjs`);
    expect(httpRequests).toContain(`${origin}/src/core/recon/__tests__/fixtures/identity/onnx/model.onnx`);
    expect(httpRequests.filter((u) => !u.startsWith(`${origin}/`)), 'no request leaves the dev server').toEqual([]);
  });

  test('geom.worker initialises manifold-3d and validates a unit cube', async ({ page }, info) => {
    const report = await page.evaluate(async () => {
      const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
      const { wrap } = await load('/node_modules/comlink/dist/esm/comlink.mjs');
      const worker = new Worker('/src/workers/geom.worker.ts?worker_file&type=module', { type: 'module' });
      try {
        return await wrap(worker).manifoldSelfTest();
      } finally {
        worker.terminate();
      }
    });
    await attachJson(info, 'manifold-self-test', report);
    expect(report).toMatchObject({ status: 'NoError', parts: 1, genus: 0 });
    expect(report.volume).toBeCloseTo(1, 6);
  });

  test('geom.worker masks a synthetic photo through workers/client.ts (Blob in, mask out)', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
      const { workers } = await load('/src/workers/client.ts');
      // A 640 × 480 photo: a red disc on a light gray background with a little noise, made in the page.
      const canvas = new OffscreenCanvas(640, 480);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#d8d8d4';
      ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#b22222';
      ctx.beginPath();
      ctx.arc(320, 240, 150, 0, Math.PI * 2);
      ctx.fill();
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      try {
        const { mask, w, h, raw, scale, issues } = await workers.geom.mask(blob);
        let area = 0;
        for (const v of mask as Uint8Array) area += v;
        // Mask grid: 512 × 384 (scale 0.8), so the disc has radius 120 px there.
        return {
          w,
          h,
          area,
          center: (mask as Uint8Array)[256 + 512 * 192],
          corner: (mask as Uint8Array)[0],
          rawLength: (raw as Uint8Array | undefined)?.length,
          scale,
          issues,
        };
      } finally {
        workers.terminate();
      }
    });
    expect(result.w).toBe(512);
    expect(result.h).toBe(384);
    expect(result.center).toBe(1);
    expect(result.corner).toBe(0);
    expect(Math.abs(result.area / (Math.PI * 120 * 120) - 1)).toBeLessThan(0.03);
    // Design v1.4: the optional raw mask, the scale and the §2.9.1 guards come back too.
    expect(result.rawLength).toBe(512 * 384);
    expect(result.scale).toBeCloseTo(0.8, 6);
    expect(result.issues).toEqual([]);
  });

  test('geom.worker builds a model (T3.2): N = 64 previews behind the latest-wins channel, N = 128 final', async ({ page }, info) => {
    const result = await page.evaluate(async () => {
      const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
      const { workers, isSuperseded } = await load('/src/workers/client.ts');
      // Three orthographic views of a sphere: discs of radius 150 px on 400² masks.
      const disc = (): Uint8Array => {
        const m = new Uint8Array(400 * 400);
        for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) if ((x + 0.5 - 200) ** 2 + (y + 0.5 - 200) ** 2 <= 150 * 150) m[x + 400 * y] = 1;
        return m;
      };
      const views = (['front', 'left', 'top'] as const).map((label) => ({
        view: { id: label, imageKey: `img:${label}`, label, align: { scale: 1, dx: 0, dy: 0, rot90: 0, mirror: false } },
        image: { w: 1, h: 1, data: new Uint8ClampedArray(4) },
        mask: disc(),
        maskW: 400,
        maskH: 400,
      }));
      const settings = {
        N: 64,
        kappa: 0.9,
        photoView: 'front',
        backShape: 'mirror',
        backColors: 'part',
        oneSidedDetail: true,
        useDepth: false,
        keepHoles: false,
        mergeTouching: false,
        splitNeck: true,
        openingFrac: 0.12,
        fitTolerance: 0.12,
        targetHeightIn: 6,
      };
      const gauge = { cell: { w: 0.22, h: 0.2 }, wSc: 0.22, hSc: 0.2, lscIn: 1, hookMm: 3.5, stretch: 1, tol: 0.1, source: 'default' };
      try {
        // Slider ticks: three N = 64 previews, then the N = 128 build on release. Only the last one resolves.
        const t0 = performance.now();
        const calls = [64, 64, 64, 128].map((N) => workers.geom.build({ views, settings: { ...settings, N }, gauge }));
        const outcomes = await Promise.allSettled(calls);
        const ms = performance.now() - t0;
        const states = outcomes.map((o) => (o.status === 'fulfilled' ? 'ok' : isSuperseded(o.reason) ? 'superseded' : `error: ${o.reason}`));
        const last = outcomes[3].status === 'fulfilled' ? outcomes[3].value : null;
        const t1 = performance.now();
        const preview = await workers.geom.build({ views, settings, gauge });
        const previewMs = performance.now() - t1;
        const summary = (r: any) => {
          const ref = Object.keys(r.meshes)[0];
          return {
            parts: r.model.parts.map((p: any) => p.id),
            height: r.model.finishedSize.height,
            triangles: r.meshes[ref].indices.length / 3,
            report: r.report,
            sdfDims: r.sdfs[ref].dims,
            errors: r.issues.filter((i: any) => i.severity === 'error').length,
          };
        };
        return { states, ms, previewMs, final: last && summary(last), preview: summary(preview) };
      } finally {
        workers.terminate();
      }
    });
    await attachJson(info, 'geom-build', result);
    expect(result.states[3]).toBe('ok');
    expect(result.states.slice(0, 3).every((s: string) => s === 'ok' || s === 'superseded')).toBe(true);
    expect(result.states.filter((s: string) => s === 'superseded').length).toBeGreaterThanOrEqual(2);
    for (const r of [result.final!, result.preview]) {
      expect(r.parts).toEqual(['body']);
      expect(r.height).toBeCloseTo(6, 6);
      expect(r.report.parts).toBe(1);
      expect(r.report.genus).toBe(0);
      expect(r.errors).toBe(0);
    }
    expect(result.final!.triangles).toBeGreaterThan(2 * result.preview.triangles);
  });
});
