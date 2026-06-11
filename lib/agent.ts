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
2. Start by calling \`screenshot\` to see what is currently on the page.
3. Use \`domQuery\` to inspect specific elements when you need structure / text / attributes.
4. Take the minimum number of actions (click/type) needed to accomplish the user's goal.
5. After any UI action, take another screenshot to verify the result.
6. When the goal is achieved, reply with a concise plain-text summary. Do NOT keep calling tools after the goal is reached.

CRITICAL — ACT, DON'T NARRATE:
After you observe something (screenshot, domQuery, tabsList), your very next response MUST be a tool call (domQuery / domClick / domType / screenshot / tabsList / tabsSwitch / tabsOpen) or the final plain-text answer.
- NEVER write a sentence like "Let me click on the search box" or "I will type 'githubtrends' now" without actually calling the tool in the same turn. Thinking is fine; describing the next step without executing it is NOT.
- If your text-only response is "I'll do X next" without a tool call, you have failed — emit the tool call instead.

WHEN USING domType / domClick ON A SEARCH BOX:
- Modern sites (Google, Bing, DuckDuckGo) put the search input inside a wrapper element. The clickable area may be a div with aria-label; the actual <input> is its child. You can:
  1. domClick the wrapper to focus the input, then domType into the input, OR
  2. domType directly into the input (this works in most cases because the input accepts value even when not focused), OR
  3. domClick the input itself.
- Prefer option (2) or (3) — fewer steps.
- After typing, submit the form with the \`pressKey\` tool (key: \"Enter\") — this also calls \`form.requestSubmit()\` so the page navigates to results. Never claim you pressed Enter without calling \`pressKey\`.

RULES:
- Never enter passwords, credit card numbers, OAuth tokens, or any other sensitive value without explicit user confirmation in the chat.
- If a selector matches multiple elements and you need a specific one, narrow it with an index, class, or attribute filter.
- If the page cannot be interacted with (chrome://, file://, about:, PDF viewer, login wall, etc.), stop and tell the user.
- If the same action fails 3 times in a row, stop and ask the user for guidance — do not loop forever.
- Be concise in plain-text responses. Do not narrate steps the user can already see in the step trace.
- When in doubt, screenshot first.`;

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
