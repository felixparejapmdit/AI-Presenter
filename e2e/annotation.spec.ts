import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, mock, test } from './support/fixtures';
import { createImageSlide, dragBy, dropImage, makePng, readLine, waitForModels } from './support/helpers';
import { answerNativeDialog } from './support/native-dialog';

test.describe('Module C: image ingestion', () => {
  test.beforeEach(async ({ app }) => {
    await app.getByTestId('script-editor').fill('Dashboard review\nConversion improved');
    await app.getByTestId('outline-button').click();
    await expect(app.getByTestId('slide-card')).toHaveCount(1);
  });

  test('drag and drop adds an image with its real proportions', async ({ app }) => {
    const zone = app.getByTestId('dropzone').first();
    await dropImage(app, zone, makePng(800, 400));
    const canvas = app.getByTestId('annotated-canvas').first();
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(2, 1);
    await app.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('[data-testid="annotated-canvas"] img');
      return image?.complete && image.naturalWidth === 800;
    });
  });

  test('the drop highlight is steady while crossing child elements', async ({ app }) => {
    const zone = app.getByTestId('dropzone').first();
    const transfer = await app.evaluateHandle(() => new DataTransfer());
    await zone.dispatchEvent('dragenter', { dataTransfer: transfer });
    await expect(zone).toHaveAttribute('data-drag-over', 'true');
    // Crossing into a child fires enter on the child, then leave on the parent.
    await zone.dispatchEvent('dragenter', { dataTransfer: transfer });
    await zone.dispatchEvent('dragleave', { dataTransfer: transfer });
    await expect(zone).toHaveAttribute('data-drag-over', 'true');
    await zone.dispatchEvent('dragleave', { dataTransfer: transfer });
    await expect(zone).toHaveAttribute('data-drag-over', 'false');
  });

  test('the file picker adds an image', async ({ app, mode }) => {
    const zone = app.getByTestId('dropzone').first();
    const file = join(mkdtempSync(join(tmpdir(), 'vanguard-picker-')), 'picked.png');
    writeFileSync(file, makePng(640, 360));

    if (mode === 'web') {
      const [chooser] = await Promise.all([app.waitForEvent('filechooser'), zone.click()]);
      await chooser.setFiles(file);
    } else {
      const answered = answerNativeDialog(app, file);
      await zone.click();
      await answered;
    }
    await expect(app.getByTestId('annotated-canvas').first()).toBeVisible();
  });

  test('pasting from the clipboard works while hovering a zone', async ({ app }) => {
    const zone = app.getByTestId('dropzone').first();
    await zone.hover();
    const png = makePng(500, 500).toString('base64');
    await app.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png);
    await expect(app.getByTestId('annotated-canvas').first()).toBeVisible();
  });

  test('pasting works while a zone has keyboard focus', async ({ app }) => {
    const zone = app.getByTestId('dropzone').first();
    await zone.focus();
    await app.mouse.move(2, 2);
    const png = makePng(300, 200).toString('base64');
    await app.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png);
    await expect(app.getByTestId('annotated-canvas').first()).toBeVisible();
  });

  test('pasting text into the script is left alone', async ({ app }) => {
    const before = await app.getByTestId('dropzone').count();
    const editor = app.getByTestId('script-editor');
    await editor.focus();
    await app.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'plain text');
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(app.getByTestId('annotated-canvas')).toHaveCount(0);
    await expect(app.getByTestId('dropzone')).toHaveCount(before);
  });

  test('a clipboard holding text and an image pastes as text inside a text field', async ({ app }) => {
    await dropImage(app, app.getByTestId('dropzone').first(), makePng(640, 360));
    const canvas = app.getByTestId('annotated-canvas').first();
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const source = await canvas.locator('img').getAttribute('src');

    await canvas.getByTestId('callout-title').focus();
    const png = makePng(50, 50).toString('base64');
    const handled = await app.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.setData('text/plain', 'Cells copied from a spreadsheet');
      data.items.add(new File([bytes], 'cells.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      return event.defaultPrevented;
    }, png);

    expect(handled, 'the browser must be left to insert the text').toBe(false);
    await app.waitForTimeout(300);
    expect(await canvas.locator('img').getAttribute('src')).toBe(source);
  });

  test('rejects files that are not images, with an explanation', async ({ app }) => {
    const zone = app.getByTestId('dropzone').first();
    const transfer = await app.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
      return data;
    });
    await zone.dispatchEvent('drop', { dataTransfer: transfer });
    await expect(app.locator('[role="status"][data-kind="error"]')).toContainText('PNG, JPEG, WebP');
    await expect(app.getByTestId('annotated-canvas')).toHaveCount(0);
  });

  test('a corrupted image is refused with an explanation', async ({ app }) => {
    const zone = app.getByTestId('dropzone').first();
    const transfer = await app.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'broken.png', { type: 'image/png' }));
      return data;
    });
    await zone.dispatchEvent('drop', { dataTransfer: transfer });
    await expect(app.locator('[role="status"][data-kind="error"]')).toBeVisible();
    await expect(app.getByTestId('annotated-canvas')).toHaveCount(0);
  });

  test('images survive a restart and load from local storage', async ({ app }) => {
    const zone = app.getByTestId('dropzone').first();
    await dropImage(app, zone, makePng(640, 360));
    await expect(app.getByTestId('annotated-canvas').first()).toBeVisible();
    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');

    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    await app.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('[data-testid="annotated-canvas"] img');
      return image?.complete && image.naturalWidth === 640;
    });
  });

  test('desktop images are served through the asset protocol', async ({ app, mode }) => {
    test.skip(mode === 'web', 'Only the desktop app has an asset protocol');
    await dropImage(app, app.getByTestId('dropzone').first(), makePng(640, 360));
    const src = await app.getByTestId('annotated-canvas').first().locator('img').getAttribute('src');
    expect(src).toMatch(/^(asset:|http:\/\/asset\.localhost)/);
  });
});

