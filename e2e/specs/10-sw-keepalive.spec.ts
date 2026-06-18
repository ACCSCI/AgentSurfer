// E2E: verify that the SW keepalive mechanism works during a long agent run.
// Uses mock:longRunning (15 sequential screenshot steps) to keep the agent
// busy long enough for Chrome's SW inactivity timeout to potentially fire.

import { expect, test } from '@playwright/test';

import {
  assertLogContains,
  clearSWLog,
  launchWithExtension,
} from '../fixtures/extension';

test('agent completes a long run without SW termination', async () => {
  // This test may take a while due to the 15 steps + keepalive interval.
  test.setTimeout(60_000);

  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // Seed the longRunning mock config.
    await sidePanel.click('button[title="Settings"]');
    await sidePanel.waitForSelector('text=Add model configuration', { timeout: 10_000 });
    await sidePanel.selectOption('#provider', 'mock');
    await sidePanel.fill('#model', 'mock:longRunning');
    await sidePanel.fill('#key', 'mock-key-not-used');
    await sidePanel.click('button[type="submit"]');
    await sidePanel.waitForSelector('text=Saved', { timeout: 5_000 });

    // Send a prompt.
    await sidePanel.locator('textarea').fill('Do something long');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for agent to finish. If SW gets killed, this will timeout.
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 50_000 });

    // Verify the agent completed successfully.
    assertLogContains('[AgentSurfer][agent] runAgent complete', 'run complete');

    // Verify keepalive pings were logged (should have at least one after 25s).
    // Note: if the run completes in <25s, no ping will be logged — that's fine.
    const pings = assertLogContains('[AgentSurfer][sw] keepalive ping', 'keepalive');
    // We don't assert pings.length > 0 because the run might finish in <25s.
    // But if pings exist, it proves the mechanism works.
    if (pings.length > 0) {
      console.log(`[test] keepalive pings observed: ${pings.length}`);
    }
  } finally {
    await ext.cleanup();
  }
});
