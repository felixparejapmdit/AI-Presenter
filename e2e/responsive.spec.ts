import { expect, test } from './support/fixtures';
import { generateDeck } from './support/helpers';

const SIZES = [
  { name: 'large desktop', width: 1920, height: 1080 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'small window', width: 1000, height: 700 },
  { name: 'tablet', width: 820, height: 1100 },
  { name: 'phone', width: 420, height: 800 },
];

for (const size of SIZES) {
  test(`no horizontal overflow and all key controls reachable at ${size.name}`, async ({ app }) => {
    await app.setViewportSize({ width: size.width, height: size.height });
    await generateDeck(app);

    const overflow = await app.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await expect(app.getByTestId('present-button')).toBeVisible();
    await expect(app.getByTestId('export-button')).toBeVisible();
    await expect(app.getByTestId('theme-toggle')).toBeVisible();

    if (size.width < 900) {
      await expect(app.getByTestId('pane-tabs')).toBeVisible();
      await expect(app.getByTestId('slide-canvas')).toBeVisible();
      await expect(app.getByTestId('script-pane')).toBeHidden();
      await app.getByTestId('pane-tab-script').click();
      await expect(app.getByTestId('script-editor')).toBeVisible();
      await expect(app.getByTestId('analyze-button')).toBeVisible();
    } else {
      await expect(app.getByTestId('script-pane')).toBeVisible();
      await expect(app.getByTestId('slide-canvas')).toBeVisible();
      await expect(app.getByTestId('split-handle')).toBeVisible();
    }
  });
}

test('the sidebar becomes an overlay on narrow windows, and the scrim dismisses it', async ({ app }) => {
  await app.setViewportSize({ width: 820, height: 900 });
  await expect(app.getByTestId('sidebar')).toHaveCount(0);
  await app.getByTestId('expand-sidebar').click();
  await expect(app.getByTestId('sidebar')).toBeVisible();
  await app.getByTestId('sidebar-scrim').click({ position: { x: 700, y: 400 } });
  await expect(app.getByTestId('sidebar')).toHaveCount(0);
});

test('modals fit small screens and stay scrollable', async ({ app }) => {
  await app.setViewportSize({ width: 420, height: 700 });
  await app.getByTestId('expand-sidebar').click();
  await app.getByTestId('open-settings').click();
  const modal = app.getByTestId('model-manager');
  await expect(modal).toBeVisible();
  const box = (await modal.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(420);
  expect(box.height).toBeLessThanOrEqual(700);
  await app.getByTestId('preferences').scrollIntoViewIfNeeded();
  await expect(app.getByTestId('preferences')).toBeInViewport();
});

test('the presenter scales to a narrow window', async ({ app }) => {
  await generateDeck(app);
  await app.setViewportSize({ width: 700, height: 900 });
  await app.keyboard.press('Control+Enter');
  const stage = (await app.getByTestId('slide-stage').boundingBox())!;
  expect(stage.width).toBeLessThanOrEqual(700);
  expect(stage.width / stage.height).toBeCloseTo(16 / 9, 2);
});

test('the split handle clamps, and its position is remembered', async ({ app }) => {
  const handle = app.getByTestId('split-handle');
  const box = (await handle.boundingBox())!;
  await app.mouse.move(box.x, box.y + 200);
  await app.mouse.down();
  await app.mouse.move(5, box.y + 200, { steps: 8 });
  await app.mouse.up();
  const clamped = await handle.getAttribute('aria-valuenow');
  expect(Number(clamped)).toBe(24);

  await app.waitForTimeout(150);
  await app.reload();
  await app.waitForSelector('[data-testid="app-shell"]');
  expect(Number(await app.getByTestId('split-handle').getAttribute('aria-valuenow'))).toBe(24);
});
