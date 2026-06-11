// E2E launcher: starts a persistent Chromium context with the unpacked
// extension, waits for the service worker, and returns helpers for navigating
// the side panel / options page and seeding Dexie with a test config.

import { type BrowserContext, chromium } from '@playwright/test';
import path from 'node:path';

const EXTENSION_PATH = path.resolve('.output/chrome-mv3');

export interface ExtensionHandle {
  ctx: BrowserContext;
  extId: string;
  /** Opens sidepanel.html in a new tab-like page (not actually in the side panel — Playwright can't open the real side panel UI, but it can load the sidepanel.html directly). */
  openSidePanel: () => Promise<{ page: import('@playwright/test').Page; url: string }>;
  openOptions: () => Promise<import('@playwright/test').Page>;
  seedMockConfig: (page: import('@playwright/test').Page) => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function launchWithExtension(): Promise<ExtensionHandle> {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });

  // Wait for the service worker to register. The SW URL is
  // `chrome-extension://<extId>/background.js`.
  const sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
  const swUrl = new URL(sw.url());
  const extId = swUrl.host;

  function openSidePanel() {
    const url = `chrome-extension://${extId}/sidepanel.html`;
    return ctx.newPage().then(async (page) => {
      await page.goto(url);
      return { page, url };
    });
  }

  function openOptions() {
    const url = `chrome-extension://${extId}/options.html`;
    return ctx.newPage().then(async (page) => {
      await page.goto(url);
      return page;
    });
  }

  /**
   * Seed Dexie with a `mock:happy` config and mark it as default, so the
   * agent can run without any user interaction. We do this by issuing
   * a message to the service worker, which forwards to a SW-side handler
   * that writes the config to Dexie.
   */
  async function seedMockConfig(page: import('@playwright/test').Page) {
    // Click the settings button so the user could see they're in the side panel
    await page.click('button[title="Settings"]');
    // Wait for the options page to render
    await page.waitForSelector('text=Add model configuration', { timeout: 10_000 });

    // The options form auto-fills the mock provider's defaults. Submit it.
    await page.selectOption('#provider', 'mock');
    await page.fill('#model', 'mock:happy');
    await page.fill('#key', 'mock-key-not-used');
    await page.click('button[type="submit"]');
    await page.waitForSelector('text=Saved', { timeout: 5_000 });
  }

  async function cleanup() {
    await ctx.close().catch(() => {});
  }

  return { ctx, extId, openSidePanel, openOptions, seedMockConfig, cleanup };
}
