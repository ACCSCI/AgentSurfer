// Service worker: opens the side panel on action click, routes messages, and
// runs the agent loop. State is NEVER stored in module-level variables —
// always chrome.storage or Dexie.

import { runAgent, setWallTimeout } from '@/lib/agent';
import { db, getActiveConfig, initToolConfigs } from '@/lib/db';
import {
  createSession,
  deleteConfig,
  deleteSession,
  setActiveConfig,
  setToolEnabled,
  upsertConfig,
} from '@/lib/data-layer';
import type { ModelConfig } from '@/types';
import type { StepUpdate } from '@/types/messages';

// ---------- Module-level state (allowed: listener registration + runtime maps) ----------

// Map of runId -> AbortController.
const inflight = new Map<string, AbortController>();
// Chunk buffer for __chunks:pull (legacy pull-based delivery).
const chunkBuf = new Map<string, unknown[]>();

// Initialize tool configs with defaults on first load.
// Deferred to first message to avoid blocking SW startup.
let toolConfigsReady = false;
async function ensureToolConfigs() {
  if (!toolConfigsReady) {
    await initToolConfigs();
    toolConfigsReady = true;
  }
}

// ---------- Message routing ----------

type IncomingMessage =
  | { type: 'agent:start'; payload: { runId: string; sessionId: string; prompt: string } }
  | { type: 'agent:cancel'; runId: string }
  | { type: 'screenshot:capture' }
  | { type: 'agent:list' }
  | { type: '__chunks:pull'; runId: string }
  | { type: 'db:create-session' }
  | { type: 'db:set-active-config'; id: string }
  | { type: 'db:upsert-config'; config: ModelConfig }
  | { type: 'db:delete-config'; id: string }
  | { type: 'db:set-tool-enabled'; name: string; enabled: boolean }
  | { type: 'db:delete-session'; id: string }
  | { type: '__e2e:seed-config'; config: ModelConfig }
  | { type: '__e2e:reset' }
  | { type: '__e2e:inspect' }
  | { type: '__e2e:set-wall-timeout'; ms: number }
  | { type: '__e2e:inspect-tabs' }
  | { type: '__e2e:list-agent-steps' }
  | { type: '__e2e:list-messages' }
  | { type: '__e2e:highlight-rect'; tabId: number; x: number; y: number; width: number; height: number; color: string; keepMs?: number }
  | { type: '__e2e:cdp-debug'; tabId: number; x: number; y: number; color: string; size: number };

