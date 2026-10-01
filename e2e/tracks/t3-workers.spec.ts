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
        const { mask, w, h } = await workers.geom.mask(blob);
        let area = 0;
        for (const v of mask as Uint8Array) area += v;
        // Mask grid: 512 × 384 (scale 0.8), so the disc has radius 120 px there.
        return { w, h, area, center: (mask as Uint8Array)[256 + 512 * 192], corner: (mask as Uint8Array)[0] };
      } finally {
        workers.terminate();
      }
    });
    expect(result.w).toBe(512);
    expect(result.h).toBe(384);
    expect(result.center).toBe(1);
    expect(result.corner).toBe(0);
    expect(Math.abs(result.area / (Math.PI * 120 * 120) - 1)).toBeLessThan(0.03);
  });
});
