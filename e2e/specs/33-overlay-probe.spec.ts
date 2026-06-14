// Pure diagnostic: invoke __e2e:overlay-probe which draws
// Overlay.highlightQuad at 5 known CSS points on Bing, captures a
// screenshot at each, and returns tabInfo + Page.getLayoutMetrics +
// shots[]. This spec saves each dataUrl to .e2e-logs/33-probe-x{x}y{y}.png
// and uses an inlined pngjs analyzer to print a requested-vs-actual
// comparison table.
//
// No production tool, prompt, or fallback is modified. No LLM is
// called. Goal: locate the coordinate transform that makes the
// crosshair land in the bottom-right instead of where the LLM asked.

import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import { launchWithExtension } from '../fixtures/extension';
import { traceStart, traceEnd, traceFail, traceReset, traceSnapshot } from '../fixtures/trace';

test('Overlay probe: highlightQuad at 5 known points', async () => {
  traceReset();
  const ext = await launchWithExtension();
  test.setTimeout(60_000);

  try {
    traceStart('7 open side panel');
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    traceEnd('7 open side panel');

    traceStart('8 open local probe target tab');
    const probePage = await ext.ctx.newPage();
    await probePage.goto('http://localhost:8888/index.html', { waitUntil: 'domcontentloaded' });
    // Static page — no remote resources, no JS-induced layout shifts.
    // 200ms is enough for first paint.
    await new Promise((r) => setTimeout(r, 200));
    traceEnd('8 open local probe target tab');

    traceStart('9 inspect tabs');
    const tabs = await ext.inspectTabs(sidePanel);
    const probeIdx = tabs.urls.findIndex((u) => u.includes('localhost:8888'));
    const targetTabId = tabs.ids[probeIdx];
    if (!targetTabId) throw new Error('localhost:8888 tab not found');
    traceEnd('9 inspect tabs', { targetTabId });

    traceStart('10 send __e2e:overlay-probe');
    const result = await sidePanel.evaluate(async (tabId) => {
      return await new Promise<unknown>((resolve, reject) => {
        const port = chrome.runtime.connect({ name: 'e2e-diag' });
        const timeout = setTimeout(() => reject(new Error('port timeout')), 30000);
        port.onMessage.addListener(function handler(response) {
          clearTimeout(timeout);
          port.disconnect();
          if (!response?.ok) reject(new Error(response?.error ?? 'unknown'));
          else resolve(response.data);
        });
        port.postMessage({ type: '__e2e:overlay-probe', tabId });
      });
    }, targetTabId) as {
      tabInfo?: chrome.tabs.Tab | { error?: string };
      layoutMetrics?: Record<string, unknown> | { error?: string };
      shots?: Array<{
        requested: { x: number; y: number; size: number };
        params: { quad: number[]; color: object; outlineColor: object };
        dataUrl?: string;
        sizeKB?: number;
        error?: string;
      }>;
    };
    traceEnd('10 send __e2e:overlay-probe', { shotCount: result.shots?.length ?? 0 });

    console.log('\n========================================');
    console.log('OVERLAY PROBE — PURE DIAGNOSTIC');
    console.log('========================================\n');

    // --- tabInfo (what cdpAim uses for width/height/dpr) ---
    console.log('--- chrome.tabs.get (what cdpAim uses) ---');
    console.log(JSON.stringify(result.tabInfo, null, 2));

    // --- Page.getLayoutMetrics (CDP source of truth) ---
    console.log('\n--- Page.getLayoutMetrics (CDP truth) ---');
    console.log(JSON.stringify(result.layoutMetrics, null, 2));

    // --- dpr / viewport comparison ---
    const tabInfo = result.tabInfo as { width?: number; height?: number } | undefined;
    const lm = result.layoutMetrics as {
      layoutViewport?: { clientWidth: number; clientHeight: number };
      visualViewport?: { clientWidth: number; clientHeight: number; offsetX: number; offsetY: number; scale: number };
      cssLayoutViewport?: { clientWidth: number; clientHeight: number };
      cssVisualViewport?: { clientWidth: number; clientHeight: number; scale: number };
    } | undefined;
    const firstShot = result.shots?.[0];
    const firstShotPng = firstShot?.dataUrl
      ? PNG.sync.read(Buffer.from(firstShot.dataUrl.split(',')[1] ?? '', 'base64'))
      : null;
    const screenshotW = firstShotPng?.width;
    const screenshotH = firstShotPng?.height;

    console.log('\n--- Coordinate system comparison ---');
    console.log(`tab.width / tab.height         : ${tabInfo?.width} x ${tabInfo?.height}  (CSS px, from chrome.tabs.get)`);
    console.log(`layoutViewport.clientW/H       : ${lm?.layoutViewport?.clientWidth} x ${lm?.layoutViewport?.clientHeight}  (CSS px, CDP)`);
    console.log(`visualViewport.clientW/H       : ${lm?.visualViewport?.clientWidth} x ${lm?.visualViewport?.clientHeight}  (CSS px, CDP)`);
    console.log(`visualViewport.offsetX / offsetY: ${lm?.visualViewport?.offsetX} / ${lm?.visualViewport?.offsetY}  (CSS px)`);
    console.log(`visualViewport.scale           : ${lm?.visualViewport?.scale}`);
    console.log(`screenshot PNG dimensions      : ${screenshotW} x ${screenshotH}  (device px)`);
    if (screenshotW && tabInfo?.width) {
      console.log(`dpr = screenshotW / tab.width  : ${(screenshotW / tabInfo.width).toFixed(4)}`);
    }
    if (screenshotW && lm?.layoutViewport?.clientWidth) {
      console.log(`dpr = screenshotW / layoutVW   : ${(screenshotW / lm.layoutViewport.clientWidth).toFixed(4)}`);
    }
    if (screenshotW && lm?.visualViewport?.clientWidth) {
      console.log(`dpr = screenshotW / visualVW   : ${(screenshotW / lm.visualViewport.clientWidth).toFixed(4)}`);
    }

    // --- Save PNGs + analyze each ---
    console.log('\n--- Requested vs Actual (per shot) ---');

    type Row = {
      requested: { x: number; y: number; size: number };
      actual: { x: number; y: number; size: number } | null;
      offsetImage: { dx: number; dy: number } | null;
      offsetCss: { dx: number; dy: number } | null;
    };
    const rows: Row[] = [];

    for (const shot of result.shots ?? []) {
      if (!shot.dataUrl) {
        console.log(`  (${shot.requested.x},${shot.requested.y}) size=${shot.requested.size}  ERROR: ${shot.error ?? 'no dataUrl'}`);
        rows.push({ requested: shot.requested, actual: null, offsetImage: null, offsetCss: null });
        continue;
      }
      const base64 = shot.dataUrl.split(',')[1] ?? '';
      const fname = `.e2e-logs/33-probe-x${shot.requested.x}y${shot.requested.y}.png`;
      writeFileSync(fname, Buffer.from(base64, 'base64'));

      const png = PNG.sync.read(Buffer.from(base64, 'base64'));
      // We need the dpr to size the search window. Use the same formula
      // as cdp.ts (screenshotW / tab.width) and fall back to layoutVP.
      const dpr = (() => {
        if (tabInfo?.width && tabInfo.width > 0) return png.width / tabInfo.width;
        if (lm?.layoutViewport?.clientWidth) return png.width / lm.layoutViewport.clientWidth;
        return 2;
      })();
      const actual = analyzeRedBox(png, shot.requested.size, dpr);
      const expectedImgX = shot.requested.x * dpr;
      const expectedImgY = shot.requested.y * dpr;
      const offsetImage = actual ? { dx: actual.x - expectedImgX, dy: actual.y - expectedImgY } : null;
      const offsetCss = offsetImage ? { dx: offsetImage.dx / dpr, dy: offsetImage.dy / dpr } : null;
      rows.push({ requested: shot.requested, actual, offsetImage, offsetCss });
    }

    // Compute dpr from the first successful shot's PNG dimensions,
    // using the SAME formula as lib/tools.ts:583 (cdpAim).
    const dpr = firstShotPng && tabInfo?.width && tabInfo.width > 0
      ? firstShotPng.width / tabInfo.width
      : 2;

    // Print markdown-ish table
    console.log('\n| req (CSS)    | req (img)       | actual (img)    | actual (CSS)    | offset (img)    | offset (CSS)    |');
    console.log('|--------------|-----------------|-----------------|-----------------|-----------------|-----------------|');
    for (const r of rows) {
      const reqX = r.requested.x, reqY = r.requested.y;
      const expImgX = reqX * dpr;
      const expImgY = reqY * dpr;
      if (!r.actual) {
        console.log(`| (${pad(reqX)},${pad(reqY)})  | (${pad(expImgX)},${pad(expImgY)})       | —               | —               | —               | —               |`);
        continue;
      }
      const actCssX = r.actual.x / dpr;
      const actCssY = r.actual.y / dpr;
      const oImg = r.offsetImage!;
      const oCss = r.offsetCss!;
      console.log(`| (${pad(reqX)},${pad(reqY)})  | (${pad(expImgX)},${pad(expImgY)})       | (${pad(r.actual.x)},${pad(r.actual.y)})       | (${pad(actCssX, 1)},${pad(actCssY, 1)})   | (${signed(oImg.dx)}, ${signed(oImg.dy)})  | (${signed(oCss.dx, 1)}, ${signed(oCss.dy, 1)})  |`);
    }

    console.log('\nSaved 5 PNGs to .e2e-logs/33-probe-x{x}y{y}.png');
    expect(result.shots?.length).toBe(5);
  } catch (err) {
    traceFail('test', err, { snapshot: traceSnapshot() });
    throw err;
  } finally {
    await ext.cleanup();
  }
});

