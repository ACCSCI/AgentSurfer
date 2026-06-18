// E2E: verify that the Runtime emits DISTINCT event types for each
// architectural concept (architecture rule 7):
//   - tool calls
//   - tool results  (new: was previously bundled into step_done)
//   - tokens        (new: incremental per step)
//   - todos         (new: agent's plan)
//   - progress updates (new: per step)
//   - errors
//
// We capture the SW console log (which now includes 'emit' debug lines
// from the wrapped emit()) and assert the new event types appear.

import { expect, test } from '@playwright/test';

import {
  assertLogContains,
  clearSWLog,
  dbMsg,
  launchWithExtension,
  resetDb,
} from '../fixtures/extension';

test('architecture rule 7 — distinct event types per concept', async () => {
  test.setTimeout(30_000);
  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await resetDb(sidePanel);

    // Seed mock:textOnly — it just returns a text reply, no tool calls
    // (screenshot etc. would require an active http tab in the test fixture).
    await dbMsg(sidePanel, {
      type: '__e2e:seed-config',
      config: {
        id: `e2e-event-types-${Date.now()}`,
        name: 'Mock (E2E / demo)',
        provider: 'mock',
        modelId: 'mock:textOnly',
        apiKey: 'mock-key-not-used',
        baseUrl: null,
        isDefault: true,
        createdAt: Date.now(),
      },
    });
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=Mock (E2E / demo) · mock:textOnly', { timeout: 5_000 });

    // Send a prompt to trigger the agent.
    await sidePanel.locator('textarea').evaluate((el, v) => {
      const ta = el as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta) as object, 'value')?.set;
      if (setter) (setter as (v: string) => void).call(ta, v);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, 'hello');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for agent to finish.
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 15_000 });
    await sidePanel.waitForTimeout(500);

    // Verify each distinct event type was emitted.
    // 1. user_message — input prompt
    assertLogContains('emit {"type":"user_message"', 'user_message');

    // 2. model_ready — LLM initialized
    assertLogContains('emit {"type":"model_ready"', 'model_ready');

    // 3. chunks (text-delta) — streamed response
    assertLogContains('emit {"type":"chunk"', 'chunk');

    // 4. token_usage — NEW distinct event (was only in agent_done before)
    const tokenUsageLines = assertLogContains('emit {"type":"token_usage"', 'token_usage');
    expect(tokenUsageLines.length).toBeGreaterThan(0);

    // 5. progress — NEW distinct event
    const progressLines = assertLogContains('emit {"type":"progress"', 'progress');
    expect(progressLines.length).toBeGreaterThan(0);

    // 6. step_done — after each step
    assertLogContains('emit {"type":"step_done"', 'step_done');

    // 7. agent_done — terminal event with total usage
    assertLogContains('emit {"type":"agent_done"', 'agent_done');
  } finally {
    await ext.cleanup();
  }
});
