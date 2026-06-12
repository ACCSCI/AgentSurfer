// Agent loop — pure event-driven runtime.
// Rules:
//   1. Emit events immediately. Never buffer.
//   2. Never hold UI state (no accumulatedText, no runReasoning).
//   3. Never call appendMessage from SW — UI owns Dexie writes.
//   4. Never wait for full LLM completion (no consumeStream/result.text).
//   5. Agent does not return a final response. All output is events.
//   6. Tool calls, tokens, steps, errors = distinct event types.

import { streamText } from 'ai';
import {
  appendStep,
  getEnabledToolNames,
  newId,
} from '@/lib/db';
import { allTools } from '@/lib/tools';
import { createModel } from '@/lib/llm';
import { CDPService, setCurrentCDP } from '@/lib/cdp';
import type { ModelConfig } from '@/types';
import type { StepUpdate } from '@/types/messages';

const MAX_STEPS = 30;

export interface RunAgentInput {
  sessionId: string;
  prompt: string;
  config: ModelConfig;
  abortSignal: AbortSignal;
  /** Emit a raw event to the side panel. No buffering. */
  emit: (event: { type: string; [k: string]: unknown }) => void;
}

/** Fire-and-forget agent loop. All output goes through emit(). */
export async function runAgent(input: RunAgentInput): Promise<void> {
  const cdpService = new CDPService();
  setCurrentCDP(cdpService);

  try {
    await runAgentInner(input, cdpService);
  } finally {
    setCurrentCDP(null);
    await cdpService.detach();
  }
}

async function runAgentInner(input: RunAgentInput, cdpService: CDPService): Promise<void> {
  const { emit, sessionId, prompt, config } = input;

  // 1. Emit user message (so UI can show it immediately).
  emit({ type: 'user_message', sessionId, prompt });

  // 2. Build CoreMessage[] for the model.
  //    We do NOT store anything here — UI handles persistence.
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] }];

  // 3. Wait briefly for side panel listener to register.
  await new Promise((r) => setTimeout(r, 100));

  // 4. Filter tools.
  const enabledNames = await getEnabledToolNames();
  const enabledTools = Object.fromEntries(
    Object.entries(allTools).filter(([name]) => enabledNames.has(name)),
  );
  console.log('[AgentSurfer] enabled tools:', Object.keys(enabledTools).join(', '));

  // 5. Build dynamic system prompt.
  const systemPrompt = buildSystemPrompt(enabledNames);

  // 6. Create model.
  const model = await createModel(config);
  emit({ type: 'model_ready', modelId: config.modelId });

  // 7. Wall-clock timeout for the entire run.
  const WALL_TIMEOUT = 120_000;
  const wallTimer = setTimeout(() => {
    input.abortSignal.dispatchEvent(new Event('abort'));
  }, WALL_TIMEOUT);

  let stepCounter = 0;

  // 8. Stream — emit each chunk immediately. No buffering.
  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools: enabledTools,
    maxSteps: MAX_STEPS,
    abortSignal: input.abortSignal,

    onChunk: ({ chunk }) => {
      const c = chunk as { type: string; [k: string]: unknown };
      // Emit every chunk as a raw event. UI decides what to display.
      emit({ type: 'chunk', chunkType: c.type, data: c });
    },

    onStepFinish: async (step) => {
      stepCounter += 1;
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
      // Persist step to Dexie (side panel doesn't handle this — it's a DB write).
      await appendStep({ messageId: '', stepNumber: stepCounter, ...update } as any).catch(() => {});
      emit({ type: 'step_done', stepNumber: stepCounter, update });
    },

    onError: ({ error }) => {
      const msg = error instanceof Error ? error.message : String(error);
      emit({ type: 'agent_error', message: msg });
    },

    onFinish: ({ steps }) => {
      const totalUsage = steps.reduce(
        (acc, s) => ({
          prompt: acc.prompt + (s.usage?.promptTokens ?? 0),
          completion: acc.completion + (s.usage?.completionTokens ?? 0),
        }),
        { prompt: 0, completion: 0 },
      );
      emit({ type: 'agent_done', usage: totalUsage, stepCount: steps.length });
    },
  });

  // 9. Consume stream in background — don't block, just drain.
  //    If it hangs, the wall-clock timer aborts.
  result.consumeStream().catch(() => {});
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
4. When done, reply with a concise summary.`);

  if (has('cdpAim') || has('cdpConfirm') || has('cdpClick')) {
    sections.push(`CLICKING: Use the aim→confirm flow:
1. cdpAim(x, y) — draws a red crosshair, returns screenshot
2. Look at screenshot: is crosshair on target?
3. cdpConfirm(x, y) — clears crosshair and clicks
4. Or cdpScroll({ deltaY }) — scroll at crosshair position
5. Or cdpCancel() — remove without acting
Never call cdpClick directly — always aim first.`);
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
- If a tool fails 3 times, try a different method.
- If the page is chrome://, file://, or about:, stop and tell the user.
- Be concise. Don't narrate steps the user can see in the trace.
- ACT, don't narrate — every observation must be followed by a tool call or final answer.`);

  return sections.join('\n\n');
}
