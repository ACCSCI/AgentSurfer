// E2E: verify that the `todo` tool emits a `todo_update` event when called
// by the LLM. The mock:withTodo script calls the todo tool first, so the
// event should appear in the SW log.

import { expect, test } from '@playwright/test';

import {
  assertLogContains,
  clearSWLog,
  dbMsg,
  launchWithExtension,
  resetDb,
} from '../fixtures/extension';

test('todo tool emits todo_update event', async () => {
  test.setTimeout(30_000);
  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await resetDb(sidePanel);

    // Seed mock:withTodo — first step is a todo tool call.
    await dbMsg(sidePanel, {
      type: '__e2e:seed-config',
      config: {
        id: `e2e-todo-${Date.now()}`,
        name: 'Mock (E2E / demo)',
        provider: 'mock',
        modelId: 'mock:withTodo',
        apiKey: 'mock-key-not-used',
        baseUrl: null,
        isDefault: true,
        createdAt: Date.now(),
      },
    });
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=Mock (E2E / demo) · mock:withTodo', { timeout: 5_000 });

    // Send a prompt.
    await sidePanel.locator('textarea').evaluate((el, v) => {
      const ta = el as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta) as object, 'value')?.set;
      if (setter) (setter as (v: string) => void).call(ta, v);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, 'plan my work');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait briefly for the todo tool to be called and the event to fire.
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeVisible({ timeout: 5_000 });
    await sidePanel.waitForTimeout(2_000);

    // Verify todo_update event was emitted with the expected shape.
    const todoLines = assertLogContains('emit {"type":"todo_update"', 'todo_update');
    expect(todoLines.length).toBeGreaterThan(0);

    // Cancel the agent to avoid the mock-scripts doStream loop.
    const cancelBtn = sidePanel.locator('button[title="Cancel"]');
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click();
    }
  } finally {
    await ext.cleanup();
  }
});
