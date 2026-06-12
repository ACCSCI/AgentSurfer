// Agent loop — self-written, no Flue.
// Uses Vercel AI SDK v4's streamText with maxSteps for multi-step agentic loops.
// Persists every step to Dexie and pushes live updates to the side panel.

import { type CoreMessage, streamText } from 'ai';
import {
  appendMessage,
  appendStep,
  getEnabledToolNames,
  getMessagesBySession,
  newId,
  saveScreenshot,
} from '@/lib/db';
import { allTools } from '@/lib/tools';
import { createModel } from '@/lib/llm';
import { CDPService, setCurrentCDP } from '@/lib/cdp';
import type {
  ModelConfig,
  ToolCall as DbToolCall,
  ToolResult as DbToolResult,
  Usage,
} from '@/types';
import type { StepUpdate } from '@/types/messages';

const SYSTEM_PROMPT = `You are AgentSurfer, an AI browser agent that can see and control the active browser tab.

WORKFLOW (always follow):
1. BEFORE you act, ensure a real http/https tab is active. Use \`tabsList\` then \`tabsSwitch\` or \`tabsOpen\`.
2. ALWAYS wait for the page to finish loading. If you just opened a tab or clicked a link, call \`smartScreenshot\` with \`{ schedule: { durationMs: 2000, intervalMs: 500 } }\`. When the change values drop to 0, the page is stable. Then take a single \`screenshot\` to see the loaded page.
3. Use \`domQuery\` to find elements. If domQuery returns nothing useful, use \`focusNext\` to Tab through — the accessible name reveals input fields.
4. Take the minimum actions needed. After any action, take another \`screenshot\` to verify.
5. When done, reply with a concise summary.

FINDING INPUT FIELDS (priority):
1. domQuery: input[name="q"], input[type="search"], textarea, input[type="text"]
2. focusNext — Tab through, check each step's name for "search", "input", "query"
3. If still stuck: smartScreenshot schedule { durationMs: 2000, intervalMs: 500 }. A blinking vertical line (cursor) = focused input. The bbox tells you WHERE.
4. Once found: domType or domClick + domType.

CRITICAL — ACT, DON'T NARRATE:
After observing, your next response MUST be a tool call or the final answer. Never write "Let me click..." without calling the tool.

RULES:
- Never enter passwords/sensitive values without user confirmation.
- If a selector fails 3 times, fall through: domQuery → focusNext → smartScreenshot.
- If the page is chrome://, file://, about:, or a login wall, stop and tell the user.
- Be concise. Don't narrate steps the user can see in the trace.
- When in doubt, screenshot first.`;

const MAX_STEPS = 30;

/** Build a system prompt dynamically based on which tools are enabled. */
function buildSystemPrompt(enabledTools: Set<string>): string {
  const has = (t: string) => enabledTools.has(t);

  const sections: string[] = [];

  // Core workflow
  sections.push(`You are AgentSurfer, an AI browser agent that can see and control the active browser tab.

WORKFLOW (always follow):
1. BEFORE you act, ensure a real http/https tab is active. Use tabsList then tabsSwitch or tabsOpen.
2. ALWAYS wait for the page to finish loading. If you just opened a tab or clicked a link, wait briefly.
3. Start by taking a screenshot to see the current state.
4. Use the minimum actions needed to accomplish the goal.
5. When done, reply with a concise summary.`);

  // Finding elements — only include relevant tools
  if (has('domQuery') || has('domClick') || has('domType')) {
    sections.push(`FINDING ELEMENTS:
1. domQuery: input[name="q"], input[type="search"], textarea, input[type="text"]
2. If domQuery fails, use focusNext to Tab through and find the input by its accessible name.
3. Once found, get its bounding box from domQuery, then use cdpClick/cdpType (native input) instead of domClick/domType (JS events). CDP tools are more reliable on modern SPAs.`);
  }

  if (has('focusNext')) {
    sections.push(`FOCUS NAVIGATION:
Use focusNext to Tab through the page. Each step returns the focused element's accessible name and role. Look for names containing "search", "input", "query", "text field".`);
  }

  if (has('smartScreenshot')) {
    sections.push(`SMART SCREENSHOT SCHEDULE:
When a page just loaded or you need to detect changes, use smartScreenshot with { schedule: { durationMs: 2000, intervalMs: 500 } }. The response shows frame-by-frame changes — when values drop to 0, the page is stable. A blinking vertical line in the bbox means a focused text input.`);
  }

  // Action rules
  if (has('domClick') && has('domType')) {
    sections.push(`ACT, DON'T NARRATE:
After observing, your next response MUST be a tool call or the final answer. Never write "Let me click..." without calling the tool.

CLICKING / SCROLLING: ALWAYS use the aim→action flow:
1. cdpAim(x, y) — draws a red crosshair at (x,y), returns a screenshot
2. Look at the screenshot: is the red square on your target?
3. If CLICKING: cdpConfirm(x, y) — clears crosshair and clicks
4. If SCROLLING: cdpScroll({ deltaY: 300 }) — scrolls at the crosshair position (no coordinates needed)
5. If WRONG: cdpAim(修正坐标) — redraw at correct position, re-screenshot, then confirm
6. If DECIDING NOT TO ACT: cdpCancel() — clears crosshair
7. NEVER call cdpClick/directly — always aim first, then confirm/scroll`);
  }

  if (has('pressKey')) {
    sections.push(`FORM SUBMISSION:
After typing with domType, press Enter with pressKey({ key: "Enter" }) to submit.`);
  }

  // Safety rules (always included)
  sections.push(`RULES:
- Never enter passwords/sensitive values without user confirmation.
- If a selector fails 3 times, try a different method.
- If the page is chrome://, file://, or about:, stop and tell the user.
- Be concise. Don't narrate steps the user can see in the trace.
- When in doubt, screenshot first.`);

  return sections.join('\n\n');
}

