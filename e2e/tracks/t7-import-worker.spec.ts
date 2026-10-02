// Track T7 (DESIGN.md §3.7.1, G12): every T7.1 teddy carrier through the REAL import.worker in Chromium, where
// DOMParser does not exist in a dedicated worker. Each must give exactly fixtures/models/teddy.canonical.json.
// The fixtures are fetched from the dev server; nothing is written anywhere.
import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { budget } from '../../src/test/timing';

const DIR = new URL('../../fixtures/claude-design/teddy-bear/', import.meta.url);
const FILES = [
  { name: 'teddy-bear.crochet-model.json', carrier: 'json' },
  { name: 'project-archive/Amigurumi Teddy Bear.html', carrier: 'html' },
  { name: 'teddy-bear.standalone.html', carrier: 'standalone-html' },
  { name: 'teddy-bear.project-archive.zip', carrier: 'zip' },
].map((f) => ({ ...f, size: fs.statSync(new URL(encodeURI(f.name), DIR)).size }));

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test.describe('T7.1 import.worker (G12 carriers)', () => {
  test('the json, html, standalone-html and zip teddies, and a pasted chat reply, give the canonical teddy', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'What would you like to make?' })).toBeVisible();
    const { out: results, sizes } = await page.evaluate(async (files) => {
      // `new Function` keeps the test runner's transpiler away from these browser-side dynamic imports.
      const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
      const { workers } = await load('/src/workers/client.ts');
      const { stringifyModel } = await load('/src/core/model/schema.ts');
      const canonical = await (await fetch('/fixtures/models/teddy.canonical.json')).text();
      const out: { name: string; ok: boolean; carrier: string; same: boolean; worker: boolean; errors: string[] }[] = [];
      const run = async (name: string, inputs: unknown[]) => {
        const r = await workers.importer.importInputs(inputs);
        out.push({
          name,
          ok: r.ok,
          carrier: r.carrier,
          same: r.ok && stringifyModel(r.model) === canonical,
          worker: workers.isRunning('import'),
          errors: r.warnings.filter((w: { severity: string }) => w.severity === 'error').map((w: { message: string }) => w.message),
        });
      };
      const sizes: number[] = [];
      for (const f of files) {
        // `?raw` (a JS module holding the file as a string) because the dev server rewrites .html it serves
        const url = `/fixtures/claude-design/teddy-bear/${encodeURI(f.name)}`;
        const bytes = f.name.endsWith('.html') ? new TextEncoder().encode((await load(`${url}?raw`)).default).buffer : await (await fetch(url)).arrayBuffer();
        sizes.push(bytes.byteLength);
        await run(f.name, [{ kind: 'file', name: f.name.split('/').pop(), bytes }]);
      }
      const json = await (await fetch('/fixtures/claude-design/teddy-bear/teddy-bear.crochet-model.json')).text();
      const fence = String.fromCharCode(96).repeat(3);
      const curly = json.replace(/"/g, String.fromCharCode(0x201c));
      const reply = `Here is the spec:\n\n${fence}json\n${curly}\n${fence}\nEnjoy!`;
      await run('pasted chat reply (smart quotes)', [{ kind: 'text', text: reply }]);
      workers.terminate();
      return { out, sizes };
    }, FILES);
    // the worker got the files' exact bytes
    expect(sizes).toEqual(FILES.map((f) => f.size));
    for (const r of results) {
      expect(r.errors, r.name).toEqual([]);
      expect(r.ok, r.name).toBe(true);
      expect(r.same, `${r.name} gives teddy.canonical.json byte for byte`).toBe(true);
      expect(r.worker, `${r.name} ran in import.worker`).toBe(true);
    }
    expect(results.map((r) => r.carrier)).toEqual([...FILES.map((f) => f.carrier), 'text']);
    expect(errors).toEqual([]);
  });
});

