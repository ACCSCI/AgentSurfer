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
  // Accumulated streaming text across the ENTIRE run (not per-step).
  // Only cleared on start/reset/finish. This prevents the "flash and disappear"
  // when a step completes and the live section resets.
  accumulatedText: string;
  // Tool calls from the current in-progress step (before onStepFinish).
  // Cleared on setStep (step completed → tool calls are now in Dexie).
  liveToolCalls: ToolCall[];
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
  accumulatedText: '',
  liveToolCalls: [],
  runningTools: {},
  abortController: null,
  error: null,

  start: (runId) => {
    const ac = new AbortController();
    set({
      runId,
      isRunning: true,
      currentStep: null,
      accumulatedText: '',
      liveToolCalls: [],
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
      // Keep liveToolCalls — they're still visible until the NEXT step's
      // first chunk arrives (appendText or addStreamingToolCall clears them).
      // This prevents the flash where tool calls vanish between steps.
    }),

  appendText: (text) =>
    set((s) => ({
      accumulatedText: s.accumulatedText + text,
      // New text arriving = new step started. Clear old live tool calls.
      liveToolCalls: [],
    })),

  addStreamingToolCall: (tc) =>
    set((s) => ({ liveToolCalls: [...s.liveToolCalls, tc] })),

  markTool: (toolCallId, status) =>
    set((s) => ({ runningTools: { ...s.runningTools, [toolCallId]: status } })),

  finish: (_totalUsage) =>
    set({
      isRunning: false,
      abortController: null,
      currentStep: null,
      liveToolCalls: [],
      // Keep accumulatedText — the user should see the full run, not
      // just the final summary. Cleared only on reset() (new session).
    }),

  fail: (message) =>
    set({
      isRunning: false,
      abortController: null,
      error: message,
      liveToolCalls: [],
      // Keep accumulatedText — the user should see what the model
      // said before the error. Cleared only on reset().
    }),

  reset: () =>
    set({
      runId: null,
      isRunning: false,
      currentStep: null,
      accumulatedText: '',
      liveToolCalls: [],
      runningTools: {},
      abortController: null,
      error: null,
    }),
}));

// Type alias export for components.
export type { AgentStep };
