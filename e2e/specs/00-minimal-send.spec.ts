// Most minimal: open side panel, send a test message, see if SW responds.

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('SW responds to a basic message', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // Use port-based communication (reliable in MV3).
    const result = await sidePanel.evaluate(async () => {
      const port = chrome.runtime.connect({ name: 'e2e-diag' });
      const r = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('port timeout')), 10000);
        port.onMessage.addListener(function handler(response) {
          clearTimeout(timeout);
          port.disconnect();
          resolve(response);
        });
        port.postMessage({ type: 'agent:list' });
      });
      return r;
    });
    console.log('[result]', JSON.stringify(result));
    expect(result).toBeTruthy();
    expect(result.ok, 'response ok').toBe(true);
    expect(result.data, 'response has data').toBeTruthy();
    expect(result.data.sessions, 'response has sessions').toBeDefined();
  } finally {
    await ext.cleanup();
  }
});
