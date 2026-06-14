// Diagnostic: capture the FULL conversation record (user msg, assistant msgs,
// every agentStep with text + toolCall args + toolResults) and print it.
// Used to verify what the LLM actually said about coordinates / directions.

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

const CORE_TOOLS = [
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
  'smartScreenshot',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot',
] as const;

test('Diagnostic: full conversation record for aim task', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(60_000);

  let apiKey = '';
  try { apiKey = ext.readApiKey(); } catch { test.skip(true, 'MINIMAX_API_KEY missing'); }

  ext.clearSWLog();

  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 15_000 });
    await ext.enableOnlyTools(sidePanel, CORE_TOOLS);

    const bingPage = await ext.ctx.newPage();
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 1500));

    // The exact prompt — note the (640, 200) coordinate hint.
    const prompt = '请用 cdpAim 在 bing 搜索框中心位置画一个红色十字，坐标大约 (640, 200)。如果搜索框不在那个位置，agent 自己用 cdpScreenshot + cdpAim 找到并 aim 上去。只 aim 不点击。完成后请说明你 aim 的坐标。';
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for agent to finish (or timeout).
    for (let i = 0; i < 30; i++) {
      const running = await ext.isAgentRunning(sidePanel).catch(() => false);
      if (!running && i > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Extra 500ms for final Dexie writes.
    await new Promise((r) => setTimeout(r, 500));

    // Read the full conversation record.
    const msgs = await ext.listMessages(sidePanel);
    const steps = await ext.listAgentSteps(sidePanel);

    console.log('\n========================================');
    console.log('FULL CONVERSATION RECORD');
    console.log('========================================\n');

    console.log(`-- ${msgs.count} MESSAGE(S) --`);
    for (const m of msgs.messages as Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }>; createdAt: number }>) {
      console.log(`[${m.role}] (${new Date(m.createdAt).toISOString()}) id=${m.id.slice(0, 8)}`);
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) {
          console.log(`  text: ${JSON.stringify(p.text)}`);
        } else if (p.type === 'reasoning' && (p as { reasoning?: string }).reasoning) {
          console.log(`  reasoning: ${JSON.stringify((p as { reasoning: string }).reasoning)}`);
        } else {
          console.log(`  part: ${p.type}`);
        }
      }
      console.log('');
    }

    console.log(`\n-- ${steps.count} AGENT STEP(S) --`);
    for (const s of steps.steps as Array<{
      id: string; stepNumber: number; text: string; toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
      toolResults: Array<{ toolCallId: string; name: string; result: unknown; isError: boolean }>;
    }>) {
      console.log(`\n[step ${s.stepNumber}] id=${s.id.slice(0, 8)}`);
      if (s.text) console.log(`  text: ${JSON.stringify(s.text)}`);
      for (const tc of s.toolCalls) {
        console.log(`  tool_call: ${tc.name}(${JSON.stringify(tc.args)})`);
      }
      for (const tr of s.toolResults) {
        const resultStr = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result).slice(0, 200);
        console.log(`  tool_result: ${tr.name} isError=${tr.isError} -> ${resultStr}`);
      }
    }

    console.log('\n========================================\n');
    expect(msgs.count, 'at least the user message is persisted').toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
