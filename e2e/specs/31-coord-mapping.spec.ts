// Phase-2 diagnostic: derive the mapping between Overlay.highlightQuad
// CSS-pixel coordinates and the actual position in the captured
// screenshot. Reads every Chrome coordinate system value, draws 3
// known-position overlays, captures each, and saves them to disk for
// visual verification.

import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

import { launchWithExtension } from '../fixtures/extension';
import { traceStart, traceEnd, traceFail, traceReset, traceSnapshot } from '../fixtures/trace';

test('Coord mapping: read metrics + 3 known-position overlays', async () => {
  traceReset();
  const ext = await launchWithExtension();
  test.setTimeout(60_000);

  try {
    traceStart('7 test start (openSidePanel call)');
    const { page: sidePanel } = await ext.openSidePanel();
    traceEnd('7 test start (openSidePanel call)', { url: sidePanel.url() });

    traceStart('8 waitForSelector(AgentSurfer)');
    await sidePanel.waitForSelector('text=AgentSurfer');
    traceEnd('8 waitForSelector(AgentSurfer)');

    traceStart('9 ext.ctx.newPage (bing)');
    const bingPage = await ext.ctx.newPage();
    traceEnd('9 ext.ctx.newPage (bing)', { url: bingPage.url() });

    traceStart('10 bingPage.goto(bing.com)');
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    traceEnd('10 bingPage.goto(bing.com)', { url: bingPage.url() });

    traceStart('11 inspectTabs');
    const tabs = await ext.inspectTabs(sidePanel);
    traceEnd('11 inspectTabs', { count: tabs.count });

    const bingIdx = tabs.urls.findIndex((u) => u.includes('bing.com'));
    const bingTabId = tabs.ids[bingIdx];
    if (!bingTabId) throw new Error('bing tab not found');

    traceStart('12 send __e2e:coord-mapping (3 overlays + capture)');
    const result = await sidePanel.evaluate(async (tabId) => {
      return await new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'e2e-diag' });
        const timeout = setTimeout(() => reject(new Error('port timeout')), 30000);
        port.onMessage.addListener(function handler(response) {
          clearTimeout(timeout);
          port.disconnect();
          if (!response?.ok) reject(new Error(response?.error ?? 'unknown'));
          else resolve(response.data);
        });
        port.postMessage({ type: '__e2e:coord-mapping', tabId });
      });
    }, bingTabId) as {
      PageGetLayoutMetrics?: Record<string, unknown>;
      windowMetrics?: Record<string, unknown>;
      overlayShots?: Array<{ name: string; requestedQuad: number[]; dataUrl?: string; sizeKB?: number; error?: string }>;
    };
    traceEnd('12 send __e2e:coord-mapping (3 overlays + capture)');

    console.log('\n========================================');
    console.log('COORD MAPPING DIAGNOSTIC');
    console.log('========================================\n');
    console.log('--- Page.getLayoutMetrics (CDP) ---');
    console.log(JSON.stringify(result.PageGetLayoutMetrics, null, 2));
    console.log('\n--- window.* metrics (in-page) ---');
    console.log(JSON.stringify(result.windowMetrics, null, 2));

    console.log('\n--- 3 overlay shots ---');
    const shots = result.overlayShots ?? [];
    for (const s of shots) {
      console.log(`\n[${s.name}] requestedQuad=${JSON.stringify(s.requestedQuad)} sizeKB=${s.sizeKB ?? '?'}`);
      if (s.dataUrl?.startsWith('data:image/png;base64,')) {
        const base64 = s.dataUrl.split(',')[1] ?? '';
        const fname = `.e2e-logs/31-coord-${s.name}.png`;
        writeFileSync(fname, Buffer.from(base64, 'base64'));
        console.log(`  saved: ${fname}`);
      }
    }

    expect(shots.length).toBe(3);
  } catch (err) {
    traceFail('test', err, { snapshot: traceSnapshot() });
    throw err;
  } finally {
    await ext.cleanup();
  }
});
