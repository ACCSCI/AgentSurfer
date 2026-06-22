// LLM factory — turns a ModelConfig from Dexie into a Vercel AI SDK
// LanguageModelV3 that streamText / generateText can call.

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { ModelConfig, Provider } from '@/types';

/**
 * Sentinels used to smuggle StepFun reasoning through the OpenAI provider's
 * `content` channel. The MessageStore (lib/message-store.ts) recognizes these
 * exact markers, peels them out of the text stream, and routes the enclosed
 * text to a `reasoning` segment. Keep these in sync with the parser there.
 */
export const THINK_OPEN = '<think>';
export const THINK_CLOSE = '</think>';

/**
 * Custom `fetch` for the StepFun provider that rewrites the streamed SSE so the
 * model's reasoning becomes visible. StepFun emits reasoning in the `reasoning`
 * / `reasoning_content` delta fields, but @ai-sdk/openai@1.3.24 ignores both.
 * We transform each SSE chunk: any reasoning delta is re-emitted as a `content`
 * delta wrapped in <think>…</think> sentinels (opened on the first reasoning
 * delta, closed when normal content starts). Non-streaming responses and
 * non-StepFun-shaped payloads pass through untouched.
 */
export const stepfunReasoningFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.body || !contentType.includes('text/event-stream')) return res;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  let thinkOpen = false;
  let thinkClosed = false;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${rewriteSseLine(line)}\n`));
      }
    },
    flush(controller) {
      if (buffered) controller.enqueue(encoder.encode(rewriteSseLine(buffered)));
      buffered = '';
    },
  });

  // Rewrites one SSE line, folding reasoning deltas into <think>-wrapped
  // content. Closure captures the thinkOpen/thinkClosed cursor so the sentinel
  // is opened/closed exactly once across the whole stream.
  function rewriteSseLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return line;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return line;
    let json: {
      choices?: Array<{ delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } }>;
    };
    try {
      json = JSON.parse(payload);
    } catch {
      return line;
    }
    const delta = json.choices?.[0]?.delta;
    if (!delta) return line;

    const reasoningPiece =
      (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
      (typeof delta.reasoning === 'string' && delta.reasoning) ||
      '';
    const contentPiece = typeof delta.content === 'string' ? delta.content : '';

    // Nothing reasoning-related and no need to close the block: pass through.
    if (!reasoningPiece && (!contentPiece || thinkClosed || !thinkOpen)) return line;

    let merged = '';
    if (reasoningPiece) {
      if (!thinkOpen) {
        merged += THINK_OPEN;
        thinkOpen = true;
      }
      merged += reasoningPiece;
    }
    if (contentPiece) {
      if (thinkOpen && !thinkClosed) {
        merged += THINK_CLOSE;
        thinkClosed = true;
      }
      merged += contentPiece;
    }

    // Strip the reasoning fields and replace content with our merged text.
    delete (delta as { reasoning?: unknown }).reasoning;
    delete (delta as { reasoning_content?: unknown }).reasoning_content;
    (delta as { content?: string }).content = merged;
    return `data: ${JSON.stringify(json)}`;
  }

  const stream = res.body.pipeThrough(transform);
  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
};

// Known model IDs per provider — used to populate the dropdown in the options
// page. Users can still type a custom model id in the form.
export const KnownModels: Record<Provider, readonly string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'o3-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    'claude-haiku-4-5-20251001',
  ],
  'openai-compatible-1': [],
  'openai-compatible-2': [],
  mimo: ['mimo-v2.5-pro'],
  MiniMax: [
    'MiniMax-M3',
    'MiniMax-M2.7',
    'MiniMax-M2.7-highspeed',
    'MiniMax-M2.5',
    'MiniMax-M2.5-highspeed',
    'MiniMax-M2.1',
    'MiniMax-M2.1-highspeed',
    'MiniMax-M2',
  ],
  // step-3.7-flash is the recommended StepFun model — supports all three
  // reasoning_effort levels (low/medium/high), image input, and tool calls.
  // step-3.5-flash-2603 only supports low/high (no medium), so we list it
  // as an alternative for users who want the older behavior. step-router-v1
  // auto-routes between deepseek-v4-pro and step-3.5-flash but rejects
  // image content, which breaks the cdpAim/visual-servoing loop.
  stepfun: ['step-3.7-flash', 'step-3.5-flash-2603'],
  mock: ['mock:happy', 'mock:oneTool', 'mock:textOnly', 'mock:clickSequence', 'mock:failsAtStep3', 'mock:echoHistory'],
};

export function listModels(provider: Provider): readonly string[] {
  return KnownModels[provider] ?? [];
}

export async function createModel(config: ModelConfig): Promise<LanguageModel> {
  return createModelInternal(config);
}

async function createModelInternal(config: ModelConfig): Promise<LanguageModel> {
  switch (config.provider) {
    case 'openai': {
      return createOpenAI({ apiKey: config.apiKey })(config.modelId);
    }

    case 'anthropic': {
      return createAnthropic({ apiKey: config.apiKey })(config.modelId);
    }

    case 'openai-compatible-1':
    case 'openai-compatible-2': {
      if (!config.baseUrl) {
        throw new Error(`${config.provider} requires a baseUrl`);
      }
      const provider = createOpenAI({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
      });
      return provider(config.modelId);
    }

    case 'mimo': {
      // Xiaomi MiMo uses an `api-key: <key>` header instead of `Authorization:
      // Bearer`. We use createOpenAI (v1 protocol) with a custom baseURL and
      // override the apiKey header. createOpenAICompatible@1.x is v2-protocol
      // and is rejected by AI SDK 4.
      const provider = createOpenAI({
        baseURL: 'https://api.xiaomimimo.com/v1',
        apiKey: config.apiKey,
        headers: {
          'api-key': config.apiKey,
        },
      });
      return provider(config.modelId);
    }

    case 'MiniMax': {
      // MiniMax's official AI SDK provider (`vercel-minimax-ai-provider@0.0.2`)
      // is built for AI SDK v5 and returns LanguageModelV2, which our pinned
      // `ai@4.3.19` rejects at runtime. Until we upgrade to AI SDK v5, we
      // hand-roll the Anthropic-compatible call using @ai-sdk/anthropic@1.x
      // (which is still v1-protocol) and override the baseURL.
      //
      // NOTE: @ai-sdk/anthropic constructs the URL as `${baseURL}/messages`
      // (NOT `/v1/messages`). To hit MiniMax's
      // `https://api.minimaxi.com/anthropic/v1/messages` we have to include
      // `/v1` in the baseURL. Verified live on 2026-06-11.
      const provider = createAnthropic({
        baseURL: 'https://api.minimaxi.com/anthropic/v1',
        apiKey: config.apiKey,
      });
      return provider(config.modelId);
    }

    case 'stepfun': {
      // StepFun (阶跃星辰) — OpenAI-compatible Chat Completions API on the
      // Step Plan channel. We piggyback on @ai-sdk/openai@1.x (v1-protocol)
      // and override the baseURL. The OpenAI provider constructs the request
      // URL as `${baseURL}/chat/completions` (matches the Step Plan path).
      //
      // Image input: the AI SDK's OpenAI provider maps our
      // `{type:'image', data, mimeType}` content (with raw base64 in `data`,
      // see stripDataUrlPrefix in lib/tools.ts:75) to
      // `{type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}`,
      // which is exactly the format StepFun accepts per
      // https://platform.stepfun.com/docs/llms.txt (Base64编码图片 / 图片理解
      // examples). Verified shape-compatible on 2026-06-19.
      //
      // reasoning_effort: the OpenAI provider's `getArgs` (in
      // @ai-sdk/openai/dist/index.mjs:465) reads
      // `providerMetadata.openai.reasoningEffort` and serializes it to
      // the `reasoning_effort` body field. We pass it via
      // `providerOptions` in lib/runtime/loop.ts. Other providers ignore
      // the field — StepFun's `step-3.7-flash` is the only model that
      // honors it today.
      const provider = createOpenAI({
        baseURL: 'https://api.stepfun.com/step_plan/v1',
        apiKey: config.apiKey,
        // @ai-sdk/openai@1.3.24 does NOT read any reasoning delta field from
        // Chat Completions SSE, so StepFun's `reasoning_content` (verified via
        // scripts/probe-reasoning-chunks.ts 2026-06-19: 1460 chars in BOTH
        // `reasoning` and `reasoning_content` delta fields, 0 surfaced by the
        // SDK) is silently dropped. We inject a custom fetch that rewrites the
        // SSE stream on the fly, folding each reasoning delta into the `content`
        // field wrapped in <think>…</think> sentinels. The loop's MessageStore
        // (lib/message-store.ts) splits those sentinels back out into a
        // `reasoning` segment so the UI shows the model's thinking interleaved
        // with its answer.
        fetch: stepfunReasoningFetch,
      });
      return provider(config.modelId);
    }

    case 'mock': {
      // In-process mock used by E2E. Dynamic-imported so the production
      // bundle never pulls in `ai/test` (which drags Node-only modules
      // like `http`/`zlib`/`net`/`stream` through Vite).
      // See lib/mock-scripts.ts for available scripts.
      const { createMockModel } = await import('@/lib/mock-scripts');
      return createMockModel(config.modelId);
    }

    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}
