// Service worker: opens the side panel on action click, routes messages, and
// runs the agent loop. State is NEVER stored in module-level variables —
// always chrome.storage or Dexie.

import { runAgent } from '@/lib/agent';
import { db, getActiveConfig } from '@/lib/db';
import type { StepUpdate } from '@/types/messages';

export default defineBackground(() => {
  // Open side panel when the user clicks the action icon.
  // chrome.action.onClicked ONLY fires when there is no default_popup.
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab.windowId == null) return;
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (err) {
      console.error('[AgentSurfer] Failed to open side panel', err);
    }
  });

  // Map of runId -> AbortController. Persisted to chrome.storage.session so
  // a service-worker restart doesn't lose the in-flight run.
  const inflight = new Map<string, AbortController>();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        const result = await handleMessage(message, sender, inflight);
        sendResponse({ ok: true, data: result });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return true; // keep channel open for async response
  });
});

type IncomingMessage =
  | { type: 'agent:start'; payload: { runId: string; sessionId: string; prompt: string } }
  | { type: 'agent:cancel'; runId: string }
  | { type: 'screenshot:capture' }
  | { type: 'agent:list' };

async function handleMessage(
  message: IncomingMessage,
  _sender: chrome.runtime.MessageSender,
  inflight: Map<string, AbortController>,
): Promise<unknown> {
  switch (message.type) {
    case 'screenshot:capture': {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || tab.windowId == null) throw new Error('No active tab');
      if (tab.url && !tab.url.startsWith('http')) {
        throw new Error('Cannot capture non-http URL');
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { dataUrl, width: tab.width ?? 0, height: tab.height ?? 0 };
    }

    case 'agent:start': {
      const { runId, sessionId, prompt } = message.payload;
      if (inflight.has(runId)) throw new Error(`Run ${runId} already in flight`);
      const config = await getActiveConfig();
      if (!config) throw new Error('No active model config — set one in the options page');

      const ac = new AbortController();
      inflight.set(runId, ac);

      // Fan-out helper: send a step update to any open extension page.
      const broadcast = (msg: unknown) => {
        chrome.runtime.sendMessage(msg).catch(() => {
          // No listeners (side panel closed) — safe to ignore.
        });
      };

      // Run async; resolve the message once the agent is started so the UI
      // can show the "running" state. The agent itself keeps running.
      runAgent({
        sessionId,
        prompt,
        config,
        abortSignal: ac.signal,
        onStep: (step: StepUpdate) => {
          broadcast({ type: 'agent:step', runId, step });
        },
        onError: (err) => {
          broadcast({ type: 'agent:error', runId, message: err.message });
          inflight.delete(runId);
        },
        onDone: (info) => {
          broadcast({ type: 'agent:done', runId, totalUsage: info.totalUsage });
          inflight.delete(runId);
        },
      }).catch((err) => {
        broadcast({
          type: 'agent:error',
          runId,
          message: err instanceof Error ? err.message : String(err),
        });
        inflight.delete(runId);
      });

      return { started: true, runId };
    }

    case 'agent:cancel': {
      const ac = inflight.get(message.runId);
      if (ac) {
        ac.abort();
        inflight.delete(message.runId);
        return { cancelled: true };
      }
      return { cancelled: false, reason: 'no-such-run' };
    }

    case 'agent:list': {
      // For debugging — list recent sessions.
      const recent = await db.sessions.orderBy('updatedAt').reverse().limit(10).toArray();
      return { sessions: recent };
    }

    default: {
      throw new Error(`Unknown message type: ${(message as { type: string }).type}`);
    }
  }
}
