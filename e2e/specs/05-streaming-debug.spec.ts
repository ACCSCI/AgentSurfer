// Debug: periodic screenshots to see streaming behavior + button state.
// Sends a complex task, takes screenshots every 2s to capture:
// - Whether text appears progressively (streaming) or all-at-once
// - Whether tool calls appear in the UI
// - Whether the Send button switches to Cancel (isRunning state)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('streaming debug: periodic screenshots every 2s', async () => {
  const envFile = readFileSync(resolve('.env'), 'utf-8');
  const apiKey = envFile.match(/^MINIMAX_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!apiKey) throw new Error('MINIMAX_API_KEY missing');

  const ext = await launchWithExtension();
  try {
    const { page: sp } = await ext.openSidePanel();
    await sp.waitForSelector('text=AgentSurfer');

    // Seed MiniMax config.
    await ext.seedLiveConfig(sp, 'MiniMax', apiKey);
    await sp.reload();
    await sp.waitForSelector('text=MiniMax-M3', { timeout: 10_000 });

    // Screenshot 0: before sending.
    await sp.screenshot({ path: 'test-results/stream-0-before.png' });

    // Send a complex task.
    const prompt = '打开 https://www.bing.com 搜索 LLM，点击前三个有用链接，阅读后总结，结束后关闭标签页。';
    await sp.locator('textarea').fill(prompt);
    await sp.locator('button[title="Send"]').click();

    // Wait 500ms then start periodic screenshots.
    await new Promise((r) => setTimeout(r, 500));

    // Take screenshots every 2 seconds for 60 seconds.
    for (let i = 1; i <= 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      // Check button state.
      const stopBtn = await sp.locator('button[title="Cancel run"]').isVisible().catch(() => false);
      const sendBtn = await sp.locator('button[title="Send"]').isVisible().catch(() => false);

      // Check if there are tool call chips.
      const toolChips = await sp.locator('[class*="border-dashed"][class*="border-primary"]').count().catch(() => 0);

      // Check text length in the last message bubble.
      const textLen = await sp.evaluate(() => {
        const bubbles = document.querySelectorAll('[data-testid="message-bubble"]');
        const last = bubbles[bubbles.length - 1];
        return last ? (last.textContent ?? '').length : 0;
      });

      // Check for reasoning.
      const reasoningVisible = await sp.locator('text=/^💭/').isVisible().catch(() => false);

      await sp.screenshot({ path: `test-results/stream-${i}.png`, fullPage: true });
      console.log(`[${i * 2}s] stop=${stopBtn} send=${sendBtn} chips=${toolChips} textLen=${textLen} reasoning=${reasoningVisible}`);

      if (!stopBtn && sendBtn && textLen > 10) {
        console.log(`Agent finished at screenshot ${i} (${i * 2}s)`);
        break;
      }
    }

    // Final screenshot.
    await sp.screenshot({ path: 'test-results/stream-final.png', fullPage: true });
  } finally {
    await ext.cleanup();
  }
});
