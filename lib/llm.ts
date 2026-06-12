// LLM factory — turns a ModelConfig from Dexie into a Vercel AI SDK
// LanguageModelV1 that streamText / generateText can call.

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';
import type { ModelConfig, Provider } from '@/types';

// NOTE: as of writing (Jun 2026), @ai-sdk/openai-compatible@1.0.39 bundles
// @ai-sdk/provider@2.x (LanguageModelV2) while @ai-sdk/openai and
// @ai-sdk/anthropic@1.x are still on @ai-sdk/provider@1.x (LanguageModelV1).
// Runtime is fine — `streamText` accepts both — but the return type
// doesn't unify. We widen to `any` and add the V1 cast to keep call sites
// typed. Will go away once we upgrade to `ai@5` + matching provider majors.
// biome-ignore lint/suspicious/noExplicitAny: V1/V2 return-type mismatch
type AnyLanguageModel = any;

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
    'MiniMax-M2.7',
    'MiniMax-M2.7-highspeed',
    'MiniMax-M2.5',
    'MiniMax-M2.5-highspeed',
    'MiniMax-M2.1',
    'MiniMax-M2.1-highspeed',
    'MiniMax-M2',
  ],
  mock: ['mock:happy', 'mock:oneTool', 'mock:textOnly', 'mock:clickSequence', 'mock:failsAtStep3'],
};

export function listModels(provider: Provider): readonly string[] {
  return KnownModels[provider] ?? [];
}

export async function createModel(config: ModelConfig): Promise<LanguageModelV1> {
  return (await createModelInternal(config)) as unknown as LanguageModelV1;
}

async function createModelInternal(config: ModelConfig): Promise<AnyLanguageModel> {
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
