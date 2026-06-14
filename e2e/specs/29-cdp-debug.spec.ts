// Diagnostic: dump everything about the Overlay stack so we can see
// exactly what the user sees in their browser.
// Output fields: Chrome version, attach result, Overlay.enable result,
// full Overlay.highlightQuad params + result, any Overlay.* events,
// chrome.tabs.captureVisibleTab dataUrl (saved to disk).

import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

import { launchWithExtension } from '../fixtures/extension';

test('Diagnostic: full Overlay debug output', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(60_000);

  let apiKey = '';
  try { apiKey = ext.readApiKey(); } catch { test.skip(true, 'MINIMAX_API_KEY missing'); }

  ext.clearSWLog();

  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 15_000 });

    // Open a real bing tab via Playwright (same browser context).
    const bingPage = await ext.ctx.newPage();
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 2000));

    // Get the tabId of the bing tab.
    const tabs = await ext.inspectTabs(sidePanel);
    const bingEntry = tabs.urls.findIndex((u) => u.includes('bing.com'));
    const bingTabId = tabs.ids[bingEntry];
    if (!bingTabId) throw new Error('bing tab not found');

    // Send the debug message. Aim at where the search box should be (CSS).
    const debugResult = await sidePanel.evaluate(async (tabId) => {
      return await new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'e2e-diag' });
        const timeout = setTimeout(() => reject(new Error('port timeout')), 30000);
        port.onMessage.addListener(function handler(response) {
          clearTimeout(timeout);
          port.disconnect();
          if (!response?.ok) reject(new Error(response?.error ?? 'unknown'));
          else resolve(response.data);
        });
        port.postMessage({
          type: '__e2e:cdp-debug',
          tabId,
          x: 640, y: 200, color: 'red', size: 16,
        });
      });
    }, bingTabId) as {
      chromeVersion?: string;
      manifestVersion?: string;
      initialTargets?: Array<{ tabId?: number; type?: string; attached?: boolean }>;
      attach?: { ok: boolean; error?: string };
      enableResults?: Record<string, unknown>;
      highlightCall?: { params?: unknown; llmView?: unknown };
      highlightResult?: unknown;
      overlayEvents?: Array<{ method: string; params: unknown; t: number }>;
      eventCount?: number;
      screenshot?: { dataUrl?: string; sizeKB?: number; error?: string };
    };

    console.log('\n========================================');
    console.log('CDP OVERLAY DEBUG OUTPUT');
    console.log('========================================\n');
    console.log(JSON.stringify(debugResult, null, 2));

    // Save the screenshot to disk (test runs in Node, can use fs).
    if (debugResult.screenshot?.dataUrl?.startsWith('data:image/png;base64,')) {
      const base64 = debugResult.screenshot.dataUrl.split(',')[1] ?? '';
      const fname = `.e2e-logs/29-cdp-debug-640-200.png`;
      writeFileSync(fname, Buffer.from(base64, 'base64'));
      console.log(`\n[29] saved screenshot: ${fname} (${debugResult.screenshot.sizeKB} KB)`);
    } else if (debugResult.screenshot?.error) {
      console.log(`\n[29] screenshot error: ${debugResult.screenshot.error}`);
    } else {
      console.log('\n[29] WARN: no screenshot returned');
    }

    expect(debugResult).toBeTruthy();
  } finally {
    await ext.cleanup();
  }
});