test.describe('T7.2 import.worker (geometry carriers)', () => {
  test('the captured GLB, the teddy OBJ + MTL (under 3 s), a builder-v1 GLB and a handoff bundle, in the real worker', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'What would you like to make?' })).toBeVisible();
    const out = await page.evaluate(async () => {
      const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
      const { workers } = await load('/src/workers/client.ts');
      const canonical = JSON.parse(await (await fetch('/fixtures/models/teddy.canonical.json')).text());
      const bytes = async (url: string): Promise<ArrayBuffer> => (await fetch(url)).arrayBuffer();
      // the dev server may already have decoded the .gz (Content-Encoding): gunzip only what still is gzip
      const gunzip = async (buf: ArrayBuffer): Promise<ArrayBuffer> => {
        const b = new Uint8Array(buf);
        if (!(b[0] === 0x1f && b[1] === 0x8b)) return buf;
        return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      };
      const T = '/fixtures/claude-design/teddy-bear/';
      const D = '/fixtures/claude-design/teddy-derived/';
      // geometry-only parts are fitted or mesh parts: only their ids, attach tree and mirror pairs are the teddy's
      const sameParts = (m: any, geometry: boolean): boolean =>
        canonical.parts.every((p: any) => {
          const q = m.parts.find((x: any) => x.id === p.id);
          if (!q) return false;
          const shape = geometry || (q.type === p.type && p.position.every((v: number, i: number) => Math.abs(v - q.position[i]) <= 1e-4));
          return q && shape && q.attach?.to === p.attach?.to && q.mirrorOf === p.mirrorOf;
        }) && m.parts.length === canonical.parts.length;
      const summary = (name: string, r: any, ms: number) => ({
        name,
        ok: r.ok,
        carrier: r.carrier,
        dialect: r.dialect,
        units: r.units ? `${r.units.chosen}/${r.units.reason}` : '',
        parts: r.model?.parts.length ?? 0,
        same: r.ok ? sameParts(r.model, r.dialect === 'geometry-only') : false,
        meshes: Object.keys(r.meshes ?? {}).length,
        ms,
        worker: workers.isRunning('import'),
        errors: r.warnings.filter((w: any) => w.severity === 'error').map((w: any) => w.message),
      });
      const results: ReturnType<typeof summary>[] = [];
      const run = async (name: string, inputs: unknown[], ctx?: unknown) => {
        const t = performance.now();
        const r = await workers.importer.importInputs(inputs, ctx);
        results.push(summary(name, r, performance.now() - t));
      };
      await run('captured GLB', [{ kind: 'file', name: 'amigurumi-teddy-bear.glb', bytes: await bytes(`${T}amigurumi-teddy-bear.glb`) }]);
      const obj = await gunzip(await bytes(`${T}amigurumi-teddy-bear.obj.gz`));
      const mtl = await bytes(`${T}amigurumi-teddy-bear.mtl`);
      // warm the worker up once (module load), then time the OBJ import itself
      await run('OBJ warm-up', [{ kind: 'file', name: 'amigurumi-teddy-bear.obj', bytes: obj.slice(0) }, { kind: 'file', name: 'amigurumi-teddy-bear.mtl', bytes: mtl.slice(0) }]);
      await run('teddy OBJ + MTL', [{ kind: 'file', name: 'amigurumi-teddy-bear.obj', bytes: obj }, { kind: 'file', name: 'amigurumi-teddy-bear.mtl', bytes: mtl }]);
      await run('builder-v1 GLB, per-node extras', [{ kind: 'file', name: 'teddy-builder-v1.noroot.glb', bytes: await bytes(`${D}teddy-builder-v1.noroot.glb`) }]);
      await run('handoff tar.gz', [{ kind: 'file', name: 'teddy-handoff.tar.gz', bytes: await bytes(`${D}teddy-handoff.tar.gz`) }]);
      workers.terminate();
      return results;
    });
    const by = Object.fromEntries(out.map((r) => [r.name, r]));
    for (const r of out) {
      expect(r.errors, r.name).toEqual([]);
      expect(r.ok, r.name).toBe(true);
      expect(r.worker, `${r.name} ran in import.worker`).toBe(true);
      expect(r.same, `${r.name}: the canonical parts and tree`).toBe(true);
    }
    expect(by['captured GLB']).toMatchObject({ carrier: 'glb', dialect: 'cd-observed-2026-09', units: 'in/gltf-extras-ratio' });
    expect(by['teddy OBJ + MTL']).toMatchObject({ carrier: 'obj', dialect: 'geometry-only', units: 'in/default', parts: 17 });
    expect(by['teddy OBJ + MTL'].ms, 'the 9.5 MB OBJ in the worker').toBeLessThan(budget(3000)); // §5.8; strict under CPG_PERF=1, the node test g26 checks it strictly in npm run perf
    expect(by['builder-v1 GLB, per-node extras']).toMatchObject({ carrier: 'glb', dialect: 'canonical-1' });
    expect(by['handoff tar.gz']).toMatchObject({ carrier: 'tar' });
    console.log(out.map((r) => `${r.name}: ${r.ms.toFixed(0)} ms`).join('; '));
    expect(errors).toEqual([]);
  });
});
