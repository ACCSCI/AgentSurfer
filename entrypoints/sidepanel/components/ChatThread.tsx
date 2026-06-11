import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef } from 'react';

import { db, getMessagesBySession, getStepsForMessage } from '@/lib/db';
import { useAgentStore } from '@/stores';
import { MessageBubble } from './MessageBubble';

export function ChatThread({ sessionId }: { sessionId: string }) {
  // Refetch the message list whenever the session changes or any message is
  // added/updated/removed in the DB.
  const messages = useLiveQuery(
    () => getMessagesBySession(sessionId),
    [sessionId],
    [],
  );

  const stepsByMessage = useLiveQuery(
    async () => {
      const map = new Map<string, Awaited<ReturnType<typeof getStepsForMessage>>>();
      for (const m of messages) {
        map.set(m.id, await getStepsForMessage(m.id));
      }
      return map;
    },
    [messages],
    new Map(),
  );

  const currentStep = useAgentStore((s) => s.currentStep);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, currentStep?.stepNumber]);

  if (messages.length === 0) {
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
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          steps={stepsByMessage.get(m.id) ?? []}
          isLive={currentStep?.stepNumber != null && m.role === 'assistant'}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

void db; // silence unused if not referenced here
