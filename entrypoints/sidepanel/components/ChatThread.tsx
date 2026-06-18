import { useEffect, useRef } from 'react';

import { useMessageStore } from '@/stores/useMessageStore';
import { useAgentStore } from '@/stores';
import { MessageBubble } from './MessageBubble';

export function ChatThread() {
  // MessageStore is the single source of truth for message bodies during
  // streaming. Dexie is not queried here — only MessageStore is.
  const { state } = useMessageStore();
  const messages = state.messages;
  const error = useAgentStore((s) => s.error);

  // The last assistant message is "live" when its status is 'draft'.
  const lastMsg = messages[messages.length - 1];
  const isLive = lastMsg?.status === 'draft';

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, lastMsg?.text?.length, lastMsg?.reasoning?.length, lastMsg?.toolCalls.length, error]);

  if (messages.length === 0 && !error) {
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
    <div
      className="mx-auto flex max-w-2xl flex-col gap-3 p-4"
      data-testid="chat-thread"
      data-message-count={messages.length}
      data-is-live={isLive}
    >
      {messages.map((m) => (
        <MessageBubble key={m.messageId} message={m} />
      ))}
      {isLive && (
        <div
          data-testid="agent-running-indicator"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
          Agent is running…
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
