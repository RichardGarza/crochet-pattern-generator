// Track T8 smoke (sprint T8.2): the library on the start screen and the folder mirror in a real browser, on the
// e2e server's own temp projects folder (playwright.config.ts: CPG_PROJECTS_DIR = a fresh mkdtemp, CPG_TEST=1 —
// the mirror runs there; the user's real folder is refused by the plugin's isolation rules).
//
//   - cards with thumbnail, name, mode, last change, the "waiting for Claude Design" badge; Duplicate, Export,
//     Delete with a confirm, "Recently deleted" with Restore; a project file round trip (export → import);
//   - the mirror: a save lands in the folder; a second browser (a fresh context = an empty IndexedDB) is offered
//     the project and restores it; "Delete for good" moves the folder copy to Backups/deleted.
//
// Every test fails on a console error or a page error. Screenshots (light and dark, 1280 × 800) go to
// CPG_T8_SHOTS (default: a temp folder) and are attached to the run.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { encodePng } from '../../src/core/kernel/png.ts';

const SHOTS = process.env.CPG_T8_SHOTS ?? path.join(os.tmpdir(), 'cpg-t8-shots');
const FOLDER = process.env.CPG_E2E_PROJECTS_DIR as string;

function watchErrors(page: Page, errors: string[], label: string): void {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
}

async function shot(page: Page, info: TestInfo, name: string, hover?: () => Promise<void>): Promise<void> {
  await page.waitForTimeout(300);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    if (hover) await hover();
    await page.waitForTimeout(200);
    const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    await info.attach(`${name}-${scheme}`, { body: png, contentType: 'image/png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, `${name}-${scheme}.png`), png);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function newProject(page: Page, card: string, name: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: card }).click();
  await expect(page).toHaveURL(/#\/p\/[^/]+\/[a-z]+$/);
  await expect(page.getByTestId('save-chip')).toContainText('Saved');
  const field = page.getByTestId('project-name');
  await field.fill(name);
  await field.press('Enter');
  await expect(page.getByTestId('save-chip')).toHaveText(/^Saved$/);
  return /#\/p\/([^/]+)\//.exec(page.url())?.[1] as string;
}

async function toLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Projects/ }).first().click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your projects' })).toBeVisible();
}

const toast = (page: Page, text: string) => page.getByRole('region', { name: 'Notifications' }).getByText(text);
const card = (page: Page, name: string) => page.locator('li.shell-project').filter({ has: page.getByRole('button', { name: new RegExp(`^${name}`) }) });

/** A 160 × 90 "thumbnail": a little heart chart on cream. */
function thumbnailPng(): Buffer {
  const w = 160;
  const h = 90;
  const data = new Uint8ClampedArray(w * h * 4);
  const heart = ['..XX...XX..', '.XXXX.XXXX.', 'XXXXXXXXXXX', 'XXXXXXXXXXX', '.XXXXXXXXX.', '..XXXXXXX..', '...XXXXX...', '....XXX....', '.....X.....'];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.floor((x - 25) / 10);
      const cy = Math.floor((y - 0) / 10);
      const on = heart[cy]?.[cx] === 'X';
      data.set(on ? [196, 84, 64, 255] : (cx + cy) % 2 ? [244, 236, 222, 255] : [238, 228, 212, 255], (y * w + x) * 4);
    }
  }
  return Buffer.from(encodePng({ w, h, data }));
}

