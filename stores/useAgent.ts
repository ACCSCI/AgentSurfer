// Agent run store — tracks the current in-flight agent run so the side panel
// can stream step updates from the service worker. Persistence of steps
// happens in the service worker via Dexie; this store is a UI-side mirror.

import { create } from 'zustand';
import type { AgentStep, ToolCall } from '@/types/agent';
import type { StepUpdate } from '@/types/messages';

interface AgentState {
  runId: string | null;
  isRunning: boolean;
  currentStep: StepUpdate | null;
  // Live, streaming deltas from the model (text + tool call deltas).
  // Reset at the start of each step; appended to as onChunk fires.
  currentText: string;
  currentToolCalls: ToolCall[];
  // Per-step live result count, so the UI can show "running tool X" badges.
  runningTools: Record<string, 'pending' | 'ok' | 'error'>;
  abortController: AbortController | null;
  error: string | null;

  start: (runId: string) => AbortController;
  cancel: () => void;
  setStep: (step: StepUpdate) => void;
  appendText: (text: string) => void;
  addStreamingToolCall: (tc: ToolCall) => void;
  markTool: (toolCallId: string, status: 'pending' | 'ok' | 'error') => void;
  finish: (totalUsage?: { prompt: number; completion: number }) => void;
  fail: (message: string) => void;
  reset: () => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  runId: null,
  isRunning: false,
  currentStep: null,
  currentText: '',
  currentToolCalls: [],
  runningTools: {},
  abortController: null,
  error: null,

  start: (runId) => {
    const ac = new AbortController();
    set({
      runId,
      isRunning: true,
      currentStep: null,
      currentText: '',
      currentToolCalls: [],
      runningTools: {},
      abortController: ac,
      error: null,
    });
    return ac;
  },

  cancel: () => {
    const ac = get().abortController;
    if (ac) ac.abort();
  },

  setStep: (step) =>
    set({
      currentStep: step,
      // Reset the streaming buffer for the new step.
      currentText: '',
      currentToolCalls: [],
    }),

  appendText: (text) =>
    set((s) => ({ currentText: s.currentText + text })),

  addStreamingToolCall: (tc) =>
    set((s) => ({ currentToolCalls: [...s.currentToolCalls, tc] })),

  markTool: (toolCallId, status) =>
    set((s) => ({ runningTools: { ...s.runningTools, [toolCallId]: status } })),

  finish: (_totalUsage) =>
    set({
      isRunning: false,
      abortController: null,
      currentStep: null,
      currentText: '',
      currentToolCalls: [],
    }),

  fail: (message) =>
    set({
      isRunning: false,
      abortController: null,
      error: message,
      currentText: '',
      currentToolCalls: [],
    }),

  reset: () =>
    set({
      runId: null,
      isRunning: false,
      currentStep: null,
      currentText: '',
      currentToolCalls: [],
      runningTools: {},
      abortController: null,
      error: null,
    }),
}));

// Type alias export for components.
export type { AgentStep };
