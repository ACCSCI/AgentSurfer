import { useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Loader2, RefreshCw, Settings as SettingsIcon, Square, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useAgentStore, useSessionStore, useSettingsStore, useModelConfigsSync, type TokenUsage, type ProgressUpdate, type ToolResultEvent, type TodoItem } from '@/stores';
import { db } from '@/lib/db';
import { useChangeCount } from '@/lib/use-change-count';
import { sendToSW } from '@/lib/sw-messenger';
import type { StepUpdate } from '@/types/messages';
import { ChatThread } from './components/ChatThread';
import { InputBar } from './components/InputBar';
import { ModelBadge } from './components/ModelBadge';
import { Sidebar } from './components/Sidebar';
import { installSmartScreenshotHandler } from './smart-screenshot';

// Register the smart-screenshot message listener at module load (must be
// synchronous per MV3 §2.5 — listeners only fire if registered at top
// level when the page loaded). Without this, the SW's `__smart-screenshot:
// execute` messages have no handler and the tool returns "side panel not
// available or unresponsive."
installSmartScreenshotHandler();

export default function App() {
  // Re-sync Zustand active config when SW writes to modelConfigs.
  useModelConfigsSync();

  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const startNewSession = useSessionStore((s) => s.startNewSession);
  const setCurrent = useSessionStore((s) => s.setCurrentSession);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const settingsReady = useSettingsStore((s) => s.ready);
  const setStep = useAgentStore((s) => s.setStep);
  const setRunId = useAgentStore((s) => s.start);
  const appendText = useAgentStore((s) => s.appendText);
  const appendReasoning = useAgentStore((s) => s.appendReasoning);
  const addStreamingToolCall = useAgentStore((s) => s.addStreamingToolCall);
  const recordToolResult = useAgentStore((s) => s.recordToolResult);
  const recordTokenUsage = useAgentStore((s) => s.recordTokenUsage);
  const setProgress = useAgentStore((s) => s.setProgress);
  const setTodos = useAgentStore((s) => s.setTodos);
  const accumulatedText = useAgentStore((s) => s.accumulatedText);
  const accumulatedReasoning = useAgentStore((s) => s.accumulatedReasoning);
  const liveToolCalls = useAgentStore((s) => s.liveToolCalls);
  const cancelRun = useAgentStore((s) => s.cancel);
  const finishRun = useAgentStore((s) => s.finish);
  const failRun = useAgentStore((s) => s.fail);
  const resetAgent = useAgentStore((s) => s.reset);
  const isRunning = useAgentStore((s) => s.isRunning);
  const currentRunId = useAgentStore((s) => s.runId);

  const sessionChangeCount = useChangeCount('sessions');
  const mostRecentSession = useLiveQuery(
    async () => (await db.sessions.orderBy('updatedAt').reverse().first()) ?? null,
    [sessionChangeCount],
    // undefined initial value: distinguishes "loading" from "no sessions".
    undefined as { id: string; title: string; createdAt: number; updatedAt: number } | null | undefined,
  );

  // On first open, ensure we have a session selected.
  useEffect(() => {
    if (!settingsReady) hydrate();
  }, [settingsReady, hydrate]);

  // Track the previous session id so we only reset agent state when the
  // session actually changes — not on every Dexie write that touches the
  // session row (e.g. updatedAt bump from appendMessage). Without this,
  // the effect re-runs and resetAgent() wipes isRunning mid-run, hiding
  // the streaming text and the Cancel button.
  const prevSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (currentSessionId && currentSessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = currentSessionId;
      // Session changed → reset agent state (clear errors, live text, etc.)
      resetAgent();
      return;
    }
    if (currentSessionId) {
      // Same session — don't reset. updatedAt bumps from appendMessage
      // re-render useLiveQuery and would otherwise kill an in-flight run.
      prevSessionIdRef.current = currentSessionId;
      return;
    }
    // `mostRecentSession === null` is ambiguous: it could mean "Dexie has no
    // sessions" OR "Dexie query is still loading" (initial render). Only
    // create a new session if the query has completed (undefined) and
    // returned null. The 3rd arg of useLiveQuery is the initial value —
    // we set it to undefined so the first render is distinguishable.
    if (mostRecentSession === undefined) return; // still loading
    if (mostRecentSession) setCurrent(mostRecentSession.id);
    else startNewSession();
  }, [currentSessionId, mostRecentSession, setCurrent, startNewSession, resetAgent]);

  // Listen for messages from the service worker.
  const setStepRef = useRef(setStep);
  setStepRef.current = setStep;
  const finishRef = useRef(finishRun);
  finishRef.current = finishRun;
  const failRef = useRef(failRun);
  failRef.current = failRun;
  const appendTextRef = useRef(appendText);
  appendTextRef.current = appendText;
  const appendReasoningRef = useRef(appendReasoning);
  appendReasoningRef.current = appendReasoning;
  const addTcRef = useRef(addStreamingToolCall);
  addTcRef.current = addStreamingToolCall;
  const recordToolResultRef = useRef(recordToolResult);
  recordToolResultRef.current = recordToolResult;
  const recordTokenUsageRef = useRef(recordTokenUsage);
  recordTokenUsageRef.current = recordTokenUsage;
  const setProgressRef = useRef(setProgress);
  setProgressRef.current = setProgress;
  const setTodosRef = useRef(setTodos);
  setTodosRef.current = setTodos;

  // Event listener — pure event consumption. UI owns all state.
  useEffect(() => {
    const handler = (message: { type?: string; __fromSW?: boolean; [k: string]: unknown }) => {
      if (!message.__fromSW) return;
      const t = message.type;
      if (t === 'user_message') return; // UI already shows the user bubble.
      if (t === 'model_ready') return; // UI doesn't need this.
      if (t === 'step_done') {
        setStepRef.current((message as { update: StepUpdate }).update);
      } else if (t === 'agent_done') {
        finishRef.current();
      } else if (t === 'agent_error') {
        failRef.current(String((message as { message?: string }).message ?? 'Agent error'));
      } else if (t === 'tool_result') {
        recordToolResultRef.current(message as unknown as ToolResultEvent);
      } else if (t === 'token_usage') {
        recordTokenUsageRef.current(message as unknown as TokenUsage);
      } else if (t === 'progress') {
        setProgressRef.current(message as unknown as ProgressUpdate);
      } else if (t === 'todo_update') {
        setTodosRef.current(((message as { todos: TodoItem[] }).todos) ?? []);
      } else if (t === 'chunk') {
        const c = (message as { data?: { type: string; [k: string]: unknown } }).data;
        if (!c) return;
        if (c.type === 'text-delta' && typeof c.textDelta === 'string') {
          appendTextRef.current(c.textDelta);
        } else if (c.type === 'reasoning' || c.type === 'reasoning-delta') {
          const text =
            ((c as { textDelta?: string }).textDelta ?? '') ||
            ((c as { text?: string }).text ?? '');
          if (text) appendReasoningRef.current(text);
        } else if (c.type === 'tool-call' && c.toolCallId && c.toolName) {
          addTcRef.current({
            id: c.toolCallId as string,
            name: c.toolName as string,
            args: (typeof c.args === 'string' ? safeJson(c.args) : (c.args as Record<string, unknown>)) ?? {},
          });
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  function safeJson(s: string): Record<string, unknown> {
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  }

  function openSettings() {
    chrome.runtime.openOptionsPage();
  }

  async function startAgent(prompt: string) {
    if (!currentSessionId) return;
    const runId = crypto.randomUUID();
    setRunId(runId);
    try {
      await sendToSW({
        type: 'agent:start',
        payload: { runId, sessionId: currentSessionId, prompt },
      });
    } catch (err) {
      failRun(err instanceof Error ? err.message : String(err));
    }
  }

  async function cancel() {
    const runId = useAgentStore.getState().runId;
    cancelRun();
    if (runId) {
      try {
        await sendToSW({ type: 'agent:cancel', runId });
      } catch {
        // ignore
      }
    }
    resetAgent();
  }

  return (
    <div className="flex h-screen w-full bg-background text-foreground">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">AgentSurfer</span>
            <Separator orientation="vertical" className="h-4" />
            <ModelBadge />
          </div>
          <div className="flex items-center gap-1">
            {isRunning && (
              <Button size="sm" variant="destructive" onClick={cancel}>
                <Square className="mr-1 h-3 w-3 fill-current" /> Cancel
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={() => hydrate()}
              title="Reload model config"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" onClick={openSettings} title="Settings">
              <SettingsIcon className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          {currentSessionId ? (
            <ChatThread sessionId={currentSessionId} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
        </ScrollArea>

        <InputBar onSubmit={startAgent} disabled={!currentSessionId} />
      </main>
    </div>
  );
}
