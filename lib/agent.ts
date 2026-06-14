// Agent loop — pure event-driven runtime.
//
// Architecture rules:
//   1. Runtime must be event-driven.
//   2. Runtime must never manipulate UI state (Zustand, React).
//      Runtime may write to Dexie (persistence) — but not to UI state.
//   3. Runtime must emit events immediately when available.
//   4. Runtime must never wait for full LLM completion before emitting output.
//   5. Agent execution must not return a final response object.
//   6. Long-running tasks must communicate exclusively through event streams.
//   7. Tool calls, tool results, tokens, todos, progress updates and errors
//      must be represented as distinct event types.
//   8. UI consumes events and owns presentation state.

import { streamText } from 'ai';
import { getEnabledToolNames, newId } from '@/lib/db';
import { appendMessage, appendStep } from '@/lib/data-layer';
import { allTools, createTodoTool } from '@/lib/tools';
import { createModel } from '@/lib/llm';
import { CDPService, setCurrentCDP } from '@/lib/cdp';
import { log, ScopedLogger } from '@/lib/logger';
import type { ModelConfig } from '@/types';
import type { StepUpdate } from '@/types/messages';

const MAX_STEPS = 30;

/** Configurable wall-clock timeout (overridable for E2E tests). */
export let WALL_TIMEOUT = 120_000;
export function setWallTimeout(ms: number) { WALL_TIMEOUT = ms; }

export interface RunAgentInput {
  sessionId: string;
  prompt: string;
  config: ModelConfig;
  abortSignal: AbortSignal;
  /** Call ac.abort() on the controller in background.ts. */
  abort: () => void;
  /** Emit a raw event to the side panel. No buffering. */
  emit: (event: { type: string; [k: string]: unknown }) => void;
}

/** Fire-and-forget agent loop. All output goes through emit(). */
export async function runAgent(input: RunAgentInput): Promise<void> {
  const run = log.scope(input.sessionId);
  run.info('runAgent start', { sessionId: input.sessionId });

  // Wrap emit so every emitted event is also logged (useful for E2E
  // assertions and post-mortem debugging — events leave a trail in
  // .e2e-logs/sw.log without needing the side panel to be open).
  const userEmit = input.emit;
  const wrappedEmit = (event: { type: string; [k: string]: unknown }) => {
    run.debug('emit', { type: event.type });
    userEmit(event);
  };
  const wrappedInput: RunAgentInput = { ...input, emit: wrappedEmit };

  const cdpService = new CDPService(input.sessionId);
  setCurrentCDP(cdpService);

  // CDP cleanup runs ONLY from the onFinish / onError callbacks inside
  // runAgentInner — NOT from this `finally` block. The finally block runs
  // immediately when runAgentInner returns (because consumeStream is
  // fire-and-forget), which is WAY before the stream actually finishes,
  // which used to null out currentCDP and break every subsequent tool call.
  // If onFinish/onError never fire (e.g., SW killed mid-stream), Chrome
  // detaches the debugger when the extension unloads.
  const cleanupCdp = async (reason: string) => {
    setCurrentCDP(null);
    await cdpService.detach();
    run.info('cdp cleanup', { reason });
  };
  (wrappedInput as RunAgentInput & { __cleanupCdp: typeof cleanupCdp }).__cleanupCdp = cleanupCdp;

  try {
    await runAgentInner(wrappedInput, cdpService, run);
    run.info('runAgent complete', { totalDurationMs: run.elapsed() });
  } finally {
    // No CDP cleanup here. See comment above.
    run.info('runAgent finally (no cleanup — handled by onFinish/onError)');
  }
}

