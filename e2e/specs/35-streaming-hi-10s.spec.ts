// Streaming verification: send "hi", capture side panel screenshots at
// 500ms intervals for 10s. The whole point of this test is to confirm
// the MessageStore → side-panel port pipeline actually streams text to
// the UI in real time (multiple distinct state updates from the SW port
// carry intermediate textLength values, not just the final length).
//
// We check streaming in two complementary ways:
//   1. **Visual snapshots** — `[data-testid="message-text"]` length over
//      time. If the response is short (<2s of streaming), the snapshots
//      may miss the in-between frames, but the final length must be > 0.
//   2. **Port update log** — useMessageStore logs each state update via
//      `[AgentSurfer][msgstore] update #N textLen=X reasoningLen=Y`.
//      We count these in the side-panel console. If the count is > 2
//      with strictly increasing textLength values, that proves the
//      port pushed intermediate states, not just the final one.

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('streaming visible: prompt "hi", 500ms screenshots for 10s', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(60_000);

  let apiKey = '';
  try { apiKey = ext.readApiKey(); } catch { test.skip(true, 'MINIMAX_API_KEY missing'); }

  ext.clearSWLog();

  // Collect side-panel console messages so we can count [msgstore] updates.
  const spConsole: string[] = [];
  const origPageOn = (page: import('@playwright/test').Page) => {
    page.on('console', (msg) => {
      spConsole.push(`[${msg.type()}] ${msg.text()}`);
    });
  };

  try {
    const { page: sidePanel } = await ext.openSidePanel();
    origPageOn(sidePanel);
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 15_000 });

    // Re-attach the listener — reload() created a new page handle? No,
    // the same page object survives reload, but the listener above is
    // still wired. Just confirm we still see logs.
    await ext.enableOnlyTools(sidePanel, []);

    await ext.setReactTextareaValue(sidePanel, 'textarea', 'hi');
    await sidePanel.locator('button[title="Send"]').click();

    // 10s window, 500ms interval. captureSnapshots stops early on isDone.
    const snapshots = await ext.captureSnapshots(sidePanel, {
      intervalMs: 500,
      durationMs: 10_000,
      label: '35-hi-stream',
    });

    const lengths = snapshots.map((s) => s.textLength);
    const distinct = new Set(lengths).size;
    const last = lengths[lengths.length - 1] ?? 0;

    console.log('\n[35-hi-stream] === summary ===');
    console.log(`snapshots taken:  ${snapshots.length}`);
    console.log(`text lengths:     ${lengths.join(', ')}`);
    console.log(`distinct lengths: ${distinct}`);
    console.log(`final length:     ${last}`);

    // Extract the [msgstore] update log lines from the side-panel console.
    const updateLines = spConsole.filter((l) => l.includes('[AgentSurfer][msgstore] update'));
    const updates = updateLines.map((l) => {
      const m = l.match(/textLen=(\d+) reasoningLen=(\d+) status=(\w+)/);
      if (!m) return null;
      return { textLen: Number(m[1]), reasoningLen: Number(m[2]), status: m[3] };
    }).filter((x): x is { textLen: number; reasoningLen: number; status: string } => x !== null);

    console.log(`\n[msgstore] updates received by side panel: ${updates.length}`);
    for (const u of updates) {
      console.log(`  textLen=${u.textLen} reasoningLen=${u.reasoningLen} status=${u.status}`);
    }

    const log = ext.readSWLog();
    const chunkEmits = (log.match(/emit.*chunk/g) ?? []).length;
    const agentDoneEmits = (log.match(/emit.*agent_done/g) ?? []).length;
    const beginRunLogs = (log.match(/run draft message opened/g) ?? []).length;
    const addUserMsgLogs = (log.match(/user_message added to MessageStore/g) ?? []).length;
    console.log(`\nSW log: chunks=${chunkEmits}, agent_done=${agentDoneEmits}`);
    console.log(`         beginRun=${beginRunLogs}, addUserMessage=${addUserMsgLogs}`);

    // ---- Streaming assertions ----
    // 1. The agent completed (agent_done emitted, final text non-empty).
    expect(agentDoneEmits, 'agent_done should be emitted').toBeGreaterThan(0);
    expect(last, 'final text length > 0').toBeGreaterThan(0);

    // 2. The MessageStore pipeline was actually exercised.
    expect(addUserMsgLogs, 'addUserMessage should have been logged').toBeGreaterThan(0);
    expect(beginRunLogs, 'beginRun should have been logged').toBeGreaterThan(0);

    // 3. The side panel received multiple port updates. This is the proof
    //    of streaming: the SW port pushed intermediate states, not just
    //    the final one. We need >=3 updates to demonstrate "more than
    //    all-or-nothing".
    expect(updates.length, `expected multiple port updates, saw ${updates.length}`).toBeGreaterThanOrEqual(3);

    // 4. At least 2 distinct text lengths were observed in the updates
    //    for the ASSISTANT message. The user message (textLen=2 for "hi")
    //    comes first, then the draft assistant message starts at 0 and
    //    grows. We filter to updates with status='draft' (the assistant
    //    bubble) so we're measuring the streaming message only.
    const draftUpdates = updates.filter((u) => u.status === 'draft');
    const distinctTextLens = new Set(draftUpdates.map((u) => u.textLen)).size;
    console.log(`draft message updates: ${draftUpdates.length}, distinct textLens: ${distinctTextLens}`);
    expect(
      distinctTextLens,
      `expected streaming: saw ${distinctTextLens} distinct text lengths in draft message updates (lengths: ${draftUpdates.map((u) => u.textLen).join(',')})`,
    ).toBeGreaterThanOrEqual(2);

    // 5. The max text length in draft updates is > 0 — proof the stream
    //    actually delivered characters (not just status flips).
    const maxDraftLen = Math.max(0, ...draftUpdates.map((u) => u.textLen));
    expect(maxDraftLen, 'max draft message text length should be > 0').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});

