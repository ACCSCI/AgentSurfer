// Wire-format for messages between sidepanel / options / service-worker.

import type { ToolCall, ToolResult } from './agent';

export type FromSidepanel =
  | { type: 'agent:start'; runId: string; sessionId: string; prompt: string }
  | { type: 'agent:cancel'; runId: string }
  | { type: 'screenshot:capture' }
  | { type: 'dom:query'; selector: string; limit?: number }
  | { type: 'dom:click'; selector: string }
  | { type: 'dom:type'; selector: string; text: string };

export type FromServiceWorker =
  | { type: 'agent:step'; runId: string; step: StepUpdate }
  | { type: 'agent:done'; runId: string; totalUsage?: { prompt: number; completion: number } }
  | { type: 'agent:error'; runId: string; message: string }
  | { type: 'screenshot:captured'; dataUrl: string; width: number; height: number };

export interface StepUpdate {
  stepNumber: number;
  text: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  durationMs: number;
}
