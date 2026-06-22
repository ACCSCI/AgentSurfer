// Checkpoint — persists in-flight run state to chrome.storage.session
// so it survives SW restarts.
//
// This fixes P0.2 from CLAUDE.md §6 (inflight was in-memory only).
// The original `inflight` Map in entrypoints/background.ts was lost
// when the SW was killed mid-run. Storing the runId → AbortController
// reference plus minimal state in `chrome.storage.session` (which
// persists across SW restarts but not browser restarts) lets a
// restarted SW look up "is there a run still alive?" and
// re-establish the abort signal.
//
// Why chrome.storage.session (not chrome.storage.local):
//   - session: persists across SW restarts, cleared on browser
//     restart. Matches the lifetime of "an active agent run".
//   - local: would persist across browser restarts, which is wrong
//     (a run is ephemeral).
//
// What we persist per run:
//   - runId, sessionId, startMs, modelId
//   - status: 'running' | 'cancelled' | 'completed' | 'errored'
//   - lastStepNumber
//
// We do NOT persist the AbortController itself (not serializable).
// Instead, the SW holds the AbortController in a module-level Map at
// runtime; after a SW restart the new instance creates a fresh
// AbortController. If the previous run is still listed in the
// checkpoint, the SW can re-attach the run to the new controller —
// but for our purposes (one-shot LLM calls), we just expose
// "is this run still tracked?" so background.ts can decide.
//
// API:
//   - saveRun(record): write/update a run record
//   - getRun(runId): read a run record
//   - listRuns(): enumerate all run records (for diagnostics / E2E)
//   - deleteRun(runId): remove a run record
//   - isActive(runId): convenience — is the run still running?
//   - sweepStaleRuns(): abandon any 'running' record older than its
//                       wall-timeout (called on SW startup; fixes the
//                       P0.1 case where chrome.alarms survives but the
//                       alarm listener is gone with the old SW)

import { log } from '@/lib/logger';

const STORAGE_KEY = '__runtime_inflight_runs';

export type RunStatus = 'running' | 'cancelled' | 'completed' | 'errored';

export interface RunRecord {
  runId: string;
  sessionId: string;
  startMs: number;
  modelId: string;
  /** Wall-clock timeout for this run, in ms. Stored so the SW-restart
   *  sweep can decide how old is "too old" without importing
   *  lib/agent.ts (which would create a circular dep). */
  wallTimeoutMs: number;
  status: RunStatus;
  lastStepNumber: number;
  /** The draft assistant messageId for this run (from
   *  MessageStore.beginRun). Persisted so the SW-restart sweep can
   *  reach into Dexie and mark the orphaned assistant message as
   *  cancelled — the in-memory runToMessageId map is gone after the
   *  SW is killed, so this is the only way to repair the message. */
  messageId?: string;
}

type InflightStore = Record<string, RunRecord>;

async function readStore(): Promise<InflightStore> {
  try {
    const got = await chrome.storage.session.get(STORAGE_KEY);
    return (got[STORAGE_KEY] as InflightStore | undefined) ?? {};
  } catch (err) {
    log.warn('runtime', 'checkpoint read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

async function writeStore(store: InflightStore): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: store });
  } catch (err) {
    log.warn('runtime', 'checkpoint write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Write or update a run record. Called on agent:start and on each
 *  step_done (so the checkpoint reflects forward progress). */
export async function saveRun(record: RunRecord): Promise<void> {
  const store = await readStore();
  store[record.runId] = record;
  await writeStore(store);
  log.debug('runtime', 'saveRun', { runId: record.runId, status: record.status, step: record.lastStepNumber });
}

export async function getRun(runId: string): Promise<RunRecord | null> {
  const store = await readStore();
  return store[runId] ?? null;
}

export async function listRuns(): Promise<RunRecord[]> {
  const store = await readStore();
  return Object.values(store);
}

export async function deleteRun(runId: string): Promise<void> {
  const store = await readStore();
  delete store[runId];
  await writeStore(store);
  log.debug('runtime', 'deleteRun', { runId });
}

export async function isActive(runId: string): Promise<boolean> {
  const rec = await getRun(runId);
  return rec?.status === 'running';
}

/** Mark a run as completed/cancelled/errored and remove it from the
 *  checkpoint. Called from onFinish / onError. Idempotent — calling
 *  it twice for the same runId is a no-op. */
export async function markRunDone(runId: string, status: Exclude<RunStatus, 'running'>): Promise<void> {
  const rec = await getRun(runId);
  if (!rec) return;
  await deleteRun(runId);
  log.info('runtime', 'markRunDone', { runId, status });
}

/**
 * Find every 'running' record that has exceeded its `wallTimeoutMs` and
 * abandon it. Called once on SW startup, after a chrome.runtime.restart
 * / re-evaluation has wiped our module-level AbortController map but
 * the alarm (which IS persistent) will fire with no listener in the
 * new SW.
 *
 * Without this sweep, a run that was started before the SW died would
 * stay in the checkpoint forever and the agent_done event would never
 * fire — the side panel would be stuck "Agent is running…" until
 * manual refresh.
 *
 * Returns the list of abandoned runIds so the caller can broadcast
 * `agent_error` events for them. Idempotent.
 */
export async function sweepStaleRuns(): Promise<RunRecord[]> {
  const now = Date.now();
  const all = await listRuns();
  const stale: RunRecord[] = [];
  for (const rec of all) {
    if (rec.status !== 'running') continue;
    const ageMs = now - rec.startMs;
    if (ageMs > rec.wallTimeoutMs) {
      stale.push(rec);
    }
  }
  if (stale.length === 0) return stale;
  log.warn('runtime', '[checkpoint-sweep] scanning N stale runs', {
    count: stale.length,
    runIds: stale.map((r) => r.runId),
  });
  for (const rec of stale) {
    await markRunDone(rec.runId, 'cancelled');
    // Repair the orphaned assistant message in Dexie. The in-memory
    // MessageStore.runToMessageId map is gone after the SW restart, so
    // the persisted messageId is the only handle we have. Without this,
    // the draft assistant message stays with no stopReason and the
    // export shows it as silently stalled. Lazy import to avoid a
    // module-load cycle (data-layer ← db ← ...).
    if (rec.messageId) {
      try {
        const { markMessageAbandoned } = await import('@/lib/data-layer');
        await markMessageAbandoned(rec.messageId);
      } catch (err) {
        log.warn('runtime', '[checkpoint-sweep] failed to repair message', {
          runId: rec.runId,
          messageId: rec.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.warn('runtime', '[checkpoint-sweep] marked runId=... as abandoned', {
      runId: rec.runId,
      ageMs: now - rec.startMs,
      wallTimeoutMs: rec.wallTimeoutMs,
    });
  }
  return stale;
}
