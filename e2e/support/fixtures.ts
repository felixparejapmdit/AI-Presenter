import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test as base, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { CDP_PORT, MOCK_OLLAMA_PORT } from '../../playwright.config';
import { desktopPids } from './native-dialog';

export const MOCK_URL = `http://127.0.0.1:${MOCK_OLLAMA_PORT}`;
export const REAL_OLLAMA_URL = 'http://127.0.0.1:11434';
const EXE_PATH = resolve('src-tauri/target/release/vanguard-deck.exe');

export type Mode = 'web' | 'tauri' | 'live';

export function modeOf(testInfo: TestInfo): Mode {
  return (testInfo.project.metadata as { mode: Mode }).mode;
}

export const mock = {
  async reset() {
    await fetch(`${MOCK_URL}/__mock/reset`, { method: 'POST' });
  },
  async set(patch: Record<string, unknown>) {
    await fetch(`${MOCK_URL}/__mock/state`, { method: 'POST', body: JSON.stringify(patch) });
  },
  async requests(): Promise<{ path: string; at?: number; body?: Record<string, any> }[]> {
    return (await fetch(`${MOCK_URL}/__mock/requests`)).json();
  },
  async chatRequests() {
    return (await this.requests()).filter((request) => request.path === '/api/chat');
  },
  async pullRequests() {
    return (await this.requests()).filter((request) => request.path === '/api/pull');
  },
};

async function waitForPortClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

function removeTempDir(path: string) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // WebView2 can hold a profile lock for a while. A leftover temp folder is harmless.
  }
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`The desktop app did not open its debugging port within ${timeoutMs} ms`);
}

export interface DesktopApp {
  process: ChildProcess;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  dataDir: string;
  close: () => Promise<void>;
}

/** Launches the real desktop executable and attaches Playwright to its WebView2. */
export async function launchDesktopApp(options: { ollamaUrl: string; dataDir?: string; profileDir?: string; keepData?: boolean }): Promise<DesktopApp> {
  if (!existsSync(EXE_PATH)) throw new Error(`Build the app first with "npm run build:exe". Missing ${EXE_PATH}`);

  const ownsData = !options.dataDir;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'vanguard-e2e-data-'));
  const ownsProfile = !options.profileDir;
  const profileDir = options.profileDir ?? mkdtempSync(join(tmpdir(), 'vanguard-e2e-profile-'));

  await waitForPortClosed(CDP_PORT, 8000);
  const child = spawn(EXE_PATH, [], {
    env: {
      ...process.env,
      VANGUARD_DATA_DIR: dataDir,
      VANGUARD_OLLAMA_URL: options.ollamaUrl,
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: 'ignore',
  });

  await waitForCdp(CDP_PORT, 30_000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0]!;
  let page = context.pages()[0];
  const deadline = Date.now() + 15_000;
  while (!page && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    page = context.pages()[0];
  }
  if (!page) throw new Error('The desktop app did not create a page');
  desktopPids.set(page, child.pid!);

  const close = async () => {
    await browser.close().catch(() => undefined);
    // WebView2 helper processes outlive the app and keep the port and profile open, so the
    // whole tree goes, and the next launch cannot attach to an instance that is shutting down.
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        // The process may have exited on its own in the meantime.
      }
    }
    await waitForPortClosed(CDP_PORT, 8000);
    if (!options.keepData) {
      if (ownsData) removeTempDir(dataDir);
      if (ownsProfile) removeTempDir(profileDir);
    }
  };

  return { process: child, browser, context, page, dataDir, close };
}

interface Fixtures {
  mode: Mode;
  app: Page;
  errors: string[];
}

/** Console noise that a test provokes on purpose, or that only a dev tool produces. */
const IGNORED_ERRORS = [/Failed to load resource/, /net::ERR_/, /Download the React DevTools/];

function trackErrors(page: Page, errors: string[]) {
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !IGNORED_ERRORS.some((pattern) => pattern.test(message.text()))) {
      errors.push(`console: ${message.text()}`);
    }
  });
}

export async function waitForApp(page: Page) {
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'visible', timeout: 30_000 });
  // The native window stays hidden until the first frame is painted. Closing it before then
  // reaches only the event loop's internal window, which no user could ever do.
  await page.waitForFunction(() => document.documentElement.dataset.windowShown === 'true', undefined, { timeout: 30_000 });
}

export const test = base.extend<Fixtures>({
  mode: async ({}, use, testInfo) => {
    await use(modeOf(testInfo));
  },
  errors: async ({}, use) => {
    await use([]);
  },
  app: async ({ browser, mode, errors }, use, testInfo) => {
    await mock.reset();

    if (mode === 'web') {
      const context = await browser.newContext({
        viewport: testInfo.project.use.viewport ?? { width: 1440, height: 900 },
        baseURL: testInfo.project.use.baseURL,
        acceptDownloads: true,
      });
      await context.addInitScript((url) => localStorage.setItem('vanguard.ollamaUrl', url), MOCK_URL);
      const page = await context.newPage();
      trackErrors(page, errors);
      await page.goto('/');
      await waitForApp(page);
      await use(page);
      await context.close();
    } else {
      const app = await launchDesktopApp({ ollamaUrl: MOCK_URL });
      try {
        trackErrors(app.page, errors);
        await waitForApp(app.page);
        await use(app.page);
      } finally {
        // Also runs after a failed start, so no app is left holding the debugging port.
        await app.close();
      }
    }

    expect(errors, 'the app must not log errors').toEqual([]);
  },
});

export { expect };
