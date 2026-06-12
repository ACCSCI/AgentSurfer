// Service worker: opens the side panel on action click, routes messages, and
// runs the agent loop. State is NEVER stored in module-level variables —
// always chrome.storage or Dexie.

import { runAgent } from '@/lib/agent';
import { db, getActiveConfig, initToolConfigs, setActiveConfig, upsertConfig } from '@/lib/db';
import type { ModelConfig } from '@/types';
import type { StepUpdate } from '@/types/messages';

export default defineBackground(() => {
  // Initialize tool configs with defaults on first load.
  initToolConfigs().catch(() => {});

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
  const chunkBuf = new Map<string, unknown[]>();

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
  | { type: 'agent:list' }
  | { type: '__e2e:seed-config'; config: ModelConfig }
  | { type: '__e2e:reset' };

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
        const tagged = { ...(msg as Record<string, unknown>), __fromSW: true };
        const m = tagged as { type?: string; chunk?: unknown; runId?: string };
        if (m.type === 'agent:chunk' && m.runId) {
          const buf = chunkBuf.get(m.runId) ?? [];
          if (m.chunk) buf.push(m.chunk);
          chunkBuf.set(m.runId, buf);
        } else {
          try { chrome.runtime.sendMessage(tagged, () => {}); } catch {}
        }
      };
      const log = (...args: unknown[]) => {
        const line = `[SW ${runId}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
        console.log(line);
        broadcast({ type: '__sw:log', line });
      };
      // also forward console.log from agent.ts to the test runner
      const origConsoleLog = console.log;
      const origConsoleError = console.error;
      console.log = (...args: unknown[]) => {
        origConsoleLog(...args);
        broadcast({ type: '__sw:log', line: '[AgentSurfer] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
      };
      console.error = (...args: unknown[]) => {
        origConsoleError(...args);
        broadcast({ type: '__sw:log', line: '[AgentSurfer][err] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
      };

      log('agent:start', { sessionId, promptPreview: prompt.slice(0, 80), provider: config.provider, modelId: config.modelId });

      // Run async; resolve the message once the agent is started so the UI
      // can show the "running" state. The agent itself keeps running.
      runAgent({
        sessionId,
        prompt,
        config,
        abortSignal: ac.signal,
        onStep: (step: StepUpdate) => {
          log('agent:step', step.stepNumber, 'toolCalls=' + step.toolCalls.length, 'toolResults=' + step.toolResults.length);
          broadcast({ type: 'agent:step', runId, step });
        },
        onChunk: (chunk) => {
          const c = chunk as { type: string };
          if (c.type === 'text-delta' || c.type === 'reasoning' || c.type === 'reasoning-delta') {
            log('agent:chunk', c.type, JSON.stringify((chunk as { textDelta?: string }).textDelta));
          } else if (c.type === 'tool-call' || c.type === 'tool-call-delta') {
            const tc = chunk as { toolName?: string; toolCallId?: string; argsTextDelta?: string };
            log('agent:chunk', c.type, tc.toolName, tc.toolCallId, JSON.stringify(tc.argsTextDelta));
          } else {
            log('agent:chunk', c.type);
          }
          broadcast({ type: 'agent:chunk', runId, chunk });
        },
        onError: (err) => {
          log('agent:error', err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
          broadcast({ type: 'agent:error', runId, message: err.message });
          inflight.delete(runId);
        },
        onDone: (info) => {
          log('agent:done', info);
          broadcast({ type: 'agent:done', runId, totalUsage: info.totalUsage });
          inflight.delete(runId);
        },
      }).catch((err) => {
        log('agent:caught', err instanceof Error ? err.message : String(err));
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

    case '__chunks:pull': {
      const runId = (message as { runId: string }).runId;
      const buf = chunkBuf.get(runId);
      if (!buf) return { chunks: [] };
      const chunks = buf.splice(0, buf.length);
      // Clean up only when: (a) no chunks left AND (b) run is done.
      if (chunks.length === 0 && !inflight.has(runId)) {
        chunkBuf.delete(runId);
      }
      return { chunks };
    }

    case 'agent:list': {
      // For debugging — list recent sessions.
      const recent = await db.sessions.orderBy('updatedAt').reverse().limit(10).toArray();
      return { sessions: recent };
    }

    case '__e2e:seed-config': {
      // E2E-only: write a config straight to Dexie. Caller is expected to
      // have authenticated this request somehow (test launcher only).
      await upsertConfig(message.config);
      await setActiveConfig(message.config.id);
      return { ok: true, seeded: message.config.id };
    }

    case '__e2e:reset': {
      // E2E-only: wipe the Dexie database. Used between tests for isolation.
      await db.delete();
      // Re-open the connection so subsequent calls don't fail.
      await db.open();
      return { ok: true };
    }

    default: {
      throw new Error(`Unknown message type: ${(message as { type: string }).type}`);
    }
  }
}
