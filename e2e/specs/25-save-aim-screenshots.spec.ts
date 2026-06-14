// Save cdpAim's returned screenshots to disk so we can visually verify
// the red crosshair landed on the search box.

import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

import { launchWithExtension } from '../fixtures/extension';

const CORE_TOOLS = [
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
  'smartScreenshot',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot',
] as const;

test('Save cdpAim screenshots to disk', async () => {
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
    await ext.enableOnlyTools(sidePanel, CORE_TOOLS);

    const bingPage = await ext.ctx.newPage();
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 1500));

    const prompt = '请用 cdpAim 在 bing 搜索框中心位置画一个红色十字。流程：1) cdpScreenshot 看页面 → 2) 计算搜索框中心 → 3) cdpAim → 4) cdpScreenshot 验证 → 5) 用 domQuery 确认搜索框位置。最多 2 轮 aim。完成后报告最终坐标。';
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    for (let i = 0; i < 30; i++) {
      const running = await ext.isAgentRunning(sidePanel).catch(() => false);
      if (!running && i > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 500));

    // Read agent steps and save every cdpAim/cdpScreenshot dataUrl to disk.
    const steps = await ext.listAgentSteps(sidePanel);
    let saved = 0;
    for (const s of steps.steps as Array<{
      stepNumber: number;
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
      toolResults: Array<{ name: string; result: unknown; isError: boolean }>;
    }>) {
      for (let i = 0; i < s.toolCalls.length; i++) {
        const tc = s.toolCalls[i];
        const tr = s.toolResults[i];
        if (!tr || tr.isError) continue;
        if (tc.name !== 'cdpAim' && tc.name !== 'cdpScreenshot') continue;
        const result = tr.result as { dataUrl?: string };
        if (!result?.dataUrl) continue;
        const base64 = result.dataUrl.split(',')[1];
        if (!base64) continue;
        const fname = `.e2e-logs/25-${tc.name}-step${s.stepNumber}-${JSON.stringify(tc.args).replace(/[^a-z0-9]/gi, '')}.png`;
        writeFileSync(fname, Buffer.from(base64, 'base64'));
        console.log(`saved ${fname}`);
        saved += 1;
      }
    }
    console.log(`\n[25] saved ${saved} screenshots to .e2e-logs/25-*.png`);

    expect(saved, 'at least one cdpAim screenshot saved').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
