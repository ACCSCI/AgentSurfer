// E2E: agent drives a search-engine mock page using ONLY CDP + screenshot tools.
//
// Fixture: http://localhost:4173/e2e/fixtures/search-engine/index.html
//   - Mimics Baidu/Bing/Google (logo + big search input + search button)
//   - Bottom of page has a red 「开始」 button that MUST be clicked first to
//     activate the search row (input + button are disabled until then)
//   - State machine: body.dataset.state ∈ {initial, started, typed, searched}
//                    body.dataset.query  = whatever was typed
//
// Tools given (NO DOM tools — CDP-only):
//   tabsList, tabsSwitch,
//   cdpAim, cdpConfirm, cdpCancel, cdpScreenshot, cdpClick,
//   cdpType, cdpPressKey
//
// Task: switch to the fixture tab, then use cdpAim → cdpConfirm + cdpType to:
//   1. click the red 「开始」 button at the bottom of the page
//   2. click the search input (white box in the middle)
//   3. cdpType "你好aBc"
//   4. click the blue 「搜一下」 button
//
// Final assertion: body.dataset.state === 'searched' AND body.dataset.query === '你好aBc'.
//
// Run: `bun run build && SKIP_BUILD=1 bun run e2e e2e/specs/41-search-engine-cdp.spec.ts`
// Pre-req: `bun run e2e:serve` must be running on port 4173.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

const FIXTURE_URL = 'http://localhost:4173/e2e/fixtures/search-engine/index.html';
const EXPECTED_QUERY = '你好aBc';

const CDP_TOOLS = [
  'tabsList', 'tabsSwitch',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpClick',
  'cdpType', 'cdpPressKey',
  'cdpScreenshot',
] as const;

