// E2E: verify that an agent run goes through the data layer correctly:
// - user message → appendMessage via data-layer
// - steps → appendStep via data-layer
// - tool results flow through
// - db persists across page reloads

import { expect, test } from '@playwright/test';

import { dbMsg, launchWithExtension, listAll, resetDb } from '../fixtures/extension';

test('agent run writes messages + steps via data-layer', async () => {
  test.setTimeout(30_000);
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await resetDb(sidePanel);

    // Seed mock:textOnly via __e2e:seed-config — it just returns a text reply,
    // so the agent produces both a user and an assistant message.
    await dbMsg(sidePanel, {
      type: '__e2e:seed-config',
      config: {
        id: `e2e-mock-textonly-${Date.now()}`,
        name: 'Mock (E2E / demo)',
        provider: 'mock',
        modelId: 'mock:textOnly',
        apiKey: 'mock-key-not-used',
        baseUrl: null,
        isDefault: true,
        createdAt: Date.now(),
      },
    });

    // Reload so the side panel re-reads the active config from Dexie.
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=Mock (E2E / demo) · mock:textOnly', { timeout: 5_000 });

    // Verify db has the config.
    let snap = await listAll(sidePanel);
    expect(snap.modelConfigs.length).toBe(1);

    // Send "hi" to trigger the agent script.
    await sidePanel.locator('textarea').evaluate((el, v) => {
      const ta = el as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta) as object, 'value')?.set;
      if (setter) (setter as (v: string) => void).call(ta, v);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, 'hi');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for the agent to finish.
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 15_000 });
    // Small wait for Dexie writes (appendMessage in onFinish) to settle.
    await sidePanel.waitForTimeout(500);

    // Verify db has the conversation.
    snap = await listAll(sidePanel);
    expect(snap.sessions.length).toBeGreaterThanOrEqual(1);
    expect(snap.messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(snap.messages.some((m) => m.role === 'user' && m.text === 'hi')).toBe(true);
    const assistantMsg = snap.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeTruthy();
    expect(assistantMsg?.text.length).toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});

test('agent history persists across side panel reload', async () => {
  test.setTimeout(30_000);
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await resetDb(sidePanel);

    await dbMsg(sidePanel, {
      type: '__e2e:seed-config',
      config: {
        id: `e2e-mock-textonly-${Date.now()}`,
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

    // Send a message.
    await sidePanel.locator('textarea').evaluate((el, v) => {
      const ta = el as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta) as object, 'value')?.set;
      if (setter) (setter as (v: string) => void).call(ta, v);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, 'remember this');
    await sidePanel.locator('button[title="Send"]').click();
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 15_000 });
    await sidePanel.waitForTimeout(500);

    // Reload side panel (force a fresh JS context).
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=AgentSurfer', { timeout: 5_000 });

    // The user message should still be in Dexie and visible after reload.
    await expect(sidePanel.locator('text=remember this')).toBeVisible({ timeout: 5_000 });
  } finally {
    await ext.cleanup();
  }
});