export interface RunAgentInput {
  sessionId: string;
  prompt: string;
  config: ModelConfig;
  abortSignal: AbortSignal;
  onStep: (step: StepUpdate) => void;
  onChunk?: (chunk: unknown) => void;
  onError: (err: Error) => void;
  onDone: (info: { totalUsage?: { prompt: number; completion: number } }) => void;
}

/**
 * Runs a single agent loop. Persists the user message + assistant message +
 * every step to Dexie, and pushes live step updates to the caller.
 */
export async function runAgent(input: RunAgentInput): Promise<void> {
  // Create CDP service for this run. Shared by all CDP tools.
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
  // 1. Persist the user message.
  await appendMessage({
    sessionId: input.sessionId,
    role: 'user',
    parts: [{ type: 'text', text: input.prompt }],
  });
  console.log('[AgentSurfer] user message persisted');

  // 2. Build the CoreMessage[] for the model. For v0.1 we send text only;
  //    visual context is refreshed each run by the first screenshot call.
  //    'tool' rows are dropped — we don't replay tool transcripts yet.
  const history = await getMessagesBySession(input.sessionId);
  console.log('[AgentSurfer] history loaded,', history.length, 'messages');
  const modelMessages: CoreMessage[] = history
    .filter((m) => m.role !== 'tool')
    .map((m) => {
      const text = m.parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n');
      if (m.role === 'system') {
        return { role: 'system', content: text };
      }
      if (m.role === 'user') {
        return { role: 'user', content: text };
      }
      // assistant
      return { role: 'assistant', content: text };
    });

  // 3. Spin up the stream.
  console.log('[AgentSurfer] creating model for', input.config.provider, input.config.modelId);
  const model = await createModel(input.config);
  console.log('[AgentSurfer] model created, calling streamText');
  const assistantMessageId = newId();
  let stepCounter = 0;
  const startMs = Date.now();
  let runReasoning = '';
  let runText = '';

  // Filter tools based on enabled config.
  const enabledNames = await getEnabledToolNames();
  const enabledTools = Object.fromEntries(
    Object.entries(allTools).filter(([name]) => enabledNames.has(name)),
  );
  console.log('[AgentSurfer] enabled tools:', Object.keys(enabledTools).join(', '));

  // Generate dynamic system prompt based on enabled tools.
  const dynamicPrompt = buildSystemPrompt(enabledNames);

  const result = streamText({
    model,
    system: dynamicPrompt,
    messages: modelMessages,
    tools: enabledTools,
    maxSteps: MAX_STEPS,
    abortSignal: input.abortSignal,
    onChunk: ({ chunk }) => {
      input.onChunk?.(chunk);
      const { type } = chunk as { type: string };
      switch (type) {
        case 'text-delta': {
          const t = (chunk as { textDelta: string }).textDelta;
          runText += t;
          console.log('[AgentSurfer][chunk] text:', JSON.stringify(t));
          break;
        }
        case 'tool-call-delta': {
          const c = chunk as {
            toolCallId: string;
            toolName: string;
            argsTextDelta: string;
          };
          console.log(
            '[AgentSurfer][chunk] tool-call-delta:',
            c.toolName,
            c.toolCallId,
            JSON.stringify(c.argsTextDelta),
          );
          break;
        }
        case 'tool-call': {
          const c = chunk as unknown as {
            toolCallId: string;
            toolName: string;
            args: string | Record<string, unknown>;
          };
          console.log(
            '[AgentSurfer][chunk] tool-call:',
            c.toolName,
            c.toolCallId,
            c.args,
          );
          break;
        }
        case 'reasoning':
        case 'reasoning-delta': {
          const r = (chunk as { textDelta?: string; text?: string });
          const text = r.textDelta ?? r.text ?? '';
          if (text) {
            runReasoning += text;
            console.log('[AgentSurfer][chunk] reasoning:', JSON.stringify(text));
          }
          break;
        }
        case 'error': {
          const e = (chunk as { error?: { message?: string } });
          console.error('[AgentSurfer][chunk] error:', e.error?.message);
          break;
        }
        default:
          break;
      }
    },
    onStepFinish: async (step) => {
      stepCounter += 1;
      console.log(
        `[AgentSurfer][step ${stepCounter}] finish — text=${JSON.stringify(
          (step.text ?? '').slice(0, 200),
        )} toolCalls=${(step.toolCalls ?? []).length} toolResults=${(step.toolResults ?? []).length}`,
      );
      const stepRow = await appendStep({
        messageId: assistantMessageId,
        stepNumber: stepCounter,
        text: step.text ?? '',
        toolCalls: (step.toolCalls ?? []).map(toDbToolCall),
        toolResults: (step.toolResults ?? []).map(toDbToolResult),
        usage: toDbUsage(step.usage),
        durationMs: 0, // filled below after we know step duration
      });

      // Persist screenshots from tool results (dataURL → Blob).
      for (const tr of step.toolResults ?? []) {
        const r = tr.result as
          | { dataUrl?: string; width?: number; height?: number }
          | undefined;
        if (r?.dataUrl && typeof r.dataUrl === 'string') {
          try {
            const blob = await dataUrlToBlob(r.dataUrl);
            await saveScreenshot(blob, {
              stepId: stepRow.id,
              width: r.width ?? 0,
              height: r.height ?? 0,
            });
          } catch (err) {
            console.warn('[AgentSurfer] Failed to persist screenshot', err);
          }
        }
      }

      input.onStep({
        stepNumber: stepRow.stepNumber,
        text: stepRow.text,
        toolCalls: stepRow.toolCalls,
        toolResults: stepRow.toolResults,
        durationMs: stepRow.durationMs,
      });
    },
    onError: ({ error }) => {
      // Save the error as a step record so the UI can show what happened.
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('[AgentSurfer] onError:', errMsg);
      appendStep({
        messageId: assistantMessageId,
        stepNumber: ++stepCounter,
        text: `Error: ${errMsg}`,
        toolCalls: [],
        toolResults: [],
        durationMs: 0,
      }).catch(() => {});
      input.onError(error instanceof Error ? error : new Error(errMsg));
    },
    onFinish: ({ steps }) => {
      console.log(
        `[AgentSurfer] agent finished — ${steps.length} step(s), total text length ${steps.reduce((n, s) => n + (s.text?.length ?? 0), 0)}`,
      );
      // Sum token usage across all steps for a session-level total.
      const totalUsage = steps.reduce(
        (acc, s) => {
          acc.prompt += s.usage?.promptTokens ?? 0;
          acc.completion += s.usage?.completionTokens ?? 0;
          return acc;
        },
        { prompt: 0, completion: 0 },
      );
      input.onDone(
        totalUsage.prompt + totalUsage.completion > 0 ? { totalUsage } : {},
      );
      // Stash total run time for debugging.
      console.log(`[AgentSurfer] run finished in ${Date.now() - startMs}ms`);
    },
  });

  // 4. Wait for the final text and persist the assistant message.
  //    AI SDK v4: `result.text` is a getter; the stream is lazy. We must
  //    call `consumeStream()` to actually drain it and fire onChunk /
  //    onStepFinish callbacks.
  await result.consumeStream();
  const finalText = (await result.text).trim();

  // Persist both reasoning and text to Dexie so old messages show the
  // full thinking process even after a new run starts.
  const displayParts: Array<{ type: string; text?: string; reasoning?: string }> = [];
  if (runReasoning) {
    displayParts.push({ type: 'reasoning', reasoning: runReasoning });
  }
  if (finalText) {
    displayParts.push({ type: 'text', text: finalText });
  }
  await appendMessage({
    sessionId: input.sessionId,
    role: 'assistant',
    parts: displayParts as any,
  });
}

// ---------- Adapters from AI SDK v4 event shape to our DB shape ----------

type RawToolCall = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
};

type RawToolResult = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  result?: unknown;
  isError?: boolean;
};

function toDbToolCall(raw: RawToolCall): DbToolCall {
  return {
    id: raw.toolCallId ?? crypto.randomUUID(),
    name: raw.toolName ?? 'unknown',
    args: (raw.args as Record<string, unknown>) ?? {},
  };
}

function toDbToolResult(raw: RawToolResult): DbToolResult {
  return {
    toolCallId: raw.toolCallId ?? '',
    name: raw.toolName ?? 'unknown',
    result: raw.result,
    isError: raw.isError ?? false,
  };
}

function toDbUsage(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  return {
    promptTokens: u.promptTokens ?? 0,
    completionTokens: u.completionTokens ?? 0,
    totalTokens: u.totalTokens ?? 0,
  };
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}
