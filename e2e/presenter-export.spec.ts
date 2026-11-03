import { existsSync, readFileSync, rmSync } from 'node:fs';
import JSZip from 'jszip';
import type { Page } from '@playwright/test';
import { expect, mock, test } from './support/fixtures';
import { createImageSlide, dropImage, generateDeck, makePng } from './support/helpers';
import { answerNativeDialog } from './support/native-dialog';
import { join } from 'node:path';

async function deckWithPin(app: Page) {
  await generateDeck(app);
  const card = app.getByTestId('slide-card').first();
  await dropImage(app, card.getByTestId('dropzone').first(), makePng(1600, 900));
  const canvas = card.getByTestId('annotated-canvas');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await app.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.3);
  await canvas.getByTestId('callout-title').fill('Revenue spike');
  await canvas.getByTestId('callout-description').fill('The partner campaign launched in week 7.');
  await expect(canvas.getByTestId('pin-anchor')).toHaveCount(1);
}

test.describe('Module E: VIP presenter', () => {
  test('Ctrl+Enter opens a distraction-free deck and hides the editor', async ({ app }) => {
    await generateDeck(app);
    await app.keyboard.press('Control+Enter');
    const presenter = app.getByTestId('presenter');
    await expect(presenter).toBeVisible();
    await expect(app.getByTestId('sidebar')).toBeHidden();
    await expect(app.getByTestId('script-pane')).toBeHidden();
    await expect(app.getByTestId('topbar')).toBeHidden();
    await expect(app.getByTestId('stage-title')).toHaveText('Revenue up 38 percent, churn down');

    await app.keyboard.press('Control+Enter');
    await expect(presenter).toHaveCount(0);
    await expect(app.getByTestId('script-pane')).toBeVisible();
  });

  test('the shortcut also works from inside the script editor', async ({ app }) => {
    await generateDeck(app);
    await app.getByTestId('script-editor').focus();
    await app.keyboard.press('Control+Enter');
    await expect(app.getByTestId('presenter')).toBeVisible();
  });

  test('presenting an empty deck explains what to do', async ({ app }) => {
    await app.keyboard.press('Control+Enter');
    await expect(app.getByTestId('presenter')).toHaveCount(0);
    await expect(app.locator('[role="status"]').filter({ hasText: 'before presenting' })).toBeVisible();
    await expect(app.getByTestId('present-button')).toBeDisabled();
  });

  test('keyboard and on-screen controls navigate the deck', async ({ app }) => {
    await generateDeck(app);
    await app.getByTestId('present-button').click();
    const counter = app.getByTestId('presenter-counter');
    await expect(counter).toHaveText('1 / 4');
    await app.keyboard.press('ArrowRight');
    await expect(counter).toHaveText('2 / 4');
    await app.keyboard.press('Space');
    await expect(counter).toHaveText('3 / 4');
    await app.keyboard.press('ArrowLeft');
    await expect(counter).toHaveText('2 / 4');
    await app.keyboard.press('End');
    await expect(counter).toHaveText('4 / 4');
    await app.keyboard.press('ArrowRight');
    await expect(counter).toHaveText('4 / 4');
    await app.keyboard.press('Home');
    await expect(counter).toHaveText('1 / 4');

    await app.mouse.move(600, 500);
    await app.getByTestId('presenter-next').click();
    await expect(counter).toHaveText('2 / 4');
    await app.getByTestId('presenter-prev').click();
    await expect(counter).toHaveText('1 / 4');
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('presenter')).toHaveCount(0);
  });

  test('each layout renders without showing empty image frames', async ({ app }) => {
    await generateDeck(app);
    await app.getByTestId('present-button').click();
    // Slides 1 to 3 have no images yet, so they all fall back to a clean statement layout.
    await expect(app.getByTestId('stage-statement')).toBeVisible();
    await expect(app.locator('[data-testid="presenter"] [data-testid="dropzone"]')).toHaveCount(0);
    await app.keyboard.press('End');
    await expect(app.getByTestId('stage-statement')).toBeVisible();
  });

  test('stage layouts match the slide layout once images are present', async ({ app }) => {
    await generateDeck(app);
    const cards = app.getByTestId('slide-card');
    await dropImage(app, cards.nth(0).getByTestId('dropzone').first(), makePng(1600, 900));
    await expect(cards.nth(0).getByTestId('annotated-canvas')).toBeVisible();
    await dropImage(app, cards.nth(1).getByTestId('dropzone').nth(0), makePng(800, 600));
    await expect(cards.nth(1).getByTestId('dropzone').nth(0)).toHaveAttribute('data-filled', 'true');
    await dropImage(app, cards.nth(1).getByTestId('dropzone').nth(1), makePng(800, 601));
    await expect(cards.nth(1).getByTestId('dropzone').nth(1)).toHaveAttribute('data-filled', 'true');

    await app.getByTestId('present-button').click();
    await expect(app.getByTestId('stage-single')).toBeVisible();
    await app.keyboard.press('ArrowRight');
    await expect(app.getByTestId('stage-split')).toBeVisible();
    await expect(app.locator('[data-testid="presenter"] [data-testid="annotated-canvas"]')).toHaveCount(2);
  });

  test('the stage fills the viewport at 16:9 and stays centered', async ({ app }) => {
    await generateDeck(app);
    await app.getByTestId('present-button').click();
    const stage = app.getByTestId('slide-stage');
    const viewport = app.getByTestId('presenter-viewport');
    const stageBox = (await stage.boundingBox())!;
    const viewBox = (await viewport.boundingBox())!;
    expect(stageBox.width / stageBox.height).toBeCloseTo(16 / 9, 2);
    expect(Math.min(viewBox.width - stageBox.width, viewBox.height - stageBox.height)).toBeLessThan(2);
    expect(stageBox.x - viewBox.x).toBeCloseTo(viewBox.x + viewBox.width - (stageBox.x + stageBox.width), 0);
  });

  test('clicking a numbered callout highlights its line and zooms smoothly', async ({ app }) => {
    await deckWithPin(app);
    await app.getByTestId('present-button').click();
    const presenter = app.getByTestId('presenter');
    const layer = app.getByTestId('zoom-layer');
    await expect(layer).toHaveAttribute('data-zoomed', 'false');

    const anchor = presenter.getByTestId('pin-anchor');
    await expect(anchor).toHaveText('1');
    const before = (await anchor.boundingBox())!;

    await anchor.click();
    await expect(layer).toHaveAttribute('data-zoomed', 'true');
    await expect(presenter.locator('.leader-group')).toHaveAttribute('data-state', 'active');
    await expect(anchor).toHaveAttribute('data-active', 'true');
    await expect(presenter.getByTestId('callout-card')).toHaveAttribute('data-state', 'active');
    const transition = await layer.evaluate((element) => getComputedStyle(element).transitionProperty);
    expect(transition).toContain('transform');

    // Sampling the matrix mid-flight proves the zoom animates rather than jumping.
    const scales: number[] = [];
    await app.keyboard.press('Escape');
    await expect(layer).toHaveAttribute('data-zoomed', 'false');
    await anchor.click();
    for (let i = 0; i < 8; i += 1) {
      scales.push(await layer.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a));
      await app.waitForTimeout(50);
    }
    expect(new Set(scales.map((scale) => scale.toFixed(2))).size, `scales: ${scales.join(', ')}`).toBeGreaterThan(2);

    await expect.poll(async () => layer.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a)).toBeGreaterThan(1.2);
    const after = (await anchor.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width * 1.2);

    await app.keyboard.press('Escape');
    await expect(layer).toHaveAttribute('data-zoomed', 'false');
    await expect(presenter).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(presenter).toHaveCount(0);
  });

  test('clicking the callout card and the number keys also select a pin', async ({ app }) => {
    await deckWithPin(app);
    await app.getByTestId('present-button').click();
    const presenter = app.getByTestId('presenter');
    const layer = app.getByTestId('zoom-layer');

    await presenter.getByTestId('callout-card').click();
    await expect(layer).toHaveAttribute('data-zoomed', 'true');
    await presenter.getByTestId('callout-card').click();
    await expect(layer).toHaveAttribute('data-zoomed', 'false');

    await app.keyboard.press('1');
    await expect(layer).toHaveAttribute('data-zoomed', 'true');
    await app.keyboard.press('ArrowRight');
    await expect(layer).toHaveAttribute('data-zoomed', 'false');
    await expect(app.getByTestId('presenter-counter')).toHaveText('2 / 4');
  });

  test('pins are read-only and hold their position in the presenter', async ({ app }) => {
    await deckWithPin(app);
    await app.getByTestId('present-button').click();
    const presenter = app.getByTestId('presenter');
    await expect(presenter.getByTestId('callout-title')).toHaveCount(0);
    await expect(presenter.getByTestId('callout-description')).toHaveCount(0);
    await expect(presenter.getByTestId('image-toolbar')).toHaveCount(0);
    await expect(presenter.getByTestId('callout-card')).toContainText('Revenue spike');

    const canvas = presenter.getByTestId('annotated-canvas');
    const pin = (await presenter.getByTestId('pin-anchor').boundingBox())!;
    const bounds = (await canvas.boundingBox())!;
    expect((pin.x + pin.width / 2 - bounds.x) / bounds.width).toBeCloseTo(0.75, 1);
    expect((pin.y + pin.height / 2 - bounds.y) / bounds.height).toBeCloseTo(0.3, 1);
  });

  test('the presenter survives the deck shrinking while it is open', async ({ app }) => {
    await generateDeck(app);
    const deck = { slides: [{ slideNumber: 1, originalExcerpt: 'x', refinedTitle: 'The only slide left', executiveSummary: ['Point'], speakerNotes: 'n', layoutType: 'statement-only', dropzones: [] }] };
    await mock.set({ deck, chatDelayMs: 150 });
    await app.getByTestId('analyze-button').click();
    await app.keyboard.press('Control+Enter');
    await app.keyboard.press('End');
    const counter = app.getByTestId('presenter-counter');
    await expect(counter).toHaveText('4 / 4');

    await expect(counter).toHaveText('1 / 1', { timeout: 20000 });
    await expect(app.getByTestId('stage-title')).toHaveText('The only slide left');
    const stage = (await app.getByTestId('slide-stage').boundingBox())!;
    const view = (await app.getByTestId('presenter-viewport').boundingBox())!;
    expect(stage.width).toBeCloseTo(Math.min(view.width, (view.height * 16) / 9), 0);
  });

  test('speaker notes toggle without moving focus away', async ({ app }) => {
    await generateDeck(app);
    await app.getByTestId('present-button').click();
    await app.keyboard.press('n');
    await expect(app.getByTestId('presenter-notes-panel')).toContainText('Start with the headline number');
    await app.keyboard.press('ArrowRight');
    await expect(app.getByTestId('presenter-notes-panel')).toContainText('Walk through both flows');
    await app.keyboard.press('n');
    await expect(app.getByTestId('presenter-notes-panel')).toHaveCount(0);
  });

  test('controls fade while idle and return on movement', async ({ app }) => {
    await generateDeck(app);
    await app.getByTestId('present-button').click();
    const controls = app.getByTestId('presenter-controls');
    await expect(controls).toHaveCSS('opacity', '1');
    await expect(controls).toHaveCSS('opacity', '0', { timeout: 5000 });
    await app.mouse.move(400, 400);
    await app.mouse.move(420, 420);
    await expect(controls).toHaveCSS('opacity', '1');
  });

  test('presentation mode requests real fullscreen on the desktop', async ({ app, mode }) => {
    test.skip(mode === 'web', 'Headless browsers do not grant fullscreen');
    await generateDeck(app);
    await app.getByTestId('present-button').click();
    await expect(app.getByTestId('presenter')).toBeVisible();
    await expect
      .poll(() => app.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('plugin:window|is_fullscreen', { label: 'main' })))
      .toBe(true);
    await app.keyboard.press('Escape');
    await expect
      .poll(() => app.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('plugin:window|is_fullscreen', { label: 'main' })))
      .toBe(false);
  });
});

