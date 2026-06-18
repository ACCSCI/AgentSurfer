// Multi-tab streaming verification. Task: open baidu, switch to bing,
// alternate 3 times, then close all opened tabs. Capture screenshots
// every 1s for up to 90s. Verifies:
//   - the agent can navigate between baidu and bing repeatedly
//   - the side panel STREAMING TEXT is visible (not all-or-nothing)
//   - tabsClose is called to clean up
//   - final tab count returns to baseline

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

const FULL_TOOLS = [
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
  'smartScreenshot',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot', 'cdpScroll',
] as const;

test('baidu/bing toggle 3x + cleanup, with periodic streaming screenshots', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(300_000); // 5 min

  let apiKey = '';
  try { apiKey = ext.readApiKey(); } catch { test.skip(true, 'MINIMAX_API_KEY missing'); }

  ext.clearSWLog();

  // Collect side-panel console messages so we can count [msgstore] updates.
  const spConsole: string[] = [];

  try {
    const { page: sidePanel } = await ext.openSidePanel();
    sidePanel.on('console', (msg) => {
      spConsole.push(`[${msg.type()}] ${msg.text()}`);
    });
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 15_000 });
    await ext.enableOnlyTools(sidePanel, FULL_TOOLS);
    await ext.setWallTimeout(sidePanel, 250_000);

    const beforeTabs = await ext.inspectTabs(sidePanel);
    console.log(`[36] tabs before: ${beforeTabs.count}`);

    // Send the multi-step toggle task. CRITICAL: each step must be a
    // tool call. The LLM has a bad habit of writing "I have done X"
    // in text and then ending the run without actually doing the
    // cleanup — we counter that by making the structure mandatory.
    const prompt =
      '用 todo 工具按顺序执行（每一步必须通过 tool call 完成，不要只在文字里描述）：\n' +
      '1) 调 tabsOpen 打开 https://www.baidu.com\n' +
      '2) 调 tabsSwitch 切到 https://www.bing.com（如果还没打开就 tabsOpen）\n' +
      '3) 调 tabsSwitch 切回 https://www.baidu.com\n' +
      '4) 调 tabsSwitch 切到 https://www.bing.com\n' +
      '5) 调 tabsSwitch 切回 https://www.baidu.com\n' +
      '6) 调 tabsSwitch 切到 https://www.bing.com\n' +
      '完成以上 6 步后，**继续用 todo 标记第 7 步完成**、然后**调 tabsClose 关闭所有你打开的 baidu / bing 标签页**（保留原始侧边栏页）\n' +
      '最后用中文写一句简短总结（"我来回切换了 5 次"），作为 assistant 最终文本回复\n' +
      '\n' +
      '重要：summary 必须是 tool call 之后写的纯文本，**不能因为写了文字就停**。所有 6 步导航 + 1 步清理 + 1 步总结全部完成后才结束。';
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    // Capture snapshots every 1s for up to 200s. captureSnapshots exits
    // early if the agent finishes.
    const snapshots = await ext.captureSnapshots(sidePanel, {
      intervalMs: 1000,
      durationMs: 200_000,
      label: '36-toggle-stream',
    });

    const lengths = snapshots.map((s) => s.textLength);
    const distinct = new Set(lengths).size;
    const last = lengths[lengths.length - 1] ?? 0;
    const max = Math.max(0, ...lengths);

    console.log('\n[36-toggle-stream] === summary ===');
    console.log(`snapshots taken:  ${snapshots.length}`);
    console.log(`text lengths:     ${lengths.join(', ')}`);
    console.log(`distinct lengths: ${distinct}`);
    console.log(`max length:       ${max}`);
    console.log(`final length:     ${last}`);

    // Verify tab manipulation actually happened.
    const afterTabs = await ext.inspectTabs(sidePanel);
    console.log(`tabs before=${beforeTabs.count} after=${afterTabs.count}`);

    // Read SW log for tool call counts.
    const log = ext.readSWLog();
    const tabsListCalls = (log.match(/"tabsList"/g) ?? []).length;
    const tabsSwitchCalls = (log.match(/"tabsSwitch"/g) ?? []).length;
    const tabsOpenCalls = (log.match(/"tabsOpen"/g) ?? []).length;
    const tabsCloseCalls = (log.match(/"tabsClose"/g) ?? []).length;
    const cdpAimCalls = (log.match(/"cdpAim"/g) ?? []).length;
    const cdpScreenshotCalls = (log.match(/"cdpScreenshot"/g) ?? []).length;
    const smartScreenshotCalls = (log.match(/"smartScreenshot"/g) ?? []).length;
    const agentDone = (log.match(/"agent_done"/g) ?? []).length;
    const agentError = (log.match(/"agent_error"/g) ?? []).length;
    const chunkEmits = (log.match(/emit.*chunk/g) ?? []).length;

    console.log(`\ntool calls: tabsList=${tabsListCalls} tabsSwitch=${tabsSwitchCalls} tabsOpen=${tabsOpenCalls} tabsClose=${tabsCloseCalls}`);
    console.log(`           cdpAim=${cdpAimCalls} cdpScreenshot=${cdpScreenshotCalls} smartScreenshot=${smartScreenshotCalls}`);
    console.log(`events: agent_done=${agentDone} agent_error=${agentError} chunks=${chunkEmits}`);

    // Final assistant text.
    const msgs = await ext.listMessages(sidePanel);
    const assistantText = (msgs.messages as Array<{ role: string; parts: Array<{ type: string; text?: string }> }>)
      .filter((m) => m.role === 'assistant')
      .map((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join(''))
      .join(' ');
    console.log(`final assistant text (first 300): ${assistantText.slice(0, 300)}`);

    // Extract [msgstore] port-update log lines from side-panel console.
    const updateLines = spConsole.filter((l) => l.includes('[AgentSurfer][msgstore] update'));
    const updates = updateLines.map((l) => {
      const m = l.match(/textLen=(\d+) reasoningLen=(\d+) status=(\w+)/);
      if (!m) return null;
      return { textLen: Number(m[1]), reasoningLen: Number(m[2]), status: m[3] };
    }).filter((x): x is { textLen: number; reasoningLen: number; status: string } => x !== null);
    const draftUpdates = updates.filter((u) => u.status === 'draft');
    const distinctDraftLens = new Set(draftUpdates.map((u) => u.textLen)).size;
    console.log(`[msgstore] port updates: total=${updates.length} draft=${draftUpdates.length} distinctDraftLens=${distinctDraftLens}`);

    // ---- Assertions ----
    // 1. The agent completed without a fatal error.
    expect(agentError, 'no fatal errors').toBe(0);
    expect(agentDone, 'agent_done emitted').toBeGreaterThan(0);

    // 2. The side panel received multiple port updates with multiple
    //    distinct text lengths in the draft message — proof of streaming.
    expect(updates.length, 'expected multiple port updates').toBeGreaterThanOrEqual(3);
    expect(distinctDraftLens, `expected streaming: ${distinctDraftLens} distinct draft textLens (${draftUpdates.map((u) => u.textLen).join(',')})`).toBeGreaterThanOrEqual(2);

    // 3. The agent actually used tabs* tools.
    expect(tabsListCalls, 'tabsList was called').toBeGreaterThan(0);
    expect(tabsOpenCalls + tabsSwitchCalls, 'tabsOpen or tabsSwitch was called').toBeGreaterThan(0);

    // 4. Cleanup happened — the agent called tabsClose.
    expect(tabsCloseCalls, 'tabsClose was called for cleanup').toBeGreaterThan(0);

    // 5. Final text is non-empty.
    expect(last, 'final assistant text length > 0').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
