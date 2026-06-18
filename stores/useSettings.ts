// Settings store — active model config id. Configs themselves are read live
// from Dexie in components via useLiveQuery.

import { useEffect } from 'react';
import { create } from 'zustand';
import { getActiveConfig } from '@/lib/db';
import { useChangeCount } from '@/lib/use-change-count';
import { sendToSW } from '@/lib/sw-messenger';

interface SettingsState {
  activeConfigId: string | null;
  ready: boolean;
  hydrate: () => Promise<void>;
  setActive: (id: string) => Promise<void>;
}

async function db(message: { type: string; [k: string]: unknown }): Promise<unknown> {
  const res = await sendToSW(message);
  if (!res.ok) throw new Error(res.error ?? 'db message failed');
  return res.data;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  activeConfigId: null,
  ready: false,

  hydrate: async () => {
    // Read is OK to do directly (same context — no cross-context issue).
    const active = await getActiveConfig();
    set({ activeConfigId: active?.id ?? null, ready: true });
  },

  setActive: async (id) => {
    // Write goes through SW (single writer rule).
    await db({ type: 'db:set-active-config', id });
    set({ activeConfigId: id });
  },
}));

/**
 * Hook: subscribe to modelConfigs change count and re-hydrate the active
 * config id whenever another context (typically the SW) writes to the table.
 *
 * Call this in the side panel root so any write to modelConfigs (from any
 * context) re-syncs the Zustand cache.
 */
export function useModelConfigsSync(): void {
  const changeCount = useChangeCount('modelConfigs');
  const hydrate = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    if (changeCount > 0) {
      void hydrate();
    }
  }, [changeCount, hydrate]);
}
