// E2E: verify that a clean agent run (mock:textOnly) produces no unexpected
// error or warning entries in the SW log. Run this after the other specs
// to ensure the logging system itself doesn't introduce noise.

import { expect, test } from '@playwright/test';

import {
  assertLogClean,
  assertLogContains,
  clearSWLog,
  launchWithExtension,
} from '../fixtures/extension';

test('clean run produces no unexpected errors', async () => {
  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.seedMockConfig(sidePanel);

    // Send a simple prompt.
    await sidePanel.locator('textarea').fill('Hello');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for agent to finish.
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 15_000 });

    // Verify the agent completed.
    assertLogContains('[AgentSurfer][agent] runAgent complete', 'run complete');

    // Verify no unexpected error-level entries.
    // Allowed errors: none for a clean mock run.
    assertLogClean('[AgentSurfer][cdp] attach failed', 'no CDP attach failures');
    assertLogClean('[AgentSurfer][cdp] send failed', 'no CDP send failures');
    assertLogClean('[AgentSurfer][agent] onError', 'no agent errors');
    assertLogClean('[AgentSurfer][sw] agent:caught', 'no uncaught agent errors');
    assertLogClean('consumeStream error', 'no stream errors');
  } finally {
    await ext.cleanup();
  }
});
