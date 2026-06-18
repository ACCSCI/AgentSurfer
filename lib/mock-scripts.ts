// Mock model scripts — used by E2E tests and for offline demos.
// Each script is identified by a `modelId` of the form `mock:<name>`.
//
// We use `MockLanguageModelV1` from `ai/test` and cast liberally because the
// test helper types are strict (require `rawCall`, etc.) but at runtime any
// correctly-shaped stream works fine. See Task #16 for why we picked an
// in-process mock over a separate HTTP server.

import { MockLanguageModelV1 } from 'ai/test';

// biome-ignore lint/suspicious/noExplicitAny: test helper, runtime shape is what matters
type Any = any;

export type ScriptedStep =
  | { type: 'text'; text: string; finishReason: 'stop' | 'tool-calls' }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      finishReason: 'tool-calls';
    };

export interface MockScript {
  steps: ScriptedStep[];
}

const SCRIPTS: Record<string, MockScript> = {
  happy: {
    steps: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'screenshot', args: {}, finishReason: 'tool-calls' },
      { type: 'text', text: 'I can see the page. Let me look around.', finishReason: 'tool-calls' },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'domQuery', args: { selector: 'button', limit: 5 }, finishReason: 'tool-calls' },
      { type: 'text', text: 'Found a button. All done.', finishReason: 'stop' },
    ],
  },
  oneTool: {
    steps: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'screenshot', args: {}, finishReason: 'tool-calls' },
    ],
  },
  textOnly: {
    steps: [{ type: 'text', text: 'Just a plain text reply, no tools.', finishReason: 'stop' }],
  },
  failsAtStep3: {
    steps: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'screenshot', args: {}, finishReason: 'tool-calls' },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'domQuery', args: { selector: 'div' }, finishReason: 'tool-calls' },
      { type: 'text', text: 'Simulated failure on step 3.', finishReason: 'stop' },
    ],
  },
  clickSequence: {
    steps: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'screenshot', args: {}, finishReason: 'tool-calls' },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'domQuery', args: { selector: '#start-button' }, finishReason: 'tool-calls' },
      { type: 'tool-call', toolCallId: 'c3', toolName: 'domClick', args: { selector: '#start-button' }, finishReason: 'tool-calls' },
      { type: 'text', text: 'Clicked the start button.', finishReason: 'stop' },
    ],
  },

  // --- Debug scripts for monitoring tests ---

  /** Streams one text delta, then the ReadableStream hangs forever (never closes). */
  hangsForever: {
    steps: [
      { type: 'text', text: 'Starting to think...', finishReason: 'stop' },
    ],
  },

  /** Streams one text delta, then the controller errors. */
  streamError: {
    steps: [
      { type: 'text', text: 'About to fail...', finishReason: 'stop' },
    ],
  },

  /** 15 sequential tool-call steps. Used to test SW keepalive. */
  longRunning: {
    steps: Array.from({ length: 15 }, (_, i) => ({
      type: 'tool-call' as const,
      toolCallId: `lr-${i}`,
      // Use `todo` (always injected by tool-registry, see CLAUDE.md §7.11)
      // so every step produces a valid tool-result and the AI SDK keeps
      // looping up to maxSteps. `screenshot` is NOT always enabled, and an
      // unavailable-tool call terminates the loop after step 1 — which would
      // make this script run a single step instead of 15.
      toolName: 'todo',
      args: {
        todos: [
          { content: `long-running step ${i}`, status: 'in_progress', activeForm: `Working on step ${i}` },
        ],
      },
      finishReason: 'tool-calls' as const,
    })),
  },

  /** Step 1: call the `todo` tool (triggers todo_update event).
   *  Step 2: finish with text. */
  withTodo: {
    steps: [
      {
        type: 'tool-call' as const,
        toolCallId: 'todo1',
        toolName: 'todo',
        args: {
          todos: [
            { content: 'Click the search button', status: 'in_progress', activeForm: 'Clicking the search button' },
            { content: 'Type query', status: 'pending', activeForm: 'Typing query' },
          ],
        },
        finishReason: 'tool-calls' as const,
      },
      {
        type: 'text' as const,
        text: 'Done planning.',
        finishReason: 'stop' as const,
      },
    ],
  },

  /** 5 steps of cdpAim + cdpConfirm. Used to test CDP conflict logging. */
  cdpHeavy: {
    steps: [
      { type: 'tool-call', toolCallId: 'ch1', toolName: 'cdpAim', args: { x: 100, y: 100 }, finishReason: 'tool-calls' },
      { type: 'tool-call', toolCallId: 'ch2', toolName: 'cdpConfirm', args: { x: 100, y: 100 }, finishReason: 'tool-calls' },
      { type: 'tool-call', toolCallId: 'ch3', toolName: 'cdpAim', args: { x: 200, y: 200 }, finishReason: 'tool-calls' },
      { type: 'tool-call', toolCallId: 'ch4', toolName: 'cdpConfirm', args: { x: 200, y: 200 }, finishReason: 'tool-calls' },
      { type: 'text', text: 'Clicked two targets.', finishReason: 'stop' },
    ],
  },

  /**
   * Echoes back the user's previous turn so the test can assert
   * that the LLM was actually given the prior conversation history.
   * Only the steps are used; the actual prompt content is ignored
   * here — the doStream/doGenerate closures in createMockModel
   * look at `options.prompt` (the full chat prompt including
   * history) and reply based on what the SECOND-to-last user
   * message was. See mockReplyForHistory() below.
   *
   * Steps intentionally left empty — the closure returns text
   * directly without consulting them.
   */
  echoHistory: {
    steps: [
      { type: 'text', text: '__placeholder__', finishReason: 'stop' },
    ],
  },
};

