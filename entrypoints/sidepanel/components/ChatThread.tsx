import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef } from 'react';

import { db, getMessagesBySession, getStepsForMessage } from '@/lib/db';
import { useAgentStore } from '@/stores';
import { MessageBubble } from './MessageBubble';

export function ChatThread({ sessionId }: { sessionId: string }) {
  // Query 1: messages for this session — re-runs when any message row changes.
  const messages = useLiveQuery(
    () => getMessagesBySession(sessionId),
    [sessionId],
    [],
  );

  // Query 2: steps for each message — keyed on session ID so it re-runs
  // when steps are added to Dexie (not just when messages change).
  const allStepsForSession = useLiveQuery(
    async () => {
      if (!messages || messages.length === 0) return new Map();
      const map = new Map<string, Awaited<ReturnType<typeof getStepsForMessage>>>();
      for (const m of messages) {
        map.set(m.id, await getStepsForMessage(m.id));
      }
      return map;
    },
    // Key on sessionId — this makes the query re-run whenever
    // the session changes. The nested getStepsForMessage also queries
    // the agentSteps table, which liveQuery watches.
    [sessionId],
    new Map(),
  );

  const currentStep = useAgentStore((s) => s.currentStep);
  const accumulatedText = useAgentStore((s) => s.accumulatedText);
  const accumulatedReasoning = useAgentStore((s) => s.accumulatedReasoning);
  const liveToolCalls = useAgentStore((s) => s.liveToolCalls);
  const error = useAgentStore((s) => s.error);
  const isRunning = useAgentStore((s) => s.isRunning);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages?.length, currentStep?.stepNumber, error]);

  if ((!messages || messages.length === 0) && !isRunning && !error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
        <p>Ask the agent to do something on the active tab.</p>
        <p className="text-xs">
          Example: "Find the search input, type 'AgentSurfer', and click search."
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      {(messages ?? []).map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          steps={allStepsForSession.get(m.id) ?? []}
          isLive={isRunning && currentStep?.stepNumber != null && m.role === 'assistant'}
          liveText={m.role === 'assistant' && m === (messages ?? [])[(messages ?? []).length - 1] ? accumulatedText : ''}
          liveReasoning={m.role === 'assistant' && m === (messages ?? [])[(messages ?? []).length - 1] ? accumulatedReasoning : ''}
          liveToolCalls={
            m.role === 'assistant' && m === (messages ?? [])[(messages ?? []).length - 1] ? liveToolCalls : []
          }
        />
      ))}
      {isRunning && (messages ?? []).length > 0 && (messages ?? [])[(messages ?? []).length - 1]?.role === 'user' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
          Agent is running…
        </div>
      )}
      {isRunning && liveToolCalls.length > 0 && (
        <div className="space-y-1">
          {liveToolCalls.map((tc) => (
            <div
              key={tc.id}
              className="rounded border border-dashed border-primary/50 bg-primary/5 p-2 font-mono text-[11px]"
            >
              <span className="text-primary">→</span> {tc.name}
              {Object.keys(tc.args).length > 0 && (
                <span className="ml-1 text-muted-foreground">
                  ({Object.keys(tc.args).slice(0, 2).map((k) => `${k}=${typeof tc.args[k] === 'string' ? (tc.args[k] as string).slice(0, 30) : '…'}`).join(', ')})
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <div className="font-semibold">Agent error</div>
          <div className="mt-1 whitespace-pre-wrap break-words">{error}</div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
