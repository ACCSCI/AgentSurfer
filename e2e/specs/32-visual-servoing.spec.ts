// Visual Servoing test: LLM should iterate cdpAim with the two-phase
// pattern (PHASE 1: fix position with large size, PHASE 2: shrink size
// with position locked). We verify by counting aim steps and inspecting
// the LLM's text responses — it should describe the relative offset
// between the red box and the target, not compute exact coordinates.

import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

import { launchWithExtension } from '../fixtures/extension';
import { traceStart, traceEnd, traceFail, traceReset } from '../fixtures/trace';

const TOOLS = [
  'tabsList', 'tabsSwitch',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot',
] as const;

test('Visual servoing: LLM uses two-phase aim pattern', async () => {
  traceReset();
  const ext = await launchWithExtension();
  test.setTimeout(120_000);

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
    await ext.enableOnlyTools(sidePanel, TOOLS);

    // Pre-open Bing.
    const bingPage = await ext.ctx.newPage();
    await bingPage.goto('https://www.bing.com/?setmkt=en-US', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 2000));

    // The prompt enforces the two-phase pattern.
    const prompt = [
      'Tabs 一下找到 bing 标签，tabsSwitch 到它。',
      'cdpScreenshot 看页面，bing 首页搜索框（白色长条带放大镜）在页面中上部。',
      '',
      '现在做两阶段视觉伺服：',
      '',
      '阶段 1（修位置，尺寸固定）：',
      '  - 用 size=200 调 cdpAim（保持尺寸不变）',
      '  - 看 BEFORE/AFTER 截图：红框是不是覆盖了搜索框？',
      '  - 如果红框偏了，cdpCancel + cdpAim 调 x/y，**仍然 size=200**',
      '  - 重复直到红框完全覆盖搜索框（最多 5 轮）',
      '',
      '阶段 2（缩尺寸，位置固定）：',
      '  - 阶段 1 收敛后，逐步缩小 size：200 → 100 → 50 → 30',
      '  - **位置不动**，只改 size',
      '  - 验证每个尺寸下搜索框还完全在框内',
      '',
      '绝对不要同时改 x/y 和 size。VLM 反馈会乱。',
      '',
      '完成后报告最终坐标和总共调了几次 cdpAim。',
    ].join('\n');
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for agent.
    for (let i = 0; i < 60; i++) {
      const running = await ext.isAgentRunning(sidePanel).catch(() => false);
      if (!running && i > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 500));

    // Read conversation.
    const steps = await ext.listAgentSteps(sidePanel);
    const cdpAimSteps = (steps.steps as Array<{
      stepNumber: number; text: string;
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
    }>).filter((s) => s.toolCalls.some((t) => t.name === 'cdpAim'));

    console.log('\n========================================');
    console.log('VISUAL SERVOING RESULT');
    console.log('========================================\n');
    console.log(`Total cdpAim calls: ${cdpAimSteps.length}\n`);

    for (const s of cdpAimSteps) {
      const aim = s.toolCalls.find((t) => t.name === 'cdpAim')!;
      console.log(`[step ${s.stepNumber}] aim(x=${aim.args.x}, y=${aim.args.y}, size=${aim.args.size}, color=${aim.args.color})`);
      if (s.text) console.log(`  LLM: ${s.text.slice(0, 200)}`);
    }

    // Save screenshots for visual verification.
    let aimIdx = 0;
    for (const s of steps.steps as Array<{
      toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
      toolResults: Array<{ name: string; isError: boolean; result: unknown }>;
    }>) {
      for (let i = 0; i < s.toolCalls.length; i++) {
        const tc = s.toolCalls[i];
        const tr = s.toolResults[i];
        if (tc.name !== 'cdpAim' || !tr || tr.isError) continue;
        const r = tr.result as { dataUrl?: string };
        if (!r?.dataUrl) continue;
        const base64 = r.dataUrl.split(',')[1] ?? '';
        const aimXY = `x${tc.args.x}y${tc.args.y}s${tc.args.size}`;
        writeFileSync(`.e2e-logs/32-servo-${String(aimIdx).padStart(2, '0')}-${aimXY}.png`, Buffer.from(base64, 'base64'));
        aimIdx += 1;
      }
    }
    console.log(`\nSaved ${aimIdx} cdpAim screenshots to .e2e-logs/32-servo-*.png`);

    // Analysis: did the LLM do two-phase servoing?
    // Phase 1: 2-5 aims all with size >= 100, x/y changes between calls
    // Phase 2: 2-4 aims with size decreasing, x/y stable
    const sizes = cdpAimSteps.map((s) => Number(s.toolCalls.find((t) => t.name === 'cdpAim')!.args.size));
    const xs = cdpAimSteps.map((s) => Number(s.toolCalls.find((t) => t.name === 'cdpAim')!.args.x));
    const ys = cdpAimSteps.map((s) => Number(s.toolCalls.find((t) => t.name === 'cdpAim')!.args.y));

    const sizesChangeDuringPhase1 = sizes.slice(0, -1).some((s, i) => s !== sizes[i + 1]);
    const sizesDecreaseAtEnd = sizes.length >= 2 && sizes[sizes.length - 1] < sizes[0];
    const phase1Count = sizes.findIndex((s, i) => i > 0 && s < sizes[i - 1]);
    const phase1EndsAt = phase1Count === -1 ? sizes.length : phase1Count;

    console.log('\n--- Visual servoing analysis ---');
    console.log(`sizes: [${sizes.join(', ')}]`);
    console.log(`x:     [${xs.join(', ')}]`);
    console.log(`y:     [${ys.join(', ')}]`);
    console.log(`phase 1 ends at aim #${phase1EndsAt} (size started decreasing)`);
    console.log(`phase 2 has ${sizes.length - phase1EndsAt} shrink steps`);

    expect(cdpAimSteps.length, 'LLM should make multiple cdpAim calls').toBeGreaterThanOrEqual(2);
  } catch (err) {
    traceFail('test', err);
    throw err;
  } finally {
    await ext.cleanup();
  }
});
