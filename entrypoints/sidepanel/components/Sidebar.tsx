import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, MessageSquare, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { db } from '@/lib/db';
import { useChangeCount } from '@/lib/use-change-count';
import { useSessionStore } from '@/stores';

async function dbMsg(message: { type: string; [k: string]: unknown }): Promise<void> {
  const res = (await chrome.runtime.sendMessage(message)) as { ok: boolean; error?: string };
  if (!res.ok) throw new Error(res.error ?? 'db message failed');
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  // Re-query when SW writes to sessions table.
  const sessionChangeCount = useChangeCount('sessions');
  const sessions = useLiveQuery(
    () => db.sessions.orderBy('updatedAt').reverse().toArray(),
    [sessionChangeCount],
    [],
  );
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setCurrent = useSessionStore((s) => s.setCurrentSession);
  const startNew = useSessionStore((s) => s.startNewSession);

  if (collapsed) {
    return (
      <aside className="flex w-9 shrink-0 flex-col items-center border-r bg-muted/30 py-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="mt-2 h-7 w-7"
          onClick={() => startNew()}
          title="New chat"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </aside>
    );
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
      <div className="flex items-center justify-between p-2">
        <Button
          variant="default"
          size="sm"
          className="flex-1 justify-start"
          onClick={() => startNew()}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> New chat
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="ml-1 h-7 w-7 shrink-0"
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 p-1">
          {sessions.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => setCurrent(s.id)}
              className={cn(
                'group flex w-full items-center justify-between gap-1 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                currentSessionId === s.id && 'bg-accent',
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{s.title || 'New chat'}</span>
              </span>
              <span
                role="button"
                tabIndex={0}
                className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/15 hover:text-destructive group-hover:inline-flex"
                onClick={(e) => {
                  e.stopPropagation();
                  dbMsg({ type: 'db:delete-session', sessionId: s.id });
                  if (currentSessionId === s.id) setCurrent(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    dbMsg({ type: 'db:delete-session', sessionId: s.id });
                    if (currentSessionId === s.id) setCurrent(null);
                  }
                }}
              >
                <Trash2 className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>
    </aside>
  );
}
