import { useLiveQuery } from 'dexie-react-hooks';
import { MessageSquare, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { db, deleteSession } from '@/lib/db';
import { useSessionStore } from '@/stores';

export function Sidebar() {
  const sessions = useLiveQuery(
    () => db.sessions.orderBy('updatedAt').reverse().toArray(),
    [],
    [],
  );
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setCurrent = useSessionStore((s) => s.setCurrentSession);
  const startNew = useSessionStore((s) => s.startNewSession);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-muted/30">
      <div className="p-2">
        <Button
          variant="default"
          size="sm"
          className="w-full justify-start"
          onClick={() => startNew()}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> New chat
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
                  deleteSession(s.id);
                  if (currentSessionId === s.id) setCurrent(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    deleteSession(s.id);
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
