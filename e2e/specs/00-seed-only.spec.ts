// Minimal: open side panel, seed, inspect. NO reload, NO send-button.
// If this fails, the seed pipeline itself is broken.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test.describe('seed only (no agent)', () => {
  test.setTimeout(20_000);
  test('seed writes a config', async () => {
    const envFile = readFileSync(resolve('.env'), 'utf-8');
    const apiKey = envFile.match(/^MINIMAX_API_KEY=(.+)$/m)?.[1]?.trim();
    if (!apiKey) throw new Error('MINIMAX_API_KEY missing from .env');

    const ext = await launchWithExtension();
    try {
      const { page: sidePanel } = await ext.openSidePanel();
      await sidePanel.waitForSelector('text=AgentSurfer');

      // Set the input + submit the message directly via the page context.
      // This avoids any UI re-render race.
      const result = await sidePanel.evaluate(
        async ({ provider, apiKey }) => {
          const cfg = {
            id: `e2e-${provider}-${Date.now()}`,
            name: `${provider} (live E2E)`,
            provider,
            modelId: 'MiniMax-M2.7-highspeed',
            apiKey,
            baseUrl: null,
            isDefault: true,
            createdAt: Date.now(),
          };
          const log: string[] = [];
          const origLog = console.log;
          console.log = (...a: unknown[]) => {
            const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
            log.push(line);
            origLog(...a);
          };
          const seed = await chrome.runtime.sendMessage({ type: '__e2e:seed-config', config: cfg });
          const inspect = await chrome.runtime.sendMessage({ type: '__e2e:inspect' });
          return { seed, inspect, log };
        },
        { provider: 'MiniMax', apiKey },
      );
      console.log('[seed result]', JSON.stringify(result, null, 2));
      expect(result.seed, 'seed returned').toBeTruthy();
      expect(result.seed.ok, 'seed ok').toBe(true);
      expect(result.inspect, 'inspect returned').toBeTruthy();
      expect(result.inspect.configs, 'inspect has configs count').toBeGreaterThan(0);
    } finally {
      await ext.cleanup();
    }
  });
});
