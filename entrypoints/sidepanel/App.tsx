import { useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Loader2, Settings as SettingsIcon, Square, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useAgentStore, useSessionStore, useSettingsStore } from '@/stores';
import { db } from '@/lib/db';
import { ChatThread } from './components/ChatThread';
import { InputBar } from './components/InputBar';
import { ModelBadge } from './components/ModelBadge';
import { Sidebar } from './components/Sidebar';

export default function App() {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const startNewSession = useSessionStore((s) => s.startNewSession);
  const setCurrent = useSessionStore((s) => s.setCurrentSession);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const settingsReady = useSettingsStore((s) => s.ready);
  const setStep = useAgentStore((s) => s.setStep);
  const setRunId = useAgentStore((s) => s.start);
  const appendText = useAgentStore((s) => s.appendText);
  const addStreamingToolCall = useAgentStore((s) => s.addStreamingToolCall);
  const cancelRun = useAgentStore((s) => s.cancel);
  const finishRun = useAgentStore((s) => s.finish);
  const failRun = useAgentStore((s) => s.fail);
  const resetAgent = useAgentStore((s) => s.reset);
  const isRunning = useAgentStore((s) => s.isRunning);

  const mostRecentSession = useLiveQuery(
    async () => (await db.sessions.orderBy('updatedAt').reverse().first()) ?? null,
    [],
    null,
  );

  // On first open, ensure we have a session selected.
  useEffect(() => {
    if (!settingsReady) hydrate();
  }, [settingsReady, hydrate]);

  useEffect(() => {
    if (currentSessionId) return;
    if (mostRecentSession) setCurrent(mostRecentSession.id);
    else startNewSession();
  }, [currentSessionId, mostRecentSession, setCurrent, startNewSession]);

  // Listen for messages from the service worker.
  const setStepRef = useRef(setStep);
  setStepRef.current = setStep;
  const finishRef = useRef(finishRun);
  finishRef.current = finishRun;
  const failRef = useRef(failRun);
  failRef.current = failRun;
  const appendTextRef = useRef(appendText);
  appendTextRef.current = appendText;
  const addTcRef = useRef(addStreamingToolCall);
  addTcRef.current = addStreamingToolCall;

  useEffect(() => {
    const listener = (message: { type?: string; [k: string]: unknown }) => {
      if (message.type === 'agent:step') {
        setStepRef.current((message as { step: unknown }).step as never);
      } else if (message.type === 'agent:done') {
        finishRef.current();
      } else if (message.type === 'agent:error') {
        failRef.current(String((message as { message?: string }).message ?? 'Agent error'));
      } else if (message.type === 'agent:chunk') {
        const c = (message as { chunk?: { type: string; [k: string]: unknown } }).chunk;
        if (!c) return;
        if (c.type === 'text-delta' && typeof c.textDelta === 'string') {
          appendTextRef.current(c.textDelta);
        } else if (c.type === 'tool-call' && c.toolCallId && c.toolName) {
          addTcRef.current({
            id: c.toolCallId as string,
            name: c.toolName as string,
            args: (typeof c.args === 'string' ? safeJson(c.args) : (c.args as Record<string, unknown>)) ?? {},
          });
        }
      } else if (message.type === '__sw:log') {
        // Bridge SW logs into the page console so the test runner can see them.
        // eslint-disable-next-line no-console
        console.log((message as { line: string }).line);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
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
      await chrome.runtime.sendMessage({
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
        await chrome.runtime.sendMessage({ type: 'agent:cancel', runId });
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
