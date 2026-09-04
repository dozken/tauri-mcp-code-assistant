import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const backendDir = fileURLToPath(new URL('../backend', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const APP_URL = process.env.E2E_APP_URL ?? 'http://127.0.0.1:1420';

/**
 * Escape hatch for CI images and sandboxes that ship a preinstalled Chromium
 * instead of the exact build `npx playwright install` would download.
 */
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

const chromium = {
  name: 'chromium',
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
};

/**
 * Tauri's webview *is* WebKit on macOS and Linux, so this is the only engine here
 * that matches what the shipped desktop app actually renders in — worth running
 * before a release, and the place a WebKit-only layout or API gap would show up.
 *
 * Opt-in because it needs its own browser download:
 *   npx playwright install webkit && E2E_ALL_BROWSERS=1 npm run test:e2e
 */
const webkit = { name: 'webkit', use: { ...devices['Desktop Safari'] } };

const PROJECTS = process.env.E2E_ALL_BROWSERS ? [chromium, webkit] : [chromium];

/**
 * Drives the web build of the same React app the Tauri window loads. Tauri's
 * webview is not automatable by Playwright, so the E2E suite targets the browser
 * build and the desktop shell is covered by `tauri build`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: APP_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  projects: PROJECTS,
  webServer: [
    {
      // The backend runs from dist, so build it first; `npm run build` is a no-op
      // when nothing changed.
      command: 'npm run build && node dist/main.js',
      cwd: backendDir,
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: '3001',
        HOST: '127.0.0.1',
        // Deterministic and offline: no Chroma server, no LLM, no token delay.
        CHROMA_ENABLED: 'false',
        LLM_PROVIDER: 'stub',
        STUB_TOKEN_DELAY_MS: '0',
        INDEX_ALLOWED_ROOTS: repoRoot,
        METADATA_DB: `${repoRoot}backend/.data/e2e.sqlite`,
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'npm run dev',
      url: APP_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
