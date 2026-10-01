// Track T8 smoke (sprint T8.1): persistence in a real browser — IndexedDB, navigator.locks and
// BroadcastChannel (the unit tests use fakes for the last two, DESIGN.md §5.5.2 "Testability").
//
//   - a project survives a reload, and the library lists it;
//   - two tabs: the second opens read-only, "Edit here instead" hands the project over after a flush;
//   - a hung tab (a 15 s busy main thread): "Take over" appears after 5 s and takes the lock;
//     when the old tab wakes, its unsaved edit becomes a copy and it keeps editing that copy.
//
// Every test fails on a console error or a page error. Screenshots of the banners (light and dark) go to
// CPG_T8_SHOTS (default: a temp folder) and are attached to the run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const SHOTS = process.env.CPG_T8_SHOTS ?? path.join(os.tmpdir(), 'cpg-t8-shots');

function watchErrors(page: Page, errors: string[], label: string): void {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.waitForTimeout(250);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    await info.attach(`${name}-${scheme}`, { body: png, contentType: 'image/png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, `${name}-${scheme}.png`), png);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function newProject(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New pattern from a picture' }).click();
  await expect(page).toHaveURL(/#\/p\/[^/]+\/source$/);
  await expect(page.getByTestId('save-chip')).toContainText('Saved');
  return /#\/p\/([^/]+)\//.exec(page.url())?.[1] as string;
}

async function rename(page: Page, name: string): Promise<void> {
  const field = page.getByTestId('project-name');
  await field.fill(name);
  await field.press('Enter');
}

test.describe('T8 persistence in a real browser', () => {
  let errors: string[] = [];
  test.beforeEach(() => {
    errors = [];
  });
  test.afterEach(() => {
    expect(errors, 'no console errors and no page errors').toEqual([]);
  });

  test('a project survives a reload and is listed in the library', async ({ page }) => {
    watchErrors(page, errors, 'tab');
    const id = await newProject(page);
    await rename(page, 'Saved across reloads');
    await expect(page.getByTestId('save-chip')).toContainText('Saved');
    await page.reload();
    await expect(page.getByTestId('project-name')).toHaveValue('Saved across reloads');
    await expect(page).toHaveURL(new RegExp(`#/p/${id}/`));
    await page.getByRole('button', { name: /Projects/ }).first().click();
    await expect(page.getByText('Saved across reloads')).toBeVisible();
  });

  test('an edit made just before a reload or a close is not lost (the unload journal)', async ({ page, context }) => {
    watchErrors(page, errors, 'tab');
    const id = await newProject(page);
    await rename(page, 'baseline');
    await expect(page.getByTestId('save-chip')).toHaveText(/^Saved$/);
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.type());
      void d.accept();
    });
    await rename(page, 'last edit before reload');
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`#/p/${id}/`));
    await expect(page.getByTestId('project-name')).toHaveValue('last edit before reload');

    await rename(page, 'last edit before closing');
    await page.close({ runBeforeUnload: true });
    const again = await context.newPage();
    watchErrors(again, errors, 'reopened');
    await again.goto(`/#/p/${id}/source`);
    await expect(again.getByTestId('project-name')).toHaveValue('last edit before closing');
    expect(dialogs, 'no prompt: the edit was safe in the journal').toEqual([]);
  });

  test('a second tab opens read-only; "Edit here instead" hands the project over after a flush', async ({ context }, info) => {
    const a = await context.newPage();
    watchErrors(a, errors, 'A');
    const id = await newProject(a);
    await rename(a, 'Shared blanket');
    await expect(a.getByTestId('save-chip')).toHaveText(/^Saved$/);

    const b = await context.newPage();
    watchErrors(b, errors, 'B');
    await b.goto(`/#/p/${id}/source`);
    await expect(b.getByText('Open in another tab', { exact: true })).toBeVisible();
    await expect(b.getByTestId('save-chip')).toContainText('Read-only');
    await expect(b.getByTestId('project-name')).toHaveValue('Shared blanket');
    await shot(b, info, 't8-read-only');

    await a.getByTestId('project-name').fill('Edited just before the hand-over');
    await a.getByTestId('project-name').press('Enter');
    await b.getByRole('button', { name: 'Edit here instead' }).click();
    await expect(b.getByTestId('save-chip')).toContainText('Saved');
    await expect(b.getByTestId('project-name')).toHaveValue('Edited just before the hand-over');
    await expect(b.getByText('Open in another tab', { exact: true })).toHaveCount(0);

    await expect(a.getByText('Editing moved to another tab', { exact: true })).toBeVisible();
    await expect(a.getByTestId('save-chip')).toContainText('Read-only');
    await shot(a, info, 't8-handed-over');
  });

  test('a hung tab: Take over after 5 s; the old tab’s unsaved edit becomes a copy when it wakes', async ({ context }, info) => {
    test.setTimeout(90_000);
    const a = await context.newPage();
    watchErrors(a, errors, 'A');
    const id = await newProject(a);
    await rename(a, 'Teddy');
    await expect(a.getByTestId('save-chip')).toContainText('Saved');

    // An edit that A has not saved yet (the 800 ms debounce), then A hangs: its main thread is busy for 15 s,
    // so it can neither save nor answer "release" (a hung tab; CDP's "frozen" lifecycle state still delivers
    // BroadcastChannel messages in Chromium 153, so it is no model of an unresponsive tab).
    await a.getByTestId('project-name').fill('Teddy, edited in the frozen tab');
    await a.getByTestId('project-name').press('Enter');
    const hung = a.evaluate(() => {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        // busy
      }
    });

    const b = await context.newPage();
    watchErrors(b, errors, 'B');
    await b.goto(`/#/p/${id}/source`);
    await expect(b.getByText('Open in another tab', { exact: true })).toBeVisible();
    const asked = Date.now();
    await b.getByRole('button', { name: 'Edit here instead' }).click();
    await expect(b.getByText('Asking the other tab to hand over…', { exact: true })).toBeVisible();
    await shot(b, info, 't8-asking');
    await expect(b.getByRole('button', { name: 'Take over' })).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - asked).toBeGreaterThanOrEqual(4500);
    await expect(b.getByText('The other tab isn’t answering', { exact: true })).toBeVisible();
    await shot(b, info, 't8-take-over');
    await b.getByRole('button', { name: 'Take over' }).click();
    await expect(b.getByTestId('save-chip')).toContainText('Saved');
    await expect(b.getByTestId('project-name')).toHaveValue('Teddy');

    await hung;
    await expect(a.getByText(/Another tab saved a newer version of “Teddy, edited in the frozen tab”/)).toBeVisible({ timeout: 15_000 });
    // (The name field still has the focus from the rename, so it keeps its text; the document title shows the copy.)
    await expect(a).toHaveTitle(/^Teddy, edited in the frozen tab \(copy, \d\d:\d\d\) · Crochet Pattern Generator$/);
    await expect(a).not.toHaveURL(new RegExp(`#/p/${id}/`));
    await expect(a.getByTestId('save-chip')).toContainText('Saved');
    await shot(a, info, 't8-conflict-copy');

    // The original is B's version, and the library has both.
    await b.getByRole('button', { name: /Projects/ }).first().click();
    await expect(b.getByText('Teddy', { exact: true })).toBeVisible();
    await expect(b.getByText(/Teddy, edited in the frozen tab \(copy/)).toBeVisible();
  });
});
