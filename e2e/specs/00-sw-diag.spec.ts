// Simplest possible diagnostic: launch headed Chromium, wait 5s for SW to
// load, then capture all SW console events. No side panel, no seed, no
// agent. We just want to see if the SW is healthy.
//
// Run: bunx playwright test e2e/specs/00-sw-diag.spec.ts --headed

import { test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('SW is healthy after load', async () => {
  const ext = await launchWithExtension();
  // Wait 8s and let the user see whatever the SW prints.
  await new Promise((r) => setTimeout(r, 8_000));
  await ext.cleanup();
});
