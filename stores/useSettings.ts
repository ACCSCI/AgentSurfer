// Settings store — active model config id. Configs themselves are read live
// from Dexie in components via useLiveQuery.

import { create } from 'zustand';
import { getActiveConfig, setActiveConfig as dbSetActive } from '@/lib/db';

interface SettingsState {
  activeConfigId: string | null;
  ready: boolean;
  hydrate: () => Promise<void>;
  setActive: (id: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  activeConfigId: null,
  ready: false,

  hydrate: async () => {
    const active = await getActiveConfig();
    set({ activeConfigId: active?.id ?? null, ready: true });
  },

  setActive: async (id) => {
    await dbSetActive(id);
    set({ activeConfigId: id });
  },
}));
