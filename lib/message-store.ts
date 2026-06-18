// MessageStore — single source of truth for chat messages.
//
// Lives in the Service Worker as a singleton. Owns the in-memory
// MessageBuffer[]. Side panel subscribes via a port and gets snapshot
// + updates. Dexie is purely a persistence layer (incremental writes
// from this store, reads for hydration on mount/session-change).
//
// Architecture docs: docs/diagnostics/aim-crosshair-bug.md and the
// design review preceding the dpr-extraction commit (8868c52).
// See design section "MessageStore 推荐数据流图".

import { db } from '@/lib/db';
import { log } from '@/lib/logger';
import type { ChatMessage, MessagePart } from '@/types';

export type MessageStatus = 'draft' | 'complete' | 'abandoned' | 'error';

export interface ToolCallBuffer {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: 'pending' | 'complete' | 'error';
  completedAt?: number;
}

export interface MessageBuffer {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string;
  toolCalls: ToolCallBuffer[];
  status: MessageStatus;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageStoreState {
  currentSessionId: string | null;
  messages: MessageBuffer[];
  lastChunkAt: number | null;
  // runId → messageId, only valid while a run is in progress
  runToMessageId: Map<string, string>;
}

export interface StreamChunk {
  type: string;
  textDelta?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

interface Subscriber {
  postMessage: (msg: unknown) => void;
}

const FLUSH_DEBOUNCE_MS = 100;
const FLUSH_CHUNK_THRESHOLD = 10;

export class MessageStore {
  private state: MessageStoreState = {
    currentSessionId: null,
    messages: [],
    lastChunkAt: null,
    runToMessageId: new Map(),
  };
  private subscribers: Set<Subscriber> = new Set();
  private flushDirty: Set<string> = new Set();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // ===== Lifecycle (called by background.ts) =====

  /**
   * Open a session — hydrate from Dexie and reset the run map. Called
   * when the side panel selects a session, or when agent:start comes
   * in for a new run.
   */
  async startSession(sessionId: string): Promise<void> {
    this.state = {
      currentSessionId: sessionId,
      messages: [],
      lastChunkAt: null,
      runToMessageId: new Map(),
    };
    this.flushDirty.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.hydrate(sessionId);
    this.notify();
  }

