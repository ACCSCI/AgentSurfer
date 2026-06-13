// Step 2: Real MiniMax E2E with CORE tools enabled (tabsList/Switch/Open/Close,
// smartScreenshot, cdpAim/Confirm/Cancel/Screenshot). Send "hi", screenshot
// every 2s for 10s. Same streaming verification as step 1, but with tools
// available to the agent.

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

const CORE_TOOLS = [
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
  'smartScreenshot',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot',
] as const;

test('MiniMax live: streaming visible with core tools, prompt "hi"', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(60_000);

  let apiKey = '';
  try {
    apiKey = ext.readApiKey();
  } catch {
    test.skip(true, 'MINIMAX_API_KEY missing from .env');
  }

  ext.clearSWLog();

  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M2.7-highspeed', { timeout: 15_000 });

    // Enable the core tools, disable the rest.
    await ext.enableOnlyTools(sidePanel, CORE_TOOLS);

    // Type "hi" and send.
    await ext.setReactTextareaValue(sidePanel, 'textarea', 'hi');
    await sidePanel.locator('button[title="Send"]').click();

    // 10s window, 2s interval. Don't exit early even if agent finishes.
    const snapshots = await ext.captureSnapshots(sidePanel, {
      intervalMs: 2000,
      durationMs: 10_000,
      label: '21-tools-on',
    });

    console.log('\n[21-tools-on] === summary ===');
    console.log('snapshot count:', snapshots.length);
    console.log('text-length trajectory:', snapshots.map((s) => `[${Math.round(s.tMs / 1000)}s]=${s.textLength}`).join(' → '));
    console.log('screenshots saved:');
    for (const s of snapshots) {
      console.log(`  - t=${Math.round(s.tMs / 1000)}s textLen=${s.textLength} done=${s.isDone} -> ${s.screenshot}`);
    }
    const log = ext.readSWLog();
    const emitChunks = (log.match(/emit.*chunk/g) ?? []).length;
    const emitDone = (log.match(/emit.*agent_done/g) ?? []).length;
    console.log(`SW log: chunk events=${emitChunks}, agent_done emits=${emitDone}, total log lines=${log.split('\n').length}`);

    expect(snapshots.length, 'at least one snapshot taken').toBeGreaterThan(0);
    expect(emitDone, 'agent_done should be emitted').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
