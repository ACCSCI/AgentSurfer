// AgentSurferDB — Dexie wrapper for local persistence.
// All chats, steps, screenshots, and model configs live here.
// API keys ARE stored locally; encryption-at-rest can be added later.

import Dexie, { type EntityTable } from 'dexie';
import type {
  AgentStep,
  ChatMessage,
  ChatSession,
  ModelConfig,
  ScreenshotMeta,
  ToolConfig,
} from '@/types';

// ---------- Internal types (Dexie rows) ----------

export interface ScreenshotRow extends ScreenshotMeta {
  blob: Blob;
}

// ---------- Schema ----------

export class AgentSurferDB extends Dexie {
  sessions!: EntityTable<ChatSession, 'id'>;
  messages!: EntityTable<ChatMessage, 'id'>;
  agentSteps!: EntityTable<AgentStep, 'id'>;
  screenshots!: EntityTable<ScreenshotRow, 'id'>;
  modelConfigs!: EntityTable<ModelConfig, 'id'>;
  toolConfigs!: EntityTable<ToolConfig, 'name'>;

  constructor() {
    super('AgentSurferDB');

    // v1 — initial schema.
    this.version(1).stores({
      sessions: 'id, updatedAt, createdAt',
      messages: 'id, sessionId, role, createdAt, [sessionId+createdAt]',
      agentSteps: 'id, messageId, stepNumber, [messageId+stepNumber]',
      screenshots: 'id, stepId, createdAt',
      modelConfigs: 'id, provider, createdAt',
    });

    // v2 — add toolConfigs table.
    this.version(2).stores({
      toolConfigs: 'name',
    });
  }
}

export const db = new AgentSurferDB();

// ---------- ID + timestamp helpers ----------

export const newId = (): string => crypto.randomUUID();
export const now = (): number => Date.now();

// ---------- Session helpers ----------

export async function createSession(title = 'New chat'): Promise<ChatSession> {
  const ts = now();
  const session: ChatSession = {
    id: newId(),
    title,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.sessions.add(session);
  return session;
}

export async function touchSession(sessionId: string): Promise<void> {
  await db.sessions.update(sessionId, { updatedAt: now() });
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await db.sessions.update(sessionId, { title, updatedAt: now() });
}

export async function deleteSession(sessionId: string): Promise<void> {
  // Cascade: delete messages, their steps, and their screenshots.
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
}

// ---------- Message + step helpers ----------

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
  await touchSession(msg.sessionId);
  return msg;
}

export async function appendStep(step: Omit<AgentStep, 'id' | 'createdAt'>): Promise<AgentStep> {
  const row: AgentStep = { id: newId(), createdAt: now(), ...step };
  await db.agentSteps.add(row);
  return row;
}

export async function getMessagesBySession(sessionId: string): Promise<ChatMessage[]> {
  const all = await db.messages.where('sessionId').equals(sessionId).toArray();
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getStepsForMessage(messageId: string): Promise<AgentStep[]> {
  const all = await db.agentSteps.where('messageId').equals(messageId).toArray();
  return all.sort((a, b) => a.stepNumber - b.stepNumber);
}

// ---------- Screenshot helpers ----------

export async function saveScreenshot(
  blob: Blob,
  meta: Omit<ScreenshotMeta, 'id' | 'createdAt' | 'mime' | 'byteSize'>,
): Promise<ScreenshotRow> {
  const row: ScreenshotRow = {
    id: newId(),
    createdAt: now(),
    mime: 'image/png',
    byteSize: blob.size,
    ...meta,
    blob,
  };
  await db.screenshots.add(row);
  return row;
}

export async function getScreenshot(id: string): Promise<ScreenshotRow | undefined> {
  return db.screenshots.get(id);
}

export async function getScreenshotsForStep(stepId: string): Promise<ScreenshotRow[]> {
  return db.screenshots.where('stepId').equals(stepId).toArray();
}

// ---------- Model config helpers ----------

export async function upsertConfig(config: ModelConfig): Promise<void> {
  await db.modelConfigs.put(config);
}

export async function deleteConfig(id: string): Promise<void> {
  await db.modelConfigs.delete(id);
}

export async function listConfigs(): Promise<ModelConfig[]> {
  return db.modelConfigs.orderBy('createdAt').toArray();
}

export async function getActiveConfig(): Promise<ModelConfig | undefined> {
  const all = await listConfigs();
  return all.find((c) => c.isDefault) ?? all[0];
}

export async function setActiveConfig(id: string): Promise<void> {
  await db.transaction('rw', db.modelConfigs, async () => {
    const all = await db.modelConfigs.toArray();
    await Promise.all(
      all.map((c) => db.modelConfigs.update(c.id, { isDefault: c.id === id })),
    );
  });
}

// ---------- Tool config helpers ----------

import { ALL_TOOLS, type ToolName } from '@/types';

// Default: CDP tools + smart screenshot + tabs enabled. Others disabled.
const DEFAULT_ENABLED = new Set([
  'cdpAim', 'cdpConfirm', 'cdpScroll', 'cdpCancel',
  'cdpClick', 'cdpType', 'cdpPressKey', 'cdpScreenshot',
  'smartScreenshot',
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
]);

/** Initialize tool configs with defaults if table is empty. Call once at startup. */
export async function initToolConfigs(): Promise<void> {
  const existing = await db.toolConfigs.toArray();
  if (existing.length >= ALL_TOOLS.length) return;
  const defaults: ToolConfig[] = ALL_TOOLS.map((name) => ({
    name,
    enabled: DEFAULT_ENABLED.has(name),
  }));
  await db.toolConfigs.bulkPut(defaults);
}

/** Read tool configs. Safe to use inside liveQuery (read-only). */
export async function getToolConfigs(): Promise<ToolConfig[]> {
  const existing = await db.toolConfigs.toArray();
  if (existing.length > 0) return existing;
  // Not initialized yet — return defaults without writing.
  return ALL_TOOLS.map((name) => ({ name, enabled: true }));
}

/** Get a set of enabled tool names for quick lookup. */
export async function getEnabledToolNames(): Promise<Set<string>> {
  const configs = await getToolConfigs();
  return new Set(configs.filter((c) => c.enabled).map((c) => c.name));
}

/** Toggle a single tool on/off. */
export async function setToolEnabled(name: string, enabled: boolean): Promise<void> {
  await db.toolConfigs.put({ name, enabled });
}
