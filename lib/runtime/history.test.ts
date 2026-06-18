// Unit tests for buildHistoryMessages — pure function, no SW/browser needed.
// Run with: bun test lib/runtime/history.test.ts
//        or: node --test lib/runtime/history.test.ts

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildHistoryMessages } from '@/lib/runtime/history';
import type { MessageBuffer } from '@/lib/message-store';

// ---------- helpers ----------

const SID = 'session-1';
let _idSeq = 0;
function mkMsg(over: Partial<MessageBuffer> & Pick<MessageBuffer, 'role'>): MessageBuffer {
  _idSeq += 1;
  return {
    messageId: `m${_idSeq}`,
    sessionId: SID,
    text: '',
    reasoning: '',
    toolCalls: [],
    status: 'complete',
    createdAt: _idSeq * 1000, // monotonic, easy to reason about
    updatedAt: _idSeq * 1000,
    ...over,
  };
}

// ---------- tests ----------

describe('buildHistoryMessages', () => {
  it('returns [] when the buffer is empty', () => {
    const r = buildHistoryMessages({ messages: [], currentPrompt: 'hi' });
    assert.equal(r.messages.length, 0);
    assert.equal(r.dropped, 0);
    assert.equal(r.totalChars, 0);
  });

  it('returns [user, assistant] for a single completed turn', () => {
    const msgs: MessageBuffer[] = [
      mkMsg({ role: 'user', text: 'hi' }),
      mkMsg({ role: 'assistant', text: 'hello there' }),
    ];
    const r = buildHistoryMessages({ messages: msgs, currentPrompt: 'follow-up' });
    assert.equal(r.messages.length, 2);
    assert.equal(r.messages[0].role, 'user');
    assert.equal(r.messages[1].role, 'assistant');
    if (r.messages[0].role === 'user' && typeof r.messages[0].content !== 'string') {
      assert.equal((r.messages[0].content[0] as { text: string }).text, 'hi');
    }
    if (r.messages[1].role === 'assistant' && typeof r.messages[1].content !== 'string') {
      assert.equal((r.messages[1].content[0] as { text: string }).text, 'hello there');
    }
  });

  it('returns 4 messages for two completed turns in order', () => {
    const msgs: MessageBuffer[] = [
      mkMsg({ role: 'user', text: 'turn1' }),
      mkMsg({ role: 'assistant', text: 'reply1' }),
      mkMsg({ role: 'user', text: 'turn2' }),
      mkMsg({ role: 'assistant', text: 'reply2' }),
    ];
    const r = buildHistoryMessages({ messages: msgs, currentPrompt: 'turn3' });
    assert.equal(r.messages.length, 4);
    assert.deepEqual(
      r.messages.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant'],
    );
  });

  it('drops the just-added user message (matches currentPrompt)', () => {
    const msgs: MessageBuffer[] = [
      mkMsg({ role: 'user', text: 'turn1' }),
      mkMsg({ role: 'assistant', text: 'reply1' }),
      mkMsg({ role: 'user', text: 'turn2' }),
    ];
    const r = buildHistoryMessages({ messages: msgs, currentPrompt: 'turn2' });
    // 2 prior messages + nothing for the dedup'd current.
    assert.equal(r.messages.length, 2);
    assert.equal(r.dropped, 1);
  });

  it('keeps an earlier turn with the same text (walks in reverse)', () => {
    // User sent "hi" twice, this is the second time. We should keep the
    // FIRST "hi" and drop the SECOND.
    const msgs: MessageBuffer[] = [
      mkMsg({ role: 'user', text: 'hi' }),
      mkMsg({ role: 'assistant', text: 'first reply' }),
      mkMsg({ role: 'user', text: 'hi' }), // the just-added one
    ];
    const r = buildHistoryMessages({ messages: msgs, currentPrompt: 'hi' });
    assert.equal(r.messages.length, 2); // [user 'hi', assistant 'first reply']
    assert.equal(r.dropped, 1);
    if (r.messages[0].role === 'user' && typeof r.messages[0].content !== 'string') {
      assert.equal((r.messages[0].content[0] as { text: string }).text, 'hi');
    }
    if (r.messages[1].role === 'assistant' && typeof r.messages[1].content !== 'string') {
      assert.equal((r.messages[1].content[0] as { text: string }).text, 'first reply');
    }
  });

  it('skips draft messages (beginRun placeholder)', () => {
    const msgs: MessageBuffer[] = [
      mkMsg({ role: 'user', text: 'turn1' }),
      mkMsg({ role: 'assistant', text: 'reply1', status: 'complete' }),
      mkMsg({ role: 'assistant', text: 'streaming...', status: 'draft' }),
    ];
    const r = buildHistoryMessages({ messages: msgs, currentPrompt: 'turn2' });
    assert.equal(r.messages.length, 2);
    for (const m of r.messages) {
      if (m.role === 'assistant' && typeof m.content !== 'string') {
        assert.notEqual((m.content[0] as { text: string }).text, 'streaming...');
      }
    }
  });

  it('skips abandoned and error messages', () => {
    const msgs: MessageBuffer[] = [
      mkMsg({ role: 'user', text: 'a' }),
      mkMsg({ role: 'assistant', text: 'cancelled reply', status: 'abandoned' }),
      mkMsg({ role: 'user', text: 'b' }),
      mkMsg({ role: 'assistant', text: 'broken reply', status: 'error' }),
    ];
    const r = buildHistoryMessages({ messages: msgs, currentPrompt: 'c' });
    // Only the user messages survive.
    assert.equal(r.messages.length, 2);
    assert.deepEqual(
      r.messages.map((m) => m.role),
      ['user', 'user'],
    );
  });

  it('splits a completed tool call into assistant + role:tool messages', () => {
    const msgs: MessageBuffer[] = [
      mkMsg({ role: 'user', text: 'look at bing' }),
      mkMsg({
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'c1', name: 'screenshot', args: {}, status: 'complete', result: { ok: true, w: 1280 }, completedAt: 1 },
        ],
      }),
    ];
    const r = buildHistoryMessages({ messages: msgs, currentPrompt: 'now aim' });
    assert.equal(r.messages.length, 3);
    assert.equal(r.messages[0].role, 'user');
    assert.equal(r.messages[1].role, 'assistant');
    assert.equal(r.messages[2].role, 'tool');
    if (r.messages[1].role === 'assistant' && typeof r.messages[1].content !== 'string') {
      const parts = r.messages[1].content;
      assert.equal(parts[0].type, 'tool-call');
      if (parts[0].type === 'tool-call') {
        assert.equal(parts[0].toolCallId, 'c1');
        assert.equal(parts[0].toolName, 'screenshot');
      }
    }
    if (r.messages[2].role === 'tool') {
      const content = r.messages[2].content;
      assert.equal(content[0].type, 'tool-result');
      if (content[0].type === 'tool-result') {
        assert.equal(content[0].toolCallId, 'c1');
        assert.equal(content[0].isError, false);
      }
    }
  });

  it('does NOT emit a role:tool message for pending tool calls', () => {
    const msgs: MessageBuffer[] = [
      mkMsg({ role: 'user', text: 'x' }),
      mkMsg({
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'p1', name: 'screenshot', args: {}, status: 'pending' }],
      }),
    ];
    const r = buildHistoryMessages({ messages: msgs, currentPrompt: 'y' });
    assert.equal(r.messages.length, 2); // user + assistant, no tool msg
  });

  it('marks isError on tool-result when the tool call errored', () => {
    const msgs: MessageBuffer[] = [
      mkMsg({ role: 'user', text: 'x' }),
      mkMsg({
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'e1', name: 'screenshot', args: {}, status: 'error', result: { error: 'boom' }, completedAt: 1 },
        ],
      }),
    ];
    const r = buildHistoryMessages({ messages: msgs, currentPrompt: 'y' });
    assert.equal(r.messages.length, 3);
    if (r.messages[2].role === 'tool') {
      const content = r.messages[2].content;
      if (content[0].type === 'tool-result') {
        assert.equal(content[0].isError, true);
      }
    }
  });

  it('preserves reasoning as a ReasoningPart on assistant messages', () => {
    const msgs: MessageBuffer[] = [
      mkMsg({ role: 'user', text: 'hi' }),
      mkMsg({ role: 'assistant', text: 'reply', reasoning: 'because reasons' }),
    ];
    const r = buildHistoryMessages({ messages: msgs, currentPrompt: 'x' });
    assert.equal(r.messages.length, 2);
    if (r.messages[1].role === 'assistant' && typeof r.messages[1].content !== 'string') {
      const parts = r.messages[1].content;
      assert.equal(parts[0].type, 'text');
      assert.equal(parts[1].type, 'reasoning');
      if (parts[1].type === 'reasoning') {
        assert.equal(parts[1].text, 'because reasons');
      }
    }
  });

  it('orders messages by createdAt ascending (stable tiebreaker)', () => {
    // All three share createdAt — should fall back to messageId order.
    const a = { ...mkMsg({ role: 'user', text: 'A' }), createdAt: 100 };
    const b = { ...mkMsg({ role: 'assistant', text: 'B' }), createdAt: 100 };
    const c = { ...mkMsg({ role: 'user', text: 'C' }), createdAt: 100 };
    const r = buildHistoryMessages({ messages: [a, c, b], currentPrompt: 'x' });
    // Expected order by messageId: a < b < c.
    assert.equal(r.messages.length, 3);
    if (r.messages[0].role === 'user' && typeof r.messages[0].content !== 'string') {
      assert.equal((r.messages[0].content[0] as { text: string }).text, 'A');
    }
  });

  it('truncates to maxMessages (oldest dropped first)', () => {
    const msgs: MessageBuffer[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(mkMsg({ role: 'user', text: `u${i}` }));
      msgs.push(mkMsg({ role: 'assistant', text: `a${i}` }));
    }
    const r = buildHistoryMessages({
      messages: msgs,
      currentPrompt: 'now',
      maxMessages: 4,
    });
    assert.equal(r.messages.length, 4);
    // 20 messages total, no currentPrompt match, keep the LAST 4.
    // Oldest (u0..a7) dropped → kept: u8, a8, u9, a9.
    if (r.messages[0].role === 'user' && typeof r.messages[0].content !== 'string') {
      assert.equal((r.messages[0].content[0] as { text: string }).text, 'u8');
    }
    if (r.messages[3].role === 'assistant' && typeof r.messages[3].content !== 'string') {
      assert.equal((r.messages[3].content[0] as { text: string }).text, 'a9');
    }
  });
});
