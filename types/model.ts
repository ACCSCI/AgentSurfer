import { z } from 'zod';

// ---------- Provider ----------

export const ProviderSchema = z.enum([
  'openai',
  'anthropic',
  'openai-compatible-1',
  'openai-compatible-2',
  'mimo',
  'MiniMax',
  'mock',
  'chrome-prompt-api',
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderMeta: Record<
  Provider,
  { label: string; authHeader: 'bearer' | 'x-api-key' | 'api-key' | 'none'; needsBaseUrl: boolean; needsApiKey: boolean }
> = {
  openai: { label: 'OpenAI', authHeader: 'bearer', needsBaseUrl: false, needsApiKey: true },
  anthropic: { label: 'Anthropic', authHeader: 'x-api-key', needsBaseUrl: false, needsApiKey: true },
  'openai-compatible-1': { label: 'OpenAI Compatible #1', authHeader: 'bearer', needsBaseUrl: true, needsApiKey: true },
  'openai-compatible-2': { label: 'OpenAI Compatible #2', authHeader: 'bearer', needsBaseUrl: true, needsApiKey: true },
  mimo: { label: 'MiMo (Xiaomi)', authHeader: 'api-key', needsBaseUrl: false, needsApiKey: true },
  MiniMax: { label: 'MiniMax', authHeader: 'bearer', needsBaseUrl: false, needsApiKey: true },
  mock: { label: 'Mock (E2E / demo)', authHeader: 'none', needsBaseUrl: false, needsApiKey: false },
  // Chrome Prompt API: Gemini Nano on-device, no API key, no network.
  'chrome-prompt-api': { label: 'Chrome Prompt API (Gemini Nano)', authHeader: 'none', needsBaseUrl: false, needsApiKey: false },
};

// Default base URLs — users can override in the options page.
export const DefaultBaseUrl: Record<Provider, string | null> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'openai-compatible-1': null,
  'openai-compatible-2': null,
  mimo: 'https://api.xiaomimimo.com/v1',
  MiniMax: 'https://api.minimaxi.com',
  mock: null,
  'chrome-prompt-api': null,
};

// Default model IDs per provider (UI suggestions).
export const DefaultModelId: Record<Provider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
  'openai-compatible-1': '',
  'openai-compatible-2': '',
  mimo: 'mimo-v2.5-pro',
  // M2.7-highspeed is the project default per the user's request — fast,
  // stable, supported by the Anthropic-compat endpoint.
  MiniMax: 'MiniMax-M2.7-highspeed',
  mock: 'mock:happy',
  'chrome-prompt-api': 'gemini-nano',
};

// ---------- ModelConfig ----------

export const ModelConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: ProviderSchema,
    modelId: z.string().min(1),
    // `mock` provider doesn't need a real key; allow empty.
    apiKey: z.string().default(''),
    baseUrl: z.string().url().nullable().default(null),
    isDefault: z.boolean().default(false),
    createdAt: z.number().int().nonnegative(),
  })
  .superRefine((cfg, ctx) => {
    const meta = ProviderMeta[cfg.provider];
    if (meta.needsBaseUrl && !cfg.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: `${meta.label} requires a base URL`,
      });
    }
    if (cfg.provider !== 'mock' && cfg.provider !== 'chrome-prompt-api' && cfg.apiKey.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: `${meta.label} requires an API key`,
      });
    }
  });
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
