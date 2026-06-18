// E2E: verify that the structured logger produces a complete agent lifecycle
// trace in the SW log. Uses mock:textOnly for deterministic, fast execution.

import { expect, test } from '@playwright/test';

import {
  assertLogContains,
  clearSWLog,
  launchWithExtension,
} from '../fixtures/extension';

test('agent lifecycle is fully logged', async () => {
  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.seedMockConfig(sidePanel);

    // Type and send a prompt.
    await sidePanel.locator('textarea').fill('Hello');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for agent to finish (Cancel button disappears).
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 15_000 });

    // Read the SW log and verify lifecycle entries.
    const startLines = assertLogContains('[AgentSurfer][sw] agent:start', 'agent:start');
    expect(startLines.length).toBeGreaterThan(0);

    assertLogContains('[AgentSurfer][agent] user_message emitted', 'user_message');
    assertLogContains('[AgentSurfer][agent] enabled tools', 'enabled tools');
    assertLogContains('[AgentSurfer][agent] model ready', 'model ready');
    assertLogContains('[AgentSurfer][agent] streamText calling', 'streamText');
    assertLogContains('[AgentSurfer][agent] onStepFinish', 'onStepFinish');
    assertLogContains('[AgentSurfer][agent] onFinish', 'onFinish');
    assertLogContains('[AgentSurfer][agent] runAgent complete', 'run complete');

    // Verify runId correlation — all agent log lines should have the same runId.
    const agentLines = assertLogContains('[AgentSurfer][agent]', 'agent lines');
    const runIds = new Set(
      agentLines
        .map((l) => l.match(/"runId":"([^"]+)"/)?.[1])
        .filter(Boolean),
    );
    // All agent lines should share the same runId (or be from the scope which
    // uses sessionId — either way, a single consistent ID).
    expect(runIds.size).toBeLessThanOrEqual(1);
  } finally {
    await ext.cleanup();
  }
});
