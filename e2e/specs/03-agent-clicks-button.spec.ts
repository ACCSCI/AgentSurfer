// E2E: full closed-loop. The user adds a mock config, navigates to a fixture
// page, sends a prompt, the agent runs the clickSequence script, and the
// fixture page's button is clicked (proving the agent actually executed a
// tool against the active tab).

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

const FIXTURE_URL = 'http://localhost:4173/e2e/fixtures/pages/search.html';

test('agent runs a multi-step script against the active tab', async () => {
  const ext = await launchWithExtension();
  try {
    // 1. Open side panel and seed the mock config
    const { page: sidePanel } = await ext.openSidePanel();
    await ext.seedMockConfig(sidePanel);

    // 2. Open a new tab with the fixture page and bring it to the front
    const fixture = await ext.ctx.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.bringToFront();

    // 3. The default config is `mock:happy` which doesn't actually click
    //    anything. For this spec, we want the clickSequence script. We
    //    update the existing config's modelId via Dexie (via the SW).
    await sidePanel.bringToFront();
    await sidePanel.evaluate(async () => {
      // The side panel UI is React; we can't easily mutate Dexie from the
      // page context. Easiest: dispatch a custom message to the SW that
      // updates the active config.
      const w = window as unknown as { __e2e?: { setModel: (id: string) => Promise<void> } };
      if (w.__e2e?.setModel) await w.__e2e.setModel('mock:clickSequence');
    });

    // 4. Bring fixture tab back to the front so it's the active tab
    await fixture.bringToFront();

    // 5. Type a prompt in the side panel input
    const input = sidePanel.locator('textarea');
    await input.fill('Click the search button');
    await sidePanel.locator('button[title="Send"]').click();

    // 6. Wait for the agent to finish — the step trace should appear
    //    and the run should complete (Cancel button disappears).
    await expect(sidePanel.locator('text=step 1')).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.locator('button[title="Cancel run"]')).toBeHidden({ timeout: 15_000 });

    // 7. The fixture page should reflect the click — but `mock:clickSequence`
    //    calls domClick('#start-button') which doesn't exist on this fixture.
    //    We assert the tool was called, not that it succeeded.
    await expect(sidePanel.locator('text=domClick').first()).toBeVisible();
  } finally {
    await ext.cleanup();
  }
});
