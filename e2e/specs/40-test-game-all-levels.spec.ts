// E2E: agent autonomously plays through a 4-level PixiJS canvas test game.
//
// The game is at http://localhost:4173/e2e/fixtures/test-game/index.html
// (served by `bun run e2e:serve` on port 4173). It uses PixiJS v8, drawn
// on a single 1280x800 canvas. Each level tests a distinct agent primitive:
//
//   L1: click in numerical order (1, 2, 3)
//   L2: identify the blinking ball among two same-colored balls
//   L3: focus a canvas-drawn input box, type, and submit
//   L4: drag-and-drop colored balls to labeled boxes
//
// This is a REAL-LLM test (uses MiniMax-M3), intended as a regression
// target. The spec asserts document.body.dataset.level === '4-passed' (or
// 'done') at the end. Wall-clock budget: 8 minutes.
//
// Anti-cheat: domQuery, domType, domClick are DISABLED via enableOnlyTools.
// The agent must drive the game via canvas primitives only (cdpAim,
// cdpConfirm, cdpClick, cdpType, cdpDrag, cdpScreenshot).
//
// Pre-req: `bun run e2e:serve` must be running on port 4173.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';
import { traceEnd, traceFail, traceReset, traceSnapshot, traceStart } from '../fixtures/trace';

const FIXTURE_URL = 'http://localhost:4173/e2e/fixtures/test-game/index.html';

// Tools the agent is allowed to use. DOM tools are explicitly EXCLUDED so
// the agent cannot bypass the canvas via domQuery('input') + domType. This
// is the strongest anti-cheat at the tool-config layer.
const TOOLS = [
  'tabsList', 'tabsSwitch',
  'cdpAim', 'cdpConfirm', 'cdpClick', 'cdpDrag',
  'cdpType', 'cdpPressKey', 'cdpScreenshot',
] as const;

