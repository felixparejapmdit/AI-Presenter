import { deflateSync } from 'node:zlib';
import type { Locator, Page } from '@playwright/test';
import { expect, mock, type Mode } from './fixtures';

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A real PNG with a colored grid, built in memory so no binary fixtures are needed. */
export function makePng(width: number, height: number, rgb: [number, number, number] = [208, 224, 240]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);

  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * row;
    raw[start] = 0;
    for (let x = 0; x < width; x += 1) {
      const onGrid = x % 80 < 2 || y % 80 < 2;
      raw[start + 1 + x * 3] = onGrid ? 170 : rgb[0];
      raw[start + 2 + x * 3] = onGrid ? 190 : rgb[1];
      raw[start + 3 + x * 3] = onGrid ? 210 : rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const SAMPLE_SCRIPT = 'Revenue grew a lot this quarter and churn went down.\n\nCompare the old checkout with the new checkout.';

/** Waits until the daemon is seen and a model is selected, which the AI actions need. */
export async function waitForModels(page: Page) {
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-ollama-online', 'true');
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-text-model', 'llama3.2:3b');
}

export async function generateDeck(page: Page) {
  await waitForModels(page);
  await page.getByTestId('script-editor').fill(SAMPLE_SCRIPT);
  await page.getByTestId('analyze-button').click();
  await expect(page.getByTestId('slide-card')).toHaveCount(4, { timeout: 20_000 });
}

/** Builds a one-image slide without AI, as the starting point for annotation tests. */
export async function createImageSlide(page: Page, size: [number, number] = [1600, 900]): Promise<Locator> {
  await page.getByTestId('script-editor').fill('Dashboard review\nConversion improved');
  await page.getByTestId('outline-button').click();
  await expect(page.getByTestId('slide-card')).toHaveCount(1);
  const zone = page.getByTestId('dropzone').first();
  await dropImage(page, zone, makePng(size[0], size[1]));
  await expect(page.getByTestId('annotated-canvas').first().locator('img')).toHaveJSProperty('complete', true);
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('[data-testid="annotated-canvas"] img');
    return Boolean(image && image.complete && image.naturalWidth > 0);
  });
  return page.getByTestId('annotated-canvas').first();
}

/** Dispatches a genuine HTML5 file drop, which is what the OS sends to the webview. */
export async function dropImage(page: Page, target: Locator, png: Buffer, name = 'dashboard.png') {
  const transfer = await page.evaluateHandle(
    ({ base64, fileName }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], fileName, { type: 'image/png' }));
      return data;
    },
    { base64: png.toString('base64'), fileName: name },
  );
  await target.dispatchEvent('dragenter', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await target.dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
}

/** Moves in steps so pointer capture, drag thresholds and frame batching all run. */
export async function dragBy(page: Page, locator: Locator, dx: number, dy: number, steps = 12) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Nothing to drag');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps });
  await page.mouse.up();
}

export interface LineGeometry {
  anchor: { x: number; y: number };
  end: { x: number; y: number };
  card: { left: number; top: number; right: number; bottom: number };
  canvas: { left: number; top: number; width: number; height: number };
  pathData: string;
}

/** Reads a leader line back from the DOM, converted from viewBox units to screen pixels. */
export async function readLine(canvas: Locator, index = 0): Promise<LineGeometry> {
  return canvas.evaluate((element, position) => {
    const rect = element.getBoundingClientRect();
    const path = element.querySelectorAll('[data-testid="leader-line"]')[position] as SVGPathElement;
    const data = path.getAttribute('d') ?? '';
    const numbers = [...data.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    const toScreen = (x: number, y: number) => ({ x: rect.left + (x / 100) * rect.width, y: rect.top + (y / 100) * rect.height });
    const card = element.querySelectorAll('[data-testid="callout-card"]')[position]!.getBoundingClientRect();
    return {
      anchor: toScreen(numbers[0]!, numbers[1]!),
      end: toScreen(numbers[numbers.length - 2]!, numbers[numbers.length - 1]!),
      card: { left: card.left, top: card.top, right: card.right, bottom: card.bottom },
      canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      pathData: data,
    };
  }, index);
}

export function isDesktop(mode: Mode): boolean {
  return mode !== 'web';
}

export async function resetMock() {
  await mock.reset();
}
