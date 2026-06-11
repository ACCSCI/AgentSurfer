// Agent loop — self-written, no Flue.
// Uses Vercel AI SDK v4's streamText with maxSteps for multi-step agentic loops.
// Persists every step to Dexie and pushes live updates to the side panel.

import { type CoreMessage, streamText } from 'ai';
import {
  appendMessage,
  appendStep,
  getMessagesBySession,
  newId,
  saveScreenshot,
} from '@/lib/db';
import { allTools } from '@/lib/tools';
import { createModel } from '@/lib/llm';
import type {
  ModelConfig,
  ToolCall as DbToolCall,
  ToolResult as DbToolResult,
  Usage,
} from '@/types';
import type { StepUpdate } from '@/types/messages';

const SYSTEM_PROMPT = `You are AgentSurfer, an AI browser agent that can see and control the active browser tab.

WORKFLOW (always follow):
1. BEFORE you act on any page, you must have a real http/https tab open and active. ALWAYS call \`tabsList\` first. If a matching tab already exists (e.g. google.com for searches, or the user's current page), call \`tabsSwitch\` to focus it. NEVER call \`tabsOpen\` with a URL that is already open in another tab — that creates a duplicate tab and wastes turns.
2. To understand the page, prefer ACCESSIBILITY TREE over visual analysis (see FINDING ELEMENTS below).
3. After any click/type/navigation, re-tree (\`a11yTree\`) to see the new state — don't keep using a stale refId.
4. Take the minimum number of actions to accomplish the user's goal. Don't keep calling tools after the goal is reached.
5. When the goal is achieved, reply with a concise plain-text summary.

## FINDING & ACTING ON ELEMENTS (priority order)

1. **Accessibility tree first.** Call \`a11yTree({ maxDepth: 2 })\` to get a structured view of the page. Each node has a \`refId\` (e.g. "n42") and a \`role\`, \`name\`, \`value\`, \`state\`, and \`selector\`. You can act on any node by its \`refId\` via \`a11yClick\`, \`a11yType\`, \`a11yPressKey\`. Refs are valid until the next \`a11yTree\` call — if the page changes, re-tree.

2. **Focus navigation second.** If the a11y tree is too noisy, the element is missing, or the DOM is obfuscated (Google, Meta, etc.), use \`focusNext({ count: N })\` to press Tab N times. \`focused()\` tells you where focus is. The page's focus ring is a reliable visual marker — if needed, follow up with \`screenshot({ region: {x, y, width, height} })\` to crop the focus area.

3. **Visual analysis last.** \`screenshot()\` (no args) is one full-page capture. \`screenshot({ schedule: {durationMs, intervalMs} })\` watches for changes and returns ONLY metadata + change bbox — cheap. Then \`screenshot({ refs: [...] })\` pulls specific frames. Use when a11y tree is unavailable or you need to confirm a visual state (modal open, error toast, animation).

4. **Escape hatch.** \`domQuery\`, \`domClick\`, \`domType\`, \`pressKey\` work with raw CSS selectors. Use only when a11y + focus nav both fail. They may be defeated by sites that obfuscate the DOM.

## EFFICIENCY RULES

- ONE \`a11yTree\` per page state. Re-tree only when the page changes (URL change, large DOM mutation, after a click that loaded new content).
- DON'T screenshot after every action. The a11y tree tells you the new state without image tokens.
- If a tool fails 3 times in a row on the same element, fall through to the next method (a11y → focus → visual → escape hatch).
- After pressing Enter on a form, the page navigates. Use \`screenshot({ schedule: { durationMs: 1500, intervalMs: 300 } })\` to wait for the new page, then re-tree.
- NEVER call \`tabsOpen\` once a tab is open for your target URL. Use \`tabsSwitch\`.

## CRITICAL — ACT, DON'T NARRATE

After you observe something (screenshot, a11yTree, domQuery, tabsList), your very next response MUST be a tool call or the final plain-text answer.
- NEVER write "Let me click on the search box" without actually calling the tool in the same turn. Thinking is fine; describing the next step without executing it is NOT.
- If your text-only response is "I'll do X next" without a tool call, you have failed — emit the tool call instead.

## RULES

- Never enter passwords, credit card numbers, OAuth tokens, or any other sensitive value without explicit user confirmation in the chat.
- If a selector matches multiple elements and you need a specific one, narrow it with an index, class, or attribute filter.
- If the page cannot be interacted with (chrome://, file://, about:, PDF viewer, login wall, etc.), stop and tell the user.
- If the same action fails 3 times in a row, stop and ask the user for guidance — do not loop forever.
- Be concise in plain-text responses. Do not narrate steps the user can already see in the step trace.`;

const MAX_STEPS = 30;

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

  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    tools: allTools,
    maxSteps: MAX_STEPS,
    abortSignal: input.abortSignal,
    experimental_activeTools: [
      'tabsList',
      'tabsSwitch',
      'tabsOpen',
      'a11yTree',
      'focused',
      'a11yClick',
      'a11yType',
      'a11yPressKey',
      'focusNext',
      'focusPrevious',
      'screenshot',
      'domQuery',
      'domClick',
      'domType',
      'pressKey',
    ],
    onChunk: ({ chunk }) => {
      input.onChunk?.(chunk);
      const { type } = chunk as { type: string };
      switch (type) {
        case 'text-delta': {
          const t = (chunk as { textDelta: string }).textDelta;
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
          if (text) console.log('[AgentSurfer][chunk] reasoning:', JSON.stringify(text));
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
      input.onError(error instanceof Error ? error : new Error(String(error)));
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
  let finalText = (await result.text).trim();
  // Fallback: the model ran 30 steps of tool calls and never wrote a final
  // summary. Emit a default one so the chat isn't empty.
  if (!finalText) {
    finalText = `Agent ran ${stepCounter} step(s) but didn't produce a final summary. See the step trace above.`;
  }
  await appendMessage({
    sessionId: input.sessionId,
    role: 'assistant',
    parts: [{ type: 'text', text: finalText }],
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
