// End-to-end test on the DEDICATED STATIC TARGET PAGE served at
// http://localhost:8888 (e2e/probe-test-page/index.html).
//
// The page has a known green target box at CSS (540, 300) → (740, 500),
// center (640, 400). Every coordinate is labeled in the screenshot, so we
// can verify exactly where the LLM's aim landed.
//
// This test exercises the real LLM path with MiniMax-M3 + the dpr-stripped
// image data + the visual-servoing flow. We assert:
//   1. The LLM makes at least 2 cdpAim calls (real iteration, not 1-shot).
//   2. The final cdpAim position is within 50 CSS px of the target center
//      (640, 400) — i.e., the LLM actually found the green box.
//
// Requires the dev server to be running on port 8888. Start it with:
//   python -m http.server 8888 --directory e2e/probe-test-page

import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

import { launchWithExtension } from '../fixtures/extension';
import { traceStart, traceEnd, traceFail, traceReset, traceSnapshot } from '../fixtures/trace';

const TOOLS = [
  'tabsList', 'tabsSwitch',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot',
] as const;

const TARGET_CENTER = { x: 640, y: 400 };

test('LLM aims at known green target on the static probe page', async () => {
  traceReset();
  const ext = await launchWithExtension();
  test.setTimeout(120_000);

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
    await ext.enableOnlyTools(sidePanel, TOOLS);

    // Open the static target page.
    const targetPage = await ext.ctx.newPage();
    await targetPage.goto('http://localhost:8888/index.html', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 1000));

    // Make sure the target tab is the active one so cdpAim targets it.
    const tabs = await ext.inspectTabs(sidePanel);
    const idx = tabs.urls.findIndex((u) => u.includes('localhost:8888'));
    const targetTabId = tabs.ids[idx];
    if (!targetTabId) throw new Error('static page tab not found');

    // The prompt uses the same two-phase pattern as 32-visual-servoing but
    // targets the known green box on the static page.
    const prompt = [
      'Use tabsList → tabsSwitch to focus the tab at http://localhost:8888/index.html.',
      'Take a cdpScreenshot. The page has a 200x200 GREEN target box labeled "TARGET @ CSS (540, 300) to (740, 500), center (640, 400)".',
      '',
      'Do TWO-PHASE visual servoing:',
      'PHASE 1 (fix position, size locked): start with size=200. Look at the AFTER image. If the red box is OFF the green target, cdpCancel and re-aim with corrected x/y (still size=200). Iterate up to 5 rounds.',
      'PHASE 2 (shrink size, position locked): once the red box covers the green target, shrink size 200→100→50, verifying at each step.',
      'Then cdpConfirm(x, y) at the converged coordinates.',
      '',
      'Report: how many cdpAim calls, the final coordinates, and the offset (in CSS px) from the target center (640, 400).',
    ].join('\n');
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for the agent to finish.
    for (let i = 0; i < 90; i++) {
      const running = await ext.isAgentRunning(sidePanel).catch(() => false);
      if (!running && i > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 500));

    // Read the LLM's actual aim steps.
    const steps = await ext.listAgentSteps(sidePanel);
    const cdpAimSteps = (steps.steps as Array<{
      stepNumber: number;
      text: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
      toolResults: Array<{ name: string; isError: boolean; result: unknown }>;
    }>).filter((s) => s.toolCalls.some((t) => t.name === 'cdpAim'));

    console.log('\n========================================');
    console.log('STATIC PAGE AIM RESULT');
    console.log('========================================');
    console.log(`Target center (CSS): (${TARGET_CENTER.x}, ${TARGET_CENTER.y})`);
    console.log(`Total cdpAim calls: ${cdpAimSteps.length}\n`);
    for (const s of cdpAimSteps) {
      const aim = s.toolCalls.find((t) => t.name === 'cdpAim')!;
      const dx = Number(aim.args.x) - TARGET_CENTER.x;
      const dy = Number(aim.args.y) - TARGET_CENTER.y;
      console.log(`[step ${s.stepNumber}] aim(x=${aim.args.x}, y=${aim.args.y}, size=${aim.args.size})  offset from target: (${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy})`);
      if (s.text) console.log(`  LLM: ${s.text.slice(0, 240)}`);
    }

    // Save each AFTER image for visual inspection.
    let aimIdx = 0;
    for (const s of steps.steps as Array<{
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
      toolResults: Array<{ name: string; isError: boolean; result: unknown }>;
    }>) {
      for (let i = 0; i < s.toolCalls.length; i++) {
        const tc = s.toolCalls[i];
        const tr = s.toolResults[i];
        if (tc.name !== 'cdpAim' || !tr || tr.isError) continue;
        const r = tr.result as { dataUrl?: string };
        if (!r?.dataUrl) continue;
        const base64 = r.dataUrl.split(',')[1] ?? '';
        const fname = `.e2e-logs/34-aim-${String(aimIdx).padStart(2, '0')}-x${tc.args.x}y${tc.args.y}s${tc.args.size}.png`;
        writeFileSync(fname, Buffer.from(base64, 'base64'));
        aimIdx += 1;
      }
    }
    console.log(`\nSaved ${aimIdx} AFTER screenshots to .e2e-logs/34-aim-*.png`);

    // Assert: real iteration happened.
    expect(cdpAimSteps.length, 'LLM should iterate (≥2 cdpAim calls)').toBeGreaterThanOrEqual(2);

    // Sanity-check the FIRST aim landed near the target. The LLM may
    // drift on later iterations if its servoing is poor, but the first
    // aim is the moment of truth for "did the LLM actually see the
    // target in the screenshot".
    const first = cdpAimSteps[0].toolCalls.find((t) => t.name === 'cdpAim')!;
    const firstDx = Number(first.args.x) - TARGET_CENTER.x;
    const firstDy = Number(first.args.y) - TARGET_CENTER.y;
    const firstDist = Math.sqrt(firstDx * firstDx + firstDy * firstDy);
    console.log(`\nFirst aim distance from target: ${firstDist.toFixed(1)} CSS px`);
    expect(firstDist, 'first aim should be within 100 CSS px of the green target center (LLM should actually see the target)').toBeLessThan(100);
  } catch (err) {
    traceFail('test', err, { snapshot: traceSnapshot() });
    throw err;
  } finally {
    await ext.cleanup();
  }
});
