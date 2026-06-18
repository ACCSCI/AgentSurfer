// Runtime event types — the 11 distinct event types produced by an
// agent run, per Architecture Rule #7 (no "catch-all update" events).
//
// This file is the SINGLE SOURCE OF TRUTH for the runtime's public
// event surface. Both Runtime implementations (current runAgent, future
// verifier, etc.) and the UI consumers (sidepanel, options) import
// from here. The shape MUST stay backwards compatible with what the
// side panel's useMessageStore and useAgentStore already consume.
//
// Event types in use:
//   user_message   — User prompt captured                       (Runtime)
//   model_ready    — LLM instance created                       (Runtime)
//   chunk          — LLM streaming delta (text/reasoning/tool)  (Runtime)
//   tool_call      — Full tool call ready (not delta)           (Runtime)
//   tool_result    — Tool execution completed                   (Runtime)
//   token_usage    — Per-step prompt/completion tokens          (Runtime)
//   progress       — Step counter update                        (Runtime)
//   todo_update    — Agent's todo list replaced                 (Runtime)
//   step_done      — Step boundary, persisted to Dexie          (Runtime)
//   agent_done     — Run completed (with total usage)           (Runtime)
//   agent_error    — Run failed                                 (Runtime)

// ---------- Distinct event type literals ----------

export const RUNTIME_EVENT_TYPES = [
  'user_message',
  'model_ready',
  'chunk',
  'tool_call',
  'tool_result',
  'token_usage',
  'progress',
  'todo_update',
  'step_done',
  'verify_result',
  'agent_done',
  'agent_error',
] as const;
export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

// ---------- Event payload shapes ----------
//
// `runId` is OPTIONAL — the agent's emit() inside the run already has
// the runId in its scoped logger. The SW-side emit wrapper in
// background.ts does NOT add runId either; it only adds `__fromSW`.
// Future enhancement: have the SW wrapper auto-tag runId from the
// inflight Map so cross-run routing in the side panel is safer. For
// now the field is just documented as the canonical place to put it.
//
// `__fromSW: true` is OPTIONAL — the SW's emit wrapper in
// background.ts adds it before broadcasting via chrome.runtime.sendMessage.
// The agent itself emits a plain event; the SW is responsible for
// tagging. Side panel listeners check for `__fromSW` to distinguish
// SW broadcasts from responses to their own requests.
//
// `chunk` is intentionally untyped at the payload level — the AI SDK's
// StreamChunk union has 9+ shapes (text-delta / reasoning / tool-call /
// tool-result / ...) and we forward the raw chunk to MessageStore
// which knows how to route each variant. Keeping it `unknown` here
// preserves the AI SDK's payload structure for downstream consumers
// (lib/message-store.ts) without us having to re-define it.

export interface RuntimeEventBase {
  type: RuntimeEventType;
  /** Optional — populated by callers that have it. */
  runId?: string;
  /** Optional — populated by the SW's emit wrapper, not by the agent. */
  __fromSW?: true;
}

export interface UserMessageEvent extends RuntimeEventBase {
  type: 'user_message';
  sessionId: string;
  prompt: string;
}

export interface ModelReadyEvent extends RuntimeEventBase {
  type: 'model_ready';
  modelId: string;
}

export interface ChunkEvent extends RuntimeEventBase {
  type: 'chunk';
  chunkType: string;
  /** Raw AI SDK StreamChunk. The receiving side (MessageStore) routes
   *  on chunkType and reads the corresponding field (textDelta,
   *  toolCallId, toolName, args, result, etc.). Kept as `unknown` here
   *  because the AI SDK chunk union is not exported as a single type. */
  data: unknown;
}

export interface ToolResultEvent extends RuntimeEventBase {
  type: 'tool_result';
  toolCallId: string;
  name: string;
  result: unknown;
  isError: boolean;
  stepNumber: number;
}

export interface TokenUsageEvent extends RuntimeEventBase {
  type: 'token_usage';
  stepNumber: number;
  prompt: number;
  completion: number;
}

export interface ProgressEvent extends RuntimeEventBase {
  type: 'progress';
  current: number;
  total: number;
  percentage: number;
}

export interface TodoUpdateEvent extends RuntimeEventBase {
  type: 'todo_update';
  todos: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }>;
}

/** `step_done` carries the per-step update payload. The shape mirrors
 *  the `StepUpdate` from `@/types/messages`. We re-declare the tool
 *  call / result shapes inline to avoid a circular import
 *  (types/messages.ts → types/agent.ts → ...). The `args` field is
 *  typed as `unknown` to match what z.record(z.unknown()) actually
 *  produces (Zod infers `Record<string, any>` which doesn't
 *  structurally match `Record<string, unknown>` in strict mode). */
export interface StepDoneEvent extends RuntimeEventBase {
  type: 'step_done';
  stepNumber: number;
  /** Payload: a `StepUpdate` (from `@/types/messages`). The `args`
   *  field of each tool call is the AI-SDK's parsed JSON, which Zod
   *  narrows to `Record<string, any>`. We type it as `unknown` to
   *  accept the wider Zod-inferred shape without `as any` at every
   *  emit call. */
  update: {
    stepNumber: number;
    text: string;
    toolCalls: Array<{ id: string; name: string; args: unknown }>;
    toolResults: Array<{ toolCallId: string; name: string; result?: unknown; isError: boolean }>;
    durationMs: number;
  };
}

export interface AgentDoneEvent extends RuntimeEventBase {
  type: 'agent_done';
  usage: { prompt: number; completion: number };
  stepCount: number;
  finishReason: string;
  perStepFinishReasons: Array<{
    step: number;
    finishReason: string;
    stepType: string;
    toolCalls: number;
    textLength: number;
  }>;
  llmSelfDeclaredCompletion: boolean;
  finalTextPreview: string;
}

export interface AgentErrorEvent extends RuntimeEventBase {
  type: 'agent_error';
  message: string;
}

/** `verify_result` — emitted by the verifier after the main agent
 *  run finishes. `verified` is the boolean verdict; `notes` is the
 *  verifier's free-text reasoning (or an error message if the
 *  verifier itself failed). */
export interface VerifyResultEvent extends RuntimeEventBase {
  type: 'verify_result';
  verified: boolean;
  notes: string;
}

// ---------- Union type ----------

export type RuntimeEvent =
  | UserMessageEvent
  | ModelReadyEvent
  | ChunkEvent
  | ToolResultEvent
  | TokenUsageEvent
  | ProgressEvent
  | TodoUpdateEvent
  | StepDoneEvent
  | VerifyResultEvent
  | AgentDoneEvent
  | AgentErrorEvent;

// ---------- Type guards (optional) ----------
//
// The side panel already uses `m.type === 'tool_result'` style checks
// on a plain object. We don't need runtime narrowing there yet. Keep
// these for future use cases (e.g., a typed reducer for events).

export function isRuntimeEvent(x: unknown): x is RuntimeEvent {
  if (!x || typeof x !== 'object') return false;
  const t = (x as { type?: unknown }).type;
  return typeof t === 'string' && (RUNTIME_EVENT_TYPES as readonly string[]).includes(t);
}
