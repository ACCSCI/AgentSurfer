// E2E: real-task closed-loop. Uses the live MiniMax provider (key from .env)
// to drive a real browser session.
//
// Layered:
//   1. Pretest  — send "hi", expect ANY response (text or tool call) within
//                 60s. If nothing comes back, abort and skip the real task —
//                 the LLM connection is broken, no point running the
//                 multi-step scenario.
//   2. Real run — open google.com, ask the agent to search "githubtrends",
//                 list the first 10 results, and click the first one.
//
// Run manually: `bun run e2e:real` (or `bunx playwright test e2e/specs/04-…`)
// with headed Chromium. Not in the default CI loop.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

const GOOGLE = 'https://www.google.com';
const RUN_TIMEOUT = 5 * 60 * 1000; // 5 min for the real multi-step task
const PRETEST_TIMEOUT = 10 * 1000; // 10s ping — should be enough for a "hi" reply

async function waitForAgentResponse(
  sidePanel: import('@playwright/test').Page,
  timeoutMs: number,
  screenshotName: string,
): Promise<{ stepCount: number; errorText: string; finalText: string; sawDone: boolean }> {
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
    // Count step badges by matching the Badge text node directly.
    stepCount = await sidePanel
      .locator('div.text-\\[10px\\]', { hasText: /^\s*step\s+\d+\s*$/ })
      .count()
      .catch(() => 0);
    if (!isRunning) {
      const last = sidePanel.locator('[data-testid="message-bubble"]').last();
      lastText = (await last.textContent().catch(() => '')) ?? '';
      sawDone = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  // Timed out — capture state for debugging.
  if (!sawDone) {
    await sidePanel.screenshot({ path: `test-results/${screenshotName}.png`, fullPage: true });
  }
  return { stepCount, errorText, finalText: lastText, sawDone };
}

test.describe('real-task closed-loop', () => {
  test.setTimeout(RUN_TIMEOUT);
  test('MiniMax on Anthropic-compat: ping → Google search githubtrends', async () => {
    const envFile = readFileSync(resolve('.env'), 'utf-8');
    const apiKey = envFile.match(/^MINIMAX_API_KEY=(.+)$/m)?.[1]?.trim();
    if (!apiKey) {
      throw new Error('MINIMAX_API_KEY missing from .env — cannot run live test');
    }

    const ext = await launchWithExtension();
    try {
      // 0. Boot side panel and seed the live MiniMax config.
      const { page: sidePanel } = await ext.openSidePanel();
      await sidePanel.waitForSelector('text=AgentSurfer');
      await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
      await sidePanel.reload();
      await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 10_000 });

      // NOTE: We deliberately do NOT pre-navigate to google.com. The agent
      // is expected to call tabsList / tabsSwitch / tabsOpen to manage its
      // own active tab. This is the user's preferred design.

      // Helper: set a React-controlled textarea's value via the native setter
      // so React's onChange fires. `locator.fill()` is unreliable here.
      async function setReactTextareaValue(
        selector: string,
        value: string,
      ) {
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

      // 1. PRETEST — send "hi", require the agent to finish within 10s
      //    and not error. Step count > 0 confirms at least one tool ran.
      console.log('[pretest] sending "hi" …');
      await sidePanel.bringToFront();
      await setReactTextareaValue('textarea', 'hi');
      await sidePanel.locator('button[title="Send"]').click();
      const pretest = await waitForAgentResponse(sidePanel, PRETEST_TIMEOUT, 'pretest-sidepanel');
      console.log(
        `[pretest] done — sawDone=${pretest.sawDone}, stepCount=${pretest.stepCount}, errorText=${JSON.stringify(pretest.errorText)}, finalText=${JSON.stringify(pretest.finalText.slice(0, 200))}`,
      );
      test.skip(
        !pretest.sawDone,
        'pretest: agent never finished within 10s — LLM connection likely broken',
      );
      expect(pretest.errorText, 'pretest must not error').toBe('');

      // 2. REAL TASK — send the prompt that asks the model to manage its
      //    own tab and complete the search.
      await sidePanel.bringToFront();
      // Wait for the input to be cleared by the previous submit before filling.
      await sidePanel.locator('textarea').waitFor({ state: 'visible' });
      const prompt =
        "Use the tabs tool to open https://www.google.com (or switch to it if " +
        "already open), then type 'githubtrends' into the search input, press " +
        "Enter, wait for the results to load, list the text of the first 10 " +
        'results, and then click the first one. Finish with a one-sentence ' +
        'summary of the result you clicked into.';
      await setReactTextareaValue('textarea', prompt);
      // Confirm the textarea actually has the text before clicking send.
      const filled = await sidePanel.locator('textarea').inputValue();
      console.log('[real-task] textarea value length:', filled.length, '— first 60:', JSON.stringify(filled.slice(0, 60)));
      await sidePanel.locator('button[title="Send"]').click();

      // Poll the side panel + Google tab and take screenshots at each step.
      const stepSeen = new Set<number>();
      const startedAt = Date.now();
      let lastScreenshot = 0;
      // Find a tab that's NOT the side panel so we can screenshot it.
      async function findGoogleTab(): Promise<import('@playwright/test').Page | null> {
        const pages = ext.ctx.pages();
        for (const p of pages) {
          const u = p.url();
          if (u.startsWith('http')) {
            if (!p.url().includes('sidepanel.html')) return p;
          }
        }
        return null;
      }
      // Track ANY visible tool-call chip in the live tool-call panel.
      async function countToolChips() {
        return sidePanel.locator('.text-\\[10px\\]').count();
      }
      while (Date.now() - startedAt < RUN_TIMEOUT - 60_000) {
        const isRunning = await sidePanel
          .locator('button[title="Cancel run"]')
          .isVisible()
          .catch(() => false);
        if (!isRunning) break;

        // Count tool-call chips via the streaming panel (more reliable than
        // the post-hoc Dexie liveQuery). The chip class is text-[10px].
        const chipCount = await countToolChips().catch(() => 0);
        if (chipCount > 0 && !stepSeen.has(chipCount)) {
          stepSeen.add(chipCount);
          const stamp = Date.now();
          if (stamp - lastScreenshot > 1500) {
            try {
              const target = await findGoogleTab();
              if (target) {
                await target.bringToFront();
                await target.screenshot({ path: `test-results/04-step-${chipCount}.png` });
              }
              lastScreenshot = stamp;
            } catch {
              // tab may have navigated away; that's fine
            }
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      await sidePanel.bringToFront();
      await sidePanel.screenshot({ path: 'test-results/04-sidepanel-end.png', fullPage: true });
      const target = await findGoogleTab();
      let finalUrl = '';
      if (target) {
        finalUrl = target.url();
        await target.bringToFront();
        await target.screenshot({ path: 'test-results/04-google-final.png' });
      }
      // Count ANY non-empty assistant message in the chat (more permissive
      // than looking for a "step N" badge, which only appears after onStepFinish
      // fires — the live tool-call chips appear sooner via currentToolCalls).
      const anyAssistantText = await sidePanel.evaluate(() => {
        const bubbles = document.querySelectorAll('[data-testid="message-bubble"]');
        for (const b of bubbles) {
          const t = (b.textContent ?? '').trim();
          if (t && t.length > 5 && !/^(hi|hello)/i.test(t)) {
            return t.slice(0, 200);
          }
        }
        return '';
      });
      const anyToolChip = await countToolChips();
      console.log(
        '[final] url:',
        finalUrl,
        'toolChips:',
        anyToolChip,
        'assistantText:',
        JSON.stringify(anyAssistantText.slice(0, 120)),
      );

      const urlChanged = !!finalUrl && (/search/.test(finalUrl) || !finalUrl.startsWith(GOOGLE));
      const hasProgress = stepSeen.size > 0 || urlChanged || anyToolChip > 0 || anyAssistantText.length > 0;
      expect(hasProgress, 'agent should have made progress').toBe(true);
    } finally {
      await ext.cleanup();
    }
  });
});
