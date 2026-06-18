// E2E: verify that SW writes trigger useChangeCount → useLiveQuery in the
// Side Panel WITHOUT requiring a page reload.
//
// Strategy: open the Side Panel, take a baseline snapshot of the
// session/config counts, then write via SW and assert the UI updates.

import { expect, test } from '@playwright/test';

import {
  dbMsg,
  launchWithExtension,
  listAll,
  resetDb,
} from '../fixtures/extension';

test('useChangeCount fires when SW writes to a different context', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // Reset db and wait for UI to settle.
    await resetDb(sidePanel);
    await expect(sidePanel.locator('text=AgentSurfer').first()).toBeVisible();

    // Baseline: no sessions, no model → "no model · set in settings" badge.
    await expect(sidePanel.locator('text=no model · set in settings')).toBeVisible({ timeout: 5_000 });

    // Write a config via SW (different context, no reload).
    const cfgId = `e2e-sync-${Date.now()}`;
    await dbMsg(sidePanel, {
      type: 'db:upsert-config',
      config: {
        id: cfgId,
        name: 'Sync test',
        provider: 'mock',
        modelId: 'mock:textOnly',
        apiKey: 'mock',
        baseUrl: null,
        isDefault: true,
        createdAt: Date.now(),
      },
    });

    // UI should automatically reflect the new model badge via useChangeCount.
    // ProviderMeta.mock.label = "Mock (E2E / demo)".
    await expect(sidePanel.locator('text=Mock (E2E / demo) · mock:textOnly')).toBeVisible({ timeout: 5_000 });

    // Verify the counter was actually bumped.
    const snap = await listAll(sidePanel);
    expect(snap.modelConfigs.length).toBe(1);
    expect(snap.changeCounters.modelConfigs ?? 0).toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});

test('session appears in Sidebar after SW creates it (cross-context)', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    await resetDb(sidePanel);
    await expect(sidePanel.locator('text=AgentSurfer').first()).toBeVisible();

    // Baseline: should have at most 1 session (auto-created on first open).
    // Just check that whatever session is shown has the default title.
    // (The Side Panel auto-creates a session if none exists, so we may see one.)

    // Write a new session via SW with a distinctive title.
    const res = await dbMsg<{ session: { id: string; title: string } }>(
      sidePanel,
      { type: 'db:create-session', title: 'SW-created sync test' },
    );

    // Sidebar should auto-update via useChangeCount('sessions').
    await expect(sidePanel.locator('text=SW-created sync test')).toBeVisible({ timeout: 5_000 });
    expect(res.session.title).toBe('SW-created sync test');
  } finally {
    await ext.cleanup();
  }
});

test('delete-session removes row from Sidebar via useChangeCount', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    await resetDb(sidePanel);

    // Create a session with a known title.
    const res = await dbMsg<{ session: { id: string; title: string } }>(
      sidePanel,
      { type: 'db:create-session', title: 'to-be-deleted' },
    );
    await expect(sidePanel.locator('text=to-be-deleted')).toBeVisible({ timeout: 5_000 });

    // Delete it via SW.
    await dbMsg(sidePanel, { type: 'db:delete-session', sessionId: res.session.id });

    // Sidebar should auto-update and the row should disappear.
    await expect(sidePanel.locator('text=to-be-deleted')).toBeHidden({ timeout: 5_000 });
  } finally {
    await ext.cleanup();
  }
});
