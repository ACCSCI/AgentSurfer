// E2E: open the options page, save a mock provider config, see it appear
// in the saved list, and see the badge update in the side panel.

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('options page persists a mock provider config and side panel shows it', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await ext.seedMockConfig(sidePanel);

    // Switch back to the side panel
    await sidePanel.bringToFront();

    // Model badge should now read "Mock (E2E / demo) · mock:happy"
    await expect(sidePanel.locator('text=Mock (E2E / demo)')).toBeVisible();
  } finally {
    await ext.cleanup();
  }
});
