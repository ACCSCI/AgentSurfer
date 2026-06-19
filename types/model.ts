import { z } from 'zod';

// ---------- Provider ----------

export const ProviderSchema = z.enum([
  'openai',
  'anthropic',
  'openai-compatible-1',
  'openai-compatible-2',
  'mimo',
  'MiniMax',
  'stepfun',
  'mock',
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderMeta: Record<
  Provider,
  { label: string; authHeader: 'bearer' | 'x-api-key' | 'api-key' | 'none'; needsBaseUrl: boolean }
> = {
  openai: { label: 'OpenAI', authHeader: 'bearer', needsBaseUrl: false },
  anthropic: { label: 'Anthropic', authHeader: 'x-api-key', needsBaseUrl: false },
  'openai-compatible-1': { label: 'OpenAI Compatible #1', authHeader: 'bearer', needsBaseUrl: true },
  'openai-compatible-2': { label: 'OpenAI Compatible #2', authHeader: 'bearer', needsBaseUrl: true },
  mimo: { label: 'MiMo (Xiaomi)', authHeader: 'api-key', needsBaseUrl: false },
  MiniMax: { label: 'MiniMax', authHeader: 'bearer', needsBaseUrl: false },
  // StepFun (阶跃星辰) — OpenAI-compatible Chat Completions API over the
  // dedicated "Step Plan" channel. The same provider also exposes a
  // separate Anthropic-compatible endpoint (https://api.stepfun.com/step_plan),
  // but we standardize on the OpenAI-compat path so image inputs (cdpAim,
  // cdpScreenshot) work the same way as for openai — AI SDK v4's OpenAI
  // provider maps `{type:'image', data, mimeType}` to OpenAI's
  // `{type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}`
  // which StepFun's docs accept verbatim.
  // See https://platform.stepfun.com/docs/llms.txt
  stepfun: { label: 'StepFun (阶跃星辰)', authHeader: 'bearer', needsBaseUrl: false },
  // `mock` is a scriptable in-process provider used by E2E tests. No auth,
  // no real network call. The `modelId` encodes which script to run.
  mock: { label: 'Mock (E2E / demo)', authHeader: 'none', needsBaseUrl: false },
};

// Default base URLs — users can override in the options page.
export const DefaultBaseUrl: Record<Provider, string | null> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'openai-compatible-1': null,
  'openai-compatible-2': null,
  mimo: 'https://api.xiaomimimo.com/v1',
  MiniMax: 'https://api.minimaxi.com',
  // Step Plan channel — dedicated entry point for step-3.7-flash and
  // step-router-v1. Differs from the generic Chat Completions endpoint
  // (https://api.stepfun.com/v1) in that it routes between
  // deepseek-v4-pro and step-3.5-flash for step-router-v1, and enforces
  // a 384K max_tokens ceiling on the router model.
  stepfun: 'https://api.stepfun.com/step_plan/v1',
  mock: null,
};

// Default model IDs per provider (UI suggestions).
export const DefaultModelId: Record<Provider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
  'openai-compatible-1': '',
  'openai-compatible-2': '',
  mimo: 'mimo-v2.5-pro',
  // M3 is the project default — it's the only MiniMax model in the
  // Anthropic-compat endpoint that supports image input (per
  // platform.minimaxi.com/docs/api-reference/text-anthropic-api). M2.7
  // and earlier accept text + tool_use/tool_result only — any image
  // content block is silently dropped, which was the root cause of the
  // "aim in bottom-right" bug (the LLM was hallucinating with no
  // visual feedback).
  MiniMax: 'MiniMax-M3',
  // step-3.7-flash is the recommended verification model — it supports
  // all three reasoning_effort levels (low/medium/high), image input,
  // tool calls, and the 256K context window. Other choices on the
  // Step Plan channel: step-router-v1 (auto-routes to deepseek-v4-pro
  // or step-3.5-flash; rejects image input), step-3.5-flash-2603
  // (low/high only — no `medium`).
  stepfun: 'step-3.7-flash',
  // `mock:happy` is the default scripted run used by E2E specs.
  mock: 'mock:happy',
};

// ---------- ToolConfig ----------

export const ALL_TOOLS = [
  'cdpAim',
  'cdpConfirm',
  'cdpScroll',
  'cdpCancel',
  'cdpType',
  'cdpPressKey',
  'cdpScreenshot',
  'cdpGridScreenshot',
  'focusNext',
  'focusPrevious',
  'smartScreenshot',
  'screenshot',
  'tabsList',
  'tabsSwitch',
  'tabsOpen',
  'tabsClose',
  'domQuery',
  'domClick',
  'domType',
  'pressKey',
  'todo',
] as const;
export type ToolName = (typeof ALL_TOOLS)[number];

export const ToolConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
});
export type ToolConfig = z.infer<typeof ToolConfigSchema>;

// ---------- ModelConfig ----------

// Reasoning effort — StepFun exposes three levels (low/medium/high) for
// step-3.7-flash. Mapped to the request body's `reasoning_effort` field
// in lib/runtime/loop.ts via `providerOptions.openai.reasoningEffort`.
// Only StepFun today (openai and MiniMax ignore it; MiniMax has its own
// non-standard `output_config.effort` on the Anthropic-compat path that
// the AI SDK doesn't expose yet). Keep the type as a string union so we
// can add other providers' vocabularies later without a schema migration.
export const REASONING_EFFORT_VALUES = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

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
    // AI SDK maxSteps passed to streamText. Configurable from the
    // options page; default 99 (raised from the historical 30 — long
    // multi-step tasks like "search → click 3 links → summarize" need
    // room for visual servoing iterations). 1-999 to keep the input
    // bounded; the AI SDK does not enforce an upper limit.
    maxSteps: z.number().int().min(1).max(999).default(99),
    // Reasoning depth. Currently only StepFun's step-3.7-flash honors
    // this; other providers silently ignore it. Optional so older
    // configs (pre-2026-06-19) keep loading — the loop treats
    // `undefined` as "don't override the provider default".
    reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
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
    if (cfg.provider !== 'mock' && cfg.apiKey.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: `${meta.label} requires an API key`,
      });
    }
  });
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
