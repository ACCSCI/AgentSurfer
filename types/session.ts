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

// Why the agent run that produced this assistant message stopped. Maps to
// the four canonical termination conditions in CLAUDE.md Rule #9, plus a
// `max_steps` value derived from the AI SDK `finishReason: 'length'`.
// `completed` is the normal "LLM self-declared done" path.
export const StopReasonSchema = z.enum([
  'completed', // LLM finished naturally (finishReason: 'stop')
  'max_steps', // hit the step budget (finishReason: 'length')
  'cancelled', // user cancelled the run
  'errored', // fatal system/provider error
  'unknown', // couldn't be determined
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

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
  // Raw AI SDK finishReason of the FINAL step (e.g. 'stop', 'tool-calls',
  // 'length'). Undefined for user messages and old rows. See loop.ts onFinish.
  finishReason: z.string().optional(),
  // Normalized business-level reason the run stopped (Rule #9). Lets a bug
  // report tell "task complete" apart from "hit max steps" / "timed out".
  stopReason: StopReasonSchema.optional(),
  updatedAt: z.number().int().nonnegative().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// Re-export the referenced schemas for convenience.
export { AgentStepSchema, ScreenshotMetaSchema, ModelConfigSchema };
