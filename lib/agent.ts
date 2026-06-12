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
  const finalText = await result.text;
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
