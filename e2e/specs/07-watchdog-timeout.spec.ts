// E2E: verify that the wall-clock timeout fires when the LLM stream hangs.
// Uses mock:hangsForever to simulate a stream that never completes.

import { expect, test } from '@playwright/test';

import {
  assertLogContains,
  clearSWLog,
  launchWithExtension,
} from '../fixtures/extension';

test('wall-clock timeout aborts a hung stream', async () => {
  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // Seed the hangsForever mock config via the options form.
    await sidePanel.click('button[title="Settings"]');
    await sidePanel.waitForSelector('text=Add model configuration', { timeout: 10_000 });
    await sidePanel.selectOption('#provider', 'mock');
    await sidePanel.fill('#model', 'mock:hangsForever');
    await sidePanel.fill('#key', 'mock-key-not-used');
    await sidePanel.click('button[type="submit"]');
    await sidePanel.waitForSelector('text=Saved', { timeout: 5_000 });

    // Override wall-clock timeout to 5 seconds for fast testing.
    await sidePanel.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: '__e2e:set-wall-timeout', ms: 5_000 });
    });

    // Send a prompt.
    await sidePanel.locator('textarea').fill('Hello');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for the timeout to fire (5s) + some buffer.
    // The agent should emit agent_error with a timeout-like message.
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 15_000 });

    // Verify the log shows the wall-clock timeout.
    assertLogContains('wall-clock timeout reached', 'wall-clock timeout');

    // Verify the agent completed (either via onFinish or agent_error).
    const doneOrError =
      assertLogContains('[AgentSurfer][agent] onFinish', 'onFinish').length > 0 ||
      assertLogContains('[AgentSurfer][agent] onError', 'onError').length > 0 ||
      assertLogContains('[AgentSurfer][sw] agent:caught', 'agent:caught').length > 0;
    expect(doneOrError).toBe(true);

    // Restore default timeout.
    await sidePanel.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: '__e2e:set-wall-timeout', ms: 120_000 });
    });
  } finally {
    await ext.cleanup();
  }
});
