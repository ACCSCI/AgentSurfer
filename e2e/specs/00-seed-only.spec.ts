// Minimal: just seed and inspect. No "hi" send. If this fails, the seed
// pipeline itself is broken.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test.describe('seed only (no agent)', () => {
  test.setTimeout(20_000);
  test('seed writes a config and Dexie reports it', async () => {
    const envFile = readFileSync(resolve('.env'), 'utf-8');
    const apiKey = envFile.match(/^MINIMAX_API_KEY=(.+)$/m)?.[1]?.trim();
    if (!apiKey) throw new Error('MINIMAX_API_KEY missing from .env');

    const ext = await launchWithExtension();
    try {
      const { page: sidePanel } = await ext.openSidePanel();
      await sidePanel.waitForSelector('text=AgentSurfer');
      await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);

      // Wait a moment for Dexie to flush, then read directly.
      await new Promise((r) => setTimeout(r, 500));

      // Open options page in another tab to force Dexie to be visible.
      const dbState = await sidePanel.evaluate(async () => {
        return new Promise<{ count: number; configs: unknown[] }>((resolve, reject) => {
          const req = indexedDB.open('AgentSurferDB');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('modelConfigs', 'readonly');
            const store = tx.objectStore('modelConfigs');
            const all = store.getAll();
            all.onsuccess = () => {
              db.close();
              resolve({ count: all.result.length, configs: all.result });
            };
            all.onerror = () => reject(all.error);
          };
          req.onerror = () => reject(req.error);
        });
      });
      console.log('[db state]', JSON.stringify(dbState));
      expect(dbState.count, 'Dexie should have at least 1 config').toBeGreaterThan(0);
    } finally {
      await ext.cleanup();
    }
  });
});
