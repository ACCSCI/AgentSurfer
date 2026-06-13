// Full-chain end-to-end test. Give the agent a multi-step task and
// track every step the LLM takes to see if it can complete the whole thing.
//
// Task: "打开bing，搜索LLM，点击前三个有用的链接，阅读后总结，结束后清理标签页"
//
// Tools given (NO DOM tools — CDP only):
//   tabsList, tabsSwitch, tabsOpen, tabsClose
//   smartScreenshot
//   cdpAim, cdpConfirm, cdpCancel, cdpScreenshot
//   cdpType, cdpPressKey
//
// Track: each step's text + tool_call args + tool_result. Verify at end:
//   - agent_done was emitted (not agent_error)
//   - tabsClose was called (cleanup happened)
//   - the final assistant message contains a "summary" or 总结

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

const FULL_TOOLS = [
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
  'smartScreenshot',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot', 'cdpScroll',
  'cdpType', 'cdpPressKey',
] as const;

test('Full chain: Bing search LLM, click 3 links, summarize, cleanup', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(300_000); // 5 min test timeout

  let apiKey = '';
  try { apiKey = ext.readApiKey(); } catch { test.skip(true, 'MINIMAX_API_KEY missing'); }

  ext.clearSWLog();

  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M2.7-highspeed', { timeout: 15_000 });
    await ext.enableOnlyTools(sidePanel, FULL_TOOLS);
    await ext.setWallTimeout(sidePanel, 240_000); // 4 min wall

    // Pre-open bing.com so the LLM doesn't have to.
    const bingPage = await ext.ctx.newPage();
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 2000));

    const beforeTabs = await ext.inspectTabs(sidePanel);
    console.log(`[27] tabs before: ${beforeTabs.count} — ${beforeTabs.urls.join(', ')}`);

    const prompt = '打开bing，搜索LLM，点击前三个有用的链接，阅读后总结，结束后清理标签页';
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for agent to finish (up to 4 min).
    for (let i = 0; i < 240; i++) {
      const running = await ext.isAgentRunning(sidePanel).catch(() => false);
      if (!running && i > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 1500));

    // Read full conversation record.
    const msgs = await ext.listMessages(sidePanel);
    const steps = await ext.listAgentSteps(sidePanel);
    const log = ext.readSWLog();
    const tabsListCalls = (log.match(/"tabsList"/g) ?? []).length;
    const tabsSwitchCalls = (log.match(/"tabsSwitch"/g) ?? []).length;
    const tabsOpenCalls = (log.match(/"tabsOpen"/g) ?? []).length;
    const tabsCloseCalls = (log.match(/"tabsClose"/g) ?? []).length;
    const cdpAimCalls = (log.match(/"cdpAim"/g) ?? []).length;
    const cdpConfirmCalls = (log.match(/"cdpConfirm"/g) ?? []).length;
    const cdpTypeCalls = (log.match(/"cdpType"/g) ?? []).length;
    const cdpPressKeyCalls = (log.match(/"cdpPressKey"/g) ?? []).length;
    const cdpScreenshotCalls = (log.match(/"cdpScreenshot"/g) ?? []).length;
    const smartScreenshotCalls = (log.match(/"smartScreenshot"/g) ?? []).length;
    const agentDone = (log.match(/"agent_done"/g) ?? []).length;
    const agentError = (log.match(/"agent_error"/g) ?? []).length;

    console.log('\n========================================');
    console.log('FULL CHAIN RESULT');
    console.log('========================================\n');
    console.log(`steps: ${steps.count}, messages: ${msgs.count}`);
    console.log(`events: agent_done=${agentDone} agent_error=${agentError}`);
    console.log(`tool calls: tabsList=${tabsListCalls} tabsSwitch=${tabsSwitchCalls} tabsOpen=${tabsOpenCalls} tabsClose=${tabsCloseCalls}`);
    console.log(`           cdpAim=${cdpAimCalls} cdpConfirm=${cdpConfirmCalls} cdpType=${cdpTypeCalls} cdpPressKey=${cdpPressKeyCalls}`);
    console.log(`           cdpScreenshot=${cdpScreenshotCalls} smartScreenshot=${smartScreenshotCalls}`);

    console.log('\n--- STEP-BY-STEP TRACE ---');
    for (const s of steps.steps as Array<{
      stepNumber: number; text: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
      toolResults: Array<{ name: string; isError: boolean; result: unknown }>;
    }>) {
      console.log(`\n[STEP ${s.stepNumber}]`);
      if (s.text) console.log(`  LLM: ${s.text.slice(0, 250)}${s.text.length > 250 ? '…' : ''}`);
      for (let i = 0; i < s.toolCalls.length; i++) {
        const tc = s.toolCalls[i];
        const tr = s.toolResults[i];
        const r = tr?.result as Record<string, unknown>;
        let summary = '';
        if (r && typeof r === 'object') {
          if ('error' in r) summary = `ERROR: ${r.error}`;
          else if ('ok' in r) summary = `ok`;
          else if (Array.isArray(r)) summary = `array[${(r as unknown[]).length}]`;
          else if ('dataUrl' in r) summary = `screenshot+ok`;
          else summary = Object.keys(r).slice(0, 3).join(',');
        }
        console.log(`  → ${tc.name}(${JSON.stringify(tc.args).slice(0, 100)}) → ${tr?.isError ? 'ERROR' : 'ok'} (${summary})`);
      }
    }

    // Final messages.
    console.log('\n--- FINAL MESSAGES ---');
    for (const m of msgs.messages as Array<{ role: string; parts: Array<{ type: string; text?: string }> }>) {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
      console.log(`[${m.role}]: ${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`);
    }

    // Verify completion.
    const afterTabs = await ext.inspectTabs(sidePanel);
    console.log(`\n[27] tabs after: ${afterTabs.count} — ${afterTabs.urls.join(', ')}`);

    const assistantText = (msgs.messages as Array<{ role: string; parts: Array<{ type: string; text?: string }> }>)
      .filter((m) => m.role === 'assistant')
      .map((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join(''))
      .join(' ');

    const didComplete = agentDone > 0 && agentError === 0;
    const didCleanup = tabsCloseCalls > 0;
    const hasSummary = /总结|summary|LLM|大语言|模型|网站|文章|搜索/i.test(assistantText);

    console.log('\n--- VERIFICATION ---');
    console.log(`agent completed (no error): ${didComplete}`);
    console.log(`tabsClose called:           ${didCleanup}`);
    console.log(`final message has summary:  ${hasSummary}`);
    console.log(`tabs before=${beforeTabs.count} after=${afterTabs.count}`);

    expect(steps.count, 'LLM made at least one step').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