async function runAgentInner(input: RunAgentInput, cdpService: CDPService, run: ScopedLogger): Promise<void> {
  const { emit, sessionId, prompt, config } = input;

  // 1. Emit user message AND persist it to Dexie.
  emit({ type: 'user_message', sessionId, prompt });
  await appendMessage({
    sessionId,
    role: 'user',
    parts: [{ type: 'text', text: prompt }],
  });
  run.info('user_message emitted and persisted', { sessionId });

  // 2. Build CoreMessage[] for the model.
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] }];

  // 3. Wait briefly for side panel listener to register.
  run.warn('100ms wait for SP listener — race condition: no confirmation', { delay: 100 });
  await new Promise((r) => setTimeout(r, 100));

  // 4. Filter tools. The `todo` tool is always available (the LLM uses it
  //    to plan multi-step work); other tools honor the user's tool config.
  const enabledNames = await getEnabledToolNames();
  const enabledTools = {
    todo: createTodoTool(emit),
    ...Object.fromEntries(
      Object.entries(allTools).filter(([name]) => enabledNames.has(name)),
    ),
  };
  run.info('enabled tools', { tools: Object.keys(enabledTools) });

  // 5. Build dynamic system prompt.
  const systemPrompt = buildSystemPrompt(enabledNames);

  // 6. Create model.
  const model = await run.timed('createModel', () => createModel(config));
  emit({ type: 'model_ready', modelId: config.modelId });
  run.info('model ready', { modelId: config.modelId });

  // 7. Wall-clock timeout for the entire run.
  //    Use chrome.alarms when the timeout is >= 30s (the alarm minimum).
  //    For sub-30s timeouts (E2E tests), fall back to setTimeout — this works
  //    as long as the SW is actively processing events (which it is, during
  //    an agent run). Alarms are persisted across SW restarts; setTimeout is not.
  run.info('wall-clock timer set', { timeout: WALL_TIMEOUT });
  let wallTimer: ReturnType<typeof setTimeout> | null = null;
  if (WALL_TIMEOUT >= 30_000 && typeof chrome !== 'undefined' && chrome.alarms) {
    const alarmName = `agent-wall-timeout-${Date.now()}`;
    chrome.alarms.create(alarmName, { delayInMinutes: WALL_TIMEOUT / 60_000 });
    const alarmListener = (alarm: chrome.alarms.Alarm) => {
      if (alarm.name === alarmName) {
        run.warn('wall-clock timeout reached — aborting', { timeout: WALL_TIMEOUT });
        input.abort();
        chrome.alarms.onAlarm.removeListener(alarmListener);
      }
    };
    chrome.alarms.onAlarm.addListener(alarmListener);
    // Also keep a setTimeout as a fast-path — alarms have ~30s granularity.
    wallTimer = setTimeout(() => {
      run.warn('wall-clock timeout reached — aborting', { timeout: WALL_TIMEOUT });
      input.abort();
    }, WALL_TIMEOUT);
  } else {
    wallTimer = setTimeout(() => {
      run.warn('wall-clock timeout reached — aborting', { timeout: WALL_TIMEOUT });
      input.abort();
    }, WALL_TIMEOUT);
  }

  let stepCounter = 0;

  // 8. Stream — emit each chunk immediately. No buffering.
  run.info('streamText calling', { maxSteps: MAX_STEPS });
  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools: enabledTools,
    maxSteps: MAX_STEPS,
    abortSignal: input.abortSignal,

    onChunk: ({ chunk }) => {
      const c = chunk as { type: string; [k: string]: unknown };
      run.debug('chunk', { chunkType: c.type });
      emit({ type: 'chunk', chunkType: c.type, data: c });
    },

    onStepFinish: async (step) => {
      stepCounter += 1;
      run.info('onStepFinish', {
        stepNumber: stepCounter,
        textLength: step.text?.length ?? 0,
        toolCallCount: step.toolCalls?.length ?? 0,
        toolResultCount: step.toolResults?.length ?? 0,
      });

      // Emit distinct event for each tool result (architecture rule 7).
      // These are emitted BEFORE step_done so the UI can render the result
      // before the step transitions to "done".
      for (const tr of step.toolResults ?? []) {
        emit({
          type: 'tool_result',
          toolCallId: (tr as { toolCallId?: string }).toolCallId ?? '',
          name: (tr as { toolName?: string }).toolName ?? 'unknown',
          result: (tr as { result?: unknown }).result,
          isError: (tr as { isError?: boolean }).isError ?? false,
          stepNumber: stepCounter,
        });
      }

      // Emit incremental token usage (architecture rule 7 — distinct from
      // the aggregate usage in agent_done).
      const stepUsage = step.usage;
      if (stepUsage) {
        emit({
          type: 'token_usage',
          stepNumber: stepCounter,
          prompt: stepUsage.promptTokens ?? 0,
          completion: stepUsage.completionTokens ?? 0,
        });
      }

      // Emit progress (architecture rule 7).
      emit({
        type: 'progress',
        current: stepCounter,
        total: MAX_STEPS,
        percentage: Math.round((stepCounter / MAX_STEPS) * 100),
      });

      const update: StepUpdate = {
        stepNumber: stepCounter,
        text: step.text ?? '',
        toolCalls: (step.toolCalls ?? []).map((tc) => ({
          id: (tc as { toolCallId?: string }).toolCallId ?? newId(),
          name: (tc as { toolName?: string }).toolName ?? 'unknown',
          args: (tc as { args?: Record<string, unknown> }).args ?? {},
        })),
        toolResults: (step.toolResults ?? []).map((tr) => ({
          toolCallId: (tr as { toolCallId?: string }).toolCallId ?? '',
          name: (tr as { toolName?: string }).toolName ?? 'unknown',
          result: (tr as { result?: unknown }).result,
          isError: (tr as { isError?: boolean }).isError ?? false,
        })),
        durationMs: 0,
      };
      await appendStep({ messageId: '', ...update } as any).catch(() => {});
      emit({ type: 'step_done', stepNumber: stepCounter, update });
    },

    onError: ({ error }) => {
      const msg = error instanceof Error ? error.message : String(error);
      const isAbort = input.abortSignal?.aborted === true
        || (error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(msg)));
      if (isAbort) {
        // User cancel — terminate cleanly. Do NOT emit agent_error so the
        // UI doesn't show a red error banner; the cancel flow handles state.
        run.info('onError: abort (user cancel)', { error: msg });
      } else {
        // Tool errors are caught by safeExecute (lib/tools.ts) and returned
        // as { error: string } observations — they should never reach this
        // callback. If we ARE here with a non-abort error, it's either a
        // network/provider failure or a stream-level error. Log it but
        // don't terminate: the AI SDK loop will continue and the LLM will
        // see the error on the next step. Only emit agent_error for
        // truly fatal cases (e.g., model creation failed, provider 5xx).
        const isFatal = /model.*not.*found|api.*key|provider.*5\d\d|ECONN|ENOTFOUND|ETIMEDOUT/i.test(msg);
        if (isFatal) {
          run.error('onError (fatal)', { error: msg });
          emit({ type: 'agent_error', message: msg });
        } else {
          run.warn('onError (non-fatal, loop continues)', { error: msg });
        }
      }
      // CDP cleanup runs in both cases — once the stream is done or aborted.
      const cleanup = (input as RunAgentInput & { __cleanupCdp?: (r: string) => Promise<void> }).__cleanupCdp;
      cleanup?.('onError').catch(() => {});
    },

    onFinish: async ({ steps }) => {
      const totalUsage = steps.reduce(
        (acc, s) => ({
          prompt: acc.prompt + (s.usage?.promptTokens ?? 0),
          completion: acc.completion + (s.usage?.completionTokens ?? 0),
        }),
        { prompt: 0, completion: 0 },
      );
      // Concatenate all step text into one assistant message and persist.
      const fullText = steps.map((s) => s.text ?? '').join('');
      if (fullText) {
        await appendMessage({
          sessionId,
          role: 'assistant',
          parts: [{ type: 'text', text: fullText }],
        });
        run.info('assistant message persisted', { length: fullText.length });
      }
      run.info('onFinish', { usage: totalUsage, stepCount: steps.length, durationMs: run.elapsed() });
      emit({ type: 'agent_done', usage: totalUsage, stepCount: steps.length });
      // CDP cleanup at the true end of the run (not when runAgentInner
      // returns, which happens immediately because consumeStream is
      // fire-and-forget).
      const cleanup = (input as RunAgentInput & { __cleanupCdp?: (r: string) => Promise<void> }).__cleanupCdp;
      await cleanup?.('onFinish');
    },
  });

  // 9. Consume stream — AWAIT it so the run doesn't return before the
  // stream terminates. Otherwise `runAgent` resolves immediately while the
  // stream is still draining, the side panel sees `runAgent complete`
  // with zero chunks, and the user gets an empty assistant message.
  // The previous fire-and-forget `.catch()` was a known-bug: the catch
  // never fired because the promise stayed pending after the function
  // returned.
  try {
    await result.consumeStream();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    run.error('consumeStream error', { error: msg });
    // Surface the failure to the side panel so the user sees something.
    emit({ type: 'agent_error', message: msg });
    // Re-throw so the caller (background.ts) sees the failure too.
    throw err;
  }

  // Clean up wall-clock timer.
  if (wallTimer) clearTimeout(wallTimer);
}

