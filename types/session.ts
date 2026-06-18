import { z } from 'zod';
import { AgentStepSchema, ScreenshotMetaSchema } from './agent';
import { ModelConfigSchema } from './model';

// ---------- ChatSession ----------

export const ChatSessionSchema = z.object({
  id: z.string(),
  title: z.string().default('New chat'),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  // The model config used for this session — frozen at creation time so a
  // config edit later doesn't affect history.
  frozenConfig: ModelConfigSchema.optional(),
  // Structured task state parsed from the agent's final output.
  taskState: z.record(z.unknown()).optional(),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

// ---------- ChatMessage ----------

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

// We store the parts list as the AI SDK's UIMessage format, then transform to
// ModelMessage when invoking the LLM. Persisted screenshots are referenced by
// id and resolved at runtime.
export const MessagePartSchema = z.object({
  type: z.enum(['text', 'image', 'tool-call', 'tool-result', 'reasoning']),
  text: z.string().optional(),
  reasoning: z.string().optional(),
  imageRef: z.string().optional(), // ScreenshotMeta.id when type=image
  toolCall: z
    .object({
      id: z.string(),
      name: z.string(),
      args: z.record(z.unknown()),
    })
    .optional(),
  toolResult: z
    .object({
      toolCallId: z.string(),
      result: z.unknown(),
      isError: z.boolean().default(false),
    })
    .optional(),
});
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const ChatMessageStatusSchema = z.enum(['draft', 'complete', 'abandoned', 'error']);
export type ChatMessageStatus = z.infer<typeof ChatMessageStatusSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: MessageRoleSchema,
  parts: z.array(MessagePartSchema).default([]),
  // Snapshot of the step the assistant message completed on.
  finalStep: AgentStepSchema.optional(),
  // Screenshots attached to this message (for replay/UI).
  screenshotIds: z.array(z.string()).default([]),
  createdAt: z.number().int().nonnegative(),
  // MessageStore lifecycle status. Old messages (v1/v2) won't have this —
  // treat as 'complete' for back-compat. See message-store.ts.
  status: ChatMessageStatusSchema.optional(),
  updatedAt: z.number().int().nonnegative().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// Re-export the referenced schemas for convenience.
export { AgentStepSchema, ScreenshotMetaSchema, ModelConfigSchema };
