// Quick smoke test for the 4-level PixiJS test game.
// Loads the page, waits for the game to start, then plays through all
// 4 levels programmatically by simulating clicks/drags at the known
// coordinates. Verifies document.body.dataset.level transitions correctly.
//
// Run: bun run scripts/smoke-test-game.ts
//
// Pre-req: `bun run e2e:serve` must be running on port 4173.
//
// This is a one-shot dev tool — not a Playwright spec. Uses Playwright
// via `bun add -d playwright` (already in devDeps).

import { chromium, type Browser, type Page } from 'playwright';

const URL = 'http://localhost:4173/e2e/fixtures/test-game/index.html';

interface GameState {
  level: string;
  blinkPhase?: string;
  typed?: string;
}

async function getState(page: Page): Promise<GameState> {
  return page.evaluate(() => ({
    level: document.body.dataset.level ?? 'unknown',
    blinkPhase: document.body.dataset.blinkPhase,
  }));
}

async function waitFor(page: Page, level: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await getState(page);
    if (s.level === level) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const s = await getState(page);
  throw new Error(`timeout waiting for level=${level}, current=${s.level}`);
}

async function main() {
  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // Capture console for diagnostics
  const consoleLogs: string[] = [];
  page.on('console', (msg) => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  console.log('Loading', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 5000 });
  await waitFor(page, 'playing-1', 3000);
  console.log('✓ L1 started');

  // L1: 3 balls at y=400 CSS (800 screenshot @ dpr=2), x in {320, 640, 960} CSS.
  // We click via canvas coordinates in CSS pixels (page.mouse uses CSS px).
  // The game reads the click via PixiJS hit-test on the ball Graphics.
  // Order: read numbers via window.__game.state.l1.balls (sorted by label)
  const l1Order = await page.evaluate(() => {
    const balls = (window as any).__game.state.l1.balls;
    return balls.map((b: any) => ({ x: b.ball.x, y: b.ball.y, label: b.label }));
  });
  console.log('L1 balls:', JSON.stringify(l1Order));
  for (let n = 1; n <= 3; n++) {
    const target = l1Order.find((b) => b.label === String(n));
    if (!target) throw new Error(`L1 ball ${n} not found`);
    await page.mouse.click(target.x, target.y);
    await new Promise((r) => setTimeout(r, 250));
  }
  await waitFor(page, '2-passed');
  await waitFor(page, 'playing-2');
  console.log('✓ L1 passed');

  // L2: 2 balls at y=400 CSS, x in {480, 800}. Click the blinker.
  // Read which ball is the blinker from state.
  const l2Info = await page.evaluate(() => {
    const s = (window as any).__game.state.l2;
    const blinker = s.balls.find((b: any) => b.id === s.blinkId);
    return { blinkId: s.blinkId, blinker: { x: blinker.x, y: blinker.y } };
  });
  console.log('L2 blinkId:', l2Info.blinkId, 'at', JSON.stringify(l2Info.blinker));
  await page.mouse.click(l2Info.blinker.x, l2Info.blinker.y);
  await waitFor(page, '2-passed');
  await waitFor(page, 'playing-3');
  console.log('✓ L2 passed');

  // L3: click input box at (640, 260) CSS, then type, then click submit at (640, 390).
  await page.mouse.click(640, 260);
  await new Promise((r) => setTimeout(r, 200));
  // Type via keyboard — Playwright dispatches real keyboard events which the
  // canvas's window keydown listener picks up.
  await page.keyboard.type('HELLO_AGENT_2026', { delay: 30 });
  await new Promise((r) => setTimeout(r, 200));
  const typed = await page.evaluate(() => (window as any).__game.state.l3.typed);
  console.log('L3 typed:', typed);
  if (typed !== 'HELLO_AGENT_2026') {
    throw new Error(`L3 typed mismatch: got '${typed}'`);
  }
  await page.mouse.click(640, 390);
  await waitFor(page, '3-passed');
  await waitFor(page, 'playing-4');
  console.log('✓ L3 passed');

  // L4: drag 3 balls to boxes. For each ball, find the target box by color.
  // L4 ball y=200 CSS, box y=520 CSS. Ball x in {320, 640, 960}, box x same.
  const l4Mapping = await page.evaluate(() => {
    const s = (window as any).__game.state.l4;
    return s.balls.map((b: any) => ({
      color: b._color,
      startX: b._startX,
      startY: b._startY,
      targetBoxIdx: b._targetBoxIdx,
    }));
  });
  console.log('L4 mapping:', JSON.stringify(l4Mapping));
  const boxPositions = [
    { x: 320, y: 520 },
    { x: 640, y: 520 },
    { x: 960, y: 520 },
  ];
  for (const ball of l4Mapping) {
    const target = boxPositions[ball.targetBoxIdx];
    // Drag from (startX, startY) to (target.x, target.y)
    await page.mouse.move(ball.startX, ball.startY);
    await page.mouse.down();
    // Move in steps so PixiJS sees the drag
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      const x = ball.startX + (target.x - ball.startX) * t;
      const y = ball.startY + (target.y - ball.startY) * t;
      await page.mouse.move(x, y);
      await new Promise((r) => setTimeout(r, 20));
    }
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 200));
  }
  await waitFor(page, '4-passed');
  await waitFor(page, 'done');
  console.log('✓ L4 passed');

  // Final state check
  const final = await getState(page);
  console.log('Final level:', final.level);
  if (final.level !== 'done') {
    throw new Error(`expected level='done', got '${final.level}'`);
  }

  if (pageErrors.length > 0) {
    console.error('PAGE ERRORS:');
    for (const e of pageErrors) console.error('  ', e);
    throw new Error('page errors during smoke test');
  }

  console.log('--- Console output ---');
  for (const l of consoleLogs) console.log(l);
  console.log('--- End console ---');
  console.log('\n✓ All 4 levels passed!');

  await page.screenshot({ path: '.e2e-logs/smoke-test-game-final.png' });
  await browser.close();
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
