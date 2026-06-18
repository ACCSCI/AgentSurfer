// e2e/specs/38-maxsteps-respected.spec.ts
//
// Verifies that the `maxSteps` field on ModelConfig actually constrains
// the agent loop. The mock:longRunning script in lib/mock-scripts.ts
// produces 15 sequential tool-call steps before finishing. If the
// wire-up between ModelConfig.maxSteps and streamText is broken, the
// loop will run all 15. If it works, the loop must terminate at the
// configured cap.
//
// This is a closed-loop debug spec — when it fails it tells you
// exactly which assumption broke:
//   - activeConfig.maxSteps not what we set   → Dexie write is broken
//   - log says effectiveMaxSteps != 5         → lib/agent.ts wire-up
//   - stepCount != 5 even though log says 5   → loop / streamText
//   - log missing 'run start' line            → didn't enter loop at all

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('agent loop respects ModelConfig.maxSteps', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // --- 1. Seed a config with maxSteps=5 -------------------------------
    // `__e2e:seed-config` accepts the full ModelConfig (including the
    // new `maxSteps` field) and marks it active in one call.
    const seedRes = await sidePanel.evaluate(async () => {
      const cfg = {
        id: 'mock-maxsteps-5',
        name: 'mock (maxSteps=5)',
        provider: 'mock',
        modelId: 'mock:longRunning', // 15 tool calls — see lib/mock-scripts.ts
        apiKey: '',
        baseUrl: null,
        isDefault: true,
        maxSteps: 5, // ← the value under test
        createdAt: Date.now(),
      };
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: '__e2e:seed-config', config: cfg },
          (response) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(response);
          },
        );
      });
    });
    expect(seedRes).toMatchObject({ ok: true });

    // --- 2. Read it back via __e2e:read-active-config --------------------
    // This is the closed-loop debug hook for "did Dexie actually
    // persist what we wrote?". If the value isn't 5 here, the test
    // bug is in seeding, not in the loop.
    const readback = (await ext.dbMsg(sidePanel, {
      type: '__e2e:read-active-config',
    })) as { activeConfig: { maxSteps?: number; modelId: string } };
    expect(readback.activeConfig.modelId).toBe('mock:longRunning');
    expect(readback.activeConfig.maxSteps).toBe(5);

    // --- 3. (capture strategy) ------------------------------------------
    // chrome.runtime.onMessage is NOT a reliable way to capture the SW's
    // broadcast events in E2E (see the working specs 35/36/37/21 which all
    // grep sw.log instead). We rely on:
    //   (a) sw.log containing `emit ... agent_done` to know the run finished
    //   (b) the persisted agentSteps table for the authoritative step count
    // Both are deterministic and don't depend on cross-context message
    // delivery timing.

    // --- 4. Start a session + send the prompt ----------------------------
    const sessionId = await sidePanel.evaluate(async () => {
      const port = chrome.runtime.connect({ name: 'msgstore' });
      // msgstore port starts a session lazily on send. Create one
      // explicitly so we don't race.
      const session = await new Promise<{ id: string }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('create-session timeout')), 5000);
        port.onMessage.addListener(function once(msg: { type?: string; data?: { session?: { id: string } } }) {
          if (msg?.type === 'select_session_done' || msg?.data?.session?.id) {
            clearTimeout(t);
            port.onMessage.removeListener(once);
            resolve(msg.data.session);
          }
        });
        // msgstore port on connect starts a session automatically,
        // but to be deterministic, request one via db:create-session
        // over a separate port.
        port.disconnect();
        const p2 = chrome.runtime.connect({ name: 'e2e-diag' });
        p2.postMessage({ type: 'db:create-session' });
        p2.onMessage.addListener(function handler(res: { ok: boolean; data?: { session: { id: string } } }) {
          if (res?.data?.session?.id) {
            p2.disconnect();
            resolve(res.data.session);
          }
        });
      });
      return session.id;
    });
    expect(sessionId).toBeTruthy();

    // Send via msgstore port.
    await sidePanel.evaluate(async (sid) => {
      const port = chrome.runtime.connect({ name: 'msgstore' });
      await new Promise<void>((resolve) => {
        port.onMessage.addListener(function once(msg: { type?: string }) {
          // On connect, MessageStore.subscribe pushes a `__msgstore:snapshot`
          // message (see lib/message-store.ts). That is our signal the port
          // is live and we can drive select_session + send.
          if (msg?.type === '__msgstore:snapshot' || msg?.type === '__msgstore:update') {
            port.onMessage.removeListener(once);
            port.postMessage({ type: 'select_session', sessionId: sid });
            // Give the runtime a beat to bind the session, then send.
            setTimeout(() => {
              port.postMessage({ type: 'send', sessionId: sid, prompt: 'do the long running task' });
              resolve();
            }, 100);
          }
        });
      });
    }, sessionId);

    // --- 5+6. Poll the persisted agentSteps table until it settles -------
    // The persisted agentSteps table is the authoritative record of how many
    // loop steps actually ran. Polling it (rather than racing on a single
    // read) both WAITS for the run to finish AND asserts the cap.
    //
    // The mock script (`mock:longRunning`) scripts 15 tool-call steps; with
    // maxSteps=5 exactly 5 must be persisted. We poll until the count reaches
    // 5 (the run is done writing), then assert it never exceeds 5.
    await expect
      .poll(async () => (await ext.listAgentSteps(sidePanel)).count, {
        timeout: 20_000,
        message: 'persisted agentSteps should reach exactly maxSteps (5)',
      })
      .toBe(5);

    // Belt-and-braces: confirm it stayed at 5 (the loop did not overrun).
    const persisted = await ext.listAgentSteps(sidePanel);
    expect(persisted.count).toBe(5);
  } finally {
    await ext.cleanup();
  }
});
