// E2E: agent drives a search-engine mock page using ONLY CDP + screenshot tools.
//
// Fixture: http://localhost:4173/e2e/fixtures/search-engine/index.html
//   - Mimics Baidu/Bing/Google (logo + big search input + search button)
//   - Bottom of page has a red 「开始」 button that MUST be clicked first to
//     activate the search row (input + button are disabled until then)
//   - State machine: body.dataset.state ∈ {initial, started, typed, searched}
//                    body.dataset.query  = whatever was typed
//
// Tools given (NO DOM tools, NO cdpClick — CDP-only aim/confirm flow):
//   tabsList, tabsSwitch,
//   cdpAim, cdpConfirm, cdpCancel, cdpScreenshot,
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
  'cdpAim', 'cdpConfirm', 'cdpCancel',
  'cdpType', 'cdpPressKey',
  'cdpScreenshot', 'cdpGridScreenshot',
] as const;

test('CDP-only: agent clicks start → types query → clicks search on a Baidu-like page', async () => {
  test.setTimeout(180_000); // 3 min — covers 2min wall + final-state polling

  // Import fs for saving cdpAim AFTER screenshots to disk.
  const fsPromises = await import('node:fs/promises');
  await fsPromises.mkdir('.e2e-logs', { recursive: true });

  // Skip gracefully when the API key is missing (CI without secrets).
  // Try STEPFUN_API_KEY first (project recommended provider for UI automation),
  // fall back to MINIMAX_API_KEY for backward compat.
  let apiKey = '';
  let envVar = 'STEPFUN_API_KEY';
  try {
    const env = readFileSync(resolve('.env'), 'utf-8');
    apiKey = env.match(/^STEPFUN_API_KEY=(.+)$/m)?.[1]?.trim()
      ?? env.match(/^MINIMAX_API_KEY=(.+)$/m)?.[1]?.trim()
      ?? '';
    if (apiKey && !env.match(/^STEPFUN_API_KEY=/m)) envVar = 'MINIMAX_API_KEY';
  } catch { /* ignore */ }
  if (!apiKey) {
    test.skip(true, 'STEPFUN_API_KEY / MINIMAX_API_KEY missing from .env — skipping real-LLM test');
    return;
  }

  const ext = await launchWithExtension();
  ext.clearSWLog();

  // E2E hook: when the SW logs an `[AGENT_DEBUG_AIM_STEP] ...` line,
  // we save the dataUrl to a PNG. Listen on the SW console stream.
  // The flag is set on the SW's `globalThis` so cdpAim can dump
  // every AFTER screenshot to console.
  await ext.sw.evaluate(`(globalThis.__AGENT_DEBUG__ = true)`);

  try {
    // E2E: capture every cdpAim AFTER screenshot by grepping the SW
    // console for `[AGENT_DEBUG_AIM_STEP]`. The SW dumps the dataUrl
    // there when `globalThis.__AGENT_DEBUG__` is true. We save each
    // dataUrl to .e2e-logs/ as a PNG.
    ext.sw.on('console', async (msg) => {
      const text = msg.text();
      // Format: [AGENT_DEBUG_AIM_STEP] step=N mode=absolute|relative x=X y=Y size=S color=C dataUrl=...
      // mode is optional (added when cdpAim gained dual-mode support) — match either with or without it.
      const match = text.match(/\[AGENT_DEBUG_AIM_STEP\]\s+step=(\d+)(?:\s+mode=(\w+))?\s+x=(-?\d+)\s+y=(-?\d+)\s+size=(\d+)\s+color=(\w+)\s+dataUrl=(data:image\/png;base64,[A-Za-z0-9+/=]+)/);
      if (!match) return;
      const [, step, , x, y, size, color, dataUrl] = match;
      const buf = Buffer.from(
        dataUrl.replace(/^data:image\/png;base64,/, ''),
        'base64',
      );
      const path = `.e2e-logs/41-cdpAim-step${step}-x${x}y${y}size${size}-${color}-AFTER.png`;
      try {
        await fsPromises.writeFile(path, buf);
        console.log(`[41-search] saved cdpAim AFTER → ${path}`);
      } catch (err) {
        console.log(`[41-search] save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // 1. Open side panel + seed live config. Prefer stepfun for UI
    //    automation; fall back to MiniMax if no STEPFUN_API_KEY.
    const provider: 'stepfun' | 'MiniMax' = envVar === 'STEPFUN_API_KEY' ? 'stepfun' : 'MiniMax';
    const modelLabel = provider === 'stepfun' ? 'step-3.7-flash' : 'MiniMax-M3';
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    // reasoningEffort=low → faster iteration, less per-step thinking.
    // Visual accuracy is the bottleneck, not reasoning depth.
    await ext.seedLiveConfig(sidePanel, provider, apiKey, { reasoningEffort: 'low' });
    await sidePanel.reload();
    await sidePanel.waitForSelector(`text=${modelLabel}`, { timeout: 15_000 });

    // 2. Restrict to CDP + tabs only — DOM tools are explicitly disabled so the
    //    agent must use the visual servoing loop (cdpAim → compare → cdpConfirm).
    await ext.enableOnlyTools(sidePanel, CDP_TOOLS);
    await ext.setWallTimeout(sidePanel, 120_000); // 2 min agent wall — enough for full 4-step flow + visual servoing

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

    // 4. Prompt — direct, terse. step-3.7-flash loses focus on long
    //    prompts. Two things matter: (a) USE the cellW/cellH from the
    //    cdpGridScreenshot response (not guessed viewport height), and
    //    (b) USE the pixelColor signal — red button → red-ish RGB;
    //    white background → rgb(255,255,255) means you missed, re-aim
    //    with (dx, dy), do NOT call cdpScreenshot.
    const prompt = [
      `Switch to tab ${tabId} via tabsList → tabsSwitch.`,
      ``,
      `Tools available (DOM tools DISABLED): cdpScreenshot, cdpGridScreenshot, cdpAim, cdpConfirm, cdpCancel, cdpType, cdpPressKey.`,
      ``,
      `The page is a search-engine homepage (Baidu/Bing style). Click these 3 things in order:`,
      `  1. RED "开始" pill button at bottom-center (only red element on page).`,
      `  2. WHITE search input "请输入搜索内容…" in middle of page. After clicking, cdpType("你好aBc") into it.`,
      `  3. BLUE "搜一下" button right of the input.`,
      `Top-right reads "state: initial" → "started" (after #1) → "typed" (after #2) → "searched" (after #3). Stop when it reads "searched".`,
      ``,
      `Per element: cdpGridScreenshot → convert cell coords to pixels using the cellW/cellH the tool REPORTS (not guessed viewport height) → cdpAim(x, y, size=200) with contrasting color → cdpConfirm(aimX, aimY).`,
      ``,
      `CRITICAL: each cdpAim response includes pixelColor: rgb(R, G, B) at the aim center. This is your ground truth. Red button → expect reddish (e.g. rgb(225,6,2)). If you got white (rgb(255,255,255)), you missed — call cdpCancel + cdpAim(dx, dy) to nudge from the current aim. NEVER claim "quota error" or "rate limit" — those aren't real, the tool succeeded. NEVER call cdpScreenshot as a "retry" — it doesn't move the crosshair.`,
      ``,
      `Reply with one short sentence when state="searched".`,
    ].join('\n');

    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();
    console.log('[41-search] prompt sent, waiting for state="searched"…');

    // Independent polling loop: capture state-change screenshots every
    // 2s. Runs in parallel with waitForFunction below.
    const stopCapturing = { v: false };
    const captureLoop = (async () => {
      while (!stopCapturing.v) {
        try {
          await captureState('loop');
        } catch { /* page may be closed */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    // Make sure the loop doesn't keep the process alive on its own.
    void captureLoop;

    // 5. Poll the fixture page for the terminal state. 5 min budget.
    const FINAL_STATE = 'searched';
    // Capture screenshots on every state change so we can see the
    // intermediate states (started / typed) even if the run never
    // reaches "searched".
    const seenStates = new Set<string>();
    const captureState = async (label: string) => {
      const cur = await fixturePage.evaluate(() => ({
        state: document.body.dataset.state,
        query: document.body.dataset.query,
      }));
      const key = `${cur.state}|${cur.query}`;
      if (!seenStates.has(key)) {
        seenStates.add(key);
        const fpath = `.e2e-logs/41-search-engine-state-${label}-${cur.state}.png`;
        try {
          await fixturePage.screenshot({ path: fpath, fullPage: false });
          console.log(`[41-search] captured ${key} → ${fpath}`);
        } catch { /* page may be closed */ }
      }
    };
    // Snapshot initial state.
    await captureState('initial');
    await fixturePage.waitForFunction(
      ({ state, q }) => {
        const ds = document.body.dataset.state;
        const dq = document.body.dataset.query;
        return ds === state && dq === q;
      },
      { state: FINAL_STATE, q: EXPECTED_QUERY },
      { timeout: 5 * 60_000, polling: 1000 },
    );
    await captureState('final');

    const finalState = await fixturePage.evaluate(() => ({
      state: document.body.dataset.state,
      query: document.body.dataset.query,
    }));
    console.log('[fixture] FINAL state:', finalState);
    stopCapturing.v = true;

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
    // cdpConfirm or cdpPressKey(Enter) — cdpClick is removed (see lib/tools.ts
    // comment). We need at least 2 confirms (one per clickable element we
    // expect the agent to interact with; the third may be cdpPressKey Enter).
    const confirmActions = cdpConfirmCalls + (log.match(/"cdpPressKey"/g) ?? []).length;
    expect(confirmActions, 'agent should have performed at least 2 confirm-style actions').toBeGreaterThanOrEqual(2);
    expect(agentError, 'no agent_error should have fired').toBe(0);
  } finally {
    await ext.cleanup();
  }
});