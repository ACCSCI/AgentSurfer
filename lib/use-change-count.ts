// React hook: subscribe to a table's change counter in chrome.storage.local.
// Use as a dependency to useLiveQuery so the query re-runs when SW writes.
//
// Example:
//   const count = useChangeCount('sessions');
//   const sessions = useLiveQuery(() => db.sessions.toArray(), [count]);

import { useEffect, useState } from 'react';

/** Read the change counter for a table. Updates when the counter increments. */
export function useChangeCount(table: string): number {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    const key = `__db_change_${table}`;
    // Initial read.
    chrome.storage.local.get(key).then((got) => {
      setCount((got[key] as number) ?? 0);
    });

    // Listen for changes.
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      const change = changes[key];
      if (change) setCount(change.newValue as number);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [table]);

  return count;
}