/** Runs an export and returns the bytes, handling the browser download or the native dialog. */
async function exportDeck(app: Page, mode: string, kind: 'pdf' | 'pptx'): Promise<Buffer> {
  const choose = async () => {
    await app.getByTestId('export-button').click();
    await app.getByRole('option', { name: kind === 'pdf' ? /Export as PDF/ : /Export as PowerPoint/ }).click();
  };

  if (mode === 'web') {
    const [download] = await Promise.all([app.waitForEvent('download', { timeout: 60_000 }), choose()]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${kind}$`));
    const path = await download.path();
    return readFileSync(path);
  }

  const info = await app.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('get_storage_info'));
  const target = join(info.dataDir, `e2e-export.${kind}`);
  if (existsSync(target)) rmSync(target);
  const answered = answerNativeDialog(app, target);
  await choose();
  await answered;
  await expect(app.locator('[role="status"][data-kind="success"]').filter({ hasText: 'Exported' })).toBeVisible({ timeout: 60_000 });
  return readFileSync(target);
}

async function decodePixels(app: Page, base64: string, mime: string) {
  return app.evaluate(
    async ({ data, type }) => {
      const image = new Image();
      image.src = `data:${type};base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      let tinted = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
        if (r < 90 && g < 90 && b < 90) dark += 1;
        if (b > r + 15 && r > 150) tinted += 1;
      }
      return { width: canvas.width, height: canvas.height, dark, tinted };
    },
    { data: base64, type: mime },
  );
}