test.describe('Module D: pins and leader lines', () => {
  test('clicking the image places a pin at exact normalized coordinates', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.4);

    const anchor = canvas.getByTestId('pin-anchor');
    await expect(anchor).toHaveCount(1);
    await expect(anchor).toHaveText('1');
    const position = await anchor.evaluate((element) => ({ left: parseFloat((element as HTMLElement).style.left), top: parseFloat((element as HTMLElement).style.top) }));
    expect(position.left).toBeCloseTo(25, 0);
    expect(position.top).toBeCloseTo(40, 0);

    await expect(canvas.getByTestId('callout-card')).toHaveCount(1);
    await expect(canvas.getByTestId('callout-title')).toHaveValue('Key Detail 1');
  });

  test('the toolbar has every action and is revealed by hover', async ({ app }) => {
    await createImageSlide(app);
    const toolbar = app.getByTestId('image-toolbar').first();
    await app.mouse.move(2, 2);
    await expect(toolbar).toHaveCSS('opacity', '0');
    await app.getByTestId('annotated-canvas').first().hover();
    await expect(toolbar).toHaveCSS('opacity', '1');
    for (const name of ['Add Pin', 'AI Vision Inspect', 'Replace Image', 'Reset Pins']) {
      await expect(toolbar.getByRole('button', { name })).toBeVisible();
    }
  });

  test('Add Pin toggles pin mode', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await canvas.hover();
    const addPin = app.getByTestId('image-toolbar').first().getByRole('button', { name: 'Add Pin' });
    await expect(addPin).toHaveAttribute('aria-pressed', 'true');
    await addPin.click();
    await expect(addPin).toHaveAttribute('aria-pressed', 'false');
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(canvas.getByTestId('pin-anchor')).toHaveCount(0);
    await addPin.click();
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(canvas.getByTestId('pin-anchor')).toHaveCount(1);
  });

  test('a leader line runs from the anchor to the nearest edge of the card', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);

    const line = await readLine(canvas);
    const anchorBox = (await canvas.getByTestId('pin-anchor').boundingBox())!;
    expect(line.anchor.x).toBeCloseTo(anchorBox.x + anchorBox.width / 2, 0);
    expect(line.anchor.y).toBeCloseTo(anchorBox.y + anchorBox.height / 2, 0);

    const onVerticalEdge = Math.abs(line.end.x - line.card.left) < 1.5 || Math.abs(line.end.x - line.card.right) < 1.5;
    const onHorizontalEdge = Math.abs(line.end.y - line.card.top) < 1.5 || Math.abs(line.end.y - line.card.bottom) < 1.5;
    expect(onVerticalEdge || onHorizontalEdge, `line ends at ${JSON.stringify(line.end)} of ${JSON.stringify(line.card)}`).toBe(true);
    expect(line.end.x).toBeGreaterThanOrEqual(line.card.left - 1.5);
    expect(line.end.x).toBeLessThanOrEqual(line.card.right + 1.5);
    expect(line.end.y).toBeGreaterThanOrEqual(line.card.top - 1.5);
    expect(line.end.y).toBeLessThanOrEqual(line.card.bottom + 1.5);
  });

  test('the elbow style has two orthogonal segments and Bezier is a curve', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);

    const elbow = (await readLine(canvas)).pathData;
    expect(elbow).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
    const [ax, ay, bx, by, cx, cy] = [...elbow.matchAll(/[\d.]+/g)].map((match) => Number(match[0])) as [number, number, number, number, number, number];
    expect(ax === bx || ay === by).toBe(true);
    expect(bx === cx || by === cy).toBe(true);

    await app.getByTestId('open-settings').click();
    await app.getByTestId('pref-bezier').click();
    await app.keyboard.press('Escape');
    await expect.poll(async () => (await readLine(canvas)).pathData).toMatch(/ C /);
  });

  test('anchor and callout drag independently, and the line follows', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
    const anchor = canvas.getByTestId('pin-anchor');
    const card = canvas.getByTestId('callout-card');
    const cardBefore = (await card.boundingBox())!;
    const lineBefore = await readLine(canvas);

    await dragBy(app, anchor, 80, 60);
    const cardAfterAnchorDrag = (await card.boundingBox())!;
    expect(cardAfterAnchorDrag.x).toBeCloseTo(cardBefore.x, 0);
    expect(cardAfterAnchorDrag.y).toBeCloseTo(cardBefore.y, 0);
    const lineAfterAnchorDrag = await readLine(canvas);
    expect(lineAfterAnchorDrag.anchor.x).toBeCloseTo(lineBefore.anchor.x + 80, 0);
    expect(lineAfterAnchorDrag.anchor.y).toBeCloseTo(lineBefore.anchor.y + 60, 0);

    const anchorBox = (await anchor.boundingBox())!;
    await dragBy(app, canvas.getByTestId('callout-header').locator('span').first(), 60, 40);
    const anchorAfterCardDrag = (await anchor.boundingBox())!;
    expect(anchorAfterCardDrag.x).toBeCloseTo(anchorBox.x, 0);
    expect(anchorAfterCardDrag.y).toBeCloseTo(anchorBox.y, 0);
    const cardAfterDrag = (await card.boundingBox())!;
    expect(cardAfterDrag.x).toBeCloseTo(cardBefore.x + 60, 0);
    expect(cardAfterDrag.y).toBeCloseTo(cardBefore.y + 40, 0);
  });

  test('dragging never creates a stray pin, even when released over the image', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await dragBy(app, canvas.getByTestId('pin-anchor'), -200, -100);
    await expect(canvas.getByTestId('pin-anchor')).toHaveCount(1);
    await dragBy(app, canvas.getByTestId('callout-header').locator('span').first(), 100, 60);
    await expect(canvas.getByTestId('pin-anchor')).toHaveCount(1);
  });

  test('a drag outside the canvas stays clamped, and cards stay inside it', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const anchor = canvas.getByTestId('pin-anchor');
    await dragBy(app, anchor, 5000, 5000);
    const position = await anchor.evaluate((element) => parseFloat((element as HTMLElement).style.left));
    expect(position).toBe(98);

    await dragBy(app, canvas.getByTestId('callout-header').locator('span').first(), 5000, 5000);
    const card = (await canvas.getByTestId('callout-card').boundingBox())!;
    const bounds = (await canvas.boundingBox())!;
    expect(card.x + card.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(card.y + card.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  });

  test('pins stay pixel-accurate across window resizing', async ({ app, mode }) => {
    test.skip(mode !== 'web', 'The desktop window is sized by the OS');
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
    await dragBy(app, canvas.getByTestId('callout-header').locator('span').first(), 120, -80);

    const relative = async () => {
      const bounds = (await canvas.boundingBox())!;
      const pin = (await canvas.getByTestId('pin-anchor').boundingBox())!;
      return { x: (pin.x + pin.width / 2 - bounds.x) / bounds.width, y: (pin.y + pin.height / 2 - bounds.y) / bounds.height };
    };
    const before = await relative();

    for (const size of [{ width: 1100, height: 700 }, { width: 1800, height: 1000 }, { width: 950, height: 640 }]) {
      await app.setViewportSize(size);
      await app.waitForTimeout(80);
      const after = await relative();
      expect(after.x).toBeCloseTo(before.x, 2);
      expect(after.y).toBeCloseTo(before.y, 2);

      const line = await readLine(canvas);
      const pin = (await canvas.getByTestId('pin-anchor').boundingBox())!;
      expect(line.anchor.x).toBeCloseTo(pin.x + pin.width / 2, 0);
      expect(line.end.x).toBeGreaterThanOrEqual(line.card.left - 1.5);
      expect(line.end.x).toBeLessThanOrEqual(line.card.right + 1.5);
      expect(line.end.y).toBeGreaterThanOrEqual(line.card.top - 1.5);
      expect(line.end.y).toBeLessThanOrEqual(line.card.bottom + 1.5);
    }
  });

  test('callouts edit inline, grow without breaking the line, and persist', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.15);

    await canvas.getByTestId('callout-title').fill('Conversion funnel');
    await canvas.getByTestId('callout-description').fill('The week 7 spike is the partner campaign, which lifted signups across every segment.');
    const line = await readLine(canvas);
    expect(line.end.y).toBeLessThanOrEqual(line.card.bottom + 1.5);

    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    const after = app.getByTestId('annotated-canvas').first();
    await expect(after.getByTestId('callout-title')).toHaveValue('Conversion funnel');
    await expect(after.getByTestId('callout-description')).toHaveValue(/partner campaign/);
    await expect.poll(async () => (await readLine(after)).pathData.length).toBeGreaterThan(5);
  });

  test('deleting a pin renumbers the rest; Reset Pins clears all and can be undone', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    for (const [x, y] of [[0.1, 0.1], [0.5, 0.15], [0.9, 0.2]] as const) {
      await app.mouse.click(box.x + box.width * x, box.y + box.height * y);
    }
    const anchors = canvas.getByTestId('pin-anchor');
    await expect(anchors).toHaveCount(3);
    await expect(anchors.nth(2)).toHaveText('3');

    await canvas.getByTestId('callout-delete').first().click();
    await expect(anchors).toHaveCount(2);
    await expect(anchors.nth(0)).toHaveText('1');
    await expect(anchors.nth(1)).toHaveText('2');

    await canvas.hover();
    await app.getByTestId('image-toolbar').first().getByRole('button', { name: 'Reset Pins' }).click();
    await expect(anchors).toHaveCount(0);
    await app.getByRole('button', { name: 'Undo' }).click();
    await expect(anchors).toHaveCount(2);
  });

  test('pins can be moved and removed from the keyboard', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const anchor = canvas.getByTestId('pin-anchor');
    await anchor.focus();
    const left = () => anchor.evaluate((element) => parseFloat((element as HTMLElement).style.left));
    const start = await left();
    await app.keyboard.press('Shift+ArrowRight');
    await expect.poll(left).toBeCloseTo(start + 2, 1);
    await app.keyboard.press('Delete');
    await expect(anchor).toHaveCount(0);
  });

  test('Replace Image keeps the pins and swaps the picture', async ({ app, mode }) => {
    const canvas = await createImageSlide(app, [1600, 900]);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const file = join(mkdtempSync(join(tmpdir(), 'vanguard-replace-')), 'replaced.png');
    writeFileSync(file, makePng(1000, 1000, [240, 220, 200]));

    await canvas.hover();
    const replace = app.getByTestId('image-toolbar').first().getByRole('button', { name: 'Replace Image' });
    if (mode === 'web') {
      const [chooser] = await Promise.all([app.waitForEvent('filechooser'), replace.click()]);
      await chooser.setFiles(file);
    } else {
      const answered = answerNativeDialog(app, file);
      await replace.click();
      await answered;
    }
    await app.waitForFunction(() => document.querySelector<HTMLImageElement>('[data-testid="annotated-canvas"] img')?.naturalWidth === 1000);
    await expect(canvas.getByTestId('pin-anchor')).toHaveCount(1);
    const next = (await canvas.boundingBox())!;
    expect(next.width / next.height).toBeCloseTo(1, 1);
  });

  test('Remove Image returns to the dropzone and offers undo', async ({ app }) => {
    const canvas = await createImageSlide(app);
    await canvas.hover();
    await app.getByTestId('image-toolbar').first().getByRole('button', { name: 'Remove image' }).click();
    await expect(app.getByTestId('annotated-canvas')).toHaveCount(0);
    await expect(app.getByTestId('dropzone').first()).toHaveAttribute('data-filled', 'false');
    await app.getByRole('button', { name: 'Undo' }).click();
    await expect(app.getByTestId('annotated-canvas')).toHaveCount(1);
  });

  test('the expanded view edits the same pins', async ({ app }) => {
    const canvas = await createImageSlide(app);
    await canvas.hover();
    await app.getByTestId('image-toolbar').first().getByRole('button', { name: 'Expand' }).click();
    const modal = app.getByTestId('annotate-modal');
    await expect(modal).toBeVisible();
    const large = modal.getByTestId('annotated-canvas');
    const box = (await large.boundingBox())!;
    expect(box.width).toBeGreaterThan(700);
    await app.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await expect(large.getByTestId('pin-anchor')).toHaveCount(1);
    await app.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(app.getByTestId('annotated-canvas').first().getByTestId('pin-anchor')).toHaveCount(1);
  });
});

