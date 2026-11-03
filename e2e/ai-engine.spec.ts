import { expect, mock, test } from './support/fixtures';
import { waitForModels } from './support/helpers';

test.describe('Module A: hardware inspector and model manager', () => {
  test('opens from the sidebar footer and shows live machine specs', async ({ app }) => {
    await app.getByTestId('open-settings').click();
    const modal = app.getByTestId('model-manager');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('hardware-banner')).toBeVisible();
    for (const id of ['spec-cpu', 'spec-ram', 'spec-gpu', 'spec-vram']) {
      await expect(modal.getByTestId(id)).not.toBeEmpty();
    }
    await expect(modal.getByTestId('tier-badge')).toContainText(/TIER [123]: (ENTRY|PRO|ULTRA)/);

    await app.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  test('every model in the plan is listed with size, status and a pull action', async ({ app }) => {
    await waitForModels(app);
    await app.getByTestId('open-settings').click();
    await expect(app.getByTestId('model-matrix')).toBeVisible();

    const expected = [
      'moondream:1.8b', 'minicpm-v:8b', 'llava:7b', 'llama3.2-vision:11b', 'qwen2.5vl:7b',
      'llama3.2:3b', 'qwen2.5:3b', 'llama3.1:8b', 'qwen2.5:7b', 'qwen2.5:14b', 'deepseek-r1:14b',
    ];
    for (const id of expected) {
      const row = app.locator(`[data-testid="model-row"][data-model="${id}"]`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(/\d+\.\d GB/);
    }
    await expect(app.getByTestId('models-vision').getByTestId('model-row')).toHaveCount(5);
    await expect(app.getByTestId('models-text').getByTestId('model-row')).toHaveCount(6);

    const installed = app.locator('[data-testid="model-row"][data-model="llama3.2:3b"]');
    await expect(installed).toHaveAttribute('data-installed', 'true');
    await expect(installed.getByTestId('installed-mark')).toBeVisible();
    await expect(installed.getByTestId('pull-model')).toContainText('Update');

    const missing = app.locator('[data-testid="model-row"][data-model="qwen2.5:3b"]');
    await expect(missing).toHaveAttribute('data-installed', 'false');
    await expect(missing.getByTestId('pull-model')).toContainText('Pull');

    await expect(app.getByTestId('other-model').first()).toContainText('moondream:latest');
  });

  test('recommendations come in vision and text pairs for the detected tier', async ({ app }) => {
    await app.getByTestId('open-settings').click();
    await expect(app.getByTestId('model-matrix')).toBeVisible();
    const tier = await app.getByTestId('tier-badge').getAttribute('data-tier');
    const expected: Record<string, string[]> = {
      '1': ['moondream:1.8b', 'llama3.2:3b', 'qwen2.5:3b'],
      '2': ['minicpm-v:8b', 'llava:7b', 'llama3.1:8b', 'qwen2.5:7b'],
      '3': ['llama3.2-vision:11b', 'qwen2.5vl:7b', 'qwen2.5:14b', 'deepseek-r1:14b'],
    };
    for (const id of expected[tier!]!) {
      await expect(app.locator(`[data-testid="model-row"][data-model="${id}"]`).getByTestId('recommended-badge')).toHaveText('Recommended for your hardware');
    }
    await expect(app.getByTestId('recommended-badge')).toHaveCount(expected[tier!]!.length);
  });

  test('a pull streams aggregated progress with speed, then installs the model', async ({ app }) => {
    await waitForModels(app);
    await app.getByTestId('open-settings').click();
    const row = app.locator('[data-testid="model-row"][data-model="qwen2.5:3b"]');
    await row.getByTestId('pull-model').click();

    const progress = row.getByTestId('pull-progress');
    await expect(progress).toBeVisible();
    await expect(row.getByTestId('pull-speed')).toHaveText(/\d+\.\d MB\/s/, { timeout: 8000 });
    await expect(row.getByTestId('pull-status')).toContainText(/MB|GB/);

    // Sampling confirms the bar only moves forward as Ollama switches layers.
    const samples: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const value = await progress.getAttribute('data-percent', { timeout: 200 }).catch(() => null);
      if (value) samples.push(Number(value));
      await app.waitForTimeout(90);
    }
    for (let i = 1; i < samples.length; i += 1) expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);

    await expect(row).toHaveAttribute('data-installed', 'true', { timeout: 15000 });
    await expect(row.getByTestId('pull-progress')).toHaveCount(0);
    expect((await mock.pullRequests())[0]?.body?.model).toBe('qwen2.5:3b');
  });

  test('a pull can be cancelled, leaving the model uninstalled', async ({ app }) => {
    await mock.set({ pullDelayMs: 150 });
    await waitForModels(app);
    await app.getByTestId('open-settings').click();
    const row = app.locator('[data-testid="model-row"][data-model="qwen2.5:7b"]');
    await row.getByTestId('pull-model').click();
    await expect(row.getByTestId('pull-progress')).toBeVisible();
    await row.getByTestId('cancel-pull').click();
    await expect(row.getByTestId('pull-progress')).toHaveCount(0);
    await expect(row.getByTestId('pull-model')).toBeVisible();
    await expect(row).toHaveAttribute('data-installed', 'false');
  });

  test('a failed pull explains itself in plain language', async ({ app, errors }) => {
    await mock.set({ pullError: 'pull model manifest: file does not exist' });
    await waitForModels(app);
    await app.getByTestId('open-settings').click();
    const row = app.locator('[data-testid="model-row"][data-model="llava:7b"]');
    await row.getByTestId('pull-model').click();
    await expect(app.locator('[role="status"][data-kind="error"]')).toContainText('does not exist in the Ollama library');
    await expect(row.getByTestId('pull-model')).toBeVisible();
    errors.length = 0;
  });

  test('Check for Model Updates re-pulls installed models and reports the result', async ({ app }) => {
    await mock.set({ pullSteps: 2, pullDelayMs: 10 });
    await waitForModels(app);
    await app.getByTestId('check-updates-top').click();
    await expect(app.locator('[role="status"][data-kind="success"]')).toContainText('All models are up to date', { timeout: 15000 });
    const pulled = (await mock.pullRequests()).map((request) => request.body?.model).sort();
    expect(pulled).toEqual(['llama3.2:3b', 'moondream:latest']);

    await mock.set({ pullBumpsDigest: true });
    await app.getByTestId('open-settings').click();
    await app.getByTestId('check-updates').click();
    await expect(app.locator('[role="status"][data-kind="success"]').last()).toContainText('Updated', { timeout: 15000 });
  });

  test('the update check reports failures instead of claiming success', async ({ app }) => {
    await mock.set({ pullError: 'network is unreachable', pullDelayMs: 10 });
    await waitForModels(app);
    await app.getByTestId('check-updates-top').click();
    await expect(app.locator('[role="status"][data-kind="error"]').filter({ hasText: 'Could not check 2 of 2' })).toBeVisible({ timeout: 15000 });
    await expect(app.locator('[role="status"]').filter({ hasText: 'up to date' })).toHaveCount(0);
  });

  test('cancelling a pull stops the whole update check', async ({ app }) => {
    await mock.set({ pullDelayMs: 150 });
    await waitForModels(app);
    await app.getByTestId('open-settings').click();
    await app.getByTestId('check-updates').click();
    const row = app.locator('[data-testid="model-row"][data-model="llama3.2:3b"]');
    await expect(row.getByTestId('cancel-pull')).toBeVisible();
    await row.getByTestId('cancel-pull').click();
    await expect(app.locator('[role="status"]').filter({ hasText: 'Update check stopped' })).toBeVisible({ timeout: 15000 });
    expect(await mock.pullRequests()).toHaveLength(1);
  });

  test('the first automatic model choice follows the hardware recommendation', async ({ app }) => {
    await mock.set({
      models: [
        { name: 'tiny-text:1b', size: 1e8, digest: 'a', capabilities: ['completion'], details: {} },
        { name: 'qwen2.5:3b', size: 2e9, digest: 'b', capabilities: ['completion'], details: {} },
      ],
    });
    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    await expect(app.getByTestId('app-shell')).toHaveAttribute('data-text-model', 'qwen2.5:3b');
  });

  test('header dropdowns switch the active models and remember them', async ({ app }) => {
    await mock.set({
      models: [
        { name: 'llama3.2:3b', size: 2e9, digest: 'a', capabilities: ['completion'], details: {} },
        { name: 'qwen2.5:7b', size: 5e9, digest: 'b', capabilities: ['completion'], details: {} },
        { name: 'moondream:latest', size: 1e9, digest: 'c', capabilities: ['completion', 'vision'], details: {} },
        { name: 'llava:7b', size: 4e9, digest: 'd', capabilities: ['completion', 'vision'], details: {} },
      ],
    });
    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    await expect(app.getByTestId('text-model-select')).toContainText('llama3.2:3b');
    await expect(app.getByTestId('vision-model-select')).toContainText('moondream:latest');

    await app.getByTestId('text-model-select').click();
    await app.getByRole('option', { name: /qwen2\.5:7b/ }).click();
    await expect(app.getByTestId('text-model-select')).toContainText('qwen2.5:7b');

    await app.getByTestId('vision-model-select').click();
    const visionOptions = app.getByRole('option');
    await expect(visionOptions).toHaveCount(2);
    await visionOptions.filter({ hasText: 'llava:7b' }).click();
    await expect(app.getByTestId('vision-model-select')).toContainText('llava:7b');

    await app.waitForTimeout(200);
    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    await expect(app.getByTestId('text-model-select')).toContainText('qwen2.5:7b');
    await expect(app.getByTestId('vision-model-select')).toContainText('llava:7b');
  });
});

