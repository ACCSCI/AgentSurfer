import { z } from 'zod';

// ---------- Provider ----------

export const ProviderSchema = z.enum([
  'openai',
  'anthropic',
  'openai-compatible-1',
  'openai-compatible-2',
  'mimo',
  'MiniMax',
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderMeta: Record<
  Provider,
  { label: string; authHeader: 'bearer' | 'x-api-key' | 'api-key'; needsBaseUrl: boolean }
> = {
  openai: { label: 'OpenAI', authHeader: 'bearer', needsBaseUrl: false },
  anthropic: { label: 'Anthropic', authHeader: 'x-api-key', needsBaseUrl: false },
  'openai-compatible-1': { label: 'OpenAI Compatible #1', authHeader: 'bearer', needsBaseUrl: true },
  'openai-compatible-2': { label: 'OpenAI Compatible #2', authHeader: 'bearer', needsBaseUrl: true },
  mimo: { label: 'MiMo (Xiaomi)', authHeader: 'api-key', needsBaseUrl: false },
  MiniMax: { label: 'MiniMax', authHeader: 'bearer', needsBaseUrl: false },
};

// Default base URLs — users can override in the options page.
export const DefaultBaseUrl: Record<Provider, string | null> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'openai-compatible-1': null,
  'openai-compatible-2': null,
  mimo: 'https://api.xiaomimimo.com/v1',
  MiniMax: 'https://api.minimaxi.com',
};

// Default model IDs per provider (UI suggestions).
export const DefaultModelId: Record<Provider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
  'openai-compatible-1': '',
  'openai-compatible-2': '',
  mimo: 'mimo-v2.5-pro',
  MiniMax: 'MiniMax-M3',
};

// ---------- ModelConfig ----------

export const ModelConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: ProviderSchema,
    modelId: z.string().min(1),
    apiKey: z.string().min(1),
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
  });
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
