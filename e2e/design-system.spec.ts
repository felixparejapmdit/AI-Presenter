import { expect, test } from './support/fixtures';
import { createImageSlide, generateDeck } from './support/helpers';

const LIGHT = {
  '--bg-primary': '#ffffff',
  '--bg-sidebar': '#f7f7f5',
  '--bg-hover': '#efefed',
  '--text-primary': '#37352f',
  '--text-secondary': '#787774',
  '--text-muted': '#9b9a97',
  '--border-hairline': '#e9e9e7',
  '--accent-blue': '#2383e2',
};

const DARK = {
  '--bg-primary': '#191919',
  '--bg-sidebar': '#202020',
  '--bg-hover': '#2c2c2b',
  '--text-primary': '#d4d4d4',
  '--text-secondary': '#9b9a97',
  '--border-hairline': '#2f2f2f',
  '--accent-blue': '#2383e2',
};

/** The CSS minifier may shorten #ffffff to #fff, so values are compared in expanded form. */
function expandHex(value: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : value;
}

const readTokens = (keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, getComputedStyle(document.documentElement).getPropertyValue(key).trim().toLowerCase()]));

function normalized(tokens: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tokens).map(([key, value]) => [key, expandHex(value)]));
}

test.describe('Notion design system', () => {
  test('light and dark tokens are exact, and the theme survives a reload', async ({ app }) => {
    await app.getByTestId('theme-toggle').click();
    let theme = await app.evaluate(() => document.documentElement.dataset.theme);
    if (theme === 'dark') {
      expect(normalized(await app.evaluate(readTokens, Object.keys(DARK)))).toEqual(DARK);
      await app.getByTestId('theme-toggle').click();
      theme = await app.evaluate(() => document.documentElement.dataset.theme);
    }
    expect(theme).toBe('light');
    expect(normalized(await app.evaluate(readTokens, Object.keys(LIGHT)))).toEqual(LIGHT);

    await app.getByTestId('theme-toggle').click();
    expect(await app.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(normalized(await app.evaluate(readTokens, Object.keys(DARK)))).toEqual(DARK);

    await app.reload();
    await app.waitForSelector('[data-testid="app-shell"]');
    expect(await app.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    expect(await app.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(25, 25, 25)');
  });

  test('typography uses Inter with the system fallback stack', async ({ app }) => {
    const family = await app.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family).toContain('Inter');
    for (const fallback of ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif']) {
      expect(family).toContain(fallback);
    }
    await app.evaluate(() => document.fonts.ready);
    expect(await app.evaluate(() => document.fonts.check('14px "Inter Variable"'))).toBe(true);
  });

  test('action buttons are 28px, radii are subtle and cards use the specified shadow', async ({ app }) => {
    await generateDeck(app);
    const heights = await app.evaluate(() => [...document.querySelectorAll('[data-testid="topbar"] .btn')].map((button) => button.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(3);
    for (const height of heights) expect(height).toBe(28);

    const card = app.getByTestId('slide-card').first();
    const style = await card.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { radius: computed.borderRadius, shadow: computed.boxShadow, borderWidth: computed.borderTopWidth };
    });
    expect(style.radius).toBe('6px');
    expect(style.borderWidth).toBe('1px');
    expect(style.shadow).toContain('0px 1px 2px');
  });

  test('every icon is an inline 1.5px SVG and nothing is fetched from an icon API', async ({ app, mode }) => {
    const external: string[] = [];
    app.on('request', (request) => {
      const url = new URL(request.url());
      if (!['127.0.0.1', 'localhost', 'tauri.localhost', 'asset.localhost', 'ipc.localhost'].includes(url.hostname) && !['data:', 'blob:', 'tauri:', 'asset:', 'ipc:'].includes(url.protocol)) {
        external.push(request.url());
      }
    });
    await generateDeck(app);
    await app.getByTestId('open-settings').click();
    await expect(app.getByTestId('model-manager')).toBeVisible();

    const icons = await app.evaluate(() =>
      [...document.querySelectorAll('svg.iconify')].map((svg) => ({
        strokes: [...svg.querySelectorAll('[stroke-width]')].map((node) => node.getAttribute('stroke-width')),
        empty: svg.children.length === 0,
      })),
    );
    expect(icons.length).toBeGreaterThan(20);
    for (const icon of icons) {
      expect(icon.empty).toBe(false);
      for (const stroke of icon.strokes) expect(stroke).toBe('1.5');
    }
    expect(external, `no external requests in ${mode}`).toEqual([]);
  });

  test('the interface contains zero emoji across every major surface', async ({ app }) => {
    const pattern = /\p{Emoji_Presentation}|\u{FE0F}/u;
    const assertClean = async (surface: string) => {
      const text = await app.evaluate(() => document.body.innerText);
      expect(pattern.test(text), `emoji found on ${surface}`).toBe(false);
    };
    await assertClean('start');
    await generateDeck(app);
    await assertClean('deck');
    await app.getByTestId('open-settings').click();
    await expect(app.getByTestId('hardware-banner')).toBeVisible();
    await assertClean('settings');
    await app.keyboard.press('Escape');
    await app.keyboard.press('Control+Enter');
    await expect(app.getByTestId('presenter')).toBeVisible();
    await assertClean('presenter');
  });

  test('dropzones use the specified dashed border colors', async ({ app }) => {
    await app.getByTestId('script-editor').fill('Slide title\nA supporting point');
    await app.getByTestId('outline-button').click();
    const zone = app.getByTestId('dropzone').first();
    const setTheme = (theme: string) =>
      app.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
    await setTheme('light');
    await expect(zone).toHaveCSS('border-top-style', 'dashed');
    await expect(zone).toHaveCSS('border-top-color', 'rgb(211, 209, 203)');
    // The color eases over 100 ms, so these assertions poll rather than read once.
    await setTheme('dark');
    await expect(zone).toHaveCSS('border-top-color', 'rgb(55, 55, 55)');
    await zone.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
  });

  test('pins are monochrome and leader lines are a crisp 1.5px', async ({ app }) => {
    const canvas = await createImageSlide(app);
    const box = (await canvas.boundingBox())!;
    await app.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const style = await canvas.evaluate((element) => {
      const line = element.querySelector('[data-testid="leader-line"]')!;
      const pin = element.querySelector('[data-testid="pin-anchor"]')!;
      return {
        stroke: getComputedStyle(line).strokeWidth,
        vectorEffect: getComputedStyle(line).vectorEffect,
        svgPointerEvents: getComputedStyle(element.querySelector('.leader-layer')!).pointerEvents,
        pinBackground: getComputedStyle(pin).backgroundColor,
        pinText: pin.textContent,
      };
    });
    expect(style.stroke).toBe('1.5px');
    expect(style.vectorEffect).toBe('non-scaling-stroke');
    expect(style.svgPointerEvents).toBe('none');
    expect(style.pinText).toBe('1');
    const [r, g, b] = style.pinBackground.match(/\d+/g)!.map(Number) as [number, number, number];
    expect(Math.max(r, g, b) - Math.min(r, g, b), 'the badge must be neutral rather than a brand color').toBeLessThan(16);
  });
});
