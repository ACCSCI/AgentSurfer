// useMessageStore — side-panel hook that subscribes to the MessageStore
// running inside the Service Worker. The store pushes a full snapshot on
// connect and an update on every state change. This hook is the SINGLE
// source of truth for the chat thread — Dexie is not queried for
// message bodies during streaming.
//
// See design doc §"MessageStore 推荐数据流图".

import { useEffect, useRef, useState, useCallback } from 'react';
import type { MessageStoreState, MessageBuffer } from '@/lib/message-store';

const EMPTY_STATE: MessageStoreState = {
  currentSessionId: null,
  messages: [] as MessageBuffer[],
  lastChunkAt: null,
  runToMessageId: new Map(),
};

type PortCommand =
  | { type: 'select_session'; sessionId: string }
  | { type: 'send'; sessionId: string; prompt: string }
  | { type: 'cancel'; runId: string };

export function useMessageStore(): {
  state: MessageStoreState;
  selectSession: (sessionId: string) => void;
  send: (sessionId: string, prompt: string) => Promise<{ started: boolean; runId: string }>;
  cancel: (runId: string) => Promise<{ cancelled: boolean; reason?: string }>;
} {
  const [state, setState] = useState<MessageStoreState>(EMPTY_STATE);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    // Use a closure-captured port to avoid race where onMessage fires
    // before React re-renders. The ref is for imperative use only.
    let cancelled = false;
    const port = chrome.runtime.connect({ name: 'msgstore' });
    portRef.current = port;
    let updateCount = 0;
    let lastTextLength = 0;
    port.onMessage.addListener((msg: unknown) => {
      if (cancelled) return;
      const m = msg as { type?: string; state?: MessageStoreState };
      if ((m.type === '__msgstore:snapshot' || m.type === '__msgstore:update') && m.state) {
        // Shallow replace. MessageBuffers are mutated in-place by the SW,
        // but React only needs a new messages array reference to re-render.
        setState(m.state);
        // Log every update so E2E tests can count them and prove the
        // MessageStore → port → React pipeline is alive and chunked.
        // Cheap to compute, easy to grep in .e2e-logs/sw.log.
        if (typeof window !== 'undefined') {
          updateCount += 1;
          const lastMsg = m.state.messages[m.state.messages.length - 1];
          const tl = lastMsg?.text?.length ?? 0;
          const rl = lastMsg?.reasoning?.length ?? 0;
          if (tl !== lastTextLength) {
            lastTextLength = tl;
            console.log(`[AgentSurfer][msgstore] update #${updateCount} textLen=${tl} reasoningLen=${rl} status=${lastMsg?.status ?? '?'}`);
          }
        }
      }
    });
    return () => {
      cancelled = true;
      port.disconnect();
      portRef.current = null;
    };
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    const port = portRef.current;
    if (!port) return;
    const cmd: PortCommand = { type: 'select_session', sessionId };
    port.postMessage(cmd);
  }, []);

  const send = useCallback(async (sessionId: string, prompt: string) => {
    const port = portRef.current;
    if (!port) throw new Error('msgstore port not connected');
    const cmd: PortCommand = { type: 'send', sessionId, prompt };
    return new Promise<{ started: boolean; runId: string }>((resolve, reject) => {
      const onMsg = (msg: unknown) => {
        const m = msg as { ok?: boolean; data?: { started: boolean; runId: string }; error?: string };
        if (!m || typeof m !== 'object') return;
        if (m.ok && m.data) {
          port.onMessage.removeListener(onMsg);
          resolve(m.data);
        } else if (m.ok === false) {
          port.onMessage.removeListener(onMsg);
          reject(new Error(m.error ?? 'send failed'));
        }
      };
      port.onMessage.addListener(onMsg);
      port.postMessage(cmd);
    });
  }, []);

  const cancel = useCallback(async (runId: string) => {
    const port = portRef.current;
    if (!port) throw new Error('msgstore port not connected');
    const cmd: PortCommand = { type: 'cancel', runId };
    return new Promise<{ cancelled: boolean; reason?: string }>((resolve, reject) => {
      const onMsg = (msg: unknown) => {
        const m = msg as { ok?: boolean; data?: { cancelled: boolean; reason?: string }; error?: string };
        if (!m || typeof m !== 'object') return;
        if (m.ok && m.data) {
          port.onMessage.removeListener(onMsg);
          resolve(m.data);
        } else if (m.ok === false) {
          port.onMessage.removeListener(onMsg);
          reject(new Error(m.error ?? 'cancel failed'));
        }
      };
      port.onMessage.addListener(onMsg);
      port.postMessage(cmd);
    });
  }, []);

  return { state, selectSession, send, cancel };
}