test.describe('Module E: export', () => {
  test('PDF has one high-DPI page per slide', async ({ app, mode }) => {
    await deckWithPin(app);
    const bytes = await exportDeck(app, mode, 'pdf');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const text = bytes.toString('latin1');
    expect((text.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(4);

    // Each page embeds a 2x raster, so 1280x720 is stored as 2560x1440.
    const widths = [...text.matchAll(/\/Width\s+(\d+)/g)].map((match) => Number(match[1]));
    expect(widths.length).toBeGreaterThanOrEqual(4);
    for (const width of widths) expect(width).toBe(2560);
  });

  test('PowerPoint has image slides and speaker notes', async ({ app, mode }) => {
    await deckWithPin(app);
    const bytes = await exportDeck(app, mode, 'pptx');
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slides).toHaveLength(4);

    const notes = Object.keys(zip.files).filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));
    const notesText = (await Promise.all(notes.map((name) => zip.file(name)!.async('string')))).join('\n');
    expect(notesText).toContain('Start with the headline number');

    const media = Object.keys(zip.files).filter((name) => /^ppt\/media\/image.*\.png$/.test(name));
    expect(media.length).toBeGreaterThanOrEqual(4);
  });

  test('the rasterized slide contains the image, the leader line and the callout', async ({ app, mode }) => {
    await deckWithPin(app);
    const bytes = await exportDeck(app, mode, 'pptx');
    const zip = await JSZip.loadAsync(bytes);
    const relationships = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
    const target = /Target="\.\.\/media\/([^"]+\.png)"/.exec(relationships)![1]!;
    const pixels = await decodePixels(app, await zip.file(`ppt/media/${target}`)!.async('base64'), 'image/png');

    expect(pixels.width).toBe(2560);
    expect(pixels.height).toBe(1440);
    // The fixture's blue-grey fill, proving the screenshot made it into the export.
    expect(pixels.tinted).toBeGreaterThan(100_000);
    // Dark ink comes from the leader line, the numbered badge and the title.
    expect(pixels.dark).toBeGreaterThan(1500);
  });

  test('export always renders on a light background, whatever the app theme', async ({ app, mode }) => {
    await deckWithPin(app);
    await app.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    const bytes = await exportDeck(app, mode, 'pptx');
    const zip = await JSZip.loadAsync(bytes);
    const relationships = await zip.file('ppt/slides/_rels/slide4.xml.rels')!.async('string');
    const target = /Target="\.\.\/media\/([^"]+\.png)"/.exec(relationships)![1]!;
    const corner = await app.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return [...context.getImageData(4, 4, 1, 1).data];
    }, await zip.file(`ppt/media/${target}`)!.async('base64'));
    expect(corner.slice(0, 3)).toEqual([255, 255, 255]);
  });

  test('progress is shown, and export is offered in the presenter', async ({ app, mode }) => {
    await deckWithPin(app);
    await app.getByTestId('present-button').click();
    await app.mouse.move(500, 500);

    if (mode === 'web') {
      const [download] = await Promise.all([app.waitForEvent('download', { timeout: 60_000 }), app.getByTestId('presenter-export').click()]);
      expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    } else {
      const info = await app.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('get_storage_info'));
      const answered = answerNativeDialog(app, join(info.dataDir, 'e2e-presenter.pdf'));
      await app.getByTestId('presenter-export').click();
      await answered;
      await expect(app.locator('[role="status"][data-kind="success"]').filter({ hasText: 'Exported' })).toBeVisible({ timeout: 60_000 });
    }
    await expect(app.getByTestId('export-progress')).toHaveCount(0);
    await expect(app.getByTestId('presenter')).toBeVisible();
  });

  test('export is unavailable until a deck exists', async ({ app }) => {
    await expect(app.getByTestId('export-button')).toBeDisabled();
    await createImageSlide(app);
    await expect(app.getByTestId('export-button')).toBeEnabled();
    await mock.reset();
  });
});
