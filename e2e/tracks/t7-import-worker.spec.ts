// Track T7 (DESIGN.md §3.7.1, G12): every T7.1 teddy carrier through the REAL import.worker in Chromium, where
// DOMParser does not exist in a dedicated worker. Each must give exactly fixtures/models/teddy.canonical.json.
// The fixtures are fetched from the dev server; nothing is written anywhere.
import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

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