  /**
   * Begin a new run for an existing session. Allocates a fresh
   * assistant messageId in 'draft' state and associates it with the
   * runId so subsequent appendChunk calls can find it.
   */
  beginRun(sessionId: string, runId: string): string {
    const messageId = crypto.randomUUID();
    this.state.messages.push({
      messageId,
      sessionId,
      role: 'assistant',
      text: '',
      reasoning: '',
      toolCalls: [],
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.state.runToMessageId.set(runId, messageId);
    this.state.lastChunkAt = Date.now();
    this.notify();
    return messageId;
  }

  /**
   * Add the user prompt as the most recent message. Returns its
   * messageId so the side panel can scroll to / focus it.
   */
  addUserMessage(sessionId: string, prompt: string): string {
    const messageId = crypto.randomUUID();
    this.state.messages.push({
      messageId,
      sessionId,
      role: 'user',
      text: prompt,
      reasoning: '',
      toolCalls: [],
      status: 'complete',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.flushDirty.add(messageId);
    this.scheduleFlush();
    this.notify();
    return messageId;
  }

  // ===== LLM event sinks (called by lib/agent.ts) =====

  appendChunk(runId: string, chunk: StreamChunk): void {
    const messageId = this.state.runToMessageId.get(runId);
    if (!messageId) return;
    const msg = this.findMessage(messageId);
    if (!msg) return;

    if (chunk.type === 'text-delta' && typeof chunk.textDelta === 'string') {
      msg.text += chunk.textDelta;
    } else if (chunk.type === 'reasoning' || chunk.type === 'reasoning-delta') {
      const r = chunk.textDelta ?? chunk.text ?? '';
      msg.reasoning += typeof r === 'string' ? r : '';
    } else if (chunk.type === 'tool-call' && chunk.toolCallId && chunk.toolName) {
      msg.toolCalls.push({
        id: chunk.toolCallId,
        name: chunk.toolName,
        args: this.parseArgs(chunk.args),
        status: 'pending',
      });
    } else if (chunk.type === 'tool-result' && chunk.toolCallId) {
      const tc = msg.toolCalls.find((t) => t.id === chunk.toolCallId);
      if (tc) {
        tc.result = chunk.result;
        tc.status = chunk.isError ? 'error' : 'complete';
        tc.completedAt = Date.now();
      }
    }
    msg.updatedAt = Date.now();
    this.state.lastChunkAt = msg.updatedAt;
    this.flushDirty.add(messageId);
    this.scheduleFlush();
    this.notify();
  }

  /**
   * Mark the run's assistant message as 'complete'. Forces a flush
   * (we don't want a 'complete' status to be sitting in the debounce
   * window if the user reloads).
   */
  markComplete(runId: string): void {
    const messageId = this.state.runToMessageId.get(runId);
    if (!messageId) return;
    const msg = this.findMessage(messageId);
    if (!msg) return;
    msg.status = 'complete';
    msg.updatedAt = Date.now();
    this.flushDirty.add(messageId);
    void this.flushNow();
    this.notify();
  }

  markError(runId: string, errorMessage: string): void {
    const messageId = this.state.runToMessageId.get(runId);
    if (!messageId) return;
    const msg = this.findMessage(messageId);
    if (!msg) return;
    msg.status = 'error';
    msg.errorMessage = errorMessage;
    msg.updatedAt = Date.now();
    this.flushDirty.add(messageId);
    void this.flushNow();
    this.notify();
  }

  markAbandoned(runId: string): void {
    const messageId = this.state.runToMessageId.get(runId);
    if (!messageId) return;
    const msg = this.findMessage(messageId);
    if (!msg) return;
    msg.status = 'abandoned';
    msg.updatedAt = Date.now();
    this.flushDirty.add(messageId);
    void this.flushNow();
    this.notify();
  }

  endRun(runId: string): void {
    this.state.runToMessageId.delete(runId);
    void this.flushNow();
    this.notify();
  }

  // ===== Subscription (port-based) =====

  subscribe(sub: Subscriber): void {
    this.subscribers.add(sub);
    // Immediately send a full snapshot so the side panel can render
    // before the next state change.
    try {
      sub.postMessage({ type: '__msgstore:snapshot', state: this.snapshot() });
    } catch {}
  }

  unsubscribe(sub: Subscriber): void {
    this.subscribers.delete(sub);
  }

  getState(): MessageStoreState {
    return this.state;
  }

  // ===== Internals =====

  private findMessage(messageId: string): MessageBuffer | undefined {
    return this.state.messages.find((m) => m.messageId === messageId);
  }

  private snapshot(): MessageStoreState {
    // The side panel only reads `messages` and the runId map (for
    // routing commands). Return a shallow copy so the side panel can't
    // mutate the singleton by accident.
    return {
      currentSessionId: this.state.currentSessionId,
      messages: this.state.messages,
      lastChunkAt: this.state.lastChunkAt,
      runToMessageId: new Map(this.state.runToMessageId),
    };
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const sub of this.subscribers) {
      try {
        sub.postMessage({ type: '__msgstore:update', state: snap });
      } catch {}
    }
  }

  private scheduleFlush(): void {
    if (this.flushDirty.size >= FLUSH_CHUNK_THRESHOLD) {
      void this.flushNow();
      return;
    }
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flushNow(): Promise<void> {
    if (this.flushDirty.size === 0) return;
    const dirty = Array.from(this.flushDirty);
    this.flushDirty.clear();
    for (const id of dirty) {
      const msg = this.findMessage(id);
      if (!msg) continue;
      try {
        const parts = this.buildParts(msg);
        // Upsert (put), not update. The row is never created up front —
        // addUserMessage/beginRun only push to the in-memory buffer and
        // queue a flush. db.messages.update() is a no-op when the row
        // doesn't exist, so nothing was ever persisted. put() creates the
        // row on first flush and overwrites it on subsequent flushes.
        await db.messages.put({
          id: msg.messageId,
          sessionId: msg.sessionId,
          role: msg.role,
          parts,
          screenshotIds: [],
          createdAt: msg.createdAt,
          status: msg.status,
          updatedAt: msg.updatedAt,
        });
      } catch (err) {
        // Re-queue so we retry next flush.
        this.flushDirty.add(id);
        log.error('msgstore', 'MessageStore flush failed', { messageId: id, err: String(err) });
      }
    }
  }

  private buildParts(msg: MessageBuffer): MessagePart[] {
    const parts: MessagePart[] = [];
    if (msg.text) parts.push({ type: 'text', text: msg.text });
    if (msg.reasoning) parts.push({ type: 'reasoning', reasoning: msg.reasoning });
    for (const tc of msg.toolCalls) {
      parts.push({
        type: 'tool-call',
        toolCall: { id: tc.id, name: tc.name, args: tc.args },
      });
      if (tc.status === 'complete' || tc.status === 'error') {
        parts.push({
          type: 'tool-result',
          toolResult: {
            toolCallId: tc.id,
            result: tc.result,
            isError: tc.status === 'error',
          },
        });
      }
    }
    return parts;
  }

  private async hydrate(sessionId: string): Promise<void> {
    try {
      const persisted = await db.messages
        .where('sessionId').equals(sessionId)
        .toArray();
      persisted.sort((a, b) => a.createdAt - b.createdAt);
      for (const p of persisted) {
        this.state.messages.push(persistedToBuffer(p));
      }
    } catch (err) {
      log.error('msgstore', 'MessageStore hydrate failed', { sessionId, err: String(err) });
    }
  }

  private parseArgs(args: unknown): Record<string, unknown> {
    if (!args) return {};
    if (typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
    if (typeof args === 'string') {
      try { return JSON.parse(args); } catch { return { _raw: args }; }
    }
    return {};
  }
}

function extractText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

function extractReasoning(parts: MessagePart[]): string {
  return parts
    .filter((p): p is { type: 'reasoning'; reasoning: string } => p.type === 'reasoning' && typeof p.reasoning === 'string')
    .map((p) => p.reasoning)
    .join('');
}

function extractToolCalls(parts: MessagePart[]): ToolCallBuffer[] {
  const tcs: ToolCallBuffer[] = [];
  for (const p of parts) {
    if (p.type === 'tool-call' && p.toolCall) {
      tcs.push({
        id: p.toolCall.id,
        name: p.toolCall.name,
        args: p.toolCall.args ?? {},
        status: 'pending',
      });
    } else if (p.type === 'tool-result' && p.toolResult) {
      const tc = tcs.find((t) => t.id === p.toolResult?.toolCallId);
      if (tc) {
        tc.result = p.toolResult.result;
        tc.status = p.toolResult.isError ? 'error' : 'complete';
        tc.completedAt = Date.now();
      }
    }
  }
  return tcs;
}

function persistedToBuffer(p: ChatMessage): MessageBuffer {
  return {
    messageId: p.id,
    sessionId: p.sessionId,
    role: p.role === 'tool' || p.role === 'system' ? 'assistant' : p.role,
    text: extractText(p.parts ?? []),
    reasoning: extractReasoning(p.parts ?? []),
    toolCalls: extractToolCalls(p.parts ?? []),
    status: (p.status ?? 'complete') as MessageStatus,
    errorMessage: undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt ?? p.createdAt,
  };
}

// Singleton — there's only one MessageStore per SW process.
export const messageStore = new MessageStore();
