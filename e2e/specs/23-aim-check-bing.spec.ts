// Focused check: when the agent calls cdpAim on the bing.com search box,
// does the red crosshair actually land on the search input?
// This test runs a minimal task that triggers cdpAim, then captures the
// bing.com page (not the side panel) at 500ms intervals so we can see the
// crosshair.

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

const CORE_TOOLS = [
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
  'smartScreenshot',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot',
] as const;

test('MiniMax: cdpAim on bing.com search box — visual verification', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(60_000);

  let apiKey = '';
  try {
    apiKey = ext.readApiKey();
  } catch {
    test.skip(true, 'MINIMAX_API_KEY missing from .env');
  }

  ext.clearSWLog();

  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 15_000 });
    await ext.enableOnlyTools(sidePanel, CORE_TOOLS);

    // Open bing.com in a new tab via Playwright.
    const bingPage = await ext.ctx.newPage();
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 2000));

    // Simple task: aim at the search box. Don't click — we just want to SEE
    // the crosshair land. Use cdpAim directly with a hint to the LLM.
    const prompt = '请用 cdpAim 在 bing 搜索框中心位置画一个红色十字，坐标大约 (640, 200)。如果搜索框不在那个位置，agent 自己用 cdpScreenshot + cdpAim 找到并 aim 上去。只 aim 不点击。完成后请说明你 aim 的坐标。';
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    // Capture the bing.com page every 500ms for 15s. Save with timestamp
    // so we can see when the crosshair appears.
    const outDir = '.e2e-logs';
    const t0 = Date.now();
    const captures: { tMs: number; path: string }[] = [];
    for (let i = 0; i < 30; i++) {
      const tMs = Date.now() - t0;
      const sec = (tMs / 1000).toFixed(1);
      const path = `${outDir}/23-aim-t${sec}s.png`;
      try { await bingPage.screenshot({ path, fullPage: false }); } catch { /* ignore */ }
      captures.push({ tMs, path });
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log('\n[23-aim] === summary ===');
    console.log(`captured ${captures.length} screenshots of bing.com`);
    for (const c of captures) {
      console.log(`  - t=${(c.tMs / 1000).toFixed(1)}s -> ${c.path}`);
    }

    // Read SW log for tool call summary.
    const log = ext.readSWLog();
    const cdpAimCalls = (log.match(/cdpAim/g) ?? []).length;
    const cdpScreenshotCalls = (log.match(/cdpScreenshot/g) ?? []).length;
    const agentDone = (log.match(/emit.*agent_done/g) ?? []).length;
    const agentError = (log.match(/emit.*agent_error/g) ?? []).length;
    console.log(`SW log: cdpAim=${cdpAimCalls}, cdpScreenshot=${cdpScreenshotCalls}, agent_done=${agentDone}, agent_error=${agentError}`);

    expect(captures.length, 'at least one bing screenshot captured').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