// ---------- Dynamic system prompt ----------

function buildSystemPrompt(enabledTools: Set<string>): string {
  const has = (t: string) => enabledTools.has(t);
  const sections: string[] = [];

  sections.push(`You are AgentSurfer, an AI browser agent that can see and control the active browser tab.

WORKFLOW:
1. Before acting, ensure an http/https tab is active. Use tabsList → tabsSwitch or tabsOpen.
2. Wait for pages to load. Use screenshots to verify.
3. Take the minimum actions needed.
4. When done, reply with a concise summary.

MULTI-STEP TASKS (e.g., "search X, click N links, summarize, clean up"):
- AT THE START: call the \`todo\` tool with the FULL list of steps as one call. Each step is one todo. Mark the first as in_progress.
- Process the todos IN ORDER. After completing each step, call \`todo\` again with the updated list (mark the just-completed step as completed, the next as in_progress).
- Do NOT skip steps. Do NOT add steps the user didn't ask for. Do NOT stop after 1 step if the user asked for N (e.g., "click 3 links" = click exactly 3, not 1).
- The FINAL step is almost always a written summary (中文/English) — DO NOT finish without writing it.
- After the summary, also clean up: tabsClose any tabs you opened during the task.
- Verify each step visually (cdpScreenshot) before marking complete. Don't trust your first aim — compare before/after cdpAim images and iterate.
- If you get stuck on a single step for >3 attempts, use \`todo\` to mark it blocked and move on rather than burning all remaining steps.`);

  if (has('cdpAim') || has('cdpConfirm') || has('cdpClick')) {
    sections.push(`CLICKING: MANDATORY aim→verify→confirm flow with VISUAL SERVOING (two-phase):

VISUAL SERVOING — do not try to compute exact coordinates in one shot.
Instead, treat it as a closed-loop control problem: draw a big box,
observe the offset, correct, repeat. After 2-3 rounds the box
converges on the target.

PHASE 1 — FIX POSITION (size locked, only x/y change):
  - Start with a LARGE size (200px). The box is way bigger than the
    target, so as long as the box COVERS the target, the position
    is close enough.
  - Call cdpAim(x, y, size=200). Get BEFORE + AFTER screenshots.
  - COMPARE: in the AFTER image, is the target inside the red box?
    - If yes → go to PHASE 2.
    - If no → describe the relative offset ("red box is right of
      target by ~100px") and call cdpCancel + cdpAim with corrected
      x/y. KEEP size=200.
  - Iterate until the target is centered in the box (3-4 rounds typical).

PHASE 2 — SHRINK SIZE (position locked, only size changes):
  - Once the box is centered on the target, shrink the size:
    200 → 100 → 50 → 20.
  - At each size, check that the target is still fully covered.
  - If the box becomes too small and the target is no longer fully
    covered, go back to a slightly larger size.

PHASE 3 — CONFIRM:
  - cdpConfirm(x, y) with the converged coordinates.

CRITICAL: never change BOTH x/y AND size in the same step. Phase
1 only changes x/y. Phase 2 only changes size. If you change both
simultaneously, the visual feedback becomes ambiguous (you can't tell
whether the position changed or the size changed).

CANCELING: cdpCancel() clears the current highlight without acting.
Always cancel before re-aiming.

COORDINATE SYSTEM: cdpAim / cdpConfirm / cdpClick accept SCREENSHOT
coordinates — the same units as the BEFORE/AFTER images you see (e.g.,
device pixels, typically 2x the CSS viewport on HiDPI). Pass the pixel
coordinates you see directly. The tool converts to CSS internamente using
the cached dpr — you do NOT need to think about dpr or divide anything.
The tool result reports the screenshot dimensions for reference.

DEFAULTS: cdpAim defaults to size=200 (large enough to see). cdpAim
defaults to color='red'. Pick a contrasting color if needed (lime on
white, yellow on red, etc.).

OR cdpScroll({ deltaY }) — scroll at the last aim position.

DOM TOOLS DISABLED: domQuery, domClick, domType, pressKey, focusNext, focusPrevious are NOT available. Use only CDP-based tools (cdpAim, cdpConfirm, cdpCancel, cdpScreenshot, cdpScroll, tabsList, tabsSwitch, tabsOpen, tabsClose, smartScreenshot). Identify target positions from screenshots only.`);
  }

  if (has('domQuery')) {
    sections.push(`FINDING ELEMENTS: Use domQuery for CSS selectors. If it fails, try focusNext.`);
  }

  if (has('focusNext')) {
    sections.push(`FOCUS NAVIGATION: focusNext/FocusPrevious for Tab traversal. Returns accessible name.`);
  }

  if (has('smartScreenshot')) {
    sections.push(`WAITING FOR PAGE: Use smartScreenshot({ schedule: { durationMs: 2000, intervalMs: 500 } }) to detect when loading finishes.`);
  }

  sections.push(`RULES:
- Never enter passwords/sensitive values without user confirmation.
- TOOL ERRORS ARE OBSERVATIONS, NOT FAILURES. When a tool returns { error: "..." }, treat it as a new input and decide what to do next: try a different approach, retry with adjusted parameters, or call another tool. Do NOT give up after one error — try at least 2-3 different approaches before concluding the task is impossible.
- Common tool errors and how to recover:
  * "CDP not available" → call cdpScreenshot first (it re-attaches the debugger) before retrying
  * "No active tab" → call tabsList, then tabsSwitch to a non-chrome:// tab
  * "Tab not found" → call tabsList to refresh tab IDs
  * "javascript: URLs are not allowed" → use domQuery + cdpType via executeScript, or open a new tab with a proper http(s):// URL
- If a tool fails 3 times with the same approach, try a fundamentally different strategy.
- If the page is chrome://, file://, or about:, stop and tell the user.
- Be concise. Don't narrate steps the user can see in the trace.
- ACT, don't narrate — every observation must be followed by a tool call or final answer.`);

  return sections.join('\n\n');
}
