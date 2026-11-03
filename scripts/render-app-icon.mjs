// Renders app-icon.svg to a 1024px PNG. Run `npx tauri icon app-icon.png` afterwards
// to regenerate src-tauri/icons when the artwork changes.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const svg = await readFile(new URL('../app-icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.screenshot({
  path: new URL('../app-icon.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('%20', ' '),
  omitBackground: true,
});
await browser.close();
