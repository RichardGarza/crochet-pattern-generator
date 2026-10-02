// Track T7.4a — the import screens in a real browser (DESIGN.md F4 steps 4–6, §3.7.7, §5.7): Start → "Import from
// Claude Design", drop the real teddy exports (project archive, standalone page, GLB, builder-v1 OBJ + MTL in meters)
// → what was read, the fixes, 17 parts → Accept → the Yarn & size panel → the Shape tab shows the model; the units
// question; the versions picker; a failed paste; the diff against the current model; the return path by `x-cpg`;
// the keyboard path; light and dark screenshots at 1280 × 800.
//
// Screenshots are attached to every run and written to e2e/screenshots/t7-*.png only when missing or with
// CPG_SCREENSHOTS=1 (as the smoke spec does), so a normal run never dirties the tree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type ConsoleMessage, type Page, type TestInfo } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = path.join(root, 'e2e', 'screenshots');
const TEDDY = path.join(root, 'fixtures', 'claude-design', 'teddy-bear');
const DERIVED = path.join(root, 'fixtures', 'claude-design', 'teddy-derived');

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function snap(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.mouse.move(2, 790); // no hover tooltip in the picture
  await page.waitForTimeout(400);
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await info.attach(name, { body: png, contentType: 'image/png' });
  const file = path.join(SHOTS, `${name}.png`);
  if (process.env.CPG_SCREENSHOTS === '1' || !fs.existsSync(file)) {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(file, png);
  }
}

async function setTheme(page: Page, theme: 'Light' | 'Dark'): Promise<void> {
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: `${theme} theme` }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
}

