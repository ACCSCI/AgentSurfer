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

      // Use Promise-based sendMessage with explicit lastError check.
      const result = await sidePanel.evaluate(
        async ({ provider, apiKey }) => {
          const cfg = {
            id: `e2e-${provider}-${Date.now()}`,
            name: `${provider} (live E2E)`,
            provider,
            modelId: 'MiniMax-M3',
            apiKey,
            baseUrl: null,
            isDefault: true,
            createdAt: Date.now(),
          };
          const seed = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: '__e2e:seed-config', config: cfg }, (response) => {
              if (chrome.runtime.lastError) reject(new Error('seed lastError: ' + chrome.runtime.lastError.message));
              else resolve(response);
            });
          });
          const inspect = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: '__e2e:inspect' }, (response) => {
              if (chrome.runtime.lastError) reject(new Error('inspect lastError: ' + chrome.runtime.lastError.message));
              else resolve(response);
            });
          });
          return { seed, inspect };
        },
        { provider: 'MiniMax', apiKey },
      );
      console.log('[seed result]', JSON.stringify(result, null, 2));
      // SW wraps responses as { ok: true, data: ... } where data is the handler result
      expect(result.seed, 'seed returned').toBeTruthy();
      expect(result.seed.ok, 'seed ok').toBe(true);
      expect(result.inspect, 'inspect returned').toBeTruthy();
      // inspect.data should be the object { configs, activeConfig, sessions, ... }
      const inspectData = (result.inspect as { data?: unknown })?.data;
      expect(inspectData, 'inspect has data').toBeTruthy();
      const configs = (inspectData as { configs?: unknown[] }).configs;
      expect(configs, 'inspect has configs count').toBeDefined();
      expect(Array.isArray(configs) ? configs.length : 0, 'inspect has configs count').toBeGreaterThan(0);
    } finally {
      await ext.cleanup();
    }
  });
});
