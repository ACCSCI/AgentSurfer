// Minimal smoke: seed config, send "hi", expect reply within 10s.
// Writes directly to IndexedDB in the side panel's context (not via SW).

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
    const { page: sp } = await ext.openSidePanel();
    await sp.waitForSelector('text=AgentSurfer', { timeout: 10_000 });

    // Seed config DIRECTLY in side panel's IndexedDB (same connection as Dexie).
    const seeded = await sp.evaluate(async ({ provider, apiKey }) => {
      const cfg = {
        id: `e2e-${provider}-${Date.now()}`,
        name: `${provider} (E2E)`,
        provider,
        modelId: 'MiniMax-M2.7-highspeed',
        apiKey,
        baseUrl: null,
        isDefault: true,
        createdAt: Date.now(),
      };
      const open = () => new Promise<IDBDatabase>((r, j) => {
        const q = indexedDB.open('AgentSurferDB');
        q.onsuccess = () => r(q.result);
        q.onerror = () => j(q.error);
      });
      // Write config.
      const db1 = await open();
      await new Promise<void>((res, rej) => {
        const tx = db1.transaction('modelConfigs', 'readwrite');
        tx.objectStore('modelConfigs').put(cfg);
        tx.oncomplete = () => { db1.close(); res(); };
        tx.onerror = () => { db1.close(); rej(tx.error); };
      });
      // Clear other defaults.
      const db2 = await open();
      await new Promise<void>((res, rej) => {
        const tx = db2.transaction('modelConfigs', 'readwrite');
        const store = tx.objectStore('modelConfigs');
        const all = store.getAll();
        all.onsuccess = () => {
          for (const c of all.result) {
            if (c.id !== cfg.id && c.isDefault) {
              c.isDefault = false;
              store.put(c);
            }
          }
          tx.oncomplete = () => { db2.close(); res(); };
          tx.onerror = () => { db2.close(); rej(tx.error); };
        };
        all.onerror = () => { db2.close(); rej(all.error); };
      });
      // Verify.
      const db3 = await open();
      const count = await new Promise<number>((res, rej) => {
        const tx = db3.transaction('modelConfigs', 'readonly');
        const q = tx.objectStore('modelConfigs').count();
        q.onsuccess = () => { db3.close(); res(q.result); };
        q.onerror = () => { db3.close(); rej(q.error); };
      });
      return count;
    }, { provider: 'MiniMax', apiKey });
    console.log('[seed] configs in Dexie:', seeded);
    expect(seeded).toBeGreaterThan(0);

    // Wait for useLiveQuery to pick up the change.
    await new Promise((r) => setTimeout(r, 1000));

    // Type "hi" and send.
    await sp.locator('textarea').fill('hi');
    await sp.locator('button[title="Send"]').click();

    // Wait up to 10s for any assistant text to appear.
    const start = Date.now();
    let ok = false;
    while (Date.now() - start < 10_000) {
      const text = await sp.evaluate(() => {
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
