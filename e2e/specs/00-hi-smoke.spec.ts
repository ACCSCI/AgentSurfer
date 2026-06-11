// E2E: minimal "hi" smoke test — proves the LLM integration still works
// after any change. Use this for fast feedback before running the full
// real-task test.
//
// Run: `bun run e2e -- e2e/specs/00-hi-smoke.spec.ts`

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test.describe('hi smoke (10s budget)', () => {
  test.setTimeout(15_000);
  test('agent replies to "hi" within 10s', async () => {
    const envFile = readFileSync(resolve('.env'), 'utf-8');
    const apiKey = envFile.match(/^MINIMAX_API_KEY=(.+)$/m)?.[1]?.trim();
    if (!apiKey) throw new Error('MINIMAX_API_KEY missing from .env');

    const ext = await launchWithExtension();
    try {
      const { page: sidePanel } = await ext.openSidePanel();
      await sidePanel.waitForSelector('text=AgentSurfer');
      await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
      await sidePanel.reload();
      await sidePanel.waitForSelector('text=MiniMax-M2.7-highspeed', { timeout: 10_000 });

      // Set value via React-friendly native setter.
      await sidePanel.locator('textarea').evaluate((el, v) => {
        const ta = el as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(ta) as object,
          'value',
        )?.set;
        if (setter) (setter as (v: string) => void).call(ta, v);
        else ta.value = v;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, 'hi');
      await sidePanel.locator('button[title="Send"]').click();

      // Wait up to 10s for ANY non-empty assistant text.
      const start = Date.now();
      let assistantText = '';
      while (Date.now() - start < 10_000) {
        const isRunning = await sidePanel
          .locator('button[title="Cancel run"]')
          .isVisible()
          .catch(() => false);
        const error = await sidePanel
          .locator('[class*="text-destructive"]')
          .first()
          .textContent()
          .catch(() => '');
        const t = await sidePanel.evaluate(() => {
          const bubbles = document.querySelectorAll('[data-testid="message-bubble"]');
          // The LAST bubble should be the assistant. Its text is the
          // concatenated content + tool labels.
          const last = bubbles[bubbles.length - 1];
          return last ? (last.textContent ?? '').trim() : '';
        });
        if (!isRunning && t.length > 5) {
          assistantText = t;
          if (error) throw new Error(`agent errored: ${error}`);
          break;
        }
        if (error) throw new Error(`agent errored: ${error}`);
        await new Promise((r) => setTimeout(r, 250));
      }

      await sidePanel.screenshot({
        path: 'test-results/00-hi-sidepanel.png',
        fullPage: true,
      });

      console.log('[hi] assistant text:', JSON.stringify(assistantText.slice(0, 200)));
      expect(assistantText.length, 'agent must produce a response').toBeGreaterThan(5);
    } finally {
      await ext.cleanup();
    }
  });
});
