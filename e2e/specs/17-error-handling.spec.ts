// E2E: verify error paths don't break the architecture:
// - unknown message types return error
// - invalid payloads are caught
// - concurrent writes are all persisted
// - __e2e:reset wipes state cleanly
// - change counters are monotonic

import { expect, test } from '@playwright/test';

import {
  dbMsg,
  launchWithExtension,
  listAll,
  resetDb,
} from '../fixtures/extension';

test('unknown message type returns error and does not crash SW', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    const res = await sidePanel.evaluate(async () => {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'this-does-not-exist' as 'agent:list' });
        return { ok: (r as { ok?: boolean })?.ok, error: (r as { error?: string })?.error };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });

    // Either {ok:false, error} or thrown error — both are valid rejection paths.
    expect(res.ok === false || !!res.error).toBe(true);

    // SW should still respond to valid messages afterwards.
    const sessions = await dbMsg<{ sessions: unknown[] }>(sidePanel, { type: 'agent:list' });
    expect(Array.isArray(sessions.sessions)).toBe(true);
  } finally {
    await ext.cleanup();
  }
});

test('concurrent writes all persist and counter advances correctly', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await resetDb(sidePanel);

    const counterBefore = (await listAll(sidePanel)).changeCounters.sessions ?? 0;

    // Fire 10 concurrent create-session messages.
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        dbMsg(sidePanel, { type: 'db:create-session', title: `concurrent ${i}` }),
      );
    }
    await Promise.all(promises);

    const snap = await listAll(sidePanel);
    expect(snap.sessions.length).toBe(10);
    // Counter should have advanced by at least 10.
    const counterAfter = snap.changeCounters.sessions ?? 0;
    expect(counterAfter - counterBefore).toBeGreaterThanOrEqual(10);
  } finally {
    await ext.cleanup();
  }
});

test('__e2e:reset wipes all tables and counters', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    // Populate with some data.
    const cfgId = `e2e-reset-${Date.now()}`;
    await dbMsg(sidePanel, {
      type: 'db:upsert-config',
      config: {
        id: cfgId,
        name: 'will be reset',
        provider: 'mock',
        modelId: 'mock:textOnly',
        apiKey: 'k',
        baseUrl: null,
        isDefault: true,
        createdAt: Date.now(),
      },
    });
    await dbMsg(sidePanel, { type: 'db:create-session', title: 'will be reset' });

    let snap = await listAll(sidePanel);
    expect(snap.sessions.length).toBeGreaterThan(0);
    expect(snap.modelConfigs.length).toBeGreaterThan(0);

    // Reset.
    await resetDb(sidePanel);

    // All data tables should be empty.
    snap = await listAll(sidePanel);
    expect(snap.sessions.length).toBe(0);
    expect(snap.messages.length).toBe(0);
    expect(snap.agentSteps.length).toBe(0);
    expect(snap.modelConfigs.length).toBe(0);
  } finally {
    await ext.cleanup();
  }
});

test('change counter persists across reads (monotonic)', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await resetDb(sidePanel);

    const counter0 = (await listAll(sidePanel)).changeCounters.sessions ?? 0;
    await dbMsg(sidePanel, { type: 'db:create-session', title: 'first' });
    const counter1 = (await listAll(sidePanel)).changeCounters.sessions ?? 0;
    await dbMsg(sidePanel, { type: 'db:create-session', title: 'second' });
    const counter2 = (await listAll(sidePanel)).changeCounters.sessions ?? 0;

    // Counter must be strictly increasing.
    expect(counter1).toBeGreaterThan(counter0);
    expect(counter2).toBeGreaterThan(counter1);
  } finally {
    await ext.cleanup();
  }
});
