// Minimal aim test on a pre-loaded Bing page.
// Goal: verify the DevTools overlay crosshair (1) is drawn on the page
// and (2) is captured in the screenshot dataUrl returned to the LLM.
//
// Why minimal: previous full-chain tests opened blank pages, so we
// couldn't tell whether the visual feedback system was broken or the
// LLM just never got the page loaded.

import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

import { launchWithExtension } from '../fixtures/extension';

const TOOLS = [
  'tabsList', 'tabsSwitch',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot',
] as const;

test('Simple aim: LLM aims at Bing search box, we verify crosshair in screenshot', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(90_000);

  let apiKey = '';
  try { apiKey = ext.readApiKey(); } catch { test.skip(true, 'MINIMAX_API_KEY missing'); }

  ext.clearSWLog();

  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M2.7-highspeed', { timeout: 15_000 });
    await ext.enableOnlyTools(sidePanel, TOOLS);

    // Pre-open bing.com in a Playwright page. The LLM will see it via
    // tabsList + tabsSwitch (no need to navigate).
    const bingPage = await ext.ctx.newPage();
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    // Give the page a long time to fully render (logo, search box, etc.).
    await new Promise((r) => setTimeout(r, 3000));

    // The test prompt: do EXACTLY ONE aim at the search box. Don't
    // iterate, don't type, don't click. Just aim.
    const prompt = '先 tabsList 找到 bing 标签，tabsSwitch 到它，然后 cdpScreenshot 看一下页面。' +
      '白色带放大镜图标的搜索框在页面中上部。' +
      '请只用一次 cdpAim 瞄准搜索框中心，参数 x≈640 y≈200（CSS 像素），size 用 80（足够大才能在截图里看见），color 用 red（在白底上对比最明显）。' +
      '**不要** cdpConfirm，**不要** cdpType，**不要**再 aim 第二次。只调一次 cdpAim 然后告诉我你 aim 到的坐标。';
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    for (let i = 0; i < 60; i++) {
      const running = await ext.isAgentRunning(sidePanel).catch(() => false);
      if (!running && i > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 500));

    // Read conversation.
    const steps = await ext.listAgentSteps(sidePanel);
    console.log('\n========================================');
    console.log('SIMPLE AIM RESULT');
    console.log('========================================\n');
    for (const s of steps.steps as Array<{
      stepNumber: number; text: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
      toolResults: Array<{ name: string; isError: boolean; result: unknown }>;
    }>) {
      console.log(`\n[STEP ${s.stepNumber}]`);
      if (s.text) console.log(`  LLM: ${s.text.slice(0, 200)}`);
      for (let i = 0; i < s.toolCalls.length; i++) {
        const tc = s.toolCalls[i];
        const tr = s.toolResults[i];
        const r = tr?.result as Record<string, unknown>;
        if (tc.name === 'cdpAim' && r && 'dataUrl' in r) {
          // Save the cdpAim screenshots for visual verification.
          const aimXY = `x${r.aimX}y${r.aimY}`;
          const afterPath = `.e2e-logs/28-cdpAim-AFTER-${aimXY}.png`;
          writeFileSync(afterPath, Buffer.from(String(r.dataUrl).split(',')[1] ?? '', 'base64'));
          console.log(`  → ${tc.name}(${JSON.stringify(tc.args).slice(0, 80)}) → saved AFTER: ${afterPath}`);
          if (r.beforeDataUrl) {
            const beforePath = `.e2e-logs/28-cdpAim-BEFORE-${aimXY}.png`;
            writeFileSync(beforePath, Buffer.from(String(r.beforeDataUrl).split(',')[1] ?? '', 'base64'));
            console.log(`    saved BEFORE: ${beforePath}`);
          }
        } else {
          const summary = r ? Object.keys(r).slice(0, 3).join(',') : 'null';
          console.log(`  → ${tc.name}(${JSON.stringify(tc.args).slice(0, 80)}) → ${tr?.isError ? 'ERROR' : 'ok'} (${summary})`);
        }
      }
    }

    expect(steps.count, 'at least one step').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
