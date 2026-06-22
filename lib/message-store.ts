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
import type { ChatMessage, MessagePart, StopReason } from '@/types';

export type MessageStatus = 'draft' | 'complete' | 'abandoned' | 'error';

export interface ToolCallBuffer {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: 'pending' | 'complete' | 'error';
  completedAt?: number;
}

/**
 * An ordered slice of an assistant message. A single agent run is made
 * of many interleaved reasoning/text/tool segments (think → call tool →
 * think → call tool → answer). Rendering them in arrival order is what
 * lets the UI show the model's actual chain of thought instead of
 * collapsing everything into "one block of text on top, all tool calls
 * at the bottom". See MessageBubble.tsx.
 */
export type MessageSegment =
  | { kind: 'reasoning'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'tool'; toolCallId: string };

export interface MessageBuffer {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string;
  toolCalls: ToolCallBuffer[];
  /** Interleaved, time-ordered view of this message. The flat
   *  `text` / `reasoning` / `toolCalls` fields above are kept for
   *  persistence + history reconstruction; `segments` is what the UI
   *  renders so the chain of thought stays in order. */
  segments: MessageSegment[];
  status: MessageStatus;
  errorMessage?: string;
  /** Raw AI SDK finishReason of the final step (e.g. 'stop', 'length',
   *  'tool-calls'). Set on terminal transitions. Persisted for bug reports. */
  finishReason?: string;
  /** Normalized business-level stop reason (Rule #9). Persisted for bug
   *  reports so "task complete" can be told apart from "hit max steps". */
  stopReason?: StopReason;
  /** Transient parser cursor: true while a StepFun <think>…</think> block
   *  spans across text-delta chunks. Not persisted. */
  _inThink?: boolean;
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
   *
   * IMPORTANT: if `sessionId` matches the already-loaded session, this
   * is a NO-OP reset — we just push a fresh notify. The side panel
   * reconnects with the same sessionId after every port drop; doing
   * a full reset+rehydrate there risks reading STALE Dexie rows (the
   * previous run's markComplete may still be flushing). The in-memory
   * state is always authoritative.
   */
  async startSession(sessionId: string): Promise<void> {
    if (this.state.currentSessionId === sessionId && this.state.messages.length > 0) {
      // Same session, already loaded — just push a fresh notify. The
      // side panel will replace its React state with the current truth.
      this.notify();
      return;
    }
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
      segments: [],
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
      segments: [{ kind: 'text', value: prompt }],
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
      // StepFun reasoning is smuggled through the content stream wrapped in
      // <think>…</think> sentinels (see stepfunReasoningFetch in lib/llm.ts).
      // Split the delta into reasoning vs text spans so the chain of thought
      // renders as a reasoning segment instead of inline answer text.
      this.appendTextDelta(msg, chunk.textDelta);
    } else if (chunk.type === 'reasoning' || chunk.type === 'reasoning-delta') {
      const r = chunk.textDelta ?? chunk.text ?? '';
      const value = typeof r === 'string' ? r : '';
      msg.reasoning += value;
      this.appendToSegment(msg, 'reasoning', value);
    } else if (chunk.type === 'tool-call' && chunk.toolCallId && chunk.toolName) {
      msg.toolCalls.push({
        id: chunk.toolCallId,
        name: chunk.toolName,
        args: this.parseArgs(chunk.args),
        status: 'pending',
      });
      msg.segments.push({ kind: 'tool', toolCallId: chunk.toolCallId });
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
   * Append a content-channel text delta, splitting out any StepFun
   * <think>…</think> reasoning sentinels (see stepfunReasoningFetch in
   * lib/llm.ts) into a `reasoning` segment. `msg._inThink` tracks whether a
   * think block spans across deltas. Plain text (no sentinels) is appended
   * as-is, so non-StepFun providers are unaffected.
   */
  private appendTextDelta(msg: MessageBuffer, delta: string): void {
    let rest = delta;
    while (rest.length > 0) {
      if (msg._inThink) {
        const close = rest.indexOf('</think>');
        if (close === -1) {
          msg.reasoning += rest;
          this.appendToSegment(msg, 'reasoning', rest);
          rest = '';
        } else {
          const piece = rest.slice(0, close);
          msg.reasoning += piece;
          this.appendToSegment(msg, 'reasoning', piece);
          msg._inThink = false;
          rest = rest.slice(close + '</think>'.length);
        }
      } else {
        const open = rest.indexOf('<think>');
        if (open === -1) {
          msg.text += rest;
          this.appendToSegment(msg, 'text', rest);
          rest = '';
        } else {
          const piece = rest.slice(0, open);
          if (piece) {
            msg.text += piece;
            this.appendToSegment(msg, 'text', piece);
          }
          msg._inThink = true;
          rest = rest.slice(open + '<think>'.length);
        }
      }
    }
  }

  /**
   * Append a text/reasoning delta to the message's ordered segment list.
   * If the last segment is the same kind it grows in place (so a run of
   * deltas stays one segment); otherwise a new segment is started. This
   * preserves the chronological interleaving of think/answer/tool so the
   * UI can render the model's actual chain of thought in order.
   */
  private appendToSegment(msg: MessageBuffer, kind: 'reasoning' | 'text', value: string): void {
    if (!value) return;
    const last = msg.segments[msg.segments.length - 1];
    if (last && last.kind === kind) {
      last.value += value;
    } else {
      msg.segments.push({ kind, value });
    }
  }

  /**
   * (we don't want a 'complete' status to be sitting in the debounce
   * window if the user reloads).
   */
  markComplete(runId: string, finish?: { finishReason?: string; stopReason?: StopReason }): void {
    const messageId = this.state.runToMessageId.get(runId);
    if (!messageId) return;
    const msg = this.findMessage(messageId);
    if (!msg) return;
    msg.status = 'complete';
    if (finish?.finishReason) msg.finishReason = finish.finishReason;
    if (finish?.stopReason) msg.stopReason = finish.stopReason;
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
    msg.stopReason = 'errored';
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
    msg.stopReason = 'cancelled';
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

  /**
   * True if the runId has a live message mapping that hasn't been
   * terminated yet. Used by runAgentInner's safety-net finally to
   * detect runs whose onFinish never fired (and therefore still have
   * a 'draft' message that would leave the side panel showing
   * "Agent is running…" forever).
   */
  hasLiveRun(runId: string): boolean {
    return this.state.runToMessageId.has(runId);
  }

  /**
   * Return the draft/assistant messageId for a live run, or undefined
   * if the run has no mapping (not started or already ended). Used by
   * the loop's onStepFinish to link persisted steps to their message
   * (the appendStep messageId:"" bug).
   */
  messageIdForRun(runId: string): string | undefined {
    return this.state.runToMessageId.get(runId);
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
    // IMPORTANT: must return a NEW messages array reference every time,
    // even if the underlying MessageBuffer objects are mutated in place.
    // The side panel's useState/setState uses Object.is to decide whether
    // to re-render; returning the same array reference would skip the
    // re-render and leave the UI stuck on stale status (e.g. the "Agent
    // is running…" banner persisting after the run actually ended).
    return {
      currentSessionId: this.state.currentSessionId,
      messages: [...this.state.messages],
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
          finishReason: msg.finishReason,
          stopReason: msg.stopReason,
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
    // Walk the ordered segments so persisted parts keep the same
    // chronological interleaving the UI shows. Fall back to the flat
    // fields for messages that have no segments (e.g. older hydrated rows).
    if (msg.segments.length > 0) {
      for (const seg of msg.segments) {
        if (seg.kind === 'text') {
          if (seg.value) parts.push({ type: 'text', text: seg.value });
        } else if (seg.kind === 'reasoning') {
          if (seg.value) parts.push({ type: 'reasoning', reasoning: seg.value });
        } else {
          const tc = msg.toolCalls.find((t) => t.id === seg.toolCallId);
          if (!tc) continue;
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
      }
      return parts;
    }
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
  const parts = p.parts ?? [];
  return {
    messageId: p.id,
    sessionId: p.sessionId,
    role: p.role === 'tool' || p.role === 'system' ? 'assistant' : p.role,
    text: extractText(parts),
    reasoning: extractReasoning(parts),
    toolCalls: extractToolCalls(parts),
    segments: extractSegments(parts),
    status: (p.status ?? 'complete') as MessageStatus,
    errorMessage: undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt ?? p.createdAt,
  };
}

/**
 * Rebuild the ordered segment list from persisted parts so a hydrated
 * (page-reload) message renders with the same chronological interleaving
 * as it did live. tool-result parts are folded into their tool-call's
 * existing segment (they share a toolCallId), so they don't create a
 * separate segment.
 */
function extractSegments(parts: MessagePart[]): MessageSegment[] {
  const segments: MessageSegment[] = [];
  for (const p of parts) {
    if (p.type === 'text' && typeof p.text === 'string' && p.text) {
      segments.push({ kind: 'text', value: p.text });
    } else if (p.type === 'reasoning' && typeof p.reasoning === 'string' && p.reasoning) {
      segments.push({ kind: 'reasoning', value: p.reasoning });
    } else if (p.type === 'tool-call' && p.toolCall) {
      segments.push({ kind: 'tool', toolCallId: p.toolCall.id });
    }
  }
  return segments;
}

// Singleton — there's only one MessageStore per SW process.
export const messageStore = new MessageStore();
