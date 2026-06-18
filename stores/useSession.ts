// Session store — current session, streaming flag, and session-list actions.
// Message contents are read live from Dexie in components via useLiveQuery
// (see lib/db.ts). This store only tracks "which session is open" + UI flags.

import { create } from 'zustand';
import { getMessagesBySession } from '@/lib/db';
import { sendToSW } from '@/lib/sw-messenger';

interface SessionState {
  currentSessionId: string | null;
  isStreaming: boolean;

  setCurrentSession: (id: string | null) => void;
  startNewSession: () => Promise<string>;
  setStreaming: (b: boolean) => void;
}

/** Send a db message to SW and return the typed response. */
async function db<T = unknown>(message: { type: string; [k: string]: unknown }): Promise<T> {
  const res = await sendToSW(message);
  if (!res.ok) throw new Error(res.error ?? 'db message failed');
  return (res.data as T) ?? (res as unknown as T);
}

export const useSessionStore = create<SessionState>((set) => ({
  currentSessionId: null,
  isStreaming: false,

  setCurrentSession: (id) => set({ currentSessionId: id }),

  startNewSession: async () => {
    // Create session via SW (single writer rule).
    const res = await db<{ session: { id: string } }>({ type: 'db:create-session' });
    set({ currentSessionId: res.session.id });
    return res.session.id;
  },

  setStreaming: (b) => set({ isStreaming: b }),
}));

// Convenience selector for the current session's messages.
export async function loadCurrentMessages(sessionId: string | null) {
  if (!sessionId) return [];
  return getMessagesBySession(sessionId);
}
