import { z } from 'zod';

// ---------- Agent step / tool call ----------

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  toolCallId: z.string(),
  name: z.string(),
  result: z.unknown(),
  isError: z.boolean().default(false),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AgentStepSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  stepNumber: z.number().int().nonnegative(),
  text: z.string().default(''),
  toolCalls: z.array(ToolCallSchema).default([]),
  toolResults: z.array(ToolResultSchema).default([]),
  usage: UsageSchema.optional(),
  durationMs: z.number().int().nonnegative().default(0),
  createdAt: z.number().int().nonnegative(),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;

// ---------- Screenshot (binary, stored as Blob in Dexie) ----------

export const ScreenshotMetaSchema = z.object({
  id: z.string(),
  stepId: z.string().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mime: z.literal('image/png'),
  byteSize: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
});
export type ScreenshotMeta = z.infer<typeof ScreenshotMetaSchema>;
