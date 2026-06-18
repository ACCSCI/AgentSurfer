// Data Layer — the single source of truth for all Dexie writes.
//
// Architecture rule: ONLY this module (or modules it calls) may write to
// the database. Service Worker, Side Panel, and Options page must go through
// the SW message router to invoke these operations.
//
// All write functions automatically broadcast a 'db:changed' event so
// other contexts can re-query if needed.

import { db, newId, now } from '@/lib/db';
import { log } from '@/lib/logger';
import type {
  AgentStep,
  ChatMessage,
  ChatSession,
  ModelConfig,
  ToolConfig,
} from '@/types';

// ---------- Change notification ----------

/**
 * Per-table queue of in-flight broadcasts. We must serialize the
 * read-modify-write of the counter, otherwise concurrent writers all
 * read the same value and overwrite each other (classic lost-update).
 */
const broadcastQueues = new Map<string, Promise<void>>();

/** Bump a counter in chrome.storage.local to signal a write happened. */
async function broadcastChange(table: string): Promise<void> {
  const prev = broadcastQueues.get(table) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const key = `__db_change_${table}`;
      const cur = (await chrome.storage.local.get(key))[key] as number ?? 0;
      const newCount = cur + 1;
      await chrome.storage.local.set({ [key]: newCount });
      log.debug('data', 'change broadcast', { table, count: newCount });
    } catch (err) {
      log.warn('data', 'broadcast failed', { table, error: err instanceof Error ? err.message : String(err) });
    }
  });
  broadcastQueues.set(table, next);
  return next;
}

/** Public API for forcing a broadcast (used by __e2e:reset to notify UIs). */
export async function notifyChange(table: string): Promise<void> {
  await broadcastChange(table);
}

/** Read the change counter for a table. Used by useLiveQuery to detect writes. */
export async function getChangeCount(table: string): Promise<number> {
  try {
    const key = `__db_change_${table}`;
    return (await chrome.storage.local.get(key))[key] as number ?? 0;
  } catch {
    return 0;
  }
}

// ---------- Session writes ----------

export async function createSession(title = 'New chat'): Promise<ChatSession> {
  const ts = now();
  const session: ChatSession = {
    id: newId(),
    title,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.sessions.add(session);
  await broadcastChange('sessions');
  log.info('data', 'createSession', { sessionId: session.id });
  return session;
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await db.sessions.update(sessionId, { title, updatedAt: now() });
  await broadcastChange('sessions');
  log.info('data', 'renameSession', { sessionId, title });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.sessions, db.messages, db.agentSteps, db.screenshots],
    async () => {
      const messageIds = await db.messages
        .where('sessionId')
        .equals(sessionId)
        .primaryKeys();
      if (messageIds.length > 0) {
        const stepIds = await db.agentSteps
          .where('messageId')
          .anyOf(messageIds as string[])
          .primaryKeys();
        if (stepIds.length > 0) {
          await db.screenshots.where('stepId').anyOf(stepIds as string[]).delete();
          await db.agentSteps.bulkDelete(stepIds as string[]);
        }
        await db.messages.bulkDelete(messageIds as string[]);
      }
      await db.sessions.delete(sessionId);
    },
  );
  await broadcastChange('sessions');
  await broadcastChange('messages');
  await broadcastChange('agentSteps');
  log.info('data', 'deleteSession', { sessionId });
}

// ---------- Message + step writes ----------

export async function appendMessage(
  partial: Omit<ChatMessage, 'id' | 'createdAt' | 'parts' | 'screenshotIds'> & {
    parts?: ChatMessage['parts'];
    screenshotIds?: string[];
  },
): Promise<ChatMessage> {
  const msg: ChatMessage = {
    id: newId(),
    createdAt: now(),
    parts: partial.parts ?? [],
    screenshotIds: partial.screenshotIds ?? [],
    ...partial,
  };
  await db.messages.add(msg);
  await db.sessions.update(msg.sessionId, { updatedAt: now() });
  await broadcastChange('messages');
  await broadcastChange('sessions');
  log.info('data', 'appendMessage', { messageId: msg.id, sessionId: msg.sessionId, role: msg.role });
  return msg;
}

export async function appendStep(step: Omit<AgentStep, 'id' | 'createdAt'>): Promise<AgentStep> {
  const row: AgentStep = { id: newId(), createdAt: now(), ...step };
  await db.agentSteps.add(row);
  await broadcastChange('agentSteps');
  log.debug('data', 'appendStep', { stepId: row.id, messageId: row.messageId, stepNumber: row.stepNumber });
  return row;
}

// ---------- Screenshot writes ----------

export async function saveScreenshot(
  blob: Blob,
  meta: Omit<import('@/lib/db').ScreenshotRow, 'id' | 'createdAt' | 'mime' | 'byteSize' | 'blob'>,
): Promise<import('@/lib/db').ScreenshotRow> {
  const row = {
    id: newId(),
    createdAt: now(),
    mime: 'image/png' as const,
    byteSize: blob.size,
    ...meta,
    blob,
  };
  await db.screenshots.add(row);
  await broadcastChange('screenshots');
  return row;
}

// ---------- Model config writes ----------

export async function upsertConfig(config: ModelConfig): Promise<void> {
  await db.modelConfigs.put(config);
  await broadcastChange('modelConfigs');
  log.info('data', 'upsertConfig', { configId: config.id, provider: config.provider });
}

export async function deleteConfig(id: string): Promise<void> {
  await db.modelConfigs.delete(id);
  await broadcastChange('modelConfigs');
  log.info('data', 'deleteConfig', { configId: id });
}

export async function setActiveConfig(id: string): Promise<void> {
  await db.transaction('rw', db.modelConfigs, async () => {
    const all = await db.modelConfigs.toArray();
    await Promise.all(
      all.map((c) => db.modelConfigs.update(c.id, { isDefault: c.id === id })),
    );
  });
  await broadcastChange('modelConfigs');
  log.info('data', 'setActiveConfig', { configId: id });
}

/** Update only the maxSteps field of a config. Used by E2E to dial
 *  the loop cap without driving the Options form. Bumps the
 *  modelConfigs change counter so the Options UI re-renders. */
export async function setConfigMaxSteps(id: string, maxSteps: number): Promise<void> {
  await db.modelConfigs.update(id, { maxSteps });
  await broadcastChange('modelConfigs');
  log.info('data', 'setConfigMaxSteps', { configId: id, maxSteps });
}

// ---------- Tool config writes ----------

import { ALL_TOOLS } from '@/types';

const DEFAULT_ENABLED = new Set([
  'cdpAim', 'cdpConfirm', 'cdpScroll', 'cdpCancel',
  'cdpClick', 'cdpType', 'cdpPressKey', 'cdpScreenshot',
  'smartScreenshot',
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
]);

export async function initToolConfigs(): Promise<void> {
  const existing = await db.toolConfigs.toArray();
  if (existing.length >= ALL_TOOLS.length) return;
  const defaults: ToolConfig[] = ALL_TOOLS.map((name) => ({
    name,
    enabled: DEFAULT_ENABLED.has(name),
  }));
  await db.toolConfigs.bulkPut(defaults);
  await broadcastChange('toolConfigs');
  log.info('data', 'initToolConfigs', { count: defaults.length });
}

export async function setToolEnabled(name: string, enabled: boolean): Promise<void> {
  await db.toolConfigs.put({ name, enabled });
  await broadcastChange('toolConfigs');
  log.info('data', 'setToolEnabled', { name, enabled });
}