test('CDP-only: agent clicks start → types query → clicks search on a Baidu-like page', async () => {
  test.setTimeout(90_000); // 1m30s hard cap — fail fast, iterate fast

  // Skip gracefully when MINIMAX_API_KEY is missing (CI without secrets).
  let apiKey = '';
  try {
    apiKey = readFileSync(resolve('.env'), 'utf-8').match(/^MINIMAX_API_KEY=(.+)$/m)?.[1]?.trim() ?? '';
  } catch { /* ignore */ }
  if (!apiKey) {
    test.skip(true, 'MINIMAX_API_KEY missing from .env — skipping real-LLM test');
    return;
  }

  const ext = await launchWithExtension();
  ext.clearSWLog();

  try {
    // 1. Open side panel + seed live MiniMax config.
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 15_000 });

    // 2. Restrict to CDP + tabs only — DOM tools are explicitly disabled so the
    //    agent must use the visual servoing loop (cdpAim → compare → cdpConfirm).
    await ext.enableOnlyTools(sidePanel, CDP_TOOLS);
    await ext.setWallTimeout(sidePanel, 60_000); // 60s agent wall — matches 90s test cap

    // 3. Pre-open the fixture so the agent only needs to switch tabs.
    const fixturePage = await ext.ctx.newPage();
    await fixturePage.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    // Sanity-check the initial state before the agent touches anything.
    const initialState = await fixturePage.evaluate(() => ({
      state: document.body.dataset.state,
      query: document.body.dataset.query,
    }));
    console.log('[fixture] initial state:', initialState);
    expect(initialState.state, 'fixture should boot in "initial" state').toBe('initial');

    // Find the tab id so we can point the agent at it (mirrors spec 40).
    const tabs = await ext.inspectTabs(sidePanel);
    const idx = tabs.urls.findIndex((u) => u.includes('/search-engine/'));
    if (idx < 0) throw new Error('fixture tab not found in inspected tabs');
    const tabId = tabs.ids[idx];
    console.log(`[fixture] tabId=${tabId}`);

    // 4. Prompt — pure visual description. NO coordinates, NO dpr, NO coordinate
    //    system explanation. Trust the agent to find targets visually. The
    //    cdpAim tool itself reports the screen-center coordinates in every
    //    response so the agent always has an anchor to aim at.
    const prompt = [
      `Switch to the search-engine fixture tab (id ${tabId}) using tabsList → tabsSwitch.`,
      ``,
      `Drive the page using ONLY cdpScreenshot / cdpAim / cdpConfirm / cdpCancel / cdpType (dom tools are DISABLED).`,
      ``,
      `The page looks like a search engine homepage (similar to Baidu / Bing / Google). Three elements to click, in order:`,
      ``,
      `  ELEMENT A — a big RED pill-shaped button labeled "开始" at the BOTTOM-CENTER of the page. Only red element on the page.`,
      `  ELEMENT B — a white rounded search input box in the MIDDLE of the page (left half of the search row). Contains placeholder text "请输入搜索内容…".`,
      `  ELEMENT C — a BLUE rounded button labeled "搜一下" immediately to the RIGHT of the search input. Only blue button on the page.`,
      ``,
      `Elements B and C start GREYED OUT. They only become clickable after you click A first.`,
      ``,
      `Top-right status indicator tracks state: starts as "state: initial", advances to "started" when A is clicked, "typed" after text is entered, "searched" after C is clicked.`,
      ``,
      `Procedure:`,
      `  1. cdpScreenshot to see the page.`,
      `  2. cdpAim at Element A (red "开始" at bottom-center) → cdpConfirm when the crosshair is on the button.`,
      `  3. cdpAim at Element B (white search input in middle) → cdpConfirm when on the input.`,
      `  4. cdpType("你好aBc") into the focused input.`,
      `  5. cdpAim at Element C (blue "搜一下" right of the input) → cdpConfirm.`,
      ``,
      `If you don't know where to aim first, use the screen-center coordinates that cdpAim reports in every response — that puts the crosshair at the visual middle of the screen so you can see it, then adjust from there.`,
      ``,
      `Stop as soon as the top-right status reads "state: searched" with q="你好aBc". Reply with one short sentence confirming success.`,
    ].join('\n');

    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();
    console.log('[41-search] prompt sent, waiting for state="searched"…');

    // 5. Poll the fixture page for the terminal state. 5 min budget.
    const FINAL_STATE = 'searched';
    await fixturePage.waitForFunction(
      ({ state, q }) => {
        const ds = document.body.dataset.state;
        const dq = document.body.dataset.query;
        return ds === state && dq === q;
      },
      { state: FINAL_STATE, q: EXPECTED_QUERY },
      { timeout: 5 * 60_000, polling: 1000 },
    );

    const finalState = await fixturePage.evaluate(() => ({
      state: document.body.dataset.state,
      query: document.body.dataset.query,
    }));
    console.log('[fixture] FINAL state:', finalState);

    await fixturePage.screenshot({ path: '.e2e-logs/41-search-engine-final.png', fullPage: true });
    await sidePanel.screenshot({ path: '.e2e-logs/41-search-engine-sidepanel.png', fullPage: true });

    expect(finalState.state, 'fixture should reach "searched" state').toBe(FINAL_STATE);
    expect(finalState.query, `typed query should equal ${JSON.stringify(EXPECTED_QUERY)}`).toBe(EXPECTED_QUERY);

    // Trajectory summary from persisted steps.
    const steps = await ext.listAgentSteps(sidePanel);
    const log = ext.readSWLog();
    const cdpAimCalls = (log.match(/"cdpAim"/g) ?? []).length;
    const cdpConfirmCalls = (log.match(/"cdpConfirm"/g) ?? []).length;
    const cdpTypeCalls = (log.match(/"cdpType"/g) ?? []).length;
    const agentDone = (log.match(/agent_done/g) ?? []).length;
    const agentError = (log.match(/agent_error/g) ?? []).length;
    console.log('\n========================================');
    console.log('SEARCH-ENGINE FLOW RESULT');
    console.log('========================================');
    console.log(`steps: ${steps.count}`);
    console.log(`tool calls: cdpAim=${cdpAimCalls} cdpConfirm=${cdpConfirmCalls} cdpType=${cdpTypeCalls}`);
    console.log(`events: agent_done=${agentDone} agent_error=${agentError}`);
    console.log(`fixture state: ${finalState.state} query=${JSON.stringify(finalState.query)}`);

    expect(cdpTypeCalls, 'agent should have called cdpType at least once').toBeGreaterThan(0);
    expect(cdpConfirmCalls, 'agent should have called cdpConfirm at least 3x (start, input, search)').toBeGreaterThanOrEqual(3);
    expect(agentError, 'no agent_error should have fired').toBe(0);
  } finally {
    await ext.cleanup();
  }
});