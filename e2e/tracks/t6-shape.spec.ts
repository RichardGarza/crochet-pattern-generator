// Track T6.1 — the Shape tab in a real browser (DESIGN.md §4.1–§4.4): the react-three-fiber viewport renders the
// sample teddy with no console errors; picking, the outliner and the inspector agree; a gizmo drag is ONE undo
// step that carries the attached parts; ⌥-drag moves the part alone and raises the gap warning; the resize gizmo
// keeps every part touching its parent; the camera buttons; light and dark screenshots at 1280 × 800.
//
// Screenshots are attached to every run and written to e2e/screenshots/t6-*.png only when missing or with
// CPG_SCREENSHOTS=1 (as the smoke spec does), so a normal run never dirties the tree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type ConsoleMessage, type Locator, type Page, type TestInfo } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = path.join(root, 'e2e', 'screenshots');

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
  await page.waitForTimeout(600); // the demand frame loop has drawn the last change
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

async function openTeddy(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New 3D toy from photos' }).click();
  await page.getByRole('tab', { name: 'Shape' }).click();
  await expect(page.getByRole('heading', { name: 'No 3D model yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Try the sample teddy' }).click();
  await expect(page.getByRole('tree', { name: 'Parts' })).toBeVisible();
  // The viewport chunk (three, R3F, drei) loads on demand; a cold dev server transforms it first.
  await expect(page.locator('[data-testid="shape-viewport"] canvas')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1200); // the lazy viewport chunk, the environment light, the first frames
}

function row(page: Page, name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true }).locator('.shape-tree__row').first();
}

const yField = (page: Page) => page.getByRole('spinbutton', { name: /^Y down to up/ });

/**
 * Where a part's center lands on the canvas in the Front view. The Front camera looks along −Z at the model's box
 * center raised by 0.06 × radius, from `radius / sin(fov / 2) × 1.12` (Viewport3D's fit), fov = 30° vertical (the
 * canvas is wider than tall).
 */
async function frontViewPoint(page: Page, y: number, box: { min: number; max: number; halfDiag: number }): Promise<{ x: number; y: number }> {
  const canvas = await page.locator('[data-testid="shape-viewport"] canvas').boundingBox();
  if (!canvas) throw new Error('no canvas');
  const fov = (30 * Math.PI) / 180;
  const dist = (box.halfDiag / Math.sin(fov / 2)) * 1.12;
  const pxPerIn = canvas.height / 2 / (dist * Math.tan(fov / 2));
  const centerY = (box.min + box.max) / 2 + box.halfDiag * 0.06;
  return { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 - (y - centerY) * pxPerIn };
}

// The sample teddy's box (fixtures/models/teddy.canonical.json): x ±2.9059, y 0 … 9.878905, z −2.25 … 2.8202.
const TEDDY_BOX = { min: 0, max: 9.878905, halfDiag: Math.hypot(5.8118, 9.878905, 5.0702) / 2 };

