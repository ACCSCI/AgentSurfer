// Quick session export — dumps the full conversation (user + assistant
// messages, every agent step with its tool calls + tool results, plus
// screenshot metadata) to a JSON file. Intended for bug reports: when
// something goes wrong, hit "Export" and attach the file.
//
// This is a READ-ONLY operation. Per the architecture rules (§3.1) the
// side panel may read directly from Dexie via the db.* helpers — it just
// must never write. Export only reads, so it's safe to run here without
// a SW round-trip.

import { db, getMessagesBySession, getStepsForMessage } from '@/lib/db';
import type { AgentStep, ChatMessage, ChatSession, StopReason } from '@/types';

export interface ExportedScreenshot {
  id: string;
  stepId: string | null;
  width: number;
  height: number;
  mime: string;
  byteSize: number;
  createdAt: number;
}

export interface ExportedMessage extends ChatMessage {
  steps: AgentStep[];
}

export interface SessionExport {
  exportedAt: number;
  schemaVersion: 2;
  session: ChatSession;
  messageCount: number;
  stepCount: number;
  // Why the most recent assistant run stopped — the normalized stopReason
  // (Rule #9) and the raw AI SDK finishReason of its final step. Lets a bug
  // report distinguish "task complete" from "hit max steps" / cancel / error
  // at a glance, without digging through the per-message fields.
  terminationReason: StopReason | null;
  finishReason: string | null;
  // The persisted status of the most recent assistant message ('draft',
  // 'streaming', 'complete', 'error', 'abandoned'). When this is 'draft'
  // or 'streaming' with a null terminationReason, the run was orphaned —
  // the SW was killed mid-run and the loop's onFinish/onError never ran.
  // This is the signal that distinguishes "silently stalled" from a
  // clean termination.
  lastAssistantStatus: string | null;
  messages: ExportedMessage[];
  screenshots: ExportedScreenshot[];
}

/** Build a complete, serializable snapshot of one session. */
export async function buildSessionExport(sessionId: string): Promise<SessionExport> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const messages = await getMessagesBySession(sessionId);

  // Attach the agent steps to each assistant message.
  const enriched: ExportedMessage[] = [];
  const screenshotIds = new Set<string>();
  let stepCount = 0;
  for (const msg of messages) {
    const steps = await getStepsForMessage(msg.id);
    stepCount += steps.length;
    for (const id of msg.screenshotIds ?? []) screenshotIds.add(id);
    enriched.push({ ...msg, steps });
  }

  // Pull screenshot metadata (NOT the blobs — keep the export text-sized).
  const screenshots: ExportedScreenshot[] = [];
  for (const id of screenshotIds) {
    const row = await db.screenshots.get(id);
    if (!row) continue;
    screenshots.push({
      id: row.id,
      stepId: row.stepId,
      width: row.width,
      height: row.height,
      mime: row.mime,
      byteSize: row.byteSize,
      createdAt: row.createdAt,
    });
  }

  // Surface the most recent assistant run's termination reason at the top
  // level. Use the ACTUAL last assistant message — NOT the last one that
  // happens to carry a reason. The previous logic walked backwards to the
  // first assistant with a stopReason||finishReason, which silently skipped
  // an orphaned final message (SW killed mid-run → no reason written) and
  // reported the PREVIOUS turn's reason instead. That made a stalled run
  // look like it completed. lastAssistantStatus exposes the orphan: a
  // 'draft'/'streaming' status with a null terminationReason means the run
  // never terminated cleanly.
  const lastAssistant = [...enriched]
    .reverse()
    .find((m) => m.role === 'assistant');

  return {
    exportedAt: Date.now(),
    schemaVersion: 2,
    session,
    messageCount: messages.length,
    stepCount,
    terminationReason: lastAssistant?.stopReason ?? null,
    finishReason: lastAssistant?.finishReason ?? null,
    lastAssistantStatus: lastAssistant?.status ?? null,
    messages: enriched,
    screenshots,
  };
}

/** Trigger a browser download of the session export as a JSON file. */
export async function downloadSessionExport(sessionId: string): Promise<void> {
  const data = await buildSessionExport(sessionId);
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const slug = (data.session.title || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'session';
  const stamp = new Date(data.exportedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const a = document.createElement('a');
  a.href = url;
  a.download = `agentsurfer-${slug}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
