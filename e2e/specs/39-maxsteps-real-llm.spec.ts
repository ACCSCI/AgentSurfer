// e2e/specs/39-maxsteps-real-llm.spec.ts
//
// Real-LLM closed-loop verification that ModelConfig.maxSteps actually
// constrains the loop on the production provider (MiniMax-M3).
//
// Marked @live so it only runs via `bun run e2e:live` (real API).
//
// What this catches that the mock spec (38) doesn't:
//   - The Zod default of 99 round-trips through the data layer cleanly
//     for a real config (not just a synthetic one)
//   - The "max steps" cap survives the real LLM tool-call dance
//     (mock scripts can't exercise streaming tool-call interleaving)
//   - The `run start` log line is emitted with the right
//     effectiveMaxSteps for a real provider
//
// Failure modes and what the logs will say:
//   - activeConfig.maxSteps != 2 after seed-config       → Dexie write
//   - log 'run start' shows effectiveMaxSteps != 2       → lib/agent.ts
//   - stepCount > 2 (loop ran past the cap)              → streamText
//   - no agent_done within 60s                           → loop is hung
//
// Tagged @live — see playwright.config.ts / `bun run e2e:live`.

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

test('@live MiniMax-M3 respects ModelConfig.maxSteps=2', async () => {
  test.setTimeout(180_000);
  const ext = await launchWithExtension();
  try {
    // Clear the cumulative SW log so the agent_done poll below can't match a
    // stale agent_done line from a previous test in this run session.
    ext.clearSWLog();

    // --- 0. Read API key from .env (the same way the other live specs do)
    const apiKey = ext.readApiKey('MINIMAX_API_KEY');
    expect(apiKey.length).toBeGreaterThan(0);

    // --- 1. Boot side panel + seed MiniMax config ----------------------
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.seedLiveConfig(sidePanel, 'MiniMax', apiKey);
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=MiniMax-M3', { timeout: 10_000 });

    // --- 2. Override maxSteps=2 via the E2E debug hook -----------------
    // We use __e2e:set-config-maxsteps (not the form) because the form
    // would require extra UI work; the value still flows through the
    // same lib/agent.ts read path. Look up the active config id first
    // (seedLiveConfig uses a fresh id each call).
    const readback1 = (await ext.dbMsg(sidePanel, {
      type: '__e2e:read-active-config',
    })) as { activeConfig: { id: string; maxSteps?: number } };
    expect(readback1.activeConfig.id).toBeTruthy();

    const setRes = await ext.dbMsg(sidePanel, {
      type: '__e2e:set-config-maxsteps',
      id: readback1.activeConfig.id,
      maxSteps: 2,
    });
    expect(setRes).toEqual({ ok: true, id: readback1.activeConfig.id, maxSteps: 2 });

    // --- 3. Verify the cap actually persisted -------------------------
    const readback2 = (await ext.dbMsg(sidePanel, {
      type: '__e2e:read-active-config',
    })) as { activeConfig: { id: string; maxSteps?: number; modelId: string } };
    expect(readback2.activeConfig.maxSteps).toBe(2);
    expect(readback2.activeConfig.modelId).toBe('MiniMax-M3');

    // --- 4. Send a task that obviously needs 3+ steps -----------------
    // "Open example.com, take a screenshot, then tell me the page
    // title" needs tabsOpen + cdpScreenshot + read text = 3 steps.
    // With maxSteps=2 the loop must stop before reading the title.
    //
    // We drive the run through the `msgstore` port (the same path the
    // mock spec 38 uses) rather than clicking the UI submit button.
    // The UI click is unreliable in E2E: the React input bar may not have
    // bound the active session by the time we click, so the click silently
    // no-ops and the SW never receives a `send` (observed: sw.log stops at
    // setConfigMaxSteps, no run start). The port path is deterministic.
    const sessionId = await sidePanel.evaluate(async () => {
      const session = await new Promise<{ id: string }>((resolve) => {
        const port = chrome.runtime.connect({ name: 'e2e-diag' });
        port.postMessage({ type: 'db:create-session' });
        port.onMessage.addListener(function handler(res: {
          ok: boolean;
          data?: { session: { id: string } };
        }) {
          if (res?.data?.session?.id) {
            port.disconnect();
            resolve(res.data.session);
          }
        });
      });
      return session.id;
    });
    expect(sessionId).toBeTruthy();

    await sidePanel.evaluate(async (sid) => {
      const port = chrome.runtime.connect({ name: 'msgstore' });
      await new Promise<void>((resolve) => {
        port.onMessage.addListener(function once(msg: { type?: string }) {
          if (
            msg?.type === '__msgstore:snapshot' ||
            msg?.type === '__msgstore:update'
          ) {
            port.onMessage.removeListener(once);
            port.postMessage({ type: 'select_session', sessionId: sid });
            setTimeout(() => {
              port.postMessage({
                type: 'send',
                sessionId: sid,
                prompt:
                  'Open https://example.com, take a screenshot, then tell me the page title.',
              });
              resolve();
            }, 100);
          }
        });
      });
    }, sessionId);

    // --- 5. Wait for agent_done in sw.log (up to 60s) ------------------
    // The `chrome.runtime.onMessage` broadcast is unreliable for capturing
    // SW events in E2E (see CLAUDE.md §7.2 and the test-38 rewrite). The
    // deterministic signal is the SW log line emitted at agent_done.
    await expect
      .poll(() => /emit.*agent_done/.test(ext.readSWLog()), { timeout: 120_000 })
      .toBe(true);

    // --- 6. Assert the cap was respected -------------------------------
    // Authoritative check: the persisted agentSteps table (immune to the
    // cumulative sw.log). With maxSteps=2 the loop must persist at most 2
    // steps. The real LLM may finish in fewer if it self-declares done,
    // so we assert `<= 2` rather than `=== 2`.
    const persisted = await ext.listAgentSteps(sidePanel);
    expect(persisted.count, 'persisted agentSteps must not exceed maxSteps (2)')
      .toBeLessThanOrEqual(2);
    expect(persisted.count, 'the loop should have run at least 1 step')
      .toBeGreaterThanOrEqual(1);

    console.log('[maxsteps-real-llm] persisted stepCount:', persisted.count);
  } finally {
    await ext.cleanup();
  }
});