test.describe('Module D: AI Vision', () => {
  test('the sparkle button sends crop and full image, then fills the description', async ({ app }) => {
    await waitForModels(app);
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.25);

    await canvas.getByTestId('callout-ai').click();
    await expect(canvas.getByTestId('callout-description')).toHaveValue(/conversion funnel/, { timeout: 15000 });

    const [request] = await mock.chatRequests();
    expect(request!.body!.model).toBe('moondream:latest');
    const user = request!.body!.messages.find((message: { role: string }) => message.role === 'user');
    expect(user.images).toHaveLength(2);
    expect(user.content).toContain('80%');
    expect(user.content).toContain('25%');
    expect(user.content).toContain('close-up');
    const [crop, full] = user.images as [string, string];
    expect(Buffer.from(crop, 'base64').subarray(0, 2).toString('hex'), 'crop is a JPEG').toBe('ffd8');
    expect(Buffer.from(full, 'base64').subarray(0, 2).toString('hex'), 'full is a JPEG').toBe('ffd8');
    expect(crop.length).toBeLessThan(full.length);
    expect(request!.body!.messages[0].content).toContain('emojis');
  });

  test('falls back to a composite for models limited to one image', async ({ app }) => {
    await mock.set({ rejectMultiImage: true });
    await waitForModels(app);
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await canvas.getByTestId('callout-ai').click();
    await expect(canvas.getByTestId('callout-description')).toHaveValue(/conversion funnel/, { timeout: 15000 });
    const requests = await mock.chatRequests();
    expect(requests).toHaveLength(2);
    const last = requests[1]!.body!.messages.find((message: { role: string }) => message.role === 'user');
    expect(last.images).toHaveLength(1);
  });

  test('AI Vision Inspect makes an overview pin when none exist, and fills empty pins', async ({ app }) => {
    await waitForModels(app);
    const canvas = await createImageSlide(app);
    await canvas.hover();
    const inspect = app.getByTestId('image-toolbar').first().getByRole('button', { name: 'AI Vision Inspect' });
    await inspect.click();
    await expect(canvas.getByTestId('pin-anchor')).toHaveCount(1);
    await expect(canvas.getByTestId('callout-title')).toHaveValue('Overview');
    await expect(canvas.getByTestId('callout-description')).toHaveValue(/conversion funnel/, { timeout: 15000 });

    await mock.set({ visionText: 'A second region.' });
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.9);
    await canvas.hover();
    await inspect.click();
    await expect(canvas.getByTestId('callout-description').nth(1)).toHaveValue('A second region.', { timeout: 15000 });
    await expect(canvas.getByTestId('callout-description').first()).toHaveValue(/conversion funnel/);
  });

  test('an analysis in progress can be stopped', async ({ app }) => {
    await mock.set({ chatDelayMs: 300 });
    await waitForModels(app);
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const button = canvas.getByTestId('callout-ai');
    await button.click();
    await expect(button).toHaveAttribute('aria-label', 'Stop AI Inspect Pin');
    await expect(canvas.getByTestId('callout-description')).toHaveJSProperty('readOnly', true);
    await button.click();
    await expect(button).toHaveAttribute('aria-label', 'AI Inspect Pin');
    await expect(canvas.getByTestId('callout-description')).toHaveValue('');
  });

  test('AI Vision gives clear guidance when the daemon is offline', async ({ app }) => {
    await waitForModels(app);
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await mock.set({ online: false });
    await expect(app.getByTestId('ai-status')).toHaveAttribute('data-online', 'false', { timeout: 8000 });
    await canvas.getByTestId('callout-ai').click();
    await expect(app.locator('[role="status"][data-kind="error"]')).toContainText('Ollama is offline');
  });

  test('a description finishing after a project switch lands on its own pin', async ({ app }) => {
    await mock.set({ chatDelayMs: 100 });
    await waitForModels(app);
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await canvas.getByTestId('callout-ai').click();
    await expect(canvas.getByTestId('callout-ai')).toHaveAttribute('aria-label', 'Stop AI Inspect Pin');

    await app.getByTestId('new-project').click();
    await expect(app.getByTestId('annotated-canvas')).toHaveCount(0);
    await app.waitForTimeout(3500);

    await app.getByTestId('project-open').first().click();
    await expect(app.getByTestId('annotated-canvas').first().getByTestId('callout-description')).toHaveValue(/conversion funnel/, { timeout: 15000 });
  });

  test('stopping one pin stops the whole AI Vision Inspect batch', async ({ app }) => {
    await mock.set({ chatDelayMs: 250 });
    await waitForModels(app);
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await app.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
    await expect(canvas.getByTestId('pin-anchor')).toHaveCount(2);

    await canvas.hover();
    await app.getByTestId('image-toolbar').first().getByRole('button', { name: 'AI Vision Inspect' }).click();
    const first = canvas.getByTestId('callout-ai').first();
    await expect(first).toHaveAttribute('aria-label', 'Stop AI Inspect Pin');
    await first.click();
    await expect(first).toHaveAttribute('aria-label', 'AI Inspect Pin');

    await app.waitForTimeout(800);
    await expect(canvas.getByTestId('callout-ai').nth(1)).toHaveAttribute('aria-label', 'AI Inspect Pin');
    // A fast stop can land before the request is even sent, so none is also correct.
    expect((await mock.chatRequests()).length).toBeLessThanOrEqual(1);
  });
});