/** Start → "Import from Claude Design": a new project on its Import tab. Returns the project id. */
async function startImport(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import from Claude Design' }).click();
  await expect(page).toHaveURL(/#\/p\/[^/]+\/import$/);
  await expect(page.getByRole('heading', { name: 'Bring in your Claude Design toy' })).toBeVisible({ timeout: 60_000 });
  return /#\/p\/([^/]+)\//.exec(page.url())?.[1] ?? '';
}

async function drop(page: Page, files: string[]): Promise<void> {
  await page.locator('.imp-intake input[type="file"]').setInputFiles(files);
}

async function expectReport(page: Page, o: { carrier: string; parts: number }): Promise<void> {
  await expect(page.getByTestId('import-carrier')).toHaveText(o.carrier, { timeout: 60_000 });
  await expect(page.getByTestId('import-summary')).toContainText(`${o.parts} parts`);
  await expect(page.getByTestId('import-preview')).toHaveAttribute('data-parts', String(o.parts), { timeout: 30_000 });
}

async function acceptAndCheckShape(page: Page, parts: number): Promise<void> {
  await page.getByTestId('import-accept').click();
  await expect(page.getByRole('heading', { name: `${parts} parts are in your project` })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Yarn & size' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/#\/p\/[^/]+\/shape$/);
  await expect(page.getByRole('tree', { name: 'Parts' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('treeitem')).toHaveCount(parts);
}

const canonical = (): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'models', 'teddy.canonical.json'), 'utf8')) as Record<string, unknown>;

test.describe('T7.4a import screens', () => {
  let errors: string[] = [];
  test.beforeEach(({ page }) => {
    errors = watchErrors(page);
  });
  test.afterEach(() => {
    expect(errors, 'no console errors and no page errors').toEqual([]);
  });

  test('the project archive: what was read, the fixes, 17 parts → Accept → Yarn & size → Shape; screenshots', async ({ page }, info) => {
    test.setTimeout(180_000);
    await startImport(page);
    await setTheme(page, 'Light');
    await snap(page, info, 't7-import-intake-light');
    await setTheme(page, 'Dark');
    await snap(page, info, 't7-import-intake-dark');
    await setTheme(page, 'Light');

    await drop(page, [path.join(TEDDY, 'teddy-bear.project-archive.zip')]);
    await expectReport(page, { carrier: 'Claude Design project archive (.zip)', parts: 17 });
    await expect(page.getByTestId('import-dialect')).toHaveText('Claude Design’s own way of writing models');
    await expect(page.getByTestId('import-confidence')).toContainText('Sure');
    await expect(page.getByTestId('import-fixes')).toHaveText('We made 15 small fixes automatically');
    await page.getByText('Show what we fixed').click();
    // every repair is a chip; the six joins and the six pairs by name
    for (const join of ['Left Leg → Body', 'Right Arm → Body', 'Head → Body', 'Tail → Body']) await expect(page.getByText(join, { exact: true })).toBeVisible();
    await expect(page.getByText('Right Ear Inner mirrors Left Ear Inner', { exact: true })).toBeVisible();
    await expect(page.getByText('9.9 in tall', { exact: true }).first()).toBeVisible();
    await snap(page, info, 't7-import-report-light');
    await setTheme(page, 'Dark');
    await snap(page, info, 't7-import-report-dark');
    await setTheme(page, 'Light');

    // a join chip before Accept asks first (the model must be in the project to open the Attach tool)
    await page.getByRole('button', { name: 'Head → Body' }).click();
    const ask = page.getByRole('dialog', { name: 'Accept the model first?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();

    await page.getByTestId('import-accept').click();
    await expect(page.getByRole('heading', { name: '17 parts are in your project' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Check how parts are joined' })).toBeVisible();
    await snap(page, info, 't7-import-accepted-light');
    await setTheme(page, 'Dark');
    await snap(page, info, 't7-import-accepted-dark');
    await setTheme(page, 'Light');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page).toHaveURL(/#\/p\/[^/]+\/shape$/);
    await expect(page.getByRole('treeitem')).toHaveCount(17, { timeout: 60_000 });
    // one undo step takes the whole import back
    await expect(page.getByTestId('undo')).toHaveAccessibleName(/Undo .*Imported from Claude Design/);
  });

  test('the standalone page and the GLB: 17 parts each → Accept → Shape shows the model', async ({ page }) => {
    test.setTimeout(180_000);
    await startImport(page);
    await drop(page, [path.join(TEDDY, 'teddy-bear.standalone.html')]);
    await expectReport(page, { carrier: 'Claude Design standalone page (.html)', parts: 17 });
    await acceptAndCheckShape(page, 17);

    await startImport(page);
    await drop(page, [path.join(TEDDY, 'amigurumi-teddy-bear.glb')]);
    await expectReport(page, { carrier: '3D model (.glb)', parts: 17 });
    await expect(page.getByTestId('import-confidence')).toContainText('Fairly sure');
    await expect(page.getByTestId('import-size')).toHaveText('9.9 in tall');
    await acceptAndCheckShape(page, 17);
  });

  test('a builder-v1 OBJ + MTL in meters asks for the size: "0.25 in tall, or 9.9 in tall?"', async ({ page }, info) => {
    test.setTimeout(180_000);
    await startImport(page);
    await drop(page, [path.join(DERIVED, 'teddy-builder-v1.obj.gz'), path.join(DERIVED, 'teddy-builder-v1.mtl')]);
    const dialog = page.getByRole('dialog', { name: 'How tall is this toy?' });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('units-question')).toHaveText('0.25 in tall, or 9.9 in tall?');
    await expect(page.getByTestId('import-accept')).toHaveAttribute('aria-disabled', 'true');
    await snap(page, info, 't7-import-units-light');
    // the tiny reading re-runs the import with ctx.units = 'in'
    await dialog.getByRole('button', { name: /0\.25 in tall/ }).click();
    await expect(page.getByTestId('import-size')).toHaveText('0.25 in tall', { timeout: 60_000 });
    // and back
    await page.getByRole('button', { name: 'Change size…' }).click();
    await page.getByRole('dialog', { name: 'How tall is this toy?' }).getByRole('button', { name: /9\.9 in tall/ }).click();
    await expect(page.getByTestId('import-size')).toHaveText('9.9 in tall', { timeout: 60_000 });
    await expect(page.getByTestId('import-carrier')).toHaveText('3D model (.obj)');
    await expect(page.getByTestId('import-confidence')).toContainText('Best guess');
    await acceptAndCheckShape(page, 17);
  });

  test('an archive with two versions: the versions chip and picker', async ({ page }) => {
    test.setTimeout(120_000);
    await startImport(page);
    await drop(page, [path.join(DERIVED, 'teddy-stale-side-file.zip')]);
    await expectReport(page, { carrier: 'Claude Design project archive (.zip)', parts: 17 });
    await expect(page.getByText('The page you saw · revision 1')).toBeVisible();
    await page.getByRole('button', { name: 'Choose version…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Which version?' });
    await dialog.getByRole('radio', { name: /Side file · revision 0/ }).check();
    await dialog.getByRole('button', { name: 'Use this version' }).click();
    await expect(page.getByText('Side file · revision 0')).toBeVisible({ timeout: 60_000 });
  });

  test('pasted text without a model: a plain explanation, then another try', async ({ page }, info) => {
    await startImport(page);
    await page.getByRole('textbox', { name: 'Or paste Claude’s reply' }).fill('Here is your teddy! Let me know if you want changes.');
    await page.getByRole('button', { name: 'Import pasted text' }).click();
    await expect(page.getByRole('heading', { name: 'We couldn’t find a toy model in this text' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'We couldn’t find a toy model in this text' })).toBeFocused();
    await snap(page, info, 't7-import-failed-light');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Bring in your Claude Design toy' })).toBeVisible();
  });

  test('a second import shows the changes against the current model', async ({ page }, info) => {
    test.setTimeout(180_000);
    await startImport(page);
    const first = canonical();
    await page.getByRole('textbox', { name: 'Or paste Claude’s reply' }).fill(JSON.stringify(first));
    await page.getByRole('button', { name: 'Import pasted text' }).click();
    await expect(page.getByTestId('import-carrier')).toHaveText('Pasted text', { timeout: 60_000 });
    await page.getByTestId('import-accept').click();
    await expect(page.getByRole('heading', { name: '17 parts are in your project' })).toBeVisible();
    await page.getByRole('button', { name: 'Import another file' }).click();
    await expect(page.getByRole('heading', { name: 'Import a newer version' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Last import' })).toBeVisible();

    const next = canonical();
    const parts = next.parts as Record<string, unknown>[];
    const head = parts.find((p) => p.id === 'head') as { dims: { rx: number; ry: number; rz: number } };
    head.dims = { rx: head.dims.rx * 1.2, ry: head.dims.ry * 1.2, rz: head.dims.rz * 1.2 };
    parts.push({ id: 'bow', type: 'torus', dims: { R: 0.4, r: 0.12 }, position: [0, 6.2, 1.6], color: (parts[0] as { color: string }).color, attach: { to: 'body' } });
    next.revision = 2;
    await page.getByRole('textbox', { name: 'Or paste Claude’s reply' }).fill(JSON.stringify(next));
    await page.getByRole('button', { name: 'Import pasted text' }).click();
    await expect(page.getByRole('heading', { name: 'Changes from your current model' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('import-diff-headline')).toContainText('1 new part');
    await expect(page.getByTestId('import-diff-headline')).toContainText('changed');
    await expect(page.getByRole('list', { name: 'New parts' }).getByText('Bow', { exact: true })).toBeVisible();
    await expect(page.locator('.imp-changed').getByText('Head', { exact: true })).toBeVisible();
    await expect(page.locator('.imp-changed li', { hasText: 'Head' })).toContainText('Bigger');
    await snap(page, info, 't7-import-diff-light');
    await setTheme(page, 'Dark');
    await snap(page, info, 't7-import-diff-dark');
    await setTheme(page, 'Light');
    await page.getByTestId('import-accept').click();
    await expect(page.getByRole('heading', { name: '18 parts are in your project' })).toBeVisible();
  });

  test('return path: a result tagged with another project\'s x-cpg is offered to it', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await page.getByRole('button', { name: 'Describe a toy for Claude Design' }).click();
    await expect(page).toHaveURL(/#\/p\/[^/]+\/qa$/);
    const home = /#\/p\/([^/]+)\//.exec(page.url())?.[1] ?? '';
    const name = page.getByTestId('project-name');
    await name.fill('Bear for Mia');
    await name.press('Enter');
    await expect(page.getByTestId('save-chip')).toContainText('Saved');

    await startImport(page);
    const spec = { ...canonical(), 'x-cpg': { project: home, seedRev: 0 } };
    await page.getByRole('textbox', { name: 'Or paste Claude’s reply' }).fill(JSON.stringify(spec));
    await page.getByRole('button', { name: 'Import pasted text' }).click();
    await expect(page.getByRole('heading', { name: 'Where should it go?' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('radio', { name: /Import into “Bear for Mia”/ })).toBeChecked();
    await page.getByRole('button', { name: 'Continue in “Bear for Mia”' }).click();
    await expect(page).toHaveURL(new RegExp(`#/p/${home}/import$`));
    await expect(page.getByTestId('project-name')).toHaveValue('Bear for Mia');
    await expect(page.getByTestId('import-summary')).toContainText('17 parts', { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Where should it go?' })).toHaveCount(0);
    await page.getByTestId('import-accept').click();
    await expect(page.getByRole('heading', { name: '17 parts are in your project' })).toBeVisible();
  });

  test('keyboard path: paste, open the fixes, accept, all with the keyboard; focus follows', async ({ page }) => {
    test.setTimeout(180_000);
    await startImport(page);
    const box = page.getByRole('textbox', { name: 'Or paste Claude’s reply' });
    await box.focus();
    // Claude Design's own JSON (no parents on 6 parts: the joins are ours)
    await box.fill(fs.readFileSync(path.join(TEDDY, 'teddy-bear.crochet-model.json'), 'utf8'));
    await page.keyboard.press('ControlOrMeta+Enter');
    const title = page.getByRole('heading', { name: 'Your model is ready to import' });
    await expect(title).toBeVisible({ timeout: 60_000 });
    await expect(title).toBeFocused();
    // Tab reaches "Show what we fixed"; Enter opens it
    const summary = page.getByText('Show what we fixed');
    for (let i = 0; i < 12 && !(await summary.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(summary).toBeFocused();
    const outline = await summary.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Head → Body', { exact: true })).toBeVisible();
    // on to Accept
    const accept = page.getByTestId('import-accept');
    for (let i = 0; i < 40 && !(await accept.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(accept).toBeFocused();
    await page.keyboard.press('Enter');
    const done = page.getByRole('heading', { name: '17 parts are in your project' });
    await expect(done).toBeVisible();
    await expect(done).toBeFocused();
  });
});
