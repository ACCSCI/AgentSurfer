// buildHistoryMessages — turn a session's in-memory MessageBuffer list
// into the AI SDK v4 `CoreMessage[]` shape that `streamText({ messages })`
// expects. Pure function. Used by the agent loop to give the LLM the
// prior turns of the conversation instead of only the current prompt.
//
// Excludes:
//   - status === 'draft'         — placeholder assistant message opened
//                                  by MessageStore.beginRun() for the
//                                  current run; its text is being streamed.
//   - status === 'abandoned' | 'error' — terminated runs that we don't
//                                        want to pollute the LLM's view.
//   - the most recent user message whose text === currentPrompt — this
//     is the one that runAgentInner just pushed via addUserMessage(),
//     and the loop appends it as the final user turn on its own.
//
// Conversion rules per message:
//   user      →  { role: 'user',      content: [{type:'text', text}] }
//   assistant →  { role: 'assistant', content: [text?, reasoning?, ...toolCall] }
//   assistant with a toolCall.result !== undefined → followed by a
//     { role: 'tool', content: [{type:'tool-result', toolCallId, toolName,
//       result, isError}] } message (one per completed tool call).
//
// Diagnostic contract: the caller (loop.ts) logs `history loaded` with
// { count, roles, totalChars } right after this returns, so a failed
// test can immediately see what the helper produced.

import type { CoreMessage, TextPart, ToolCallPart, ToolResultPart } from 'ai';
import type { MessageBuffer } from '@/lib/message-store';

const COMPLETED_STATUSES = new Set<MessageBuffer['status']>(['complete']);
// Drafts, abandoned, error are filtered out — see docstring.

interface BuildHistoryInput {
  /** All in-memory messages for the session, in any order. */
  messages: readonly MessageBuffer[];
  /** The current user prompt — used to identify (and skip) the just-added message. */
  currentPrompt: string;
  /** Optional max message count. Default 50 (defensive against runaway growth). */
  maxMessages?: number;
}

export interface BuildHistoryResult {
  /** The CoreMessage list to pass to streamText({ messages }). */
  messages: CoreMessage[];
  /** How many of the input messages were dropped (draft / abandoned / dedupe). */
  dropped: number;
  /** Sum of text length across all produced messages — token-cost smoke test. */
  totalChars: number;
}

export function buildHistoryMessages(input: BuildHistoryInput): BuildHistoryResult {
  const { messages, currentPrompt } = input;
  const maxMessages = input.maxMessages ?? 50;

  // 1. Filter to complete messages only (skip drafts, abandoned, error).
  const complete = messages.filter((m) => COMPLETED_STATUSES.has(m.status));

  // 2. Sort ascending by createdAt. Stable enough; if two share a
  //    millisecond we fall back to messageId so the order is deterministic.
  const sorted = [...complete].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.messageId.localeCompare(b.messageId);
  });

  // 3. Drop the most recent user message whose text === currentPrompt.
  //    Walk in reverse so we never accidentally drop an earlier turn
  //    that happened to use the same text (e.g. user re-sends "hi").
  let droppedCurrent = false;
  const dedup: MessageBuffer[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i];
    if (
      !droppedCurrent &&
      m.role === 'user' &&
      m.text === currentPrompt
    ) {
      droppedCurrent = true;
      continue;
    }
    dedup.unshift(m);
  }

  // 4. Truncate to maxMessages from the back (keep the most recent N).
  //    Older turns are dropped first — they're least relevant to the
  //    current turn. (Could later become a token-budget-based trim.)
  const truncated =
    dedup.length > maxMessages ? dedup.slice(dedup.length - maxMessages) : dedup;

  // 5. Convert to CoreMessage.
  const out: CoreMessage[] = [];
  let totalChars = 0;
  for (const m of truncated) {
    const core = bufferToCore(m);
    if (core === null) continue;
    out.push(core);
    totalChars += countChars(core);
    // If the assistant message had completed tool calls, follow with a
    // role:'tool' message for each (AI SDK v4 expects them separately).
    if (m.role === 'assistant') {
      for (const tc of m.toolCalls) {
        if (tc.status === 'pending') continue;
        const tr: ToolResultPart = {
          type: 'tool-result',
          toolCallId: tc.id,
          toolName: tc.name,
          result: tc.result,
          isError: tc.status === 'error',
        };
        const toolMsg: CoreMessage = { role: 'tool', content: [tr] };
        out.push(toolMsg);
        totalChars += countChars(toolMsg);
      }
    }
  }

  return {
    messages: out,
    dropped: messages.length - truncated.length,
    totalChars,
  };
}

function bufferToCore(m: MessageBuffer): CoreMessage | null {
  if (m.role === 'user') {
    if (!m.text) return null;
    const part: TextPart = { type: 'text', text: m.text };
    return { role: 'user', content: [part] };
  }
  // role === 'assistant' (message-store normalizes tool/system → assistant,
  // and we only carry user + assistant through the buffer).
  if (m.role !== 'assistant') return null;
  const content: Array<TextPart | ToolCallPart | { type: 'reasoning'; text: string }> = [];
  if (m.text) content.push({ type: 'text', text: m.text });
  if (m.reasoning) content.push({ type: 'reasoning', text: m.reasoning });
  for (const tc of m.toolCalls) {
    const part: ToolCallPart = {
      type: 'tool-call',
      toolCallId: tc.id,
      toolName: tc.name,
      args: tc.args as ToolCallPart['args'],
    };
    content.push(part);
  }
  if (content.length === 0) return null;
  return { role: 'assistant', content };
}

function countChars(msg: CoreMessage): number {
  const c = msg.content;
  if (typeof c === 'string') return c.length;
  let n = 0;
  for (const p of c) {
    if (p.type === 'text' && typeof p.text === 'string') n += p.text.length;
    else if (p.type === 'reasoning' && typeof (p as { text?: string }).text === 'string') {
      n += (p as { text: string }).text.length;
    } else if (p.type === 'tool-call') {
      n += JSON.stringify(p.args ?? {}).length + (p.toolName?.length ?? 0);
    } else if (p.type === 'tool-result') {
      n += JSON.stringify(p.result ?? null).length + (p.toolName?.length ?? 0);
    }
  }
  return n;
}
