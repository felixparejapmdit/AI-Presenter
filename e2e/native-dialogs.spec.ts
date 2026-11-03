import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from './support/fixtures';
import { makePng } from './support/helpers';
import { answerNativeDialog, cancelNativeDialog } from './support/native-dialog';

test.describe('Real Windows file dialogs', () => {
  test('Open imports a chosen image, and Save writes both formats outside the app folder', async ({ app, mode }) => {
    test.skip(mode === 'web', 'Only the desktop app uses native dialogs');
    test.setTimeout(150_000);
    const folder = mkdtempSync(join(tmpdir(), 'vanguard-dialogs-'));
    const imagePath = join(folder, 'chosen by the user.png');
    const pdfPath = join(folder, 'client deck.pdf');
    const pptxPath = join(folder, 'client deck.pptx');
    writeFileSync(imagePath, makePng(800, 450));

    try {
      await app.getByTestId('script-editor').fill('A slide with a chosen image\nA supporting point');
      await app.getByTestId('outline-button').click();

      const opened = answerNativeDialog(app, imagePath);
      await app.getByTestId('dropzone').first().click();
      await opened;
      await expect(app.getByTestId('annotated-canvas').first()).toBeVisible({ timeout: 15_000 });
      await app.waitForFunction(() => document.querySelector<HTMLImageElement>('[data-testid="annotated-canvas"] img')?.naturalWidth === 800);

      const exportThrough = async (option: RegExp, target: string) => {
        const saved = answerNativeDialog(app, target);
        await app.getByTestId('export-button').click();
        await app.getByRole('option', { name: option }).click();
        await saved;
        // The previous export's message can still be showing, so this matches on the file name.
        await expect(app.locator('[role="status"]').filter({ hasText: `Exported ${basename(target)}` })).toBeVisible({ timeout: 60_000 });
        expect(existsSync(target), `${target} was written`).toBe(true);
        await expect(app.getByTestId('export-progress')).toHaveCount(0, { timeout: 60_000 });
      };

      await exportThrough(/Export as PDF/, pdfPath);
      expect(readFileSync(pdfPath).subarray(0, 5).toString()).toBe('%PDF-');

      await exportThrough(/Export as PowerPoint/, pptxPath);
      expect(readFileSync(pptxPath).subarray(0, 2).toString(), 'a PowerPoint file is a zip').toBe('PK');
    } finally {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  test('cancelling either dialog changes nothing and raises no error', async ({ app, mode }) => {
    test.skip(mode === 'web', 'Only the desktop app uses native dialogs');
    test.setTimeout(120_000);
    await app.getByTestId('script-editor').fill('One slide\nOne point');
    await app.getByTestId('outline-button').click();

    const cancelledOpen = cancelNativeDialog(app);
    await app.getByTestId('dropzone').first().click();
    await cancelledOpen;
    await expect(app.getByTestId('dropzone').first()).toHaveAttribute('data-filled', 'false');

    const cancelledSave = cancelNativeDialog(app);
    await app.getByTestId('export-button').click();
    await app.getByRole('option', { name: /Export as PDF/ }).click();
    await cancelledSave;
    await expect(app.getByTestId('export-progress')).toHaveCount(0, { timeout: 60_000 });
    await expect(app.locator('[role="status"][data-kind="error"]')).toHaveCount(0);
    await expect(app.getByTestId('slide-title').first()).toHaveValue('One slide');
  });
});
