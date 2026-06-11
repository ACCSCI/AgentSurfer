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

  return new MockLanguageModelV1({
    provider: 'mock',
    modelId,
    defaultObjectGenerationMode: 'json',
    supportsStructuredOutputs: false,
    doStream: (async () => ({
      stream: streamFromStep(steps[Math.min(callIndex, steps.length - 1)] as ScriptedStep),
      rawCall: { rawPrompt: null, rawSettings: {} },
    })) as Any,
    doGenerate: (async () => {
      const step = steps[Math.min(callIndex, steps.length - 1)] as ScriptedStep;
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
