// E2E: verify that the side panel loads when the user navigates to it.

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('side panel loads and shows the AgentSurfer header', async () => {
  const ext = await launchWithExtension();
  try {
    const { page } = await ext.openSidePanel();
    await expect(page.locator('text=AgentSurfer').first()).toBeVisible();
    await expect(page.locator('button[title="New chat"]')).toBeVisible();
  } finally {
    await ext.cleanup();
  }
});
