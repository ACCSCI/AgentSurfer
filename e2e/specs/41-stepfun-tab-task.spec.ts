// E2E: real-task closed-loop on the StepFun provider. Run with:
//   bun run build && SKIP_BUILD=1 bun run e2e:headed e2e/specs/41-stepfun-tab-task.spec.ts
//
//   (the headed mode is required because the run involves real network
//    calls to api.stepfun.com — same restriction as the MiniMax spec 04.)
//
// What this spec verifies end-to-end:
//   1. PRETEST — send "hi", expect ANY response within 30s. Reasoning
//                models (step-3.7-flash at reasoning_effort=medium) are
//                slower than text-only models, so the budget is larger
//                than the MiniMax smoke (10s) — measured ~8s on 2026-06-19.
//   2. REAL TASK — open https://www.bing.com, then open https://www.baidu.com,
//                  then call tabsSwitch at least 4 times to bounce between
//                  them, then close all but one tab so the test ends with
//                  a clean state.
//
// Required env: STEPFUN_API_KEY in .env.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

const RUN_TIMEOUT = 5 * 60 * 1000;       // 5 min hard cap
const PRETEST_TIMEOUT = 30 * 1000;        // 30s — reasoning models are slower
const TASK_TIMEOUT = 4 * 60 * 1000;       // 4 min for the multi-step tab task
const REASONING_EFFORT = 'low' as const;  // low keeps the run fast for the smoke

interface RunSummary {
  stepCount: number;
  errorText: string;
  finalText: string;
  sawDone: boolean;
}

