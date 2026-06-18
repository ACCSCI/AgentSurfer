// Agent run store — non-message concerns.
//
// Message bodies (text / reasoning / tool calls) live in MessageStore and
// flow to the side panel via the `msgstore` port. This store only carries
// the auxiliary event-driven state that the architecture rules require to
// be distinct event types (per Rule 7): steps, todos, progress, token
// usage, tool results, and errors.

import { create } from 'zustand';
import type { StepUpdate } from '@/types/messages';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export interface TokenUsage {
  stepNumber: number;
  prompt: number;
  completion: number;
}

export interface ProgressUpdate {
  current: number;
  total: number;
  percentage: number;
}

export interface ToolResultEvent {
  toolCallId: string;
  name: string;
  result: unknown;
  isError: boolean;
  stepNumber: number;
}

interface AgentState {
  currentStep: StepUpdate | null;
  error: string | null;

  // Per-event-type state (architecture rule 7).
  todos: TodoItem[];
  currentProgress: ProgressUpdate | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  perStepTokens: TokenUsage[];
  toolResults: ToolResultEvent[];

  setStep: (step: StepUpdate) => void;
  /** tool_result event — record the result. */
  recordToolResult: (e: ToolResultEvent) => void;
  /** token_usage event — append to per-step list and update totals. */
  recordTokenUsage: (e: TokenUsage) => void;
  /** progress event — update the current step indicator. */
  setProgress: (p: ProgressUpdate) => void;
  /** todo_update event — replace the todo list. */
  setTodos: (todos: TodoItem[]) => void;
  /** agent_error event — record a fatal error for display. */
  fail: (message: string) => void;
}

const initial = {
  currentStep: null,
  error: null,
  todos: [],
  currentProgress: null,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  perStepTokens: [],
  toolResults: [],
};

export const useAgentStore = create<AgentState>((set) => ({
  ...initial,

  setStep: (step) =>
    set({ currentStep: step }),

  recordToolResult: (e) =>
    set((s) => ({ toolResults: [...s.toolResults, e] })),

  recordTokenUsage: (e) =>
    set((s) => ({
      perStepTokens: [...s.perStepTokens, e],
      totalPromptTokens: s.totalPromptTokens + e.prompt,
      totalCompletionTokens: s.totalCompletionTokens + e.completion,
    })),

  setProgress: (p) => set({ currentProgress: p }),

  setTodos: (todos) => set({ todos }),

  fail: (message) => set({ error: message }),
}));
