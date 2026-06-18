import { useLiveQuery } from 'dexie-react-hooks';

import { Badge } from '@/components/ui/badge';
import { db } from '@/lib/db';
import { useChangeCount } from '@/lib/use-change-count';
import { ProviderMeta } from '@/types';
import { useSettingsStore } from '@/stores';

export function ModelBadge() {
  const activeConfigId = useSettingsStore((s) => s.activeConfigId);
  const configChangeCount = useChangeCount('modelConfigs');
  const configs = useLiveQuery(() => db.modelConfigs.toArray(), [configChangeCount], []);
  const active = configs.find((c) => c.id === activeConfigId);

  if (!active) {
    return (
      <Badge variant="outline" className="text-[10px]">
        no model · set in settings
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="text-[10px]" title={active.modelId}>
      {ProviderMeta[active.provider].label} · {active.modelId}
    </Badge>
  );
}
