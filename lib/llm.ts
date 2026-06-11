// LLM factory — turns a ModelConfig from Dexie into a Vercel AI SDK
// LanguageModelV1 that streamText / generateText can call.

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV1 } from 'ai';
import type { ModelConfig, Provider } from '@/types';

// NOTE: as of writing (Jun 2026), @ai-sdk/openai-compatible@1.0.39 bundles
// @ai-sdk/provider@2.x (LanguageModelV2) while @ai-sdk/openai and
// @ai-sdk/anthropic@1.x are still on @ai-sdk/provider@1.x (LanguageModelV1).
// Runtime is fine — `streamText` accepts both — but the return type
// doesn't unify. We widen to `any` and add the V1 cast to keep call sites
// typed. Will go away once we upgrade to `ai@5` + matching provider majors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  MiniMax: ['MiniMax-M3'],
};

export function listModels(provider: Provider): readonly string[] {
  return KnownModels[provider] ?? [];
}

export function createModel(config: ModelConfig): LanguageModelV1 {
  // See note above re: V1/V2 mismatch. Cast is safe at runtime.
  return createModelInternal(config) as unknown as LanguageModelV1;
}

function createModelInternal(config: ModelConfig): AnyLanguageModel {
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
      const provider = createOpenAICompatible({
        name: config.provider,
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
      });
      return provider(config.modelId);
    }

    case 'mimo': {
      // Xiaomi MiMo uses an `api-key: <key>` header instead of `Authorization:
      // Bearer`. The underlying OpenAI client also adds `Authorization`, which
      // the server ignores — but we override the key in headers too for safety.
      const provider = createOpenAICompatible({
        name: 'mimo',
        baseURL: 'https://api.xiaomimimo.com/v1',
        apiKey: config.apiKey,
        headers: {
          'api-key': config.apiKey,
        },
      });
      return provider(config.modelId);
    }

    case 'MiniMax': {
      // MiniMax exposes an Anthropic-Messages-compatible endpoint at the
      // inference gateway. The model id is `MiniMax-M3` (MiniMax's own series).
      const provider = createAnthropic({
        baseURL: 'https://api.minimaxi.com',
        apiKey: config.apiKey,
      });
      return provider(config.modelId);
    }

    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}
