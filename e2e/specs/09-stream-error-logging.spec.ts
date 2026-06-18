// E2E: verify that stream errors are logged (not silently swallowed).
// Uses mock:streamError which produces a stream that errors after one delta.

import { expect, test } from '@playwright/test';

import {
  assertLogContains,
  clearSWLog,
  launchWithExtension,
} from '../fixtures/extension';

test('stream errors are logged, not silently swallowed', async () => {
  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // Seed the streamError mock config.
    await sidePanel.click('button[title="Settings"]');
    await sidePanel.waitForSelector('text=Add model configuration', { timeout: 10_000 });
    await sidePanel.selectOption('#provider', 'mock');
    await sidePanel.fill('#model', 'mock:streamError');
    await sidePanel.fill('#key', 'mock-key-not-used');
    await sidePanel.click('button[type="submit"]');
    await sidePanel.waitForSelector('text=Saved', { timeout: 5_000 });

    // Send a prompt.
    await sidePanel.locator('textarea').fill('Hello');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for agent to finish (should error out quickly).
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 15_000 });

    // Verify the stream error is logged at error level.
    assertLogContains('consumeStream error', 'consumeStream error');

    // Verify the agent completed (either via onFinish or agent_error).
    const hasError =
      assertLogContains('[AgentSurfer][agent] onError', 'onError').length > 0 ||
      assertLogContains('[AgentSurfer][agent] consumeStream error', 'consumeStream').length > 0 ||
      assertLogContains('[AgentSurfer][sw] agent:caught', 'agent:caught').length > 0;
    expect(hasError).toBe(true);
  } finally {
    await ext.cleanup();
  }
});
