// E2E: verify that CDP operations are logged (attach, detach, commands).
// Uses mock:cdpHeavy which calls cdpAim + cdpConfirm.
// Note: actual CDP conflict detection is observational — if another debugger
// is attached, a warn-level log appears. This test verifies the logging works.

import { expect, test } from '@playwright/test';

import {
  assertLogContains,
  clearSWLog,
  launchWithExtension,
} from '../fixtures/extension';

const FIXTURE_URL = 'http://localhost:4173/e2e/fixtures/pages/search.html';

test('CDP operations are logged', async () => {
  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // Seed the cdpHeavy mock config.
    await sidePanel.click('button[title="Settings"]');
    await sidePanel.waitForSelector('text=Add model configuration', { timeout: 10_000 });
    await sidePanel.selectOption('#provider', 'mock');
    await sidePanel.fill('#model', 'mock:cdpHeavy');
    await sidePanel.fill('#key', 'mock-key-not-used');
    await sidePanel.click('button[type="submit"]');
    await sidePanel.waitForSelector('text=Saved', { timeout: 5_000 });

    // Open a fixture page so the agent has a tab to operate on.
    const fixture = await ext.ctx.newPage();
    await fixture.goto(FIXTURE_URL);
    await fixture.bringToFront();

    // Send a prompt that triggers CDP tools.
    await sidePanel.bringToFront();
    await sidePanel.locator('textarea').fill('Click the button');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for agent to finish.
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 15_000 });

    // Verify CDP operations are logged.
    assertLogContains('[AgentSurfer][cdp] attach start', 'attach start');
    assertLogContains('[AgentSurfer][cdp] attach ok', 'attach ok');
    assertLogContains('[AgentSurfer][cdp] highlightQuad', 'highlightQuad');
    assertLogContains('[AgentSurfer][cdp] click', 'click');
    assertLogContains('[AgentSurfer][cdp] detach', 'detach');
  } finally {
    await ext.cleanup();
  }
});
