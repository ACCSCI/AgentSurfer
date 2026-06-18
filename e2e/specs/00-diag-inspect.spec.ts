// Diagnostic: test __e2e:inspect via port-based communication
import { test, expect } from '@playwright/test';
import { launchWithExtension } from '../fixtures/extension';

test('diagnostic: __e2e:inspect via port', async () => {
  const ext = await launchWithExtension();
  try {
    const { page } = await ext.openSidePanel();
    await page.waitForSelector('text=AgentSurfer');

    // Seed a config
    const seedResult = await page.evaluate(async () => {
      const r = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: '__e2e:seed-config',
          config: {
            id: 'port-diag-1',
            name: 'PortDiag',
            provider: 'MiniMax',
            modelId: 'MiniMax-M3',
            apiKey: 'test-key',
            baseUrl: null,
            isDefault: true,
            createdAt: Date.now(),
          },
        }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      });
      return r;
    });
    console.log('[diag] seed result:', JSON.stringify(seedResult));

    await page.waitForTimeout(500);

    // Use connect port for inspect
    const inspectResult = await page.evaluate(async () => {
      const port = chrome.runtime.connect({ name: 'e2e-diag' });
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('port timeout')), 10000);
        port.onMessage.addListener(function handler(msg) {
          clearTimeout(timeout);
          port.disconnect();
          resolve(msg);
        });
        port.postMessage({ type: '__e2e:inspect' });
      });
      return result;
    });
    console.log('[diag] inspect result:', JSON.stringify(inspectResult));

    expect(inspectResult.ok, 'inspect ok').toBe(true);
    expect(inspectResult.data.configs.length, 'inspect has configs').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