export function listMockScripts(): string[] {
  return Object.keys(SCRIPTS);
}

export function getMockScript(name: string): MockScript {
  return SCRIPTS[name] ?? SCRIPTS.happy;
}

export function createMockModel(modelId: string): MockLanguageModelV1 {
  const name = modelId.startsWith('mock:') ? modelId.slice(5) : modelId;
  const script = getMockScript(name);
  const steps = script.steps;
  let callIndex = 0;

  // Special scripts with non-standard stream behavior.
  const isHangForever = name === 'hangsForever';
  const isStreamError = name === 'streamError';
  const isEchoHistory = name === 'echoHistory';

  return new MockLanguageModelV1({
    provider: 'mock',
    modelId,
    defaultObjectGenerationMode: 'json',
    supportsStructuredOutputs: false,
    doStream: (async (options: { prompt?: Array<{ role: string; content: unknown }> }) => {
      // echoHistory: synthesize a text reply from the previous user turn
      // in the prompt. We use doStream's `options.prompt` to inspect what
      // the loop actually fed the LLM — this is the only place in the
      // mock layer where we can see the prior turns.
      const replyText = isEchoHistory
        ? mockReplyForHistory(options?.prompt ?? [])
        : (steps[Math.min(callIndex, steps.length - 1)] as ScriptedStep).type === 'text'
          ? ((steps[Math.min(callIndex, steps.length - 1)] as ScriptedStep) as { text: string }).text
          : '';
      callIndex += 1;
      return {
        stream: isHangForever
          ? streamHangsForever()
          : isStreamError
            ? streamWithError()
            : isEchoHistory
              ? streamFromText(replyText)
              : streamFromStep(steps[Math.min(callIndex - 1, steps.length - 1)] as ScriptedStep),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    }) as Any,
    doGenerate: (async (options: { prompt?: Array<{ role: string; content: unknown }> }) => {
      if (isEchoHistory) {
        const replyText = mockReplyForHistory(options?.prompt ?? []);
        callIndex += 1;
        return {
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5 },
          text: replyText,
          toolCalls: [],
        };
      }
      const step = steps[Math.min(callIndex, steps.length - 1)] as ScriptedStep;
      callIndex += 1;
      return {
        finishReason: step.finishReason,
        usage: { promptTokens: 10, completionTokens: 5 },
        text: step.type === 'text' ? step.text : '',
        toolCalls:
          step.type === 'tool-call'
            ? [
                {
                  toolCallId: step.toolCallId,
                  toolName: step.toolName,
                  args: JSON.stringify(step.args),
                },
              ]
            : [],
      };
    }) as Any,
  });
}

/**
 * For the `echoHistory` mock: extract the second-to-last user message
 * from the prompt and echo it back. If there's only one user message
 * (i.e. first turn, no history), reply with a sentinel so the test can
 * distinguish.
 *
 * Prompt shape: Array<{ role: 'system' | 'user' | 'assistant' | 'tool',
 *                       content: string | Array<{type:string,...}> }>
 */
function mockReplyForHistory(prompt: Array<{ role: string; content: unknown }>): string {
  const userMessages = prompt.filter((m) => m.role === 'user');
  // userMessages[last] is the CURRENT turn; userMessages[last-1] is the
  // previous one. If there is none, no history was provided.
  if (userMessages.length < 2) {
    return 'NO_HISTORY';
  }
  const prev = userMessages[userMessages.length - 2];
  const text = extractPromptUserText(prev);
  return `HISTORY_SAW:${text ?? '?'}`;
}

function extractPromptUserText(m: { content: unknown }): string | null {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    for (const part of c) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: string }).type === 'text' &&
        typeof (part as { text?: string }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
}

/** Stream that emits one text-delta then hangs forever (never closes). */
function streamHangsForever(): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'response-metadata', id: 'mock', modelId: 'mock' });
      controller.enqueue({ type: 'text-delta', textDelta: 'Starting to think...' });
      // Intentionally never close or error — the stream hangs.
    },
  });
}

/** Stream that emits one text-delta then errors. */
function streamWithError(): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'response-metadata', id: 'mock', modelId: 'mock' });
      controller.enqueue({ type: 'text-delta', textDelta: 'About to fail...' });
      controller.error(new Error('simulated stream failure'));
    },
  });
}

function streamFromText(text: string): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'response-metadata', id: 'mock', modelId: 'mock' });
      if (text) {
        controller.enqueue({ type: 'text-delta', textDelta: text });
      }
      controller.enqueue({
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5 },
      });
      controller.close();
    },
  });
}

function streamFromStep(step: ScriptedStep): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'response-metadata', id: 'mock', modelId: 'mock' });
      if (step.type === 'text') {
        controller.enqueue({ type: 'text-delta', textDelta: step.text });
      } else if (step.type === 'tool-call') {
        controller.enqueue({
          type: 'tool-call-delta',
          toolCallId: step.toolCallId,
          toolName: step.toolName,
          argsTextDelta: JSON.stringify(step.args),
        });
        controller.enqueue({
          type: 'tool-call',
          toolCallId: step.toolCallId,
          toolName: step.toolName,
          args: JSON.stringify(step.args),
        });
      }
      controller.enqueue({
        type: 'finish',
        finishReason: step.finishReason,
        usage: { promptTokens: 10, completionTokens: 5 },
      });
      controller.close();
    },
  });
}
