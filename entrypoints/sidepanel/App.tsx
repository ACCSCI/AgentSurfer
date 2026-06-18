import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Loader2, RefreshCw, Settings as SettingsIcon, Square, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useAgentStore, useSessionStore, useSettingsStore, useModelConfigsSync, type TokenUsage, type ProgressUpdate, type ToolResultEvent, type TodoItem } from '@/stores';
import { useMessageStore } from '@/stores/useMessageStore';
import { db } from '@/lib/db';
import { useChangeCount } from '@/lib/use-change-count';
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
  const setCurrent = useSessionStore((s) => s.setCurrentSession);
  const startNewSession = useSessionStore((s) => s.startNewSession);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const settingsReady = useSettingsStore((s) => s.ready);
  const setStep = useAgentStore((s) => s.setStep);
  const recordToolResult = useAgentStore((s) => s.recordToolResult);
  const recordTokenUsage = useAgentStore((s) => s.recordTokenUsage);
  const setProgress = useAgentStore((s) => s.setProgress);
  const setTodos = useAgentStore((s) => s.setTodos);
  const failRun = useAgentStore((s) => s.fail);

  // MessageStore is the single source of truth for messages + send/cancel
  // commands. The side panel connects to the SW's `msgstore` port via this
  // hook and gets a snapshot on connect + updates on every state change.
  const { state: msgState, selectSession, send, cancel: cancelRunViaPort } = useMessageStore();
  const messages = msgState.messages;

  // isRunning is derived from the last message's status. While a draft
  // message exists, the agent is mid-stream. When markComplete runs, the
  // status flips to 'complete' and isLive becomes false.
  const isLive = messages.length > 0 && messages[messages.length - 1]?.status === 'draft';
  const currentRunIdRef = useRef<string | null>(null);

  const sessionChangeCount = useChangeCount('sessions');
  const mostRecentSession = useLiveQuery(
    async () => (await db.sessions.orderBy('updatedAt').reverse().first()) ?? null,
    [sessionChangeCount],
    undefined as { id: string; title: string; createdAt: number; updatedAt: number } | null | undefined,
  );

  // On first open, ensure we have a session selected.
  useEffect(() => {
    if (!settingsReady) hydrate();
  }, [settingsReady, hydrate]);

  // On first open, ensure we have a session selected.
  useEffect(() => {
    if (mostRecentSession === undefined) return; // still loading
    if (mostRecentSession) setCurrent(mostRecentSession.id);
    else startNewSession();
  }, [mostRecentSession, setCurrent, startNewSession]);

  // When the current session changes, tell the SW to hydrate MessageStore
  // from Dexie. MessageStore pushes a snapshot back via the port, which
  // updates `messages` and triggers a re-render of ChatThread.
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentSessionId === prevSessionIdRef.current) return;
    prevSessionIdRef.current = currentSessionId;
    if (currentSessionId) {
      selectSession(currentSessionId);
      currentRunIdRef.current = null;
    }
  }, [currentSessionId, selectSession]);

  // Listen for non-message events from the SW (step_done, todo_update,
  // progress, token_usage, agent_done, agent_error). Message bodies flow
  // through MessageStore — we don't touch 'chunk' or 'user_message' here.
  useEffect(() => {
    const handler = (message: { type?: string; __fromSW?: boolean; [k: string]: unknown }) => {
      if (!message.__fromSW) return;
      const t = message.type;
      if (t === 'step_done') {
        setStep((message as { update: StepUpdate }).update);
      } else if (t === 'agent_done') {
        currentRunIdRef.current = null;
      } else if (t === 'agent_error') {
        failRun(String((message as { message?: string }).message ?? 'Agent error'));
        currentRunIdRef.current = null;
      } else if (t === 'tool_result') {
        recordToolResult(message as unknown as ToolResultEvent);
      } else if (t === 'token_usage') {
        recordTokenUsage(message as unknown as TokenUsage);
      } else if (t === 'progress') {
        setProgress(message as unknown as ProgressUpdate);
      } else if (t === 'todo_update') {
        setTodos(((message as { todos: TodoItem[] }).todos) ?? []);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [setStep, recordToolResult, recordTokenUsage, setProgress, setTodos, failRun]);

  function openSettings() {
    chrome.runtime.openOptionsPage();
  }

  async function startAgent(prompt: string) {
    if (!currentSessionId) return;
    try {
      const result = await send(currentSessionId, prompt);
      currentRunIdRef.current = result.runId;
    } catch (err) {
      failRun(err instanceof Error ? err.message : String(err));
    }
  }

  async function cancel() {
    const runId = currentRunIdRef.current;
    if (runId) {
      try { await cancelRunViaPort(runId); } catch { /* ignore */ }
    }
    currentRunIdRef.current = null;
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
            {isLive && (
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
            <ChatThread />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
        </ScrollArea>

        <InputBar onSubmit={startAgent} onCancel={cancel} disabled={!currentSessionId} />
      </main>
    </div>
  );
}