test.describe('T6 Shape tab', () => {
  let errors: string[] = [];
  test.beforeEach(({ page }) => {
    errors = watchErrors(page);
  });
  test.afterEach(() => {
    expect(errors, 'no console errors and no page errors').toEqual([]);
  });

  test('the sample teddy renders; outliner, picking and inspector agree; screenshots light and dark', async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await setTheme(page, 'Light');
    await page.getByRole('button', { name: 'New 3D toy from photos' }).click();
    await page.getByRole('tab', { name: 'Shape' }).click();
    await expect(page.getByRole('heading', { name: 'No 3D model yet' })).toBeVisible();
    await snap(page, info, 't6-shape-empty-light');
    await page.getByRole('button', { name: 'Try the sample teddy' }).click();
    // The viewport chunk (three, R3F, drei) loads on demand; a cold dev server transforms it first.
    await expect(page.locator('[data-testid="shape-viewport"] canvas')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('treeitem')).toHaveCount(17);
    await expect(page.getByText('Every part touches its parent')).toBeVisible();
    await page.waitForTimeout(1200);
    await snap(page, info, 't6-shape-teddy-light');

    // Picking in the view selects the part (Front view: the head's center is straight above the box center).
    await page.getByRole('group', { name: 'Camera' }).getByRole('button', { name: 'Front' }).click();
    await page.waitForTimeout(700);
    const head = await frontViewPoint(page, 7.278905, TEDDY_BOX);
    await page.mouse.click(head.x, head.y - 20);
    await expect(page.getByRole('heading', { level: 2, name: 'Head' })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'Head', exact: true })).toHaveAttribute('aria-selected', 'true');
    // Clicking empty space clears it.
    const canvas = (await page.locator('[data-testid="shape-viewport"] canvas').boundingBox())!;
    await page.mouse.click(canvas.x + 40, canvas.y + canvas.height - 60);
    await expect(page.getByRole('heading', { name: 'Nothing selected' })).toBeVisible();

    // The outliner selects too; the Move gizmo shows on the selected part.
    await row(page, 'Left Arm').click();
    await expect(page.getByRole('heading', { level: 2, name: 'Left Arm' })).toBeVisible();
    await page.keyboard.press('e');
    await expect(page.getByRole('radio', { name: 'Rotate' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('group', { name: 'Camera' }).getByRole('button', { name: 'Reset' }).click();
    await snap(page, info, 't6-shape-selected-light');

    await setTheme(page, 'Dark');
    await row(page, 'Head').click();
    await page.keyboard.press('w');
    await snap(page, info, 't6-shape-selected-dark');
    await page.keyboard.press('Escape');
    await snap(page, info, 't6-shape-teddy-dark');
    for (const view of ['Left', 'Top'] as const) {
      await page.getByRole('group', { name: 'Camera' }).getByRole('button', { name: view }).click();
      await snap(page, info, `t6-shape-view-${view.toLowerCase()}-dark`);
    }
  });

  test('a gizmo drag is one undo step and carries the attached parts; ⌥-drag moves the part alone', async ({ page }) => {
    test.setTimeout(120_000);
    await openTeddy(page);
    await page.getByRole('group', { name: 'Camera' }).getByRole('button', { name: 'Front' }).click();
    await page.waitForTimeout(700);
    await row(page, 'Head').click();
    await page.keyboard.press('w');
    await page.waitForTimeout(500);
    await expect(yField(page)).toHaveValue('7.28');
    const earY0 = await (async () => {
      await row(page, 'Left Ear').click();
      const v = await yField(page).inputValue();
      await row(page, 'Head').click();
      return Number(v);
    })();

    // Grab the green (Y) arrow and pull it up. The head sits above the camera, so three.js draws its Y arrow
    // pointing down (towards the eye): the handle is BELOW the head's center on the screen.
    const c = await frontViewPoint(page, 7.278905, TEDDY_BOX);
    const grab = { x: c.x, y: c.y + 55 };
    await page.mouse.move(grab.x, grab.y);

    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(grab.x, grab.y - i * 5);
    await page.mouse.up();
    await expect(page.getByTestId('undo')).toHaveAccessibleName('Undo Move Head');
    const headY1 = Number(await yField(page).inputValue());
    expect(headY1).toBeGreaterThan(7.6);
    expect(headY1 * 20).toBeCloseTo(Math.round(headY1 * 20), 5); // snapped to 0.05 in
    await row(page, 'Left Ear').click();
    expect(Number(await yField(page).inputValue())).toBeCloseTo(earY0 + (headY1 - 7.278905), 1); // the ear came along
    await expect(page.getByText('1 part has a gap')).toBeVisible(); // the head left the body

    // One undo restores the head and the ear.
    await page.getByTestId('undo').click();
    await expect(page.getByText('Every part touches its parent')).toBeVisible();
    expect(Number(await yField(page).inputValue())).toBeCloseTo(earY0, 2);
    await row(page, 'Head').click();
    await expect(yField(page)).toHaveValue('7.28');

    // ⌥-drag: the head moves alone; its ears stay.
    await page.keyboard.down('Alt');
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(grab.x, grab.y - i * 5);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect(page.getByTestId('undo')).toHaveAccessibleName('Undo Move Head');
    await row(page, 'Left Ear').click();
    expect(Number(await yField(page).inputValue())).toBeCloseTo(earY0, 2);
    // The head left the body on its own: the outliner flags it (W_GAP).
    await expect(page.getByRole('treeitem', { name: 'Head, has a gap to its parent' })).toBeVisible();
    await page.getByTestId('undo').click();
    await expect(page.getByText('Every part touches its parent')).toBeVisible();

    // Escape during a drag cancels it: no new step, the head back where it was.
    await row(page, 'Head').click();
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(grab.x, grab.y - i * 5);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(yField(page)).toHaveValue('7.28');
    await expect(page.getByRole('heading', { level: 2, name: 'Head' })).toBeVisible();
    await expect(page.getByTestId('undo')).toHaveAccessibleName('Undo Open the sample teddy');

    // Resize: pull the Y handle of the scale gizmo; the ears are re-anchored, nothing floats.
    await row(page, 'Head').click();
    await page.keyboard.press('r');
    await page.waitForTimeout(400);
    const heightBefore = Number(await page.getByRole('spinbutton', { name: /^Height/ }).inputValue());
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    // The handle is below the center (flipped, as above): pulling it further down makes the head taller.
    for (let i = 1; i <= 10; i++) await page.mouse.move(grab.x, grab.y + i * 3);
    await page.waitForTimeout(150);
    await page.mouse.up();
    await expect(page.getByTestId('undo')).toHaveAccessibleName('Undo Resize Head');
    const heightAfter = Number(await page.getByRole('spinbutton', { name: /^Height/ }).inputValue());
    expect(heightAfter).toBeGreaterThan(heightBefore);
    expect(heightAfter).toBeLessThan(heightBefore * 2);
    await expect(page.getByText('Every part touches its parent')).toBeVisible();
  });
});