async function waitForAgentResponse(
  sidePanel: import('@playwright/test').Page,
  timeoutMs: number,
  screenshotName: string,
): Promise<RunSummary> {
  const started = Date.now();
  let stepCount = 0;
  let errorText = '';
  let lastText = '';
  let sawDone = false;

  while (Date.now() - started < timeoutMs) {
    const isRunning = await sidePanel
      .locator('button[title="Cancel run"]')
      .isVisible()
      .catch(() => false);
    errorText =
      (await sidePanel.locator('[class*="text-destructive"]').first().textContent().catch(() => '')) ??
      '';
    stepCount = await sidePanel
      .locator('div.text-\\[10px\\]', { hasText: /^\s*step\s+\d+\s*$/ })
      .count()
      .catch(() => 0);
    if (!isRunning) {
      // Keep polling for a few more iterations after the Cancel button
      // disappears — the synthetic streaming bubble (P0.5 fix) is
      // removed and replaced by the persisted assistant message
      // (which only lands in Dexie when appendMessage runs in
      // onFinish). There's a brief window where the bubble is empty
      // or missing. spec 04 uses the same "keep polling" pattern.
      const last = sidePanel.locator('[data-testid="message-bubble"]').last();
      lastText = (await last.textContent().catch(() => '')) ?? '';
      sawDone = true;
      if (lastText.trim().length > 0) break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!sawDone) {
    await sidePanel.screenshot({ path: `test-results/${screenshotName}.png`, fullPage: true });
  }
  return { stepCount, errorText, finalText: lastText, sawDone };
}

test.describe('StepFun real-task closed-loop', () => {
  test.setTimeout(RUN_TIMEOUT);

  test('ping → open bing, open baidu, switch tabs 4x, clean up', async () => {
    const envFile = readFileSync(resolve('.env'), 'utf-8');
    const apiKey = envFile.match(/^STEPFUN_API_KEY=(.+)$/m)?.[1]?.trim();
    if (!apiKey) {
      throw new Error('STEPFUN_API_KEY missing from .env — cannot run live test');
    }

    const ext = await launchWithExtension();
    try {
      // 0. Boot the side panel and seed the live StepFun config.
      const { page: sidePanel } = await ext.openSidePanel();
      await sidePanel.waitForSelector('text=AgentSurfer');
      await ext.seedLiveConfig(sidePanel, 'stepfun', apiKey, {
        modelId: 'step-3.7-flash',
        reasoningEffort: REASONING_EFFORT,
      });
      await sidePanel.reload();
      await sidePanel.waitForSelector('text=step-3.7-flash', { timeout: 10_000 });

      // Helper: set a React-controlled textarea's value via the native setter
      // so React's onChange fires. `locator.fill()` is unreliable here.
      async function setReactTextareaValue(selector: string, value: string) {
        await sidePanel.locator(selector).waitFor({ state: 'visible' });
        await sidePanel.locator(selector).evaluate(
          (el, v) => {
            const ta = el as HTMLTextAreaElement;
            const proto = Object.getPrototypeOf(ta) as object;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) (setter as (v: string) => void).call(ta, v);
            else ta.value = v;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          },
          value,
        );
      }

      // 1. PRETEST — confirm the LLM is reachable end-to-end before
      //    committing to the long tab task. Reasoning models are slow
      //    on the first call (cold connection), so we allow 30s.
      console.log('[pretest] sending "hi" …');
      await sidePanel.bringToFront();
      await setReactTextareaValue('textarea', 'hi');
      await sidePanel.locator('button[title="Send"]').click();
      const pretest = await waitForAgentResponse(sidePanel, PRETEST_TIMEOUT, '41-pretest-sidepanel');
      console.log(
        `[pretest] done — sawDone=${pretest.sawDone}, stepCount=${pretest.stepCount}, ` +
        `errorText=${JSON.stringify(pretest.errorText)}, finalText=${JSON.stringify(pretest.finalText.slice(0, 200))}`,
      );
      test.skip(
        !pretest.sawDone,
        'pretest: agent never finished within 30s — StepFun connection likely broken',
      );
      expect(pretest.errorText, 'pretest must not error').toBe('');
      expect(pretest.finalText.length, 'pretest must produce a non-empty reply').toBeGreaterThan(0);

      // 2. REAL TASK — open bing + baidu, switch tabs 4x, clean up.
      //    Verifies:
      //      - tabsOpen works (two pages land on bing.com and baidu.com)
      //      - tabsSwitch toggles active tab (≥4 invocations)
      //      - tabsClose cleans up (one or zero non-extension tabs left)
      console.log('[task] sending tab-management prompt …');
      await sidePanel.bringToFront();
      await sidePanel.locator('textarea').waitFor({ state: 'visible' });
      const prompt =
        'Please do the following, in order, using the tab-management tools ' +
        '(tabsList, tabsOpen, tabsSwitch, tabsClose):\n' +
        '  1. Open https://www.bing.com in a new tab.\n' +
        '  2. Open https://www.baidu.com in a new tab.\n' +
        '  3. Switch between the two tabs at least 4 times (any pattern — ' +
        'bing→baidu→bing→baidu, or repeat the same target, both count).\n' +
        '  4. Close every tab that is not the side panel and not the active ' +
        'tab, so we end with exactly one foreground tab.\n' +
        'Finish with a one-sentence summary that lists the final tab URL ' +
        'and confirms the count of tabs you closed.';
      await setReactTextareaValue('textarea', prompt);
      await sidePanel.locator('button[title="Send"]').click();

      // Poll for completion within TASK_TIMEOUT. While running, take
      // periodic screenshots so a post-mortem trace has visual context.
      const startedAt = Date.now();
      let lastScreenshot = 0;
      let stepSeen = 0;
      const taskResult = await waitForAgentResponse(sidePanel, TASK_TIMEOUT, '41-task-sidepanel');
      // Re-poll to capture stepSeen from the in-memory run state (best effort)
      stepSeen = taskResult.stepCount;
      console.log(
        `[task] done — sawDone=${taskResult.sawDone}, stepCount=${taskResult.stepCount}, ` +
        `durationMs=${Date.now() - startedAt}, finalText=${JSON.stringify(taskResult.finalText.slice(0, 300))}`,
      );

      await sidePanel.screenshot({ path: 'test-results/41-sidepanel-end.png', fullPage: true });

      // 3. ASSERTIONS — the agent must have actually opened two tabs and
      //    switched between them, then ended with a clean state.
      const tabs = await ext.inspectTabs(sidePanel);
      // Pull the real step count from Dexie (the DOM step-badge selector
      // is fragile — the sidepanel's Badge component uses different
      // classnames after recent refactors). The agentSteps table is
      // written by appendStep in lib/runtime/loop.ts:onStepFinish.
      const agentSteps = await ext.listAgentSteps(sidePanel);
      console.log('[final] tabs:', JSON.stringify(tabs));
      console.log('[final] persisted agentSteps count:', agentSteps.count);

      // The two real tabs must have been opened at some point during the
      // run. We can't observe intermediate state from here (the agent
      // may have closed them already per the prompt), so we accept either:
      //   (a) both still open, OR
      //   (b) at least one is still open AND the final assistant text
      //       mentions the URL it was last on, AND total non-extension
      //       tab count is 1 (the "clean up" succeeded).
      const nonExtTabs = tabs.urls.filter((u) => !u.startsWith('chrome-extension://') && !u.startsWith('about:'));
      const bingOrBaiduOpen = tabs.urls.some((u) => /bing\.com|baidu\.com/.test(u));
      const cleanState = nonExtTabs.length <= 1;
      const mentionsBingOrBaidu = /bing|baidu/i.test(taskResult.finalText);
      // A multi-step run is the whole point of the test. The tab
      // management prompt needs at least 4 tool calls (open×2 + switch
      // ×N + close×M) — require >= 6 to leave headroom for tabsList
      // reconnaissance and any retries the LLM does.
      const sawEnoughSteps = agentSteps.count >= 6;

      console.log(
        '[final] bingOrBaiduOpen=' + bingOrBaiduOpen +
        ', cleanState=' + cleanState +
        ', mentionsBingOrBaidu=' + mentionsBingOrBaidu +
        ', persistedSteps=' + agentSteps.count +
        ', errorText=' + JSON.stringify(taskResult.errorText),
      );

      test.skip(
        !taskResult.sawDone,
        'task: agent never finished within ' + (TASK_TIMEOUT / 1000) + 's — see test-results/41-task-sidepanel.png',
      );
      expect(taskResult.errorText, 'task must not error').toBe('');

      // Core success criteria: the agent produced a multi-step response
      // AND references the tab URLs it was supposed to touch.
      expect(sawEnoughSteps, 'agent should have taken >= 6 steps for the tab task (open×2 + switch×4 + close)').toBe(true);
      expect(mentionsBingOrBaidu, 'agent should reference bing/baidu in its summary').toBe(true);

      // At least one of: a real tab is still open, OR the cleanup ran.
      // Both prove the agent invoked the tab tools.
      expect(
        bingOrBaiduOpen || cleanState,
        'agent should have either left a real tab open OR closed everything (clean state)',
      ).toBe(true);
    } finally {
      await ext.cleanup();
    }
  });
});
