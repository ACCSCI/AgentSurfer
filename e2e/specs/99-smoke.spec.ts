// Quick smoke: seed MiniMax config, send "hi", expect reply within 10s.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('seed + hi reply', async () => {
  const envFile = readFileSync(resolve('.env'), 'utf-8');
  const apiKey = envFile.match(/^MINIMAX_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!apiKey) throw new Error('MINIMAX_API_KEY missing');

  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer', { timeout: 10_000 });
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M2.7-highspeed', { timeout: 5_000 });

    // Type "hi" and send.
    await sidePanel.locator('textarea').fill('hi');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait up to 10s for any assistant text to appear.
    const start = Date.now();
    let ok = false;
    while (Date.now() - start < 10_000) {
      const text = await sidePanel.evaluate(() => {
        const bubbles = document.querySelectorAll('[data-testid="message-bubble"]');
        const last = bubbles[bubbles.length - 1];
        return last ? (last.textContent ?? '').trim() : '';
      });
      if (text.length > 5) { ok = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(ok, 'agent should reply within 10s').toBe(true);
  } finally {
    await ext.cleanup();
  }
});
