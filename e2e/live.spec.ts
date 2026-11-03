import { expect, launchDesktopApp, REAL_OLLAMA_URL, test } from './support/fixtures';
import { dropImage, makePng } from './support/helpers';

// The real desktop executable against the real local Ollama and real models. Nothing is
// mocked here. These run only through the "live" project, and CPU inference is slow.
const SCRIPT = `Revenue grew 38 percent this quarter, driven by the enterprise tier.

Next quarter we will expand into the APAC region and ship the mobile companion.`;

test.describe('Live Ollama', () => {
  test.beforeAll(async () => {
    const response = await fetch(`${REAL_OLLAMA_URL}/api/tags`).catch(() => null);
    test.skip(!response?.ok, 'Ollama is not running');
  });

  test('real models generate a deck and describe a pinned region', async () => {
    const desktop = await launchDesktopApp({ ollamaUrl: REAL_OLLAMA_URL });
    const page = desktop.page;
    try {
      await page.waitForSelector('[data-testid="app-shell"]', { state: 'visible', timeout: 30_000 });
      await expect(page.getByTestId('ai-status')).toHaveAttribute('data-online', 'true', { timeout: 15_000 });

      const tags = (await (await fetch(`${REAL_OLLAMA_URL}/api/tags`)).json()) as { models: { name: string; capabilities?: string[] }[] };
      const textModel = tags.models.find((model) => model.name === 'llama3.2:3b')?.name;
      const visionModel = tags.models.find((model) => model.name.startsWith('moondream'))?.name;
      test.skip(!textModel || !visionModel, 'This test needs llama3.2:3b and moondream');

      await page.getByTestId('text-model-select').click();
      await page.getByRole('option', { name: new RegExp(textModel!.replace('.', '\\.')) }).first().click();
      await page.getByTestId('vision-model-select').click();
      await page.getByRole('option', { name: new RegExp(visionModel!) }).first().click();

      // Text pipeline
      await page.getByTestId('script-editor').fill(SCRIPT);
      await page.getByTestId('analyze-button').click();
      await expect(page.getByTestId('analysis-panel')).toBeVisible();
      const analyzeStart = Date.now();
      await expect(page.getByTestId('slide-card').first()).toBeVisible({ timeout: 8 * 60_000 });
      console.log(`Text analysis took ${((Date.now() - analyzeStart) / 1000).toFixed(1)} s`);

      const slideCount = await page.getByTestId('slide-card').count();
      expect(slideCount).toBeGreaterThanOrEqual(1);
      const titles: string[] = [];
      for (let index = 0; index < slideCount; index += 1) {
        const title = await page.getByTestId('slide-title').nth(index).inputValue();
        titles.push(title);
        expect(title.trim().length).toBeGreaterThan(0);
      }
      console.log(`Generated titles: ${JSON.stringify(titles)}`);
      const emoji = /\p{Emoji_Presentation}|\u{FE0F}/u;
      expect(emoji.test(await page.evaluate(() => document.body.innerText))).toBe(false);

      // Vision pipeline
      let card = page.getByTestId('slide-card').first();
      if ((await card.getByTestId('dropzone').count()) === 0) {
        await card.getByTestId('slide-layout').click();
        await page.getByRole('option', { name: 'Single visual' }).click();
      }
      card = page.getByTestId('slide-card').first();
      await dropImage(page, card.getByTestId('dropzone').first(), makePng(640, 360, [220, 60, 60]));
      const canvas = card.getByTestId('annotated-canvas');
      await expect(canvas).toBeVisible();
      const box = (await canvas.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await canvas.getByTestId('callout-ai').click();

      const description = canvas.getByTestId('callout-description');
      const visionStart = Date.now();
      await expect(description).not.toHaveValue('', { timeout: 6 * 60_000 });
      await expect(canvas.getByTestId('callout-ai')).toHaveAttribute('aria-label', 'AI Inspect Pin', { timeout: 6 * 60_000 });
      console.log(`Vision took ${((Date.now() - visionStart) / 1000).toFixed(1)} s`);
      const text = await description.inputValue();
      console.log(`Vision description: ${text}`);
      expect(text.trim().length).toBeGreaterThan(5);
      expect(emoji.test(text)).toBe(false);
    } finally {
      await desktop.close();
    }
  });
});