// --- helpers ---

/**
 * Find the densest red region of size `expectedSizeCss * dpr` in the
 * given PNG. Mirrors the analyzer I ran in .e2e-logs/analyze31.cjs.
 * Returns image-space coordinates.
 */
function analyzeRedBox(png: PNG, expectedSizeCss: number, dpr: number): { x: number; y: number; size: number } | null {
  const W = png.width, H = png.height;
  const expectedImgSize = Math.round(expectedSizeCss * dpr);
  const step = 4;
  const halfBox = Math.floor(expectedImgSize / 2 / step);
  const cols = Math.floor(W / step), rows = Math.floor(H / step);
  if (halfBox <= 0 || cols <= 2 * halfBox || rows <= 2 * halfBox) return null;

  const red = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = ((y * step) * W + (x * step)) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      // "More red than not": R clearly higher than both G and B.
      if (r > 200 && r > g * 1.5 && r > b * 1.5 && r - Math.max(g, b) > 50) {
        red[y * cols + x] = 1;
      }
    }
  }
  let bestSum = 0, bestX = 0, bestY = 0;
  for (let y = halfBox; y < rows - halfBox; y++) {
    for (let x = halfBox; x < cols - halfBox; x++) {
      let s = 0;
      for (let dy = -halfBox; dy <= halfBox; dy++) {
        for (let dx = -halfBox; dx <= halfBox; dx++) {
          s += red[(y + dy) * cols + (x + dx)];
        }
      }
      if (s > bestSum) { bestSum = s; bestX = x; bestY = y; }
    }
  }
  if (bestSum === 0) return null;
  return { x: bestX * step, y: bestY * step, size: expectedImgSize };
}

function pad(n: number, decimals = 0): string {
  if (decimals > 0) return n.toFixed(decimals);
  return String(Math.round(n));
}

function signed(n: number, decimals = 0): string {
  if (decimals > 0) return (n >= 0 ? '+' : '') + n.toFixed(decimals);
  return (n >= 0 ? '+' : '') + Math.round(n);
}
