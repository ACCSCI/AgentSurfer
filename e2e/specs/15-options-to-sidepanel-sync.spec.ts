// E2E: verify that going through the real Options form (provider select,
// model field, API key field, submit) propagates to the Side Panel through
// the data layer + cross-context change notification.
//
// This exercises the full user path: UI form → db:* message → data-layer
// → chrome.storage.local counter → useChangeCount → useLiveQuery re-render.

import { expect, test } from '@playwright/test';

import { launchWithExtension, listAll, resetDb } from '../fixtures/extension';

test('Options form add config → Side Panel badge updates automatically', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await resetDb(sidePanel);

    // Baseline: no model badge.
    await expect(sidePanel.locator('text=no model · set in settings')).toBeVisible({ timeout: 5_000 });

    // Open the Options page and exercise the real form.
    const optionsPage = await ext.openOptions();
    await optionsPage.waitForSelector('text=Add model configuration', { timeout: 10_000 });

    // The provider select is a Radix Select (not native <select>). Click the
    // trigger to open the dropdown, then click the "Mock (E2E / demo)" option.
    await optionsPage.locator('#provider').click();
    await optionsPage.locator('[role="option"]:has-text("Mock")').click();

    // Now fill the model field. The form auto-populates the default model
    // when the provider changes, so we just need to override if we want a
    // specific one.
    await optionsPage.locator('#model').fill('mock:happy');

    // The API key field is required by Zod (apiKey must be non-empty).
    await optionsPage.locator('#key').fill('mock-key-not-used');

    // Tick "Set as default" (it's already checked by default — confirm).
    const checkbox = optionsPage.locator('input[type="checkbox"]');
    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }

    // Submit.
    await optionsPage.locator('button[type="submit"]').click();

    // Wait for the "Saved" toast.
    await expect(optionsPage.locator('text=Saved')).toBeVisible({ timeout: 5_000 });

    // The Side Panel should now show the new model badge — no reload needed.
    // ProviderMeta.mock.label = "Mock (E2E / demo)".
    await expect(sidePanel.locator('text=Mock (E2E / demo) · mock:happy')).toBeVisible({ timeout: 5_000 });

    // Verify db state from the side panel context.
    const snap = await listAll(sidePanel);
    expect(snap.modelConfigs.length).toBe(1);
    expect(snap.modelConfigs[0]?.isDefault).toBe(true);
    expect(snap.modelConfigs[0]?.provider).toBe('mock');
    expect(snap.modelConfigs[0]?.modelId).toBe('mock:happy');
  } finally {
    await ext.cleanup();
  }
});

test('Options form update config → Side Panel sees new modelId', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await resetDb(sidePanel);

    // First: open Options and add mock:happy as default via the form.
    const optionsPage = await ext.openOptions();
    await optionsPage.waitForSelector('text=Add model configuration', { timeout: 10_000 });
    await optionsPage.locator('#provider').click();
    await optionsPage.locator('[role="option"]:has-text("Mock")').click();
    await optionsPage.locator('#model').fill('mock:textOnly');
    await optionsPage.locator('#key').fill('mock-key-not-used');
    await optionsPage.locator('button[type="submit"]').click();
    await expect(optionsPage.locator('text=Saved')).toBeVisible({ timeout: 5_000 });
    await expect(sidePanel.locator('text=Mock (E2E / demo) · mock:textOnly')).toBeVisible({ timeout: 5_000 });

    // Capture the saved config id.
    const initialSnap = await listAll(sidePanel);
    const cfgId = initialSnap.modelConfigs[0]?.id;
    expect(cfgId).toBeTruthy();

    // Now: change the model on the same config via Dexie (simulating a
    // second save form submission with the same provider but different model).
    // We could re-submit the form, but the form has no "edit existing"
    // affordance — it only adds new configs. The delete+re-add path is
    // already covered by data-layer-routing spec 12. Here we just verify
    // the sync direction (Options → Side Panel) by submitting a different
    // model and checking the badge flips.
    await optionsPage.locator('#provider').click();
    await optionsPage.locator('[role="option"]:has-text("Mock")').click();
    await optionsPage.locator('#model').fill('mock:clickSequence');
    await optionsPage.locator('#key').fill('mock-key-not-used');
    // Uncheck "Set as default" so we don't change which config is active.
    await optionsPage.locator('input[type="checkbox"]').uncheck();
    await optionsPage.locator('button[type="submit"]').click();
    await expect(optionsPage.locator('text=Saved')).toBeVisible({ timeout: 5_000 });

    // Two configs now. The active one is still mock:textOnly.
    await expect(sidePanel.locator('text=Mock (E2E / demo) · mock:textOnly')).toBeVisible({ timeout: 5_000 });

    // Now click the star icon on the new config row to make it active.
    const newRow = optionsPage.locator('div').filter({ hasText: 'mock:clickSequence' }).first();
    await newRow.locator('button[title="Set as default"]').click();

    // Side Panel badge should now flip to the new model.
    await expect(sidePanel.locator('text=Mock (E2E / demo) · mock:clickSequence')).toBeVisible({ timeout: 5_000 });
  } finally {
    await ext.cleanup();
  }
});
