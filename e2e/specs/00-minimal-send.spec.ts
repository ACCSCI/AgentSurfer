// Most minimal: open side panel, send a test message, see if SW responds.
// Times out at 10s if SW doesn't answer.

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('SW responds to a basic message', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // Send a message the SW definitely knows how to answer.
    const result = await sidePanel.evaluate(
      async () => {
        const r = await chrome.runtime.sendMessage({ type: 'agent:list' });
        return r;
      },
      undefined,
      // Hard timeout to fail fast.
    );
    console.log('[result]', JSON.stringify(result));
    expect(result).toBeTruthy();
  } finally {
    await ext.cleanup();
  }
});
