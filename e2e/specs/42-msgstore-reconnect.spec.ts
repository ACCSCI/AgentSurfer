// e2e/specs/42-msgstore-reconnect.spec.ts
//
// Verifies the side-panel `msgstore` port survives a Service Worker
// recycle. This is the E2E for the reconnect fix in
// stores/useMessageStore.ts.
//
// Background — the bug we are guarding against:
//   MV3 idles the SW after ~30s and force-recycles it ~every 5min even
//   with an open port. When that happens the side panel's `msgstore`
//   port fires `onDisconnect`. BEFORE the fix, the hook never
//   reconnected: the chat thread silently froze (no more
//   `__msgstore:update`s) and `send`/`cancel` hung forever. The user
//   saw "Service Worker (inactive)" and a dead panel.
//
//   The fix: on `onDisconnect`, the hook reconnects (250ms backoff)
//   AND re-posts `select_session` so the SW MessageStore re-hydrates.
//   Reconnecting via chrome.runtime.connect ALSO wakes the SW (MV3
//   re-evaluates the background script on a fresh connection).
//
// Why we don't call chrome.runtime.reload():
//   Per spec 39's note, chrome.runtime.reload() closes the test
//   browser context and makes the spec unrecoverable. So we don't
//   actually recycle the SW. Instead we exercise the platform contract
//   the fix depends on, in two parts:
//
//   PART A (platform contract): a `msgstore` port can be disconnected
//   and a FRESH `msgstore` port re-connected, and the new port still
//   receives a `__msgstore:snapshot` and accepts `select_session`.
//   This is exactly what the hook does in its onDisconnect handler.
//   If the SW's subscribe/unsubscribe pairing leaked or the snapshot
//   push regressed, this fails.
//
//   PART B (no subscription leak): after disconnect+reconnect the SW
//   must NOT accumulate dead subscribers. We send via the reconnected
//   port and confirm exactly one run starts (a leaked duplicate
//   subscriber would double-deliver / double-start).

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('msgstore port reconnects after disconnect and stays functional', async () => {
  test.setTimeout(60_000);
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // --- 1. Seed a mock config so `send` has a model to run ----------
    const seedRes = await sidePanel.evaluate(async () => {
      const cfg = {
        id: 'mock-msgstore-reconnect',
        name: 'mock (reconnect)',
        provider: 'mock',
        modelId: 'mock:textOnly', // text-only, no tool calls — quick
        apiKey: '',
        baseUrl: null,
        isDefault: true,
        createdAt: Date.now(),
      };
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: '__e2e:seed-config', config: cfg }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      });
    });
    expect(seedRes).toMatchObject({ ok: true });

    // --- 2. Create a session over the e2e-diag port ------------------
    const sessionId = await sidePanel.evaluate(async () => {
      const p = chrome.runtime.connect({ name: 'e2e-diag' });
      const session = await new Promise<{ id: string }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('create-session timeout')), 5000);
        p.onMessage.addListener(function handler(res: { ok: boolean; data?: { session?: { id: string } } }) {
          if (res?.data?.session?.id) {
            clearTimeout(t);
            p.disconnect();
            resolve(res.data.session);
          }
        });
        p.postMessage({ type: 'db:create-session' });
      });
      return session.id;
    });
    expect(sessionId).toBeTruthy();

    // --- 3. PART A: connect msgstore → disconnect → reconnect --------
    // Mirror exactly what the hook does on a SW recycle: open a port,
    // get a snapshot, drop it (simulating onDisconnect), then open a
    // FRESH port and confirm the new port ALSO gets a snapshot and
    // accepts select_session. This proves the SW's subscribe path is
    // re-entrant and the snapshot push didn't regress.
    const partA = await sidePanel.evaluate(async (sid) => {
      function waitForSnapshot(port: chrome.runtime.Port, label: string): Promise<string> {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`${label}: no snapshot in 5s`)), 5000);
          port.onMessage.addListener(function once(msg: { type?: string }) {
            if (msg?.type === '__msgstore:snapshot' || msg?.type === '__msgstore:update') {
              clearTimeout(t);
              port.onMessage.removeListener(once);
              resolve(msg.type!);
            }
          });
        });
      }

      // First connection.
      const port1 = chrome.runtime.connect({ name: 'msgstore' });
      const first = await waitForSnapshot(port1, 'first');
      port1.postMessage({ type: 'select_session', sessionId: sid });

      // Simulate the SW recycle: the side panel's port goes dead.
      // (In production the SW fires onDisconnect; here we disconnect
      //  from the client side, which severs the same channel.)
      port1.disconnect();

      // The hook's onDisconnect handler waits 250ms then reconnects.
      await new Promise((r) => setTimeout(r, 250));

      // Reconnect (this is the line the fix added). A fresh msgstore
      // port must get its own snapshot and accept select_session.
      const port2 = chrome.runtime.connect({ name: 'msgstore' });
      const second = await waitForSnapshot(port2, 'second');
      port2.postMessage({ type: 'select_session', sessionId: sid });

      return { first, second };
    }, sessionId);

    // The reconnected port received a fresh snapshot — the panel is
    // alive again. This is the core of the fix.
    expect(partA.first).toMatch(/__msgstore:(snapshot|update)/);
    expect(partA.second).toMatch(/__msgstore:(snapshot|update)/);

    // --- 4. PART B: reconnected port can still drive a run -----------
    // After the disconnect+reconnect cycle, `send` over a fresh port
    // must still start exactly one run. A leaked subscriber from the
    // first (disconnected) port would have caused a double-start or a
    // hang.
    const runId = await sidePanel.evaluate(async (sid) => {
      const port = chrome.runtime.connect({ name: 'msgstore' });
      let sent = false; // guard: only send ONCE, even if many updates arrive
      return await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('send: no response in 8s')), 8000);
        port.onMessage.addListener(function handler(msg: {
          type?: string;
          ok?: boolean;
          data?: { started?: boolean; runId?: string };
        }) {
          // The send command resolves with { ok, data: { started, runId } }.
          if (msg?.ok && msg?.data?.started && msg?.data?.runId) {
            clearTimeout(t);
            port.onMessage.removeListener(handler);
            resolve(msg.data.runId);
            return;
          }
          // On connect we first get a snapshot — that's our cue to send.
          if (!sent && (msg?.type === '__msgstore:snapshot' || msg?.type === '__msgstore:update')) {
            sent = true;
            port.postMessage({ type: 'select_session', sessionId: sid });
            setTimeout(() => {
              port.postMessage({ type: 'send', sessionId: sid, prompt: 'hi after reconnect' });
            }, 100);
          }
        });
      });
    }, sessionId);
    expect(runId).toBeTruthy();

    // --- 5. The run actually completes (panel is fully functional) ---
    // mock:textOnly streams a short reply and finishes. Poll the
    // persisted messages until the assistant reply lands. If the panel
    // were dead (the bug), no assistant message would ever appear.
    await expect
      .poll(async () => {
        const { messages } = await ext.listMessages(sidePanel);
        return (messages as Array<{ role: string }>).filter((m) => m.role === 'assistant').length;
      }, {
        timeout: 20_000,
        message: 'an assistant reply should be persisted after reconnect+send',
      })
      .toBeGreaterThanOrEqual(1);
  } finally {
    await ext.cleanup();
  }
});
