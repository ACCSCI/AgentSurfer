// Chrome Prompt API adapter — wraps the built-in Gemini Nano model into
// a Vercel AI SDK-compatible LanguageModelV1, so streamText() works with
// no API key and no network.

import type { LanguageModelV1 } from '@ai-sdk/provider';

declare global {
  interface Window {
    LanguageModel?: {
      availability?: (opts?: unknown) => Promise<string>;
      create?: (opts?: {
        monitor?: (m: EventTarget) => void;
        expectedInputs?: unknown[];
        expectedOutputs?: unknown[];
        signal?: AbortSignal;
      }) => Promise<ChromeLanguageModel>;
    };
  }
  // In service workers, LanguageModel is a global.
  const LanguageModel: typeof Window.LanguageModel | undefined;
}

interface ChromeLanguageModel {
  prompt: (input: unknown, opts?: { signal?: AbortSignal }) => Promise<string>;
  promptStreaming: (
    input: unknown,
    opts?: { signal?: AbortSignal },
  ) => ReadableStream<string>;
  destroy: () => Promise<void>;
  clone?: () => ChromeLanguageModel;
}

let cachedSession: ChromeLanguageModel | null = null;

async function getSession(): Promise<ChromeLanguageModel> {
  // Use the global LanguageModel if available (service workers get it directly).
  const LM = typeof LanguageModel !== 'undefined' ? LanguageModel : undefined;
  if (!LM?.create) {
    throw new Error(
      'Chrome Prompt API (LanguageModel) is not available. ' +
        'Requires Chrome 133+ with Gemini Nano on device.',
    );
  }
  if (!cachedSession) {
    cachedSession = await LM.create({
      expectedInputs: [
        { type: 'text', languages: ['en'] },
        { type: 'image' },
      ],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
  }
  return cachedSession;
}

/**
 * Creates a LanguageModelV1-compatible object backed by the Chrome Prompt API.
 * The model is Gemini Nano running locally on the user's device.
 *
 * Usage: `const model = createChromePromptApiModel('gemini-nano')`
 */
export function createChromePromptApiModel(
  _modelId: string = 'gemini-nano',
): LanguageModelV1 {
  return {
    specificationVersion: 'v1',
    provider: 'chrome-prompt-api',
    modelId: 'gemini-nano',

    doStream: async (options) => {
      const session = await getSession();
      const prompt = options.prompt;
      // Extract the last user message text for the prompt.
      // The Chrome Prompt API accepts either a string or a structured
      // content array. We convert the AI SDK's message format to
      // the Prompt API's expected format.
      const input = await convertToPromptApiInput(prompt);

      const stream = session.promptStreaming(input, {
        signal: options.abortSignal,
      });

      // Transform Chrome Prompt API string chunks → AI SDK stream parts.
      const transformed = new ReadableStream({
        start(controller) {
          // Response metadata.
          controller.enqueue({
            type: 'response-metadata',
            id: `cpa-${Date.now()}`,
            modelId: 'gemini-nano',
          });
          // Wrap the Chrome stream.
          const reader = stream.getReader();
          function pump(): Promise<void> {
            return reader.read().then(({ done, value }) => {
              if (done) {
                controller.enqueue({
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { promptTokens: 0, completionTokens: 0 },
                });
                controller.close();
                return;
              }
              controller.enqueue({
                type: 'text-delta',
                textDelta: value,
              });
              return pump();
            });
          }
          pump().catch((err) => controller.error(err));
        },
      });

      return {
        stream: transformed,
        rawCall: { rawPrompt: prompt, rawSettings: {} },
      };
    },

    // Non-streaming fallback — the Chrome Prompt API's prompt() is
    // effectively non-streaming.
    doGenerate: async (options) => {
      const session = await getSession();
      const prompt = options.prompt;
      const input = await convertToPromptApiInput(prompt);
      const text = await session.prompt(input, {
        signal: options.abortSignal,
      });
      return {
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        text,
        toolCalls: [],
        toolResults: [],
        warnings: [],
        logprobs: undefined,
        request: {},
        response: { id: `cpa-${Date.now()}`, modelId: 'gemini-nano', headers: {} },
        providerMetadata: {},
      };
    },
  } as LanguageModelV1;
}

/**
 * Convert AI SDK's message format to Chrome Prompt API's input format.
 * Handles multi-modal content (text + images).
 */
async function convertToPromptApiInput(
  prompt: Array<{
    role: string;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; image: string | URL | ArrayBuffer }
      | { type: 'tool-result'; toolCallId: string; result: unknown }
    >;
  }>,
): string | Array<{ role: string; content: Array<{ type: string; value: string | Blob | ArrayBuffer }> }> {
  // Simple case: just a user message with text → pass string directly.
  if (prompt.length === 1 && prompt[0].role === 'user') {
    const content = prompt[0].content;
    if (content.length === 1 && content[0].type === 'text') {
      return content[0].text;
    }
  }

  // Multi-message / multi-modal → convert to Prompt API structured format.
  const messages: Array<{
    role: string;
    content: Array<{ type: string; value: string | Blob | ArrayBuffer }>;
  }> = [];

  for (const msg of prompt) {
    const parts: Array<{ type: string; value: string | Blob | ArrayBuffer }> = [];
    for (const part of msg.content) {
      if (part.type === 'text') {
        parts.push({ type: 'text', value: part.text });
      } else if (part.type === 'image') {
        // Convert dataURL (base64) to Blob if needed.
        const val = part.image;
        if (typeof val === 'string' && val.startsWith('data:')) {
          const blob = await dataUrlToBlob(val);
          parts.push({ type: 'image', value: blob });
        } else if (val instanceof URL || val instanceof ArrayBuffer) {
          parts.push({ type: 'image', value: val as Blob });
        }
      }
      // tool-result: skip (not supported by Prompt API).
    }
    if (parts.length > 0) {
      messages.push({ role: msg.role, content: parts });
    }
  }

  // Flatten to a single user message with all parts (Prompt API limitation).
  if (messages.length === 1) {
    return messages[0].content.map((p) => p.value);
  }

  // For multi-message, concatenate text parts into a single string.
  const allText = messages
    .map((m) =>
      m.content
        .filter((p) => p.type === 'text')
        .map((p) => String(p.value))
        .join('\n'),
    )
    .join('\n\n');
  return allText;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}
