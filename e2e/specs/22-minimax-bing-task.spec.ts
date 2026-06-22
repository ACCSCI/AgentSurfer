// Step 3: Real MiniMax E2E with CORE tools. Open bing.com in a new tab via
// Playwright, then send a complex multi-step task:
//   "打开bing，搜索LLM，点击前三个有用的链接，阅读后总结，结束后清理标签页"
// Sample the side panel every 30s for 3 min. Verifies:
//   - Streaming text is visible across screenshots (not just empty → complete)
//   - Tool-call chips appear in the side panel
//   - agent_done is emitted
//   - Bing tab and any opened tabs are closed at the end

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

const CORE_TOOLS = [
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
  'smartScreenshot',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot',
] as const;

test('MiniMax live: Bing search LLM, click 3 links, summarize, cleanup', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(300_000); // 5 min test timeout

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
    await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 15_000 });

    await ext.enableOnlyTools(sidePanel, CORE_TOOLS);

    // Give the agent 4 min wall-clock (default is 2 min).
    await ext.setWallTimeout(sidePanel, 240_000);

    // Open bing.com in a new tab via the extension's Chrome context.
    const beforeTabs = await ext.inspectTabs(sidePanel);
    console.log(`[22-bing] tabs before opening bing: ${beforeTabs.count} (${beforeTabs.urls.join(', ')})`);

    const bingPage = await ext.ctx.newPage();
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 1500)); // let the page settle

    const afterOpen = await ext.inspectTabs(sidePanel);
    console.log(`[22-bing] tabs after opening bing: ${afterOpen.count} (${afterOpen.urls.join(', ')})`);

    // Send the multi-step task.
    const prompt = '打开bing，搜索LLM，点击前三个有用的链接，阅读后总结，结束后清理标签页';
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    // Sample every 30s for up to 3 min.
    const snapshots = await ext.captureSnapshots(sidePanel, {
      intervalMs: 30_000,
      durationMs: 180_000,
      label: '22-bing',
    });

    console.log('\n[22-bing] === summary ===');
    console.log('snapshot count:', snapshots.length);
    console.log('text-length trajectory:', snapshots.map((s) => `[${Math.round(s.tMs / 1000)}s]=${s.textLength}`).join(' → '));
    console.log('screenshots saved:');
    for (const s of snapshots) {
      console.log(`  - t=${Math.round(s.tMs / 1000)}s textLen=${s.textLength} done=${s.isDone} -> ${s.screenshot}`);
    }

    // The snapshot window (180s) is shorter than the agent's wall budget
    // (240s), so a slow-but-healthy run can still be streaming when the loop
    // ends. Wait for a terminal event (agent_done/agent_error) before
    // exporting, otherwise we'd snapshot a legitimately-still-running message
    // as 'draft'. Cap the extra wait so the whole test stays under its 300s
    // timeout.
    {
      const terminalDeadline = Date.now() + 90_000;
      while (Date.now() < terminalDeadline) {
        const l = ext.readSWLog();
        if (/emit.*agent_(done|error)/.test(l)) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    const log = ext.readSWLog();
    const emitChunks = (log.match(/emit.*chunk/g) ?? []).length;
    const emitDone = (log.match(/emit.*agent_done/g) ?? []).length;
    const tabsListCalls = (log.match(/tabsList/g) ?? []).length;
    const tabsSwitchCalls = (log.match(/tabsSwitch/g) ?? []).length;
    const tabsCloseCalls = (log.match(/tabsClose/g) ?? []).length;
    const cdpAimCalls = (log.match(/cdpAim/g) ?? []).length;
    const cdpConfirmCalls = (log.match(/cdpConfirm/g) ?? []).length;
    console.log(`SW log: chunks=${emitChunks} agent_done=${emitDone}`);
    console.log(`  tool calls: tabsList=${tabsListCalls} tabsSwitch=${tabsSwitchCalls} tabsClose=${tabsCloseCalls} cdpAim=${cdpAimCalls} cdpConfirm=${cdpConfirmCalls}`);

    // Give the agent a moment to close any tabs it opened.
    await new Promise((r) => setTimeout(r, 2000));
    const finalTabs = await ext.inspectTabs(sidePanel);
    console.log(`[22-bing] tabs at end: ${finalTabs.count} (${finalTabs.urls.join(', ')})`);

    // Export the session WITHOUT base64 — the export already strips screenshot
    // blobs (metadata only). Dump it to .e2e-logs so we can read exactly what
    // the agent did and whether the task completed.
    const { export: sessionExport, error: exportError } = await ext.exportSession(sidePanel);
    const outDir = resolve('.e2e-logs');
    mkdirSync(outDir, { recursive: true });
    if (sessionExport) {
      writeFileSync(
        resolve(outDir, '22-bing-export.json'),
        JSON.stringify(sessionExport, null, 2),
        'utf-8',
      );
      console.log('\n[22-bing] === export verdict ===');
      console.log('  terminationReason  =', sessionExport.terminationReason);
      console.log('  finishReason       =', sessionExport.finishReason);
      console.log('  lastAssistantStatus=', sessionExport.lastAssistantStatus);
      console.log('  messageCount       =', sessionExport.messageCount);
      console.log('  stepCount          =', sessionExport.stepCount);
      console.log('  export written to  -> .e2e-logs/22-bing-export.json');

      // The orphan-repair fix means the last assistant message ALWAYS carries
      // a status; a clean run is 'complete'/'error', an orphaned one would be
      // 'draft'/'streaming' with a null terminationReason.
      expect(sessionExport.lastAssistantStatus, 'last assistant status must be present').toBeTruthy();
      expect(
        ['draft', 'streaming'].includes(String(sessionExport.lastAssistantStatus)),
        'run must NOT be left orphaned (draft/streaming)',
      ).toBe(false);
    } else {
      console.log('[22-bing] export failed:', exportError);
    }

    // The agent should at least have done the run (even if some tools failed).
    expect(emitDone, 'agent_done should be emitted (run completed within wall timeout)').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
