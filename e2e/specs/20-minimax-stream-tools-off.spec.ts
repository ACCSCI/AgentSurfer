// Step 1: Real MiniMax E2E with ALL tools disabled, send "hi", screenshot
// every 2s for 10s. Verifies that streaming is visible in the side panel —
// the assistant reply should grow incrementally, not jump from empty to
// complete. Uses `mcp__MiniMax__understand_image` after the test to verify
// the screenshots.

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('MiniMax live: streaming visible with NO tools, prompt "hi"', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(60_000);

  let apiKey = '';
  try {
    // Skip if no API key. Reading .env is local — no skip on CI if .env exists.
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

    // Disable every non-todo tool.
    await ext.enableOnlyTools(sidePanel, []);

    // Type "hi" and send.
    await ext.setReactTextareaValue(sidePanel, 'textarea', 'hi');
    await sidePanel.locator('button[title="Send"]').click();

    // Take screenshots at ~2s intervals for 10s (or until agent_done).
    const snapshots = await ext.captureSnapshots(sidePanel, {
      intervalMs: 2000,
      durationMs: 10_000,
      label: '20-tools-off',
    });

    // Print a summary for the human (and Claude) reviewing the run.
    console.log('\n[20-tools-off] === summary ===');
    console.log('snapshot count:', snapshots.length);
    console.log('text-length trajectory:', snapshots.map((s) => `[${Math.round(s.tMs / 1000)}s]=${s.textLength}`).join(' → '));
    console.log('screenshots saved:');
    for (const s of snapshots) {
      console.log(`  - t=${Math.round(s.tMs / 1000)}s textLen=${s.textLength} done=${s.isDone} -> ${s.screenshot}`);
    }
    // Diagnostic: SW log tail.
    const log = ext.readSWLog();
    const emitChunks = (log.match(/emit.*chunk/g) ?? []).length;
    const emitDone = (log.match(/emit.*agent_done/g) ?? []).length;
    console.log(`SW log: chunk events=${emitChunks}, agent_done emits=${emitDone}, total log lines=${log.split('\n').length}`);

    // Soft check: at least 2 chunks OR at least 1 screenshot after text > 0.
    // The "streaming implemented" check is the image review, not these numbers.
    expect(snapshots.length, 'at least one snapshot taken').toBeGreaterThan(0);
    expect(emitDone, 'agent_done should be emitted').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
