// Service worker: opens the side panel on action click, routes messages,
// and delegates to the Runtime. State is NEVER stored in module-level
// variables — always chrome.storage or Dexie. The Runtime owns the
// in-flight AbortController map and the agent lifecycle.

import { setWallTimeout } from '@/lib/agent';
import { db, initToolConfigs } from '@/lib/db';
import { Runtime, type RuntimeEvent } from '@/lib/runtime';
import {
  createSession,
  deleteConfig,
  deleteSession,
  setActiveConfig,
  setConfigMaxSteps,
  setToolEnabled,
  upsertConfig,
} from '@/lib/data-layer';
import { messageStore } from '@/lib/message-store';
import type { ModelConfig } from '@/types';

// ---------- Module-level state (allowed: listener registration + runtime instance) ----------

// The Runtime is a singleton — one per SW process. It owns the
// inflight map. After a SW restart, the new instance starts with an
// empty map; in-flight runs from before the restart are still
// tracked in the checkpoint (lib/runtime/checkpoint.ts) but the new
// Runtime can't abort them.
//
// Startup sweep: P0.1 fix. Runs once on SW load to abandon any
// 'running' checkpoint records that have exceeded their wallTimeoutMs.
// This handles the case where the SW was killed mid-run — the alarm
// would still fire (it's persistent), but with no listener in the
// new SW. The sweep makes sure the side panel gets a terminal
// `agent_error` event so it doesn't stay stuck on "Agent is running…".
void (async () => {
  try {
    const { sweepStaleRuns } = await import('@/lib/runtime/checkpoint');
    const abandoned = await sweepStaleRuns();
    for (const rec of abandoned) {
      try {
        chrome.runtime.sendMessage(
          {
            __fromSW: true,
            type: 'agent_error',
            runId: rec.runId,
            sessionId: rec.sessionId,
            message: 'abandoned (SW restarted while run was active)',
            reason: 'abandoned',
          },
          () => {},
        );
      } catch {
        // side panel not open — drop the broadcast
      }
    }
  } catch (err) {
    console.error('[SW] startup sweep failed:', err);
  }
})();

