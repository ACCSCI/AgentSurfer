// Diagnostic test: run a multi-step toggle task and dump the FULL
// per-step trace — finishReason, stepType, isContinued, text preview,
// tool call names — plus the top-level onFinish termination metadata.
//
// The point is NOT to assert pass/fail. It's to capture ground truth
// about WHY the agent stops: did the LLM emit a text-only final step
// (`llmSelfDeclaredCompletion: true`)? Or did it reach maxSteps? Or did
// the wall-clock timer fire? Or did the stream hang mid-text-delta?
//
// We dump the trace to stdout + .e2e-logs/37-trace.json so a human can
// read it after the fact.

import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

import { launchWithExtension } from '../fixtures/extension';

const FULL_TOOLS = [
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
  'smartScreenshot',
  'cdpAim', 'cdpConfirm', 'cdpCancel', 'cdpScreenshot', 'cdpScroll',
] as const;

test('diagnose: dump per-step trace for baidu/bing toggle', async () => {
  const ext = await launchWithExtension();
  test.setTimeout(240_000); // 4 min — we're a diagnostic, give it room

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
    await ext.enableOnlyTools(sidePanel, FULL_TOOLS);
    await ext.setWallTimeout(sidePanel, 200_000);

    // Moderate complexity: 4 navigations + 1 cleanup + 1 summary.
    // Enough to see if the LLM self-declares or actually finishes.
    const prompt =
      '用 todo 工具按顺序执行：\n' +
      '1) 调 tabsOpen 打开 https://www.baidu.com\n' +
      '2) 调 tabsSwitch 切到 https://www.bing.com\n' +
      '3) 调 tabsSwitch 切回 https://www.baidu.com\n' +
      '4) 调 tabsSwitch 切到 https://www.bing.com\n' +
      '5) 调 tabsClose 关闭所有 baidu / bing 标签页\n' +
      '6) 用中文写一句总结';
    await ext.setReactTextareaValue(sidePanel, 'textarea', prompt);
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for the agent to either finish (agent_done) or hit the wall timeout.
    // Be patient — we want to distinguish "LLM is slow" from "LLM is hung".
    // Up to 3 minutes of patience; bail only on hard signals.
    const startedAt = Date.now();
    let agentDoneSeen = false;
    let lastLength = -1;
    let stableTicks = 0;
    while (Date.now() - startedAt < 180_000) {
      const running = await ext.isAgentRunning(sidePanel).catch(() => false);
      const log = ext.readSWLog();
      if (log.includes('"agent_done"') || log.includes('"agent_error"')) {
        agentDoneSeen = true;
        // Give it 1s of grace for any trailing updates
        await new Promise((r) => setTimeout(r, 1000));
        break;
      }
      if (!running) {
        // Cancel button gone — agent may have finished or be dead.
        // Wait 2s and check again to disambiguate.
        await new Promise((r) => setTimeout(r, 2000));
        const stillGone = !(await ext.isAgentRunning(sidePanel).catch(() => false));
        if (stillGone) { agentDoneSeen = false; break; }
      }
      // Capture textLen stability as a hint
      const len = await ext.getAssistantTextLength(sidePanel).catch(() => -1);
      if (len === lastLength) stableTicks += 1; else { stableTicks = 0; lastLength = len; }
      // Be VERY patient about LLM slowness — bail only after 30s of no growth
      if (stableTicks >= 30) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const wallMs = Date.now() - startedAt;

    // ---- Parse the SW log into a structured trace ----
    const log = ext.readSWLog();
    const lines = log.split('\n');

    const stepTrace: Array<Record<string, unknown>> = [];
    const reOnStepFinish = /\[AgentSurfer\]\[agent\] onStepFinish (\{[^\n]+)/;
    const reOnFinish = /\[AgentSurfer\]\[agent\] onFinish (\{[^\n]+)/;
    const reAgentDone = /emit \{"type":"agent_done"[^}]*\}/;
    let onFinishLine: string | null = null;

    for (const line of lines) {
      const m1 = line.match(reOnStepFinish);
      if (m1) {
        try { stepTrace.push(JSON.parse(m1[1])); } catch { /* skip */ }
      }
      const m2 = line.match(reOnFinish);
      if (m2) {
        onFinishLine = m2[1];
      }
    }
    const onFinishParsed = onFinishLine ? (() => { try { return JSON.parse(onFinishLine); } catch { return null; } })() : null;

    // Count tool calls and chunks
    const toolCallCounts: Record<string, number> = {};
    const reToolCall = /chunk \{"chunkType":"tool-call"[^}]*"toolName":"([^"]+)"/g;
    let tm: RegExpExecArray | null;
    while ((tm = reToolCall.exec(log))) {
      toolCallCounts[tm[1]] = (toolCallCounts[tm[1]] ?? 0) + 1;
    }
    const chunkEmits = (log.match(/emit.*chunk/g) ?? []).length;
    const agentDoneEmits = (log.match(/emit.*agent_done/g) ?? []).length;
    const agentErrorEmits = (log.match(/emit.*agent_error/g) ?? []).length;

    // Inspect final tabs
    const finalTabs = await ext.inspectTabs(sidePanel);

    // ---- Persist a structured trace for post-mortem ----
    const trace = {
      wallMs,
      agentDoneSeen,
      stepCount: stepTrace.length,
      steps: stepTrace,
      onFinish: onFinishParsed,
      toolCallCounts,
      chunkEmits,
      agentDoneEmits,
      agentErrorEmits,
      finalTabCount: finalTabs.count,
      finalTabUrls: finalTabs.urls,
    };
    writeFileSync(
      pathResolve('.e2e-logs/37-trace.json'),
      JSON.stringify(trace, null, 2),
    );

    // ---- Pretty print to stdout ----
    console.log('\n========================================');
    console.log('DIAGNOSTIC TRACE: baidu/bing toggle');
    console.log('========================================');
    console.log(`wall time:                 ${wallMs}ms`);
    console.log(`agent_done event emitted:  ${agentDoneEmits > 0}`);
    console.log(`agent_error event emitted: ${agentErrorEmits > 0}`);
    console.log(`chunks emitted:            ${chunkEmits}`);
    console.log(`tool calls:                ${JSON.stringify(toolCallCounts)}`);
    console.log(`final tab count:           ${finalTabs.count} (was 2 before)`);
    console.log(`final tab urls:            ${finalTabs.urls.join(', ')}`);
    if (onFinishParsed) {
      console.log(`\n[onFinish]`);
      console.log(`  stepCount:                  ${onFinishParsed.stepCount}`);
      console.log(`  topFinishReason:            ${onFinishParsed.topFinishReason}`);
      console.log(`  llmSelfDeclaredCompletion:  ${onFinishParsed.llmSelfDeclaredCompletion}`);
      console.log(`  finalTextPreview:           ${JSON.stringify(onFinishParsed.finalTextPreview)}`);
      console.log(`  perStepFinishReasons:       ${JSON.stringify(onFinishParsed.perStepFinishReasons, null, 2)}`);
    } else {
      console.log(`\n[onFinish] NOT FIRED — run was killed externally (no agent_done, no agent_error)`);
    }
    console.log('\n[per-step trace]');
    for (const s of stepTrace) {
      const nr = s as {
        stepNumber: number; finishReason: string; stepType: string;
        isContinued: boolean; wouldTerminate: boolean;
        textLength: number; textPreview: string;
        toolCallCount: number; toolResultCount: number;
      };
      const flag = nr.wouldTerminate ? '  ← WOULD TERMINATE' : '';
      console.log(
        `  step ${nr.stepNumber}: ` +
        `fr=${nr.finishReason} type=${nr.stepType} cont=${nr.isContinued} ` +
        `tools=${nr.toolCallCount}/${nr.toolResultCount} ` +
        `textLen=${nr.textLength}${flag}`
      );
      if (nr.textPreview) {
        console.log(`    text: ${JSON.stringify(nr.textPreview.slice(0, 150))}`);
      }
    }

    console.log(`\nFull trace written to .e2e-logs/37-trace.json`);

    // The test always passes — this is a diagnostic, not a gate.
    expect(stepTrace.length).toBeGreaterThan(0);
  } finally {
    await ext.cleanup();
  }
});
