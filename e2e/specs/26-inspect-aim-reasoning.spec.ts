// Inspect: read Dexie agentSteps to see the LLM's actual text reasoning
// during the aim task. Check if the LLM did the dpr conversion and how
// it described the search box position. Also save the cdpAim screenshots
// so we can verify where the crosshair actually landed.

import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

import { launchWithExtension } from '../fixtures/extension';

const CORE_TOOLS = [
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
  'smartScreenshot',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot',
] as const;

test('Inspect LLM aim reasoning + save screenshots', async () => {
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
    await sidePanel.waitForSelector('text=MiniMax-M2.7-highspeed', { timeout: 15_000 });
    await ext.enableOnlyTools(sidePanel, CORE_TOOLS);

    const bingPage = await ext.ctx.newPage();
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 1500));

    const prompt = '请用 cdpAim 在 bing 搜索框中心位置画一个红色十字。流程：1) cdpScreenshot 看页面 → 2) 找出搜索框中心（白色带放大镜的输入框）的截图像素坐标 → 3) 除以 dpr 得到 CSS 像素 → 4) cdpAim → 5) 仔细比较 BEFORE/AFTER 截图，如果十字不在搜索框上就 cdpCancel + 重新 aim → 6) 最多 aim 4 轮。完成后报告最终坐标。';
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    for (let i = 0; i < 60; i++) {
      const running = await ext.isAgentRunning(sidePanel).catch(() => false);
      if (!running && i > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 500));

    const steps = await ext.listAgentSteps(sidePanel);
    console.log('\n========================================');
    console.log('LLM REASONING DURING AIM');
    console.log('========================================\n');
    for (const s of steps.steps as Array<{
      stepNumber: number; text: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
      toolResults: Array<{ name: string; isError: boolean; result: unknown }>;
    }>) {
      console.log(`\n--- STEP ${s.stepNumber} ---`);
      if (s.text) console.log(`LLM text: ${s.text}`);
      // toolCalls and toolResults are parallel arrays; iterate by index.
      for (let i = 0; i < s.toolCalls.length; i++) {
        const tc = s.toolCalls[i];
        const tr = s.toolResults[i];
        console.log(`  tool_call: ${tc.name}(${JSON.stringify(tc.args)})`);
        if (!tr) continue;
        const r = tr.result as Record<string, unknown>;
        if (r && typeof r === 'object' && 'dpr' in r) {
          const { dpr, width, height, screenshotWidth, screenshotHeight, aimX, aimY, dataUrl, beforeDataUrl } = r as Record<string, unknown>;
          console.log(`  tool_result: ${tr.name} isError=${tr.isError}`);
          console.log(`    css=${width}x${height} screenshot=${screenshotWidth}x${screenshotHeight} dpr=${dpr} aimXY=(${aimX},${aimY})`);
          if (dataUrl && (tc.name === 'cdpAim' || tc.name === 'cdpScreenshot')) {
            const base64 = String(dataUrl).split(',')[1] ?? '';
            const fname = `.e2e-logs/26-${tc.name}-step${s.stepNumber}-${JSON.stringify(tc.args).replace(/[^a-z0-9]/gi, '')}.png`;
            writeFileSync(fname, Buffer.from(base64, 'base64'));
            console.log(`    saved: ${fname}`);
          }
          if (beforeDataUrl && tc.name === 'cdpAim') {
            const base64 = String(beforeDataUrl).split(',')[1] ?? '';
            const fname = `.e2e-logs/26-${tc.name}-step${s.stepNumber}-BEFORE.png`;
            writeFileSync(fname, Buffer.from(base64, 'base64'));
            console.log(`    saved: ${fname}`);
          }
        } else {
          console.log(`  tool_result: ${tr.name} isError=${tr.isError} -> ${JSON.stringify(r).slice(0, 200)}`);
        }
      }
    }

    expect(steps.count, 'at least one step').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
