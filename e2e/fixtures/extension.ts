// E2E launcher: starts a persistent Chromium context with the unpacked
// extension, waits for the service worker, and returns helpers for navigating
// the side panel / options page and seeding Dexie with a test config.

import { type BrowserContext, chromium, type Page } from '@playwright/test';
import path from 'node:path';

const EXTENSION_PATH = path.resolve('.output/chrome-mv3');

export interface ExtensionHandle {
  ctx: BrowserContext;
  extId: string;
  sw: import('@playwright/test').Worker;
  /** Opens sidepanel.html in a new tab-like page (not actually in the side panel — Playwright can't open the real side panel UI, but it can load the sidepanel.html directly). */
  openSidePanel: () => Promise<{ page: Page; url: string }>;
  openOptions: () => Promise<Page>;
  seedMockConfig: (page: Page) => Promise<void>;
  seedLiveConfig: (page: Page, provider: 'MiniMax' | 'mimo', apiKey: string) => Promise<void>;
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

  // Forward SW console + network to the test runner so we can see what's
  // happening. SW pages are also Pages from Playwright's perspective.
  sw.on('console', (msg) => {
    console.log(`[SW:${msg.type()}]`, msg.text());
  });
  sw.on('request', (req) => {
    if (req.url().includes('anthropic') || req.url().includes('minimaxi') || req.url().includes('xiaomimimo')) {
      console.log(`[SW:req]`, req.method(), req.url(), JSON.stringify(req.postData()?.slice(0, 200)));
    }
  });
  sw.on('response', (res) => {
    if (res.url().includes('anthropic') || res.url().includes('minimaxi') || res.url().includes('xiaomimimo')) {
      console.log(`[SW:res]`, res.status(), res.url());
    }
  });
  sw.on('requestfailed', (req) => {
    if (req.url().includes('anthropic') || req.url().includes('minimaxi') || req.url().includes('xiaomimimo')) {
      console.log(`[SW:req-failed]`, req.url(), req.failure()?.errorText);
    }
  });

  const swUrl = new URL(sw.url());
  const extId = swUrl.host;

  function openSidePanel() {
    const url = `chrome-extension://${extId}/sidepanel.html`;
    return ctx.newPage().then(async (page) => {
      page.on('console', (msg) => {
        const t = msg.text();
        if (t.includes('[AgentSurfer]')) console.log(`[SP:console]`, t);
      });
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

  /** Seed a mock provider config via the options form. */
  async function seedMockConfig(page: Page) {
    await page.click('button[title="Settings"]');
    await page.waitForSelector('text=Add model configuration', { timeout: 10_000 });
    await page.selectOption('#provider', 'mock');
    await page.fill('#model', 'mock:happy');
    await page.fill('#key', 'mock-key-not-used');
    await page.click('button[type="submit"]');
    await page.waitForSelector('text=Saved', { timeout: 5_000 });
  }

  /**
   * Seed a live LLM config directly via the SW (bypasses the options form
   * so we don't have to type a real API key into the form). Provider-specific
   * defaults come from types/model.ts.
   */
  async function seedLiveConfig(page: Page, provider: 'MiniMax' | 'mimo', apiKey: string) {
    const configId = `e2e-${provider}-${Date.now()}`;
    await page.evaluate(
      async ({ configId, provider, apiKey }) => {
        // @ts-expect-error injected in the page context
        const cfg = {
          id: configId,
          name: `${provider} (live E2E)`,
          provider,
          modelId: provider === 'MiniMax' ? 'MiniMax-M2.7-highspeed' : 'mimo-v2.5-pro',
          apiKey,
          baseUrl: null,
          isDefault: true,
          createdAt: Date.now(),
        };
        await chrome.runtime.sendMessage({ type: '__e2e:reset' });
        await chrome.runtime.sendMessage({ type: '__e2e:seed-config', config: cfg });
      },
      { configId, provider, apiKey },
    );
  }

  async function cleanup() {
    await ctx.close().catch(() => {});
  }

  return { ctx, extId, sw, openSidePanel, openOptions, seedMockConfig, seedLiveConfig, cleanup };
}