const runtime = new Runtime({
  emit: (event) => {
    // Bridge the Runtime's emit() to chrome.runtime.sendMessage with
    // the `__fromSW: true` tag. The side panel's onMessage listener
    // uses this to distinguish SW broadcasts from responses to its
    // own requests.
    const tagged = { ...event, __fromSW: true as const };
    try { chrome.runtime.sendMessage(tagged, () => {}); } catch {}
  },
});
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
  | { type: 'agent:start'; payload: { sessionId: string; prompt: string; agentName?: string } }
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
  | { type: '__e2e:read-active-config' }
  | { type: '__e2e:set-config-maxsteps'; id: string; maxSteps: number }
  | { type: '__e2e:inspect-tabs' }
  | { type: '__e2e:list-agent-steps' }
  | { type: '__e2e:list-messages' }
  | { type: '__e2e:highlight-rect'; tabId: number; x: number; y: number; width: number; height: number; color: string; keepMs?: number }
  | { type: '__e2e:cdp-debug'; tabId: number; x: number; y: number; color: string; size: number }
  | { type: '__e2e:coord-mapping'; tabId: number }
  | { type: '__e2e:overlay-probe'; tabId: number };

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
      const { sessionId, prompt, agentName } = message.payload;
      console.log(`[SW] agent:start agent=${agentName ?? 'browser-agent'}`);
      // Delegate to the Runtime. It handles runId generation, agent
      // resolution, config lookup, abort wiring, and fire-and-forget
      // dispatch. Returns the runId for the caller to track.
      const result = await runtime.start({ sessionId, prompt, agentName });
      return { started: true, runId: result.runId };
    }

    case 'agent:cancel': {
      const result = runtime.cancel(message.runId);
      if (result.cancelled) {
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
      if (chunks.length === 0 && !runtime.isInflight(runId)) {
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

    case '__e2e:list-alarms': {
      // E2E-only: enumerate every active chrome.alarms entry by name.
      // Used by the wall-timeout specs to assert cancelWall actually
      // removes the alarm. Requires the 'alarms' permission.
      const all = await chrome.alarms.getAll();
      return all.map((a) => a.name);
    }

    case '__e2e:read-checkpoint': {
      // E2E-only: read every RunRecord from chrome.storage.session.
      // Used by the wall-timeout sweep spec to assert sweepStaleRuns
      // marks abandoned runs correctly.
      const { listRuns } = await import('@/lib/runtime/checkpoint');
      return await listRuns();
    }

    case '__e2e:simulate-sw-restart': {
      // E2E-only: trigger a chrome.runtime.reload(). The Playwright
      // fixture will detect the new SW via ctx.waitForEvent. Schedules
      // the reload 100ms later so the current port postMessage can
      // return its response before the SW dies.
      setTimeout(() => chrome.runtime.reload(), 100);
      return { ok: true, reloadInMs: 100 };
    }

    case '__e2e:arm-sweep': {
      // E2E-only: force checkpoint.sweepStaleRuns() to run now (without
      // restarting the SW). Useful for testing the sweep in isolation.
      const { sweepStaleRuns } = await import('@/lib/runtime/checkpoint');
      const abandoned = await sweepStaleRuns();
      return { ok: true, abandonedCount: abandoned.length, abandoned };
    }

    case '__e2e:inject-stale-run': {
      // E2E-only: write a fake 'running' RunRecord to the checkpoint
      // with startMs old enough to be stale. Lets the SW-restart
      // sweep spec run in isolation without actually killing the SW
      // (chrome.runtime.reload() closes the entire test browser
      // context, which makes the spec flaky).
      const { saveRun } = await import('@/lib/runtime/checkpoint');
      const ageMs = (message as { ageMs?: number }).ageMs ?? 200_000;
      const wallTimeoutMs = (message as { wallTimeoutMs?: number }).wallTimeoutMs ?? 30_000;
      const rec = {
        runId: (message as { runId?: string }).runId ?? `e2e-stale-${Date.now()}`,
        sessionId: `e2e-stale-session-${Date.now()}`,
        startMs: Date.now() - ageMs,
        modelId: 'mock:hangsForever',
        wallTimeoutMs,
        status: 'running' as const,
        lastStepNumber: 0,
      };
      await saveRun(rec);
      return rec;
    }

    case '__e2e:list-all': {
      // E2E-only: dump every Dexie table + the per-table change counters.
      // Used by specs 17/19/14 etc. to assert data-layer behavior end-to-end.
      // Return the raw payload — the port wrapper in background.ts adds
      // the {ok, data, error} envelope. Double-wrapping breaks dbMsg.
      const [sessions, messages, agentSteps, screenshots, modelConfigs, toolConfigs] =
        await Promise.all([
          db.sessions.toArray(),
          db.messages.toArray(),
          db.agentSteps.toArray(),
          db.screenshots.toArray(),
          db.modelConfigs.toArray(),
          db.toolConfigs.toArray(),
        ]);
      const changeCounters = await chrome.storage.local.get([
        '__db_change_sessions',
        '__db_change_messages',
        '__db_change_agentSteps',
        '__db_change_screenshots',
        '__db_change_modelConfigs',
        '__db_change_toolConfigs',
      ]);
      return { sessions, messages, agentSteps, screenshots, modelConfigs, toolConfigs, changeCounters };
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

    case '__e2e:read-active-config': {
      // E2E-only: return the active ModelConfig in full (including
      // maxSteps) so a test can assert what the agent loop will read.
      // Distinct from __e2e:inspect (which also returns sessions etc.)
      // — this is a focused, deterministic read for maxSteps assertions.
      const configs = await db.modelConfigs.toArray();
      const active = configs.find((c) => c.isDefault) ?? configs[0] ?? null;
      return { activeConfig: active };
    }

    case '__e2e:set-config-maxsteps': {
      // E2E-only: mutate a single config's maxSteps. Used by live-LLM
      // specs to dial the cap without driving the Options form.
      const { id, maxSteps } = message as { id: string; maxSteps: number };
      await setConfigMaxSteps(id, maxSteps);
      return { ok: true, id, maxSteps };
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

    case '__e2e:coord-mapping': {
      // Phase-2 diagnostic: read every Chrome coordinate system value, then
      // draw 3 known-position overlays and capture each so we can derive
      // the linear mapping `overlayX = a*requestedX + b`.
      // msg: { tabId }
      const { tabId } = message as { tabId: number };
      const out: Record<string, unknown> = {};
      // 1. attach + DOM.enable + Overlay.enable
      try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (err) {
        return { attachError: err instanceof Error ? err.message : String(err) };
      }
      try { await chrome.debugger.sendCommand({ tabId }, 'DOM.enable'); } catch {}
      try { await chrome.debugger.sendCommand({ tabId }, 'Overlay.enable'); } catch {}
      // 2. Page.getLayoutMetrics (CDP) → layout viewport + visual viewport
      try {
        const lm = await chrome.debugger.sendCommand<{
          layoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
          visualViewport: { offsetX: number; offsetY: number; pageX: number; pageY: number; clientWidth: number; clientHeight: number; scale: number; zoom: number };
          cssLayoutViewport: { clientWidth: number; clientHeight: number };
          cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number; scale: number };
        }>({ tabId }, 'Page.getLayoutMetrics');
        out.PageGetLayoutMetrics = lm;
      } catch (err) {
        out.PageGetLayoutMetrics = { error: err instanceof Error ? err.message : String(err) };
      }
      // 3. chrome.scripting.executeScript → read window.* values
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const w = window as unknown as Record<string, unknown>;
            return {
              devicePixelRatio: window.devicePixelRatio,
              innerWidth: window.innerWidth,
              innerHeight: window.innerHeight,
              outerWidth: window.outerWidth,
              outerHeight: window.outerHeight,
              screenX: window.screenX,
              screenY: window.screenY,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              devicePixelRatio_again: w['devicePixelRatio'],
              visualViewport: window.visualViewport ? {
                width: window.visualViewport.width,
                height: window.visualViewport.height,
                offsetX: window.visualViewport.offsetX,
                offsetY: window.visualViewport.offsetY,
                pageX: window.visualViewport.pageX,
                pageY: window.visualViewport.pageY,
                scale: window.visualViewport.scale,
              } : null,
              visualViewportApi: typeof w['visualViewport'] !== 'undefined',
            };
          },
        });
        out.windowMetrics = (result[0]?.result) ?? { error: 'no result' };
      } catch (err) {
        out.windowMetrics = { error: err instanceof Error ? err.message : String(err) };
      }
      // 4. Draw 3 overlays at known positions, capture after each
      // Chrome limits chrome.tabs.captureVisibleTab to ~3 calls/sec
      // (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). Spread them out.
      const positions = [
        { name: 'top-left',     x: 0,   y: 0,   w: 100, h: 100 },
        { name: 'offset-100',   x: 100, y: 100, w: 100, h: 100 },
        { name: 'mid-screen',   x: 500, y: 500, w: 100, h: 100 },
      ];
      const shots: Array<{ name: string; requestedQuad: number[]; dataUrl?: string; sizeKB?: number; error?: string }> = [];
      for (const [i, pos] of positions.entries()) {
        const quad = [pos.x, pos.y, pos.x + pos.w, pos.y, pos.x + pos.w, pos.y + pos.h, pos.x, pos.y + pos.h];
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Overlay.highlightQuad', {
            quad,
            color: { r: 255, g: 0, b: 0, a: 0.5 },
            outlineColor: { r: 255, g: 255, b: 255, a: 1 },
          });
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
        // Wait an extra 350ms between captures to stay under the
        // MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.
        if (i > 0) await new Promise((r) => setTimeout(r, 350));
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId != null) {
          if (!tab.active) await chrome.tabs.update(tabId, { active: true });
          await new Promise((r) => setTimeout(r, 50));
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          shots.push({ name: pos.name, requestedQuad: quad, dataUrl, sizeKB: Math.round(dataUrl.length / 1024) });
        }
      }
      out.overlayShots = shots;
      return out;
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

    case '__e2e:overlay-probe': {
      // Pure diagnostic: at 5 known CSS points on a single tab, draw
      // Overlay.highlightQuad with size=100, capture a screenshot, and
      // return both the image and the source-of-truth viewport metrics
      // (tabInfo from chrome.tabs.get + Page.getLayoutMetrics from CDP)
      // so a downstream analyzer can compare requested vs actual bbox
      // positions and locate where any coordinate transform is happening.
      //
      // No production tool is touched. No LLM is called. No prompt or
      // fallback is changed. This handler exists only to expose the
      // raw Overlay behavior for inspection.
      //
      // Wait ordering matches `__e2e:coord-mapping`:
      //   draw → 100ms → (if i>0) 350ms → capture
      // The 350ms gap keeps us under MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND.
      const { tabId } = message as { tabId: number };
      const out: Record<string, unknown> = {};

      // 1. tabInfo — what cdpAim uses for width/height
      try {
        out.tabInfo = await chrome.tabs.get(tabId);
      } catch (err) {
        out.tabInfo = { error: err instanceof Error ? err.message : String(err) };
      }

      // 2. Attach debugger. Treat "already attached" as success.
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('Another debugger') && !msg.includes('Already attached')) {
          return { ...out, attachError: msg };
        }
      }

      // 3. Enable DOM + Overlay. DOM MUST come first (cdp.ts:276).
      try { await chrome.debugger.sendCommand({ tabId }, 'DOM.enable'); } catch (e) {
        out.domEnableError = e instanceof Error ? e.message : String(e);
      }
      try { await chrome.debugger.sendCommand({ tabId }, 'Overlay.enable'); } catch (e) {
        out.overlayEnableError = e instanceof Error ? e.message : String(e);
      }

      // 4. Page.getLayoutMetrics — the CDP source of truth for the
      //    layout + visual viewport, independent of chrome.tabs.get.
      try {
        out.layoutMetrics = await chrome.debugger.sendCommand<Record<string, unknown>>(
          { tabId }, 'Page.getLayoutMetrics',
        );
      } catch (err) {
        out.layoutMetrics = { error: err instanceof Error ? err.message : String(err) };
      }

      // 5. Activate the tab once (captureVisibleTab requires it). Then
      //    loop the 5 points, drawing + capturing for each.
      try {
        const tab0 = await chrome.tabs.get(tabId);
        if (tab0.windowId != null && !tab0.active) {
          await chrome.tabs.update(tabId, { active: true });
        }
      } catch {}

      const points: Array<{ x: number; y: number }> = [
        { x: 0,   y: 0   },
        { x: 100, y: 100 },
        { x: 200, y: 200 },
        { x: 400, y: 400 },
        { x: 640, y: 400 },
        { x: 800, y: 400 },
      ];
      const size = 100;
      const shots: Array<{
        requested: { x: number; y: number; size: number };
        params: { quad: number[]; color: { r: number; g: number; b: number; a: number }; outlineColor: { r: number; g: number; b: number; a: number } };
        dataUrl?: string;
        sizeKB?: number;
        error?: string;
      }> = [];

      for (const [i, p] of points.entries()) {
        // Quad centered at (p.x, p.y) with side = size — EXACTLY the
        // construction used by lib/cdp.ts:337-342. This makes the probe
        // a faithful reproduction of cdpAim's Overlay.highlightQuad call.
        const half = size / 2;
        const quad = [
          p.x - half, p.y - half,   // tl
          p.x + half, p.y - half,   // tr
          p.x + half, p.y + half,   // br
          p.x - half, p.y + half,   // bl
        ];
        const params = {
          quad,
          color: { r: 255, g: 0, b: 0, a: 0.5 },
          outlineColor: { r: 255, g: 255, b: 255, a: 1 },
        };
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Overlay.highlightQuad', params);
        } catch (err) {
          shots.push({
            requested: { x: p.x, y: p.y, size },
            params,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        await new Promise((r) => setTimeout(r, 100));
        if (i > 0) await new Promise((r) => setTimeout(r, 350));
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.windowId == null) throw new Error('no windowId');
          if (!tab.active) await chrome.tabs.update(tabId, { active: true });
          await new Promise((r) => setTimeout(r, 50));
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          shots.push({
            requested: { x: p.x, y: p.y, size },
            params,
            dataUrl,
            sizeKB: Math.round(dataUrl.length / 1024),
          });
        } catch (err) {
          shots.push({
            requested: { x: p.x, y: p.y, size },
            params,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 6. Cleanup: hideHighlight + disable overlay. We deliberately
      //    leave the debugger attached (matches `__e2e:coord-mapping`).
      try { await chrome.debugger.sendCommand({ tabId }, 'Overlay.hideHighlight'); } catch {}
      try { await chrome.debugger.sendCommand({ tabId }, 'Overlay.disable'); } catch {}

      out.shots = shots;
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
    if (port.name === 'e2e-diag') {
      port.onMessage.addListener(async (msg) => {
        try {
          const result = await handleMessage(msg, null);
          const plain = JSON.parse(JSON.stringify(result));
          port.postMessage({ ok: true, data: plain });
        } catch (err) {
          port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }
    if (port.name === 'msgstore') {
      // The side panel's long-lived connection to MessageStore. On connect,
      // subscribe the port as a state subscriber — it gets a snapshot
      // immediately. Subsequent state changes (chunks, markComplete, etc.)
      // are pushed as `__msgstore:update` messages. The port also carries
      // commands from the side panel: select_session, send, cancel.
      messageStore.subscribe(port as unknown as { postMessage: (msg: unknown) => void });
      port.onDisconnect.addListener(() => {
        messageStore.unsubscribe(port as unknown as { postMessage: (msg: unknown) => void });
      });
      port.onMessage.addListener(async (msg) => {
        const m = msg as { type?: string; sessionId?: string; prompt?: string; runId?: string };
        try {
          if (m.type === 'select_session' && typeof m.sessionId === 'string') {
            await messageStore.startSession(m.sessionId);
          } else if (m.type === 'send' && typeof m.prompt === 'string' && typeof m.sessionId === 'string') {
            // Delegate to the Runtime directly. The Runtime generates
            // the runId and dispatches the agent loop fire-and-forget.
            const result = await runtime.start({
              sessionId: m.sessionId,
              prompt: m.prompt,
            });
            port.postMessage({ ok: true, data: { started: true, runId: result.runId } });
          } else if (m.type === 'cancel' && typeof m.runId === 'string') {
            const result = runtime.cancel(m.runId);
            port.postMessage({ ok: true, data: result });
          }
        } catch (err) {
          port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });
    }
  });
});
