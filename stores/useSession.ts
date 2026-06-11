// Session store — current session, streaming flag, and session-list actions.
// Message contents are read live from Dexie in components via useLiveQuery
// (see lib/db.ts). This store only tracks "which session is open" + UI flags.

import { create } from 'zustand';
import { createSession, getMessagesBySession } from '@/lib/db';

interface SessionState {
  currentSessionId: string | null;
  isStreaming: boolean;

  setCurrentSession: (id: string | null) => void;
  startNewSession: () => Promise<string>;
  setStreaming: (b: boolean) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  currentSessionId: null,
  isStreaming: false,

  setCurrentSession: (id) => set({ currentSessionId: id }),

  startNewSession: async () => {
    const session = await createSession();
    set({ currentSessionId: session.id });
    return session.id;
  },

  setStreaming: (b) => set({ isStreaming: b }),
}));

// Convenience selector for the current session's messages.
export async function loadCurrentMessages(sessionId: string | null) {
  if (!sessionId) return [];
  return getMessagesBySession(sessionId);
}
