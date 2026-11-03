import { defineConfig } from '@playwright/test';

export const PREVIEW_PORT = 17392;
export const MOCK_OLLAMA_PORT = 17393;
export const CDP_PORT = 17394;

/**
 * Three layers, each exercising more of the real product:
 *  - web:   the production web bundle in Chromium, against the mock daemon.
 *  - tauri: the real desktop executable, driven over CDP, against the mock daemon.
 *           Exercises the Rust commands, SQLite, the asset protocol and the CSP.
 *  - live:  the real desktop executable against the real local Ollama and real models.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Tests share one mock daemon and, in desktop mode, one debugging port.
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: 'node scripts/mock-ollama.mjs',
      url: `http://127.0.0.1:${MOCK_OLLAMA_PORT}/__mock/health`,
      reuseExistingServer: true,
      stdout: 'ignore',
    },
    {
      command: 'npm run preview:web',
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: true,
      stdout: 'ignore',
    },
  ],
  projects: [
    {
      name: 'web',
      testMatch: /\.spec\.ts$/,
      testIgnore: /live\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PREVIEW_PORT}` },
      metadata: { mode: 'web' },
    },
    {
      name: 'tauri',
      testMatch: /\.spec\.ts$/,
      testIgnore: /(live|responsive)\.spec\.ts$/,
      metadata: { mode: 'tauri' },
    },
    {
      name: 'live',
      testMatch: /live\.spec\.ts$/,
      timeout: 15 * 60_000,
      metadata: { mode: 'live' },
    },
  ],
});