async function handleMessage(
  message: IncomingMessage,
  _sender: chrome.runtime.MessageSender | null,
): Promise<unknown> {
  await ensureToolConfigs();
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

      // Emit function: raw event → side panel. No buffering. No state.
      const emit = (event: { type: string; [k: string]: unknown }) => {
        const tagged = { ...event, __fromSW: true };
        try { chrome.runtime.sendMessage(tagged, () => {}); } catch {}
      };

      console.log(`[SW] agent:start run=${runId}`);

      // Fire-and-forget. Agent emits events; never returns a result.
      runAgent({
        sessionId,
        prompt,
        config,
        abortSignal: ac.signal,
        abort: () => ac.abort(),
        emit,
      }).catch((err) => {
        console.error('[SW] agent:caught', err);
        emit({ type: 'agent_error', message: err instanceof Error ? err.message : String(err) });
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
      const runId = message.runId;
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

    case 'db:create-session': {
      const session = await createSession();
      return { session };
    }

    case 'db:set-active-config': {
      await setActiveConfig(message.id);
      return { ok: true };
    }

    case 'db:upsert-config': {
      await upsertConfig(message.config);
      return { ok: true };
    }

    case 'db:delete-config': {
      await deleteConfig(message.id);
      return { ok: true };
    }

    case 'db:set-tool-enabled': {
      await setToolEnabled(message.name, message.enabled);
      return { ok: true };
    }

    case 'db:delete-session': {
      await deleteSession(message.id);
      return { ok: true };
    }

    case '__e2e:seed-config': {
      console.log('[SW] __e2e:seed-config received', message.config.id);
      try {
        await upsertConfig(message.config);
        await setActiveConfig(message.config.id);
        console.log('[SW] __e2e:seed-config done');
        return { ok: true, seeded: message.config.id };
      } catch (err) {
        console.error('[SW] __e2e:seed-config error:', err);
        throw err;
      }
    }

    case '__e2e:reset': {
      // E2E-only: wipe the Dexie database. Used between tests for isolation.
      await db.delete();
      // Re-open the connection so subsequent calls don't fail.
      await db.open();
      return { ok: true };
    }

    case '__e2e:inspect': {
      console.log('[SW] __e2e:inspect handler running');
      const configs = await db.modelConfigs.toArray();
      const activeConfig = configs.find((c) => c.isDefault) ?? configs[0] ?? null;
      const sessions = await db.sessions.orderBy('updatedAt').reverse().limit(5).toArray();
      return {
        configs,
        activeConfig,
        sessions,
        toolConfigsReady,
      };
    }

    case '__e2e:set-wall-timeout': {
      // E2E-only: override the wall-clock timeout for long-running tests.
      setWallTimeout(message.ms);
      return { ok: true, ms: message.ms };
    }

    case '__e2e:list-agent-steps': {
      // E2E-only: return every persisted agent step (text + toolCall args +
      // toolResults) so tests can inspect what the LLM actually said / called.
      // agentSteps table doesn't index createdAt (per lib/db.ts schema), so
      // we read all and sort in memory by stepNumber.
      const allSteps = await db.agentSteps.toArray();
      allSteps.sort((a, b) => a.stepNumber - b.stepNumber);
      return { steps: allSteps, count: allSteps.length };
    }

    case '__e2e:list-messages': {
      // E2E-only: return every persisted message (user + assistant) so tests
      // can inspect the full conversation record. Sort in memory because
      // createdAt isn't indexed on every table.
      const allMessages = await db.messages.toArray();
      allMessages.sort((a, b) => a.createdAt - b.createdAt);
      return { messages: allMessages, count: allMessages.length };
    }

    case '__e2e:inspect-tabs': {
      // E2E-only: snapshot of all tabs in this extension's browser. Used
      // by the 22-minimax-bing-task spec to verify the agent opened/closed tabs.
      const allTabs = await chrome.tabs.query({});
      return {
        count: allTabs.length,
        urls: allTabs.map((t) => t.url ?? '').filter(Boolean),
        ids: allTabs
          .map((t) => t.id)
          .filter((id): id is number => id != null),
      };
    }

    case '__e2e:highlight-rect': {
      // E2E-only: draw a big rectangle (RECOMMENDED for visibility tests —
      // anything smaller than ~80×80 is hard to see on HiDPI screenshots).
      // Keeps the highlight on (no hideHighlight) so the user can look.
      // msg: { tabId, x, y, width, height, color, keepMs }
      const { tabId, x, y, width, height, color, keepMs } = message as {
        tabId: number; x: number; y: number; width: number; height: number;
        color: string; keepMs?: number;
      };
      const out: Record<string, unknown> = {};
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        out.attach = { ok: true };
      } catch (err) {
        out.attach = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return out;
      }
      // DOM.enable (required before Overlay.enable per CDP spec).
      try { await chrome.debugger.sendCommand({ tabId }, 'DOM.enable'); } catch {}
      try { await chrome.debugger.sendCommand({ tabId }, 'Overlay.enable'); } catch {}
      // Parse color.
      const parseHex = (s: string): [number, number, number] => {
        const v = parseInt(s.replace('#', ''), 16);
        return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
      };
      const named: Record<string, [number, number, number]> = {
        red: [255, 0, 0], green: [0, 200, 0], blue: [0, 100, 255],
        yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
        white: [255, 255, 255], black: [0, 0, 0], lime: [0, 255, 0],
      };
      const c = (color ?? 'red').toLowerCase();
      const [r, g, b] = c in named ? named[c]! : (c.startsWith('#') ? parseHex(c) : [255, 0, 0]);
      // Clockwise quad: top-left, top-right, bottom-right, bottom-left.
      const quad = [
        x, y,
        x + width, y,
        x + width, y + height,
        x, y + height,
      ];
      out.highlightCall = { quad, color: `${c} (${r},${g},${b})`, x, y, width, height };
      try {
        out.highlightResult = await chrome.debugger.sendCommand({ tabId }, 'Overlay.highlightQuad', {
          quad,
          color: { r, g, b, a: 0.5 },
          outlineColor: { r: 255, g: 255, b: 255, a: 1 },
        });
      } catch (err) {
        out.highlightResult = { error: err instanceof Error ? err.message : String(err) };
      }
      // Take a screenshot for the test to inspect.
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId != null) {
          if (!tab.active) await chrome.tabs.update(tabId, { active: true });
          await new Promise((r) => setTimeout(r, 50));
          out.screenshot = { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) };
        }
      } catch (err) {
        out.screenshot = { error: err instanceof Error ? err.message : String(err) };
      }
      // Hold the highlight for `keepMs` so the user can look.
      if (keepMs && keepMs > 0) {
        await new Promise((r) => setTimeout(r, keepMs));
      }
      return out;
    }

    case '__e2e:cdp-debug': {
      // E2E-only: full diagnostic of the Overlay stack. Outputs:
      //   - chrome.runtime.getManifest().version
      //   - chrome.debugger.getTargets() snapshot
      //   - attach result for the given tabId
      //   - DOM.enable + Overlay.enable return values (errors if any)
      //   - Overlay.highlightQuad exact params + return value
      //   - any Overlay.* events that arrive within 1.5s after highlightQuad
      //   - a chrome.tabs.captureVisibleTab dataUrl so the test can save + view
      // msg: { tabId, x, y, color, size }
      const { tabId, x, y, color, size } = message as { tabId: number; x: number; y: number; color: string; size: number };
      const out: Record<string, unknown> = {
        chromeVersion: (navigator as Navigator & { userAgent: string }).userAgent,
        manifestVersion: chrome.runtime.getManifest().version,
      };
      // chrome.debugger.getTargets is async (callback API).
      out.initialTargets = await new Promise<unknown[]>((resolve) => {
        chrome.debugger.getTargets((targets) => {
          resolve(targets.map((t) => ({ tabId: t.tabId, type: t.type, attached: t.attached })));
        });
      });

      // 1. attach
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        out.attach = { ok: true };
      } catch (err) {
        out.attach = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return out; // can't continue without attach
      }

      // 2. listen for Overlay.* events
      const events: Array<{ method: string; params: unknown; t: number }> = [];
      const listener = (source: chrome.debugger.Debuggee, method: string, params: unknown) => {
        if (method.startsWith('Overlay.')) {
          events.push({ method, params, t: Date.now() });
        }
      };
      chrome.debugger.onEvent.addListener(listener);

      // 3. enable DOM + Overlay
      const enableResults: Record<string, unknown> = {};
      for (const domain of ['DOM.enable', 'Overlay.enable']) {
        try {
          enableResults[domain] = await chrome.debugger.sendCommand({ tabId }, domain);
        } catch (err) {
          enableResults[domain] = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      out.enableResults = enableResults;

      // 4. compute quad
      const half = size / 2;
      const quad = [
        x - half, y - half,
        x + half, y - half,
        x + half, y + half,
        x - half, y + half,
      ];
      const highlightParams = {
        quad,
        color: { r: 255, g: 0, b: 0, a: 0.5 },
        outlineColor: { r: 255, g: 255, b: 255, a: 1 },
      };
      out.highlightCall = {
        params: highlightParams,
        // also include the LLM-friendly form
        llmView: { x, y, size, color, quad, note: 'quad is [x1,y1, x2,y2, x3,y3, x4,y4] clockwise from top-left, CSS pixels' },
      };

      // 5. call highlightQuad
      try {
        out.highlightResult = await chrome.debugger.sendCommand({ tabId }, 'Overlay.highlightQuad', highlightParams);
      } catch (err) {
        out.highlightResult = { error: err instanceof Error ? err.message : String(err) };
      }

      // 6. wait briefly for compositor to render
      await new Promise((r) => setTimeout(r, 200));

      // 7. take screenshot via chrome.tabs.captureVisibleTab
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId == null) throw new Error('no windowId');
        if (!tab.active) await chrome.tabs.update(tabId, { active: true });
        await new Promise((r) => setTimeout(r, 50));
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        // Return the FULL dataUrl (not a prefix) so the test can save it.
        out.screenshot = {
          sizeKB: Math.round(dataUrl.length / 1024),
          dataUrl, // base64 PNG
        };
      } catch (err) {
        out.screenshot = { error: err instanceof Error ? err.message : String(err) };
      }

      // 8. wait 1.5s for any Overlay events
      await new Promise((r) => setTimeout(r, 1500));
      chrome.debugger.onEvent.removeListener(listener);
      out.overlayEvents = events;
      out.eventCount = events.length;

      // 9. final targets snapshot (to see if attach is still active)
      out.finalTargets = await new Promise<unknown[]>((resolve) => {
        chrome.debugger.getTargets((targets) => {
          resolve(targets.map((t) => ({ tabId: t.tabId, attached: t.attached })));
        });
      });

      return out;
    }

    default: {
      throw new Error(`Unknown message type: ${(message as { type: string }).type}`);
    }
  }
}

// ---------- SW entrypoint ----------

export default defineBackground(() => {
  console.log('[AgentSurfer] SW loaded OK');

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

  // All messages go through handleMessage. Must return true for async response.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msgType = (message as { type: string }).type;
    console.log(`[SW] onMessage received: ${msgType}`);
    (async () => {
      try {
        const result = await handleMessage(message, sender);
        const plain = JSON.parse(JSON.stringify(result));
        sendResponse({ ok: true, data: plain });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error: errMsg });
      }
    })();
    return true;
  });

  // Also listen on connect ports for long-lived e2e communication.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'e2e-diag') return;
    port.onMessage.addListener(async (msg) => {
      try {
        const result = await handleMessage(msg, null);
        const plain = JSON.parse(JSON.stringify(result));
        port.postMessage({ ok: true, data: plain });
      } catch (err) {
        port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
});
