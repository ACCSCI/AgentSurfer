// Minimal: send __e2e:seed-config and check response.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('SW processes __e2e:seed-config', async () => {
  const envFile = readFileSync(resolve('.env'), 'utf-8');
  const apiKey = envFile.match(/^MINIMAX_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!apiKey) throw new Error('MINIMAX_API_KEY missing');

  const ext = await launchWithExtension();
  try {
    const { page: sp } = await ext.openSidePanel();
    await sp.waitForSelector('text=AgentSurfer');

    // Wait extra time for SW to fully initialize.
    await new Promise((r) => setTimeout(r, 3000));

    // Send the seed config and wait for response.
    const result = await sp.evaluate(
      async ({ provider, apiKey }) => {
        const cfg = {
          id: `e2e-${provider}-${Date.now()}`,
          name: `${provider} (E2E)`,
          provider,
          modelId: 'MiniMax-M3',
          apiKey,
          baseUrl: null,
          isDefault: true,
          createdAt: Date.now(),
        };
        try {
          const res = await chrome.runtime.sendMessage({
            type: '__e2e:seed-config',
            config: cfg,
          });
          return { ok: true, res };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
      { provider: 'MiniMax', apiKey },
    );

    console.log('[seed result]', JSON.stringify(result));
    expect(result.ok).toBe(true);
    expect(result.res?.ok).toBe(true);
  } finally {
    await ext.cleanup();
  }
});
