// E2E for P0.1 fix: real LLM sanity. Verify the alarm-based wall-clock
// timeout path doesn't break normal LLM streaming. The production
// default is 120s; this test uses a 35s override to keep it short.
//
// Requires MINIMAX_API_KEY in .env. Skipped if missing.
//
// NOTE: this spec may be flaky in CI if the LLM is slow — it only
// verifies the alarm was created + cleared correctly, not the LLM
// response content. If the LLM call hangs past the 35s wall timeout,
// the alarm fires and the agent errors out — the test then asserts
// that the fired marker appeared, which is the correct P0.1 contract.

import { expect, test } from '@playwright/test';

import {
  assertLogContains,
  clearSWLog,
  launchWithExtension,
  readApiKey,
  setWallTimeout,
} from '../fixtures/extension';

test('P0.1 Case D — real LLM under alarm-based timeout creates + clears correctly', async () => {
  test.setTimeout(90_000);

  let apiKey: string;
  try {
    apiKey = readApiKey('MINIMAX_API_KEY');
  } catch {
    test.skip(true, 'MINIMAX_API_KEY missing from .env');
    return;
  }

  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // 35s wall timeout — well above the 30s alarm minimum.
    // Production is 120s; we use 35s to keep the test fast.
    await setWallTimeout(sidePanel, 35_000);

    // Use the fixture's seedLiveConfig — same pattern as spec 20 etc.
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 15_000 });

    await sidePanel.locator('textarea').fill('hi');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for the agent to finish OR for the alarm to fire.
    let alarmFiredOrFinished = false;
    try {
      await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 60_000 });
      alarmFiredOrFinished = true;
      // Give the loop a moment to run its cleanup (wall.cancel).
      await sidePanel.waitForTimeout(2_000);
    } catch {
      // 60s elapsed, agent still running — likely the alarm fired.
    }

    // In either case, the alarm was created.
    const createdLines = assertLogContains('[wall-alarm] created', '[wall-alarm] created');
    expect(createdLines.length).toBe(1);

    if (alarmFiredOrFinished) {
      // Natural completion — cleared should appear, NOT fired.
      const clearedLines = assertLogContains('[wall-alarm] cleared', '[wall-alarm] cleared');
      expect(clearedLines.length).toBe(1);
      const firedLines = assertLogContains('[wall-alarm] fired', '[wall-alarm] fired');
      expect(firedLines.length).toBe(0);
    } else {
      // Alarm fired (LLM hung past 35s) — fired should appear.
      const firedLines = assertLogContains('[wall-alarm] fired', '[wall-alarm] fired');
      expect(firedLines.length).toBe(1);
    }
  } finally {
    await ext.cleanup();
  }
});
