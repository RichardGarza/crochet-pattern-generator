// Step 0 smoke test (DESIGN.md §6.2 items 3 and 8, §5.4 tests, acceptance): the app shell in a real browser.
//
//   - the start screen renders with no console errors and no page errors (every test checks this);
//   - each start card opens a workspace with the expected tabs (§5.3 registry and visibility predicates);
//   - rename + undo / redo, the theme toggle, the keyboard path, the library card of a project;
//   - light and dark screenshots of the start screen, a 2D and a 3D workspace, and the component gallery;
//   - §5.4: a progress callback passed through workers/client.ts fires in a real worker, and a nested worker
//     (the real mesh.worker, spawned inside another worker) answers;
//   - the cold-cache dev smoke: a dev server on an EMPTY dependency cache serves the app and spins up all six
//     workers with exactly one navigation and no "optimized dependencies changed" reload.
//
// Screenshots are attached to the test output on every run. They are written to e2e/screenshots/ only when
// a file is missing or CPG_SCREENSHOTS=1, so a normal run never dirties the tree.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type ConsoleMessage, type Page, type TestInfo } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = path.join(root, 'e2e', 'screenshots');

/** Console errors and page errors of a page; every test asserts there are none. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    // The start-up probe no longer asks WebGPU for an adapter (design v1.4): headless Chromium has none and warns.
    else if (m.type() === 'warning' && /No available adapters/.test(m.text())) errors.push(`console warning: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function snap(page: Page, info: TestInfo, name: string, o: { fullPage?: boolean } = {}): Promise<void> {
  // Let entrance transitions finish and hide the caret, so a re-run gives the same pixels.
  await page.waitForTimeout(250);
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide', fullPage: o.fullPage });
  await info.attach(name, { body: png, contentType: 'image/png' });
  const file = path.join(SHOTS, `${name}.png`);
  if (process.env.CPG_SCREENSHOTS === '1' || !fs.existsSync(file)) {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(file, png);
  }
}

async function openStart(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'What would you like to make?' })).toBeVisible();
}

async function tabNames(page: Page): Promise<string[]> {
  return page.getByRole('tablist', { name: 'Project views' }).getByRole('tab').allInnerTexts();
}

const CARDS = [
  { kind: 'picture', title: 'New pattern from a picture', tabs: ['Source', 'Chart', 'Pattern', 'Materials', 'Export'], route: 'source', stub: 'SourceTab' },
  { kind: 'photos', title: 'New 3D toy from photos', tabs: ['Photos', 'Shape', 'Pattern', 'Materials', 'Export'], route: 'photos', stub: 'PhotosTab' },
  { kind: 'one-photo', title: 'New 3D toy from one photo', tabs: ['Photos', 'Shape', 'Pattern', 'Materials', 'Export'], route: 'photos', stub: 'PhotosTab' },
  { kind: 'describe', title: 'Describe a toy for Claude Design', tabs: ['Import', 'Shape', 'Pattern', 'Materials', 'Export'], route: 'qa', stub: 'QaWizard' },
  { kind: 'claude-design', title: 'Import from Claude Design', tabs: ['Import', 'Shape', 'Pattern', 'Materials', 'Export'], route: 'import', stub: 'ImportTab' },
] as const;

test.describe('app shell', () => {
  let errors: string[] = [];

  test.beforeEach(({ page }) => {
    errors = watchErrors(page);
  });

  test.afterEach(() => {
    expect(errors, 'no console errors and no page errors').toEqual([]);
  });

  test('the start screen renders: five cards, the projects section, the mirror probe', async ({ page }) => {
    await openStart(page);
    for (const card of CARDS) await expect(page.getByRole('button', { name: card.title })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Your projects' })).toBeVisible();
    await expect(page.getByText('No projects yet')).toBeVisible();
    // HEAD /__projects answers 204 + x-cpg-mirror: off under CPG_TEST (§5.5.4).
    await expect(page.getByText('Folder mirror off')).toBeVisible();
    await expect(page).toHaveTitle('Crochet Pattern Generator');
  });

  for (const card of CARDS) {
    test(`"${card.title}" opens a workspace with the ${card.tabs.join(' · ')} tabs`, async ({ page }) => {
      await openStart(page);
      await page.getByRole('button', { name: card.title }).click();
      await expect(page).toHaveURL(new RegExp(`#/p/[^/]+/${card.route}$`));
      await expect(page.getByTestId('workspace')).toBeVisible();
      expect(await tabNames(page)).toEqual(card.tabs);
      await expect(page.locator(`[data-stub="${card.stub}"]`)).toBeVisible();
      if (card.route !== 'qa') {
        await expect(page.getByRole('tab', { selected: true })).toHaveText(card.tabs[0]);
      }
      // T8.1: projects autosave to IndexedDB, so a new project's chip settles on "Saved".
      await expect(page.getByTestId('save-chip')).toContainText('Saved');
      // Every tab of the project opens its (stub) view inside the workspace.
      for (const name of card.tabs) {
        await page.getByRole('tab', { name }).click();
        await expect(page.getByRole('tab', { name, selected: true })).toBeVisible();
        await expect(page.getByRole('tabpanel')).toBeVisible();
      }
    });
  }

  test('a project route without a tab goes to the default tab; an unknown project says so', async ({ page }) => {
    await openStart(page);
    await page.getByRole('button', { name: 'New 3D toy from photos' }).click();
    await expect(page).toHaveURL(/#\/p\/[^/]+\/photos$/);
    const id = /#\/p\/([^/]+)\//.exec(page.url())?.[1];
    await page.evaluate((projectId) => (window.location.hash = `#/p/${projectId}`), id);
    await expect(page).toHaveURL(new RegExp(`#/p/${id}/photos$`));
    await page.evaluate(() => (window.location.hash = '#/p/no-such-project/shape'));
    await expect(page.getByRole('heading', { name: "This project isn't here" })).toBeVisible();
    await page.getByRole('button', { name: 'Back to your projects' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'What would you like to make?' })).toBeVisible();
  });

  test('rename, then undo and redo with the buttons and the keyboard', async ({ page }) => {
    await openStart(page);
    await page.getByRole('button', { name: 'New pattern from a picture' }).click();
    const name = page.getByTestId('project-name');
    await expect(name).toHaveValue('Untitled chart');
    await name.fill('Heart blanket');
    await name.press('Enter');
    await expect(page).toHaveTitle('Heart blanket · Crochet Pattern Generator');
    const undo = page.getByTestId('undo');
    await expect(undo).toHaveAccessibleName('Undo Rename project');
    await undo.click();
    await expect(name).toHaveValue('Untitled chart');
    await page.getByTestId('redo').click();
    await expect(name).toHaveValue('Heart blanket');
    // Keyboard: outside a text field, ⌘Z / Ctrl+Z is the project's undo.
    await page.getByRole('tab', { name: 'Chart' }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(name).toHaveValue('Untitled chart');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(name).toHaveValue('Heart blanket');
    // The library card follows the name; the project opens again from it.
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByRole('button', { name: /^Heart blanket/ }).click();
    await expect(name).toHaveValue('Heart blanket');
  });

  test('keyboard: skip link, start card by Tab and Enter, tabs by arrow keys, shortcuts dialog', async ({ page }) => {
    await openStart(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.getAttribute('data-kind') === 'picture');
    }
    expect(reached, 'the first start card is reachable with Tab').toBe(true);
    // The focus ring is visible on it.
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
    expect(outline).toBe('solid');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/p\/[^/]+\/source$/);
    // Focus moved into the new screen (not dropped on <body>).
    await expect(page.locator('main#main')).toBeFocused();
    await page.getByRole('tab', { name: 'Source' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/\/chart$/);
    await expect(page.getByRole('tab', { name: 'Chart' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(/\/export$/);
    // "?" opens the shortcut list; Escape closes it and focus returns.
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('the theme switch: System, Light, Dark; the choice survives a reload', async ({ page }) => {
    await openStart(page);
    const html = page.locator('html');
    const theme = page.getByRole('radiogroup', { name: 'Theme' });
    await expect(theme.getByRole('radio', { name: 'System theme' })).toBeChecked();
    await expect(html).not.toHaveAttribute('data-theme');
    await theme.getByRole('radio', { name: 'Light theme' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await theme.getByRole('radio', { name: 'Dark theme' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('radio', { name: 'Dark theme' })).toBeChecked();
    // Keyboard: arrows move the choice.
    await page.getByRole('radio', { name: 'Dark theme' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(html).not.toHaveAttribute('data-theme');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`screenshots, ${scheme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openStart(page);
      await snap(page, info, `start-${scheme}`);
      await page.getByRole('button', { name: 'New pattern from a picture' }).click();
      await expect(page.locator('[data-stub="SourceTab"]')).toBeVisible();
      await snap(page, info, `workspace-2d-${scheme}`);
      await page.getByRole('button', { name: 'Projects' }).click();
      await page.getByRole('button', { name: 'New 3D toy from photos' }).click();
      await page.getByRole('tab', { name: 'Pattern' }).click();
      await expect(page.locator('[data-stub="PatternTab"]')).toBeVisible();
      await snap(page, info, `workspace-3d-${scheme}`);
      // The design-system gallery (DEV / TEST ONLY page, e2e/gallery/): every ui/common component.
      await page.goto('/e2e/gallery/');
      await expect(page.getByRole('heading', { name: 'Buttons' })).toBeVisible();
      await snap(page, info, `components-${scheme}`, { fullPage: true });
    });
  }

  test('§5.4: a progress callback passed through workers/client.ts fires in a real worker', async ({ page }) => {
    await openStart(page);
    const result = await page.evaluate(async () => {
      // `new Function` keeps the test runner's transpiler away from this browser-side dynamic import.
      const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
      const client = await load('/src/workers/client.ts');
      client.setWorkerSpawner((name: string) => {
        if (name !== 'ml') throw new Error(`unexpected worker ${name}`);
        // TEST ONLY worker, served by the dev server like the app's own (?worker_file as Vite writes it).
        return new Worker('/e2e/workers/progress.worker.ts?worker_file&type=module', { type: 'module' });
      });
      try {
        const seen: number[] = [];
        const image = { w: 1, h: 1, data: new Uint8ClampedArray(4) };
        const depth = await client.workers.ml.depth(image, (p: number) => {
          seen.push(p);
        });
        return { seen, w: depth.w, h: depth.h, values: [...depth.data].map((v: number) => Math.round(v * 10)) };
      } finally {
        client.setWorkerSpawner(null);
      }
    });
    expect(result).toEqual({ seen: [0.25, 0.5, 0.75, 1], w: 2, h: 2, values: [1, 2, 3, 4] });
  });

  test('§5.4: a nested worker (the real mesh.worker) answers from inside another worker', async ({ page }) => {
    await openStart(page);
    const result = await page.evaluate(
      () =>
        new Promise<{ superseded: boolean; fit: string }>((resolve, reject) => {
          const worker = new Worker('/e2e/workers/nested.worker.ts?worker_file&type=module', { type: 'module' });
          const done = () => worker.terminate();
          worker.onmessage = (e) => {
            done();
            resolve(e.data);
          };
          worker.onerror = (e) => {
            done();
            reject(new Error(e.message));
          };
          worker.postMessage('ask');
        }),
    );
    expect(result.superseded).toBe(true);
    // The Step 0 stub answers NotImplementedError; T5's fit may answer or reject — either way it answered.
    expect(typeof result.fit).toBe('string');
  });
});

/** A free TCP port on localhost (never 5180: the OS hands out ephemeral ports far above it). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

test.describe('cold-cache dev smoke (§6.2 acceptance)', () => {
  test('an empty dependency cache: the start screen, a 3D tab and all six workers load with one navigation', async ({ page }) => {
    test.setTimeout(180_000);
    const { createServer } = await import('vite');
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-vite-cold-'));
    const port = await freePort();
    expect(port).not.toBe(5180);
    process.env.CPG_TEST = '1';
    const server = await createServer({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      cacheDir,
      logLevel: 'silent',
      server: { port, strictPort: true, host: 'localhost' },
    });
    try {
      await server.listen();
      const errors = watchErrors(page);
      const messages: string[] = [];
      page.on('console', (m) => messages.push(m.text()));
      // Document loads only: route changes are same-document hash navigations and load nothing.
      let navigations = 0;
      page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
      });
      await page.goto(`http://localhost:${port}/`);
      await expect(page.getByRole('heading', { level: 1, name: 'What would you like to make?' })).toBeVisible({ timeout: 90_000 });
      // A 3D workspace (its lazy tab chunks), then every worker of the app.
      await page.getByRole('button', { name: 'New 3D toy from photos' }).click();
      await expect(page.locator('[data-stub="PhotosTab"]')).toBeVisible({ timeout: 60_000 });
      const answers = await page.evaluate(async () => {
        const load = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
        const { workers } = await load('/src/workers/client.ts');
        const image = { w: 1, h: 1, data: new Uint8ClampedArray(4) };
        const calls: Record<string, () => Promise<unknown>> = {
          chart2d: () => workers.chart2d.buildPattern({} as never),
          geom: () => workers.geom.mask(image, {} as never),
          ml: () => workers.ml.status(),
          ami: () => workers.ami.generate({} as never),
          mesh: () => workers.mesh.fit({} as never),
          import: () => workers.importer.importInputs([]),
        };
        const out: Record<string, string> = {};
        for (const [name, call] of Object.entries(calls)) {
          try {
            await call();
            out[name] = 'answered';
          } catch (error) {
            // A Step 0 stub rejects with NotImplementedError: the worker loaded and answered.
            out[name] = (error as Error).name;
          }
        }
        workers.terminate();
        return out;
      });
      expect(Object.keys(answers).sort()).toEqual(['ami', 'chart2d', 'geom', 'import', 'mesh', 'ml']);
      // Any answer is fine (a Step 0 stub rejects with NotImplementedError); a worker that failed to load or
      // crashed rejects with WorkerTerminated.
      for (const [name, answer] of Object.entries(answers)) expect(answer, `${name} worker loaded and answered`).not.toBe('WorkerTerminated');
      // A late re-optimization would reload the page now; give it time to happen.
      await page.waitForTimeout(4000);
      expect(navigations, `exactly one navigation (console: ${messages.join(' | ')})`).toBe(1);
      expect(messages.filter((m) => /optimized dependencies changed|new dependencies optimized/i.test(m))).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await server.close();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