test.describe('T8 library and folder mirror in a real browser', () => {
  let errors: string[] = [];
  test.beforeEach(() => {
    errors = [];
  });
  test.afterEach(() => {
    expect(errors, 'no console errors and no page errors').toEqual([]);
  });

  test('the library: cards and badge, duplicate, export → import, delete with confirm, Recently deleted, restore', async ({ page }, info) => {
    test.setTimeout(90_000);
    watchErrors(page, errors, 'tab');
    await newProject(page, 'New pattern from a picture', 'Heart blanket');
    await newProject(page, 'New 3D toy from photos', 'Bunny from photos');

    // Export "Heart blanket" from its card, then import a variant of the file: another id, a thumbnail, and the
    // project waiting for Claude Design.
    await toLibrary(page);
    await card(page, 'Heart blanket').hover();
    const [download] = await Promise.all([page.waitForEvent('download'), card(page, 'Heart blanket').getByRole('button', { name: 'Export Heart blanket as a file' }).click()]);
    expect(download.suggestedFilename()).toBe('Heart blanket.crochet.json');
    const file = JSON.parse(fs.readFileSync((await download.path()) as string, 'utf8'));
    expect(file).toMatchObject({ format: 'crochet-project-file', project: { name: 'Heart blanket', mode: '2d' } });
    const png = thumbnailPng();
    const sha = createHash('sha256').update(png).digest('hex');
    const id = randomUUID();
    const key = `${id}/${sha}`;
    file.project = {
      ...file.project,
      id,
      name: 'Teddy for Claude Design',
      mode: '3d',
      thumbnail: { key, mime: 'image/png', bytes: png.length, sha256: sha },
      qa: {
        answers: {},
        decided: {},
        seedSource: 'template',
        promptVersion: 'prompt-v1',
        builderVersion: 'builder-v1',
        step: 'import',
        awaiting: { since: new Date().toISOString(), seedRev: 1, via: 'copy' },
      },
    };
    file.assets = { [key]: { mime: 'image/png', sha256: sha, base64: png.toString('base64') } };
    file.revisions = [];
    const crafted = path.join(info.outputDir, 'teddy.crochet.json');
    fs.mkdirSync(info.outputDir, { recursive: true });
    fs.writeFileSync(crafted, JSON.stringify(file));

    await page.getByRole('button', { name: 'Restore from folder or backup' }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore a project' });
    await dialog.getByRole('tab', { name: /Project file/ }).click();
    await dialog.locator('input[type="file"]').setInputFiles(crafted);
    await expect(page).toHaveURL(new RegExp(`#/p/${id}/`));
    await toLibrary(page);

    const teddy = card(page, 'Teddy for Claude Design');
    await expect(teddy.getByText('Waiting for Claude Design')).toBeVisible();
    await expect(teddy.locator('img')).toHaveAttribute('src', /^blob:/);
    await expect(card(page, 'Heart blanket').getByText('2D chart')).toBeVisible();
    await expect(card(page, 'Bunny from photos').getByText('3D toy')).toBeVisible();
    await expect(page.getByText('3 projects')).toBeVisible();
    await shot(page, info, 't8-library', () => card(page, 'Heart blanket').hover());

    // Keyboard: Tab reaches a card's actions.
    await card(page, 'Heart blanket').getByRole('button', { name: /^Heart blanket/ }).focus();
    await page.keyboard.press('Tab');
    await expect(card(page, 'Heart blanket').getByRole('button', { name: 'Duplicate Heart blanket' })).toBeFocused();

    // Duplicate.
    await page.keyboard.press('Enter');
    await expect(card(page, 'Heart blanket \\(copy\\)')).toBeVisible();

    // Delete, with a confirm.
    await card(page, 'Bunny from photos').hover();
    await card(page, 'Bunny from photos').getByRole('button', { name: 'Delete Bunny from photos' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete “Bunny from photos”?' });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await shot(page, info, 't8-delete-confirm');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(card(page, 'Bunny from photos')).toHaveCount(0);
    // Focus moves to the next card (the deleted card's button is gone).
    await expect(page.locator('.shell-project__open:focus')).toHaveCount(1);
    await expect(toast(page, 'Moved “Bunny from photos” to Recently deleted. It stays there for 30 days.')).toBeVisible();

    const trash = page.getByRole('button', { name: /Recently deleted/ });
    await trash.click();
    await expect(page.getByText(/30 days left/)).toBeVisible();
    await page.mouse.move(5, 5);
    await shot(page, info, 't8-recently-deleted', async () => {
      await page.getByRole('region', { name: 'Recently deleted' }).scrollIntoViewIfNeeded();
    });
    await page.getByRole('button', { name: 'Restore Bunny from photos' }).click();
    await expect(card(page, 'Bunny from photos')).toBeVisible();
    await expect(page.getByRole('button', { name: /Recently deleted/ })).toHaveCount(0);

    // A deleted project's link does not open it.
    await card(page, 'Heart blanket \\(copy\\)').hover();
    await card(page, 'Heart blanket \\(copy\\)').getByRole('button', { name: 'Delete Heart blanket (copy)' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(card(page, 'Heart blanket \\(copy\\)')).toHaveCount(0);
  });

  test('the folder mirror: saves land in the folder; another browser restores; delete for good moves it to Backups/deleted', async ({ browser }, info) => {
    test.setTimeout(90_000);
    expect(FOLDER, 'playwright.config.ts hands the folder to the specs').toBeTruthy();
    expect(FOLDER).not.toContain(path.join(os.homedir(), 'Documents'));

    const contextA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const a = await contextA.newPage();
    watchErrors(a, errors, 'A');
    const id = await newProject(a, 'New pattern from a picture', 'Mirrored scarf');
    await toLibrary(a);
    await expect(a.getByText('Folder mirror on')).toBeVisible();
    // Mirrored 5 s after the save.
    const doc = path.join(FOLDER, id, 'project.json');
    await expect.poll(() => fs.existsSync(doc) && JSON.parse(fs.readFileSync(doc, 'utf8')).name, { timeout: 15_000 }).toBe('Mirrored scarf');
    await contextA.close();

    // Another browser: an empty IndexedDB on the same server.
    const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const b = await contextB.newPage();
    watchErrors(b, errors, 'B');
    await b.goto('/');
    await expect(b.getByText(/in the projects folder but not in this browser/)).toBeVisible();
    await shot(b, info, 't8-folder-notice');
    await b.getByRole('button', { name: 'Review' }).click();
    const dialog = b.getByRole('dialog', { name: 'Restore a project' });
    await expect(dialog.getByRole('tab', { name: /Projects folder/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByText(FOLDER)).toBeVisible();
    await shot(b, info, 't8-restore-folder');
    await dialog.getByRole('button', { name: 'Restore Mirrored scarf' }).click();
    await expect(toast(b, 'Restored “Mirrored scarf”.')).toBeVisible();
    await dialog.getByRole('tab', { name: /Backups/ }).click();
    await expect(dialog.getByText(/No backups yet|project/).first()).toBeVisible();
    await shot(b, info, 't8-restore-backups');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(card(b, 'Mirrored scarf')).toBeVisible();

    // Delete, then delete for good: the folder copy moves to Backups/deleted.
    await card(b, 'Mirrored scarf').hover();
    await card(b, 'Mirrored scarf').getByRole('button', { name: 'Delete Mirrored scarf' }).click();
    await b.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await b.getByRole('button', { name: /Recently deleted/ }).click();
    await b.getByRole('button', { name: 'Delete Mirrored scarf for good' }).click();
    const forGood = b.getByRole('dialog', { name: 'Delete “Mirrored scarf” for good?' });
    await expect(forGood.getByText(/The projects folder keeps a copy in Backups\/deleted/)).toBeVisible();
    await forGood.getByRole('button', { name: 'Delete for good' }).click();
    await expect.poll(() => fs.existsSync(path.join(FOLDER, id)), { timeout: 10_000 }).toBe(false);
    const deleted = fs.readdirSync(path.join(FOLDER, '_backups', 'deleted'));
    expect(deleted.some((n) => n.startsWith(`${id}-`))).toBe(true);
    // A deleted project never comes back as a restore offer.
    await b.reload();
    await expect(b.getByRole('heading', { level: 2, name: 'Your projects' })).toBeVisible();
    await b.waitForTimeout(500);
    const offer = b.getByText(/“Mirrored scarf” is in the projects folder/);
    await expect(offer).toHaveCount(0);
    await contextB.close();
  });
});