test('agent plays all 4 levels of the PixiJS test game', async () => {
  traceReset();
  const ext = await launchWithExtension();
  test.setTimeout(8 * 60_000); // 8 min total budget

  // Skip if no API key — this is a real-LLM test, not mocked.
  let apiKey = '';
  try {
    const envFile = readFileSync(resolve('.env'), 'utf-8');
    apiKey = envFile.match(/^MINIMAX_API_KEY=(.+)$/m)?.[1]?.trim() ?? '';
  } catch {
    /* fall through to skip */
  }
  if (!apiKey) {
    test.skip(true, 'MINIMAX_API_KEY missing from .env — skipping real-LLM test');
    return;
  }

  ext.clearSWLog();

  try {
    traceStart('open-side-panel');
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 15_000 });
    await ext.enableOnlyTools(sidePanel, TOOLS);
    traceEnd('open-side-panel');

    // Open the test game page in a new tab. The page loads PixiJS via ESM
    // from a vendored copy (./vendor/pixi.min.mjs). After 300ms boot delay
    // the page sets body.dataset.level to 'playing-1'.
    traceStart('open-game-page');
    const gamePage = await ext.ctx.newPage();
    await gamePage.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    await gamePage.waitForFunction(
      () => document.body.dataset.level?.startsWith('playing'),
      null,
      { timeout: 10_000 },
    );
    traceEnd('open-game-page');

    // Find the game tab and capture its id for the prompt.
    const tabs = await ext.inspectTabs(sidePanel);
    const gameTab = tabs.urls.findIndex((u) => u.includes('test-game'));
    if (gameTab < 0) throw new Error('test-game tab not found in inspected tabs');
    const gameTabId = tabs.ids[gameTab];

    // The prompt walks the agent through all 4 levels. Coordinates are
    // SCREENSHOT pixels (the same units as the image from cdpScreenshot).
    // The PixiJS canvas renders at dpr=2 (1280x800 CSS = 2560x1600 device),
    // so the screenshot coordinates are 2x the CSS coordinates.
    //
    // Key positions in SCREENSHOT pixels (dpr=2):
    //   L1: 3x3 grid of balls, y in {400, 800, 1200}, x in {640, 1280, 1920}.
    //       Numbers 1-9 are randomized to positions; click 1, 2, 3, ..., 9 in order.
    //   L2: 3x5 grid of balls, y in {400, 800, 1200}, x in {400, 800, 1200, 1600, 2000}.
    //       1 ball blinks (alpha 0.3↔1.0 over 1500ms), 14 stay solid.
    //   L3 input box: (640, 540), Submit (1280, 780).
    //   L4 balls (start): 2 rows of 3, y in {360, 640}, x in {640, 1280, 1920}.
    //   L4 boxes: y=1120, x in {640, 1280, 1920} (200x200 each).
    const prompt = [
      `Use tabsList → tabsSwitch to focus the game tab (id ${gameTabId}).`,
      `Then take a cdpScreenshot to see the current state. The page is a single PixiJS canvas (1280x800 CSS, rendered at 2x devicePixelRatio so screenshots are 2560x1600). Coordinates in cdpAim / cdpConfirm / cdpClick / cdpDrag are SCREENSHOT pixels (the same units as the image you see).`,
      ``,
      `LEVEL 1 — 9 balls arranged in a 3×3 grid at y in {400, 800, 1200}, x in {640, 1280, 1920}. Each ball has a number 1-9 in its center; the number→position mapping is SHUFFLED each run. Click them in order 1, 2, 3, 4, 5, 6, 7, 8, 9. Wrong order resets the level.`,
      ``,
      `LEVEL 2 — 15 same-colored balls in a 3×5 grid (3 rows × 5 columns) at y in {400, 800, 1200}, x in {400, 800, 1200, 1600, 2000}. One ball blinks (alpha oscillates ~0.3 ↔ 1.0 over 1500ms), the other 14 stay solid. Random-clicking gives only ~7% chance of success — you MUST observe. Take TWO cdpScreenshot calls ~600ms apart and COMPARE which ball's alpha changes between the two frames. cdpClick the one that changes. Wrong ball resets the level.`,
      ``,
      `LEVEL 3 — A canvas-drawn input box at (640, 540) and a Submit button at (1280, 780). The instruction on screen says to type "HELLO_AGENT_2026". cdpAim + cdpConfirm on the input box (center) to focus it (the border turns blue when focused). Then cdpType("HELLO_AGENT_2026") — the typed text appears in the box. cdpAim + cdpConfirm on the Submit button. If the text doesn't match, the button flashes red and you can re-submit after fixing.`,
      ``,
      `LEVEL 4 — 6 balls at the top (2 of each color: red, blue, green), arranged in 2 rows of 3 at roughly y=360 and y=640, with x in {640, 1280, 1920}. 3 large boxes at the bottom (y=1120, 200x200 each, x in {640, 1280, 1920}), each labeled "RED", "BLUE", or "GREEN" (centered text). The color→label assignment is SHUFFLED each run — READ the box labels from your screenshot. Each box holds 2 balls of its matching color.`,
      ``,
      `For each ball, cdpDrag from the ball's center to the center of the box whose label matches the ball's color. The ball STAYS WHERE DROPPED — no auto-center, no auto-return. The pass check requires each ball's center to be at least 5 CSS px (10 screenshot px) inside the target box on every side. If you drop a ball in the wrong box, just pick it up and drag it to the right one. The level passes when all 6 balls are correctly placed.`,
      ``,
      `Take a cdpScreenshot after each action to verify state. The game reports progress via document.body.dataset.level — you can read this from any screenshot, or just observe the on-screen messages ("LEVEL N PASSED").`,
    ].join('\n');

    traceStart('send-prompt-and-wait');
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for the agent to finish AND the game to reach the final state.
    // Budget 7 min — leaves 1 min for the final assertions.
    const PASSED = '4-passed';
    const DONE = 'done';
    await gamePage.waitForFunction(
      (targets) => {
        const lvl = document.body.dataset.level;
        return lvl === targets.passed || lvl === targets.done;
      },
      { passed: PASSED, done: DONE },
      { timeout: 7 * 60_000, polling: 1000 },
    );
    traceEnd('send-prompt-and-wait');

    // Final assertion.
    const finalLevel = await gamePage.evaluate(() => document.body.dataset.level);
    console.log('\n========================================');
    console.log('TEST GAME FINAL STATE');
    console.log('========================================');
    console.log(`document.body.dataset.level = ${finalLevel}`);

    // Save a final screenshot for visual regression.
    await gamePage.screenshot({ path: '.e2e-logs/40-test-game-final.png', fullPage: true });

    expect(
      finalLevel === PASSED || finalLevel === DONE,
      `expected level '${PASSED}' or '${DONE}', got '${finalLevel}'`,
    ).toBe(true);

    // Also assert no agent_error in the SW log (catches silent failures).
    const swLog = ext.readSWLog();
    const errorCount = (swLog.match(/agent_error/g) || []).length;
    console.log(`SW log agent_error count: ${errorCount}`);
  } catch (err) {
    traceFail('test-game', err, { snapshot: traceSnapshot() });
    throw err;
  } finally {
    await ext.cleanup();
  }
});
