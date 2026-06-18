import { defineConfig, devices } from '@playwright/test';

// Playwright config for AgentSurfer E2E.
// MV3 extensions REQUIRE headed Chrome, so we never use headless.
// Specs run against a real persistent context with the unpacked extension.

const PORT = 4173;
const EXTENSION_PATH = '.output/chrome-mv3';

export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: false, // MV3 + side panel + SW: keep specs serial to avoid state leaks
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium-extension',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Build the extension before running. Skipped if SKIP_BUILD=1 (dev loop).
  // Note: the E2E fixture loads files from .output/chrome-mv3/ directly —
  // no HTTP server is needed for the extension itself. The e2e/fixtures/serve.ts
  // server is started separately by tests that need it (e.g. google search).
  webServer: process.env.SKIP_BUILD
    ? undefined
    : {
        command: 'bun run build',
        // No port needed — build exits when done.
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});

export const PLAYWRIGHT_CONFIG = { PORT, EXTENSION_PATH };
