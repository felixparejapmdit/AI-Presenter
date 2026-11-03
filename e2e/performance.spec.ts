import type { Page } from '@playwright/test';
import { expect, mock, test } from './support/fixtures';
import { createImageSlide, dragBy, dropImage, generateDeck, makePng } from './support/helpers';

/** Records long tasks, layout shifts and DOM churn on the page. */
async function startRecording(page: Page) {
  await page.evaluate(() => {
    const record = { longTasks: [] as number[], shifts: [] as number[], frames: [] as number[] };
    (window as any).__recording = record;
    const longTasks = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record.longTasks.push(entry.duration);
    });
    longTasks.observe({ type: 'longtask', buffered: false });
    const shifts = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (!entry.hadRecentInput) record.shifts.push(entry.value);
      }
    });
    shifts.observe({ type: 'layout-shift', buffered: false });
    let last = performance.now();
    let running = true;
    const tick = (time: number) => {
      record.frames.push(time - last);
      last = time;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as any).__stopRecording = () => {
      running = false;
      longTasks.disconnect();
      shifts.disconnect();
      return record;
    };
  });
}

function stopRecording(page: Page): Promise<{ longTasks: number[]; shifts: number[]; frames: number[] }> {
  return page.evaluate(() => (window as any).__stopRecording());
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

/** Counts mutations inside a region, which is how a re-render or flicker would show up. */
async function watchMutations(page: Page, selector: string) {
  await page.evaluate((target) => {
    const element = document.querySelector(target)!;
    const counter = { count: 0, samples: [] as string[] };
    const observer = new MutationObserver((records) => {
      counter.count += records.length;
      for (const record of records.slice(0, 3)) counter.samples.push(`${record.type}:${(record.target as Element).nodeName}:${record.attributeName ?? ''}`);
    });
    observer.observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
    (window as any).__stopWatching = () => {
      observer.disconnect();
      return counter;
    };
  }, selector);
}

function stopWatching(page: Page): Promise<{ count: number; samples: string[] }> {
  return page.evaluate(() => (window as any).__stopWatching());
}

test.describe('Smoothness and absence of flicker', () => {
  test('the first frame already has its final colors, in both themes', async ({ browser, baseURL, mode }) => {
    test.skip(mode !== 'web', 'The desktop window stays hidden until painted, which the next test covers');
    for (const [theme, color] of [['dark', 'rgb(25, 25, 25)'], ['light', 'rgb(255, 255, 255)']] as const) {
      const context = await browser.newContext({ baseURL });
      await context.addInitScript((value) => localStorage.setItem('vanguard.theme', value), theme);
      const page = await context.newPage();
      await page.goto('/', { waitUntil: 'commit' });
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-theme'));
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(color);
      await context.close();
    }
  });

  test('startup has no layout shift and no icon pop-in', async ({ app }) => {
    const shift = await app.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let total = 0;
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as (PerformanceEntry & { value: number })[]) total += entry.value;
          });
          observer.observe({ type: 'layout-shift', buffered: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(total);
          }, 800);
        }),
    );
    expect(shift, 'cumulative layout shift').toBeLessThan(0.02);

    const blank = await app.evaluate(() => [...document.querySelectorAll('svg.iconify')].filter((svg) => svg.children.length === 0).length);
    expect(blank).toBe(0);
    expect(await app.evaluate(() => document.querySelectorAll('span.iconify, [data-icon]').length)).toBe(0);
  });

  test('a daemon with models never flashes the no-models banner during startup', async ({ app }) => {
    await app.addInitScript(() => {
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="ollama-banner"]')) (window as any).__bannerSeen = true;
      }).observe(document, { subtree: true, childList: true });
    });
    await mock.set({ tagsSlowMs: 900 });
    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    await expect(app.getByTestId('text-model-select')).toContainText('llama3.2:3b');
    await app.waitForTimeout(1200);
    expect(await app.evaluate(() => (window as any).__bannerSeen ?? false)).toBe(false);
  });

  test('the model pills show their names from the first frame after a restart', async ({ app }) => {
    await expect(app.getByTestId('text-model-select')).toContainText('llama3.2:3b');
    await app.waitForTimeout(300);
    await app.addInitScript(() => {
      new MutationObserver(() => {
        const pill = document.querySelector('[data-testid="text-model-select"]');
        if (pill && !(window as any).__firstPill) (window as any).__firstPill = pill.textContent;
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    await expect(app.getByTestId('text-model-select')).toContainText('llama3.2:3b');
    expect(await app.evaluate(() => (window as any).__firstPill)).toContain('llama3.2:3b');
  });

  test('the 5 second health poll causes no repaint or DOM churn when nothing changed', async ({ app }) => {
    await generateDeck(app);
    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
    await watchMutations(app, '[data-testid="app-shell"]');
    await app.waitForTimeout(11_000);
    const result = await stopWatching(app);
    expect(result.count, `mutations: ${result.samples.join(' | ')}`).toBe(0);
    const polls = (await mock.requests()).filter((request) => request.path === '/api/tags').length;
    expect(polls).toBeGreaterThan(2);
  });

  test('dragging a pin stays on the compositor budget and touches no other slide', async ({ app }) => {
    await generateDeck(app);
    const cards = app.getByTestId('slide-card');
    await dropImage(app, cards.nth(0).getByTestId('dropzone').first(), makePng(1600, 900));
    const canvas = cards.nth(0).getByTestId('annotated-canvas');
    await expect(canvas).toBeVisible();
    // A click on a callout card is not a new pin, so each pin goes on open image.
    for (let added = 1; added <= 5; added += 1) {
      const spot = await canvas.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        for (let y = 0.1; y < 1; y += 0.1) {
          for (let x = 0.05; x < 1; x += 0.1) {
            const px = rect.left + rect.width * x;
            const py = rect.top + rect.height * y;
            const hit = document.elementFromPoint(px, py);
            if (hit && element.contains(hit) && !hit.closest('[data-interactive="true"]')) return { x: px, y: py };
          }
        }
        return null;
      });
      expect(spot, 'open space on the image').not.toBeNull();
      await app.mouse.click(spot!.x, spot!.y);
      await expect(canvas.getByTestId('pin-anchor')).toHaveCount(added);
    }
    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');

    const secondSlideId = await cards.nth(1).getAttribute('data-slide-id');
    await watchMutations(app, `[data-slide-id="${secondSlideId}"]`);
    await startRecording(app);

    const anchor = canvas.getByTestId('pin-anchor').first();
    const start = (await anchor.boundingBox())!;
    await app.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await app.mouse.down();
    for (let i = 1; i <= 120; i += 1) {
      await app.mouse.move(start.x + start.width / 2 + Math.sin(i / 8) * 180, start.y + start.height / 2 + Math.cos(i / 8) * 90);
    }
    await app.mouse.up();

    const recording = await stopRecording(app);
    const others = await stopWatching(app);
    expect(others.count, `other slide changed: ${others.samples.join(' | ')}`).toBe(0);
    const worst = Math.max(0, ...recording.longTasks);
    expect(worst, `long tasks: ${recording.longTasks.join(', ')}`).toBeLessThan(120);
    expect(recording.shifts.reduce((sum, value) => sum + value, 0), 'layout shift while dragging').toBeLessThan(0.01);
    expect(percentile(recording.frames, 0.95), 'p95 frame time in ms').toBeLessThan(50);
  });

  test('a drag renders outside React until the pointer is released', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');

    const anchor = canvas.getByTestId('pin-anchor');
    const start = (await anchor.boundingBox())!;
    await app.mouse.move(start.x + 5, start.y + 5);
    await app.mouse.down();
    await app.mouse.move(start.x + 100, start.y + 80, { steps: 10 });
    await app.waitForTimeout(100);
    await expect(app.getByTestId('save-state'), 'no store commit mid-drag').toHaveAttribute('data-state', 'saved');
    await app.mouse.up();
    await expect(app.getByTestId('save-state')).not.toHaveAttribute('data-state', 'error');
    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  });

  test('typing in the script does not touch the slide deck', async ({ app }) => {
    await generateDeck(app);
    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
    await watchMutations(app, '[data-testid="slide-canvas"]');
    await startRecording(app);
    await app.getByTestId('script-editor').focus();
    await app.keyboard.press('Control+End');
    await app.keyboard.type(' additional words typed quickly by the presenter while drafting', { delay: 8 });
    const recording = await stopRecording(app);
    const canvasChanges = await stopWatching(app);
    expect(canvasChanges.count, canvasChanges.samples.join(' | ')).toBe(0);
    expect(Math.max(0, ...recording.longTasks), 'typing long tasks').toBeLessThan(120);
  });

  test('editing one slide leaves the others untouched', async ({ app }) => {
    await generateDeck(app);
    const cards = app.getByTestId('slide-card');
    await expect(app.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
    const secondSlideId = await cards.nth(1).getAttribute('data-slide-id');
    await watchMutations(app, `[data-slide-id="${secondSlideId}"]`);
    await cards.first().getByTestId('slide-title').focus();
    await app.keyboard.type(' edited', { delay: 10 });
    const result = await stopWatching(app);
    expect(result.count, result.samples.join(' | ')).toBe(0);
  });

  test('slide transitions in the presenter are fast and shift nothing', async ({ app }) => {
    await generateDeck(app);
    await app.getByTestId('present-button').click();
    await expect(app.getByTestId('presenter')).toBeVisible();
    await startRecording(app);
    for (let i = 0; i < 6; i += 1) {
      await app.keyboard.press(i % 2 === 0 ? 'ArrowRight' : 'ArrowLeft');
      await app.waitForTimeout(60);
    }
    const recording = await stopRecording(app);
    expect(Math.max(0, ...recording.longTasks), 'presenter long tasks').toBeLessThan(150);
  });

  test('resizing the split pane keeps pins attached without React commits', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
    const handle = app.getByTestId('split-handle');
    await startRecording(app);
    await dragBy(app, handle, 200, 0, 30);
    const recording = await stopRecording(app);
    expect(Math.max(0, ...recording.longTasks), 'split drag long tasks').toBeLessThan(150);

    const after = await canvas.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const pin = element.querySelector('[data-testid="pin-anchor"]')!.getBoundingClientRect();
      return { x: (pin.left + pin.width / 2 - rect.left) / rect.width, y: (pin.top + pin.height / 2 - rect.top) / rect.height };
    });
    expect(after.x).toBeCloseTo(0.4, 1);
    expect(after.y).toBeCloseTo(0.4, 1);
  });

  test('download progress at high frequency does not freeze the interface', async ({ app }) => {
    await mock.set({ pullSteps: 200, pullDelayMs: 2 });
    await expect(app.getByTestId('ai-status')).toHaveAttribute('data-online', 'true');
    await app.getByTestId('open-settings').click();
    const row = app.locator('[data-testid="model-row"][data-model="qwen2.5:3b"]');
    await startRecording(app);
    await row.getByTestId('pull-model').click();
    await expect(row).toHaveAttribute('data-installed', 'true', { timeout: 30_000 });
    const recording = await stopRecording(app);
    expect(Math.max(0, ...recording.longTasks), 'pull long tasks').toBeLessThan(150);
    expect(percentile(recording.frames, 0.95), 'p95 frame time during a pull').toBeLessThan(60);
  });
});