test.describe('Daemon health', () => {
  test('polls /api/tags every 5 seconds', async ({ app }) => {
    await waitForModels(app);
    await app.waitForTimeout(11_000);
    const times = (await mock.requests()).filter((request) => request.path === '/api/tags').map((request) => request.at!);
    const gaps = times.slice(1).map((time, index) => time - times[index]!).filter((gap) => gap > 1000);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(4000);
      expect(gap).toBeLessThan(6500);
    }
  });

  test('going offline shows a banner with actions, and recovery clears it', async ({ app, mode }) => {
    await waitForModels(app);
    await expect(app.getByTestId('ollama-banner')).toHaveCount(0);

    await mock.set({ online: false });
    const banner = app.getByTestId('ollama-banner');
    await expect(banner).toBeVisible({ timeout: 8000 });
    await expect(banner).toHaveAttribute('data-kind', 'offline');
    await expect(app.getByTestId('ai-status')).toHaveAttribute('data-online', 'false');
    await expect(banner.getByTestId(mode === 'web' ? 'download-ollama' : 'start-ollama')).toBeVisible();

    await mock.set({ online: true });
    await banner.getByTestId('recheck-ollama').click();
    await expect(banner).toHaveCount(0);
    await expect(app.getByTestId('text-model-select')).toContainText('llama3.2:3b');
  });

  test('a daemon with no models guides the user to install one', async ({ app }) => {
    await mock.set({ models: [] });
    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    const banner = app.getByTestId('ollama-banner');
    await expect(banner).toHaveAttribute('data-kind', 'no-models');
    await banner.getByTestId('banner-open-models').click();
    await expect(app.getByTestId('model-manager')).toBeVisible();
  });
});
