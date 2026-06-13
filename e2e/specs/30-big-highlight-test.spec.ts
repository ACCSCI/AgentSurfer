// Visibility test: draw an 800x400 red box and hold for 60 seconds.
// User will manually look at the browser to see if the overlay is visible.
// Run with: bunx playwright test e2e/specs/30-big-highlight-test.spec.ts

import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

import { launchWithExtension } from '../fixtures/extension';

test('Visibility: 800x400 red box, hold 60s, no DevTools', async () => {
  const ext = await launchWithExtension();
  // 60s keepMs in the SW + buffer for build/setup/cleanup.
  test.setTimeout(180_000);

  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // Open a real Bing tab via Playwright.
    const bingPage = await ext.ctx.newPage();
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 2000));

    const tabs = await ext.inspectTabs(sidePanel);
    const bingIdx = tabs.urls.findIndex((u) => u.includes('bing.com'));
    const bingTabId = tabs.ids[bingIdx];
    if (!bingTabId) throw new Error('bing tab not found');

    console.log('\n[30] drawing 800x400 red box at (100, 100) on Bing tab, hold 60s...');
    console.log('[30] LOOK AT THE BROWSER NOW. The box should be visible on the Bing page.');

    const result = await sidePanel.evaluate(async ({ tabId }) => {
      return await new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'e2e-diag' });
        const timeout = setTimeout(() => reject(new Error('port timeout')), 90000);
        port.onMessage.addListener(function handler(response) {
          clearTimeout(timeout);
          port.disconnect();
          if (!response?.ok) reject(new Error(response?.error ?? 'unknown'));
          else resolve(response.data);
        });
        port.postMessage({
          type: '__e2e:highlight-rect',
          tabId,
          x: 100, y: 100, width: 800, height: 400,
          color: 'red', keepMs: 60000,
        });
      });
    }, { tabId: bingTabId }) as { attach?: unknown; highlightCall?: unknown; highlightResult?: unknown; screenshot?: { dataUrl?: string; error?: string } };

    console.log('\n[30] RESULT:');
    console.log('  attach:', result.attach);
    console.log('  highlightCall:', result.highlightCall);
    console.log('  highlightResult:', result.highlightResult);
    console.log('  screenshot.error:', result.screenshot?.error ?? 'none');
    if (result.screenshot?.dataUrl) {
      const base64 = result.screenshot.dataUrl.split(',')[1] ?? '';
      writeFileSync('.e2e-logs/30-big-highlight.png', Buffer.from(base64, 'base64'));
      console.log('  screenshot saved: .e2e-logs/30-big-highlight.png');
    }

    console.log('\n[30] 60 seconds elapsed. The user should have looked at the browser by now.');
    expect(result.attach).toEqual({ ok: true });
  } finally {
    await ext.cleanup();
  }
});
