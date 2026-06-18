// E2E for P0.1 fix: wall-clock timeout via chrome.alarms.
//
// Case A: mock:hangsForever + 31s wall timeout → alarm fires once
//         (the OLD code would also call abort() from the setTimeout
//         fast-path, causing double-firing).
// Case B: mock:textOnly + 60s wall timeout → completes naturally, the
//         cancel path removes the alarm cleanly (no late fire).
//
// These run slowly (the chrome.alarms minimum is 30s), so each case
// has its own test() with a long setTimeout.

import { expect, test } from '@playwright/test';

import {
  assertLogContains,
  clearSWLog,
  dbMsg,
  launchWithExtension,
  listAlarms,
  readCheckpoint,
  setWallTimeout,
  waitForLogMarker,
} from '../fixtures/extension';

/** Seed a mock provider config directly via the SW (bypasses the
 *  Options form, which currently has a separate UI bug unrelated to
 *  P0.1). Same pattern as seedLiveConfig in the fixture. */
async function seedMockViaSW(
  page: import('@playwright/test').Page,
  modelId: string,
): Promise<void> {
  await dbMsg(page, {
    type: '__e2e:seed-config',
    config: {
      id: `e2e-wall-${Date.now()}`,
      name: `wall-test (${modelId})`,
      provider: 'mock',
      modelId,
      apiKey: 'mock-key-not-used',
      baseUrl: null,
      isDefault: true,
      createdAt: Date.now(),
    },
  });
}

test('P0.1 Case A — alarm fires exactly once when stream hangs', async () => {
  test.setTimeout(120_000);
  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // 31s — just above chrome.alarms' 30s minimum. This forces the
    // alarm path (not the setTimeout fallback).
    await setWallTimeout(sidePanel, 31_000);
    await seedMockViaSW(sidePanel, 'mock:hangsForever');

    // Send the prompt.
    await sidePanel.locator('textarea').fill('hi');
    await sidePanel.locator('button[title="Send"]').click();

    // The alarm should fire within ~31s. Wait for the marker.
    const firedLines = await waitForLogMarker('[wall-alarm] fired', { timeoutMs: 45_000 });
    // Exactly one fire for this run — the OLD code's setTimeout
    // fast-path would produce a second [wall-alarm] fired (or
    // a second "wall-clock timeout reached — aborting" line).
    expect(firedLines.length).toBe(1);

    // Also assert the abort line appears exactly once.
    const abortLines = assertLogContains(
      'wall-clock timeout reached — aborting',
      'wall-clock timeout reached — aborting',
    );
    expect(abortLines.length).toBe(1);

    // ListAlarms should not include our agent-wall-timeout-* alarm
    // (either it fired and Chrome cleaned up, or cancel ran).
    // We wait 2s after the fire for Chrome's alarm scheduler to
    // clean up.
    await sidePanel.waitForTimeout(2_000);
    const alarms = await listAlarms(sidePanel);
    const ours = alarms.filter((n) => n.startsWith('agent-wall-timeout-'));
    expect(ours.length).toBe(0);
    //
    // NOTE: the checkpoint cleanup is NOT asserted here because
    // mock:hangsForever doesn't honor the abort signal — its
    // ReadableStream never closes, so consumeStream never resolves,
    // and the loop's onError never runs. The fix for that mock is
    // out of scope for P0.1. The CHECKPOINT sweep is verified in
    // spec 39 instead, where it doesn't depend on mock cooperation.
  } finally {
    await ext.cleanup();
  }
});

test('P0.1 Case B — alarm cleared on natural completion (no late fire)', async () => {
  test.setTimeout(120_000);
  clearSWLog();
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // 60s alarm — task will finish in <1s, so cancel must run.
    await setWallTimeout(sidePanel, 60_000);
    await seedMockViaSW(sidePanel, 'mock:textOnly');

    await sidePanel.locator('textarea').fill('hi');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for agent_done.
    await expect(sidePanel.locator('button[title="Cancel"]')).toBeHidden({ timeout: 15_000 });

    // The cancel log should appear.
    const cleared = assertLogContains('[wall-alarm] cleared', '[wall-alarm] cleared');
    expect(cleared.length).toBe(1);

    // ListAlarms should not include ours.
    const alarms = await listAlarms(sidePanel);
    const ours = alarms.filter((n) => n.startsWith('agent-wall-timeout-'));
    expect(ours.length).toBe(0);

    // CRITICAL: wait 65s and verify the alarm did NOT late-fire.
    // (If cancel didn't actually clear the alarm, Chrome would fire
    // it after 60s, calling abort() on a now-finished run. The
    // '[wall-alarm] fired' marker is our tripwire.)
    await sidePanel.waitForTimeout(65_000);
    const lateFires = assertLogContains('[wall-alarm] fired', 'late [wall-alarm] fired');
    expect(lateFires.length).toBe(0);
  } finally {
    await ext.cleanup();
  }
});
