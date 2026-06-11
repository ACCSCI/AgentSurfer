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
1. Start by calling \`screenshot\` to see what is currently on the page.
2. Use \`domQuery\` to inspect specific elements when you need structure / text / attributes.
3. Take the minimum number of actions (click/type) needed to accomplish the user's goal.
4. After any UI action, take another screenshot to verify the result.
5. When the goal is achieved, reply with a concise plain-text summary.

RULES:
- Never enter passwords, credit card numbers, OAuth tokens, or any other sensitive value without explicit user confirmation in the chat.
- If a selector matches multiple elements and you need a specific one, narrow it with an index, class, or attribute filter.
- If the page cannot be interacted with (chrome://, file://, about:, PDF viewer, login wall, etc.), stop and tell the user.
- If the same action fails 3 times in a row, stop and ask the user for guidance — do not loop forever.
- Be concise. Do not narrate steps the user can already see in the step trace.
- When in doubt, screenshot first.`;

const MAX_STEPS = 20;

export interface RunAgentInput {
  sessionId: string;
  prompt: string;
  config: ModelConfig;
  abortSignal: AbortSignal;
  onStep: (step: StepUpdate) => void;
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

  // 2. Build the CoreMessage[] for the model. For v0.1 we send text only;
  //    visual context is refreshed each run by the first screenshot call.
  //    'tool' rows are dropped — we don't replay tool transcripts yet.
  const history = await getMessagesBySession(input.sessionId);
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
  const model = createModel(input.config);
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
    experimental_activeTools: ['domQuery', 'domClick', 'domType', 'screenshot'],
    onStepFinish: async (step) => {
      stepCounter += 1;
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
