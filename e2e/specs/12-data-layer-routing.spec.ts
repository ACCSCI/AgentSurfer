// E2E: verify that every db:* message type reaches the data layer and
// produces the expected Dexie write + change counter bump.

import { expect, test } from '@playwright/test';

import {
  dbMsg,
  launchWithExtension,
  listAll,
  resetDb,
  type DbSnapshot,
} from '../fixtures/extension';

test.describe('db:* message routing', () => {
  test('all 9 db:* messages work end-to-end', async () => {
    const ext = await launchWithExtension();
    try {
      const { page: sidePanel } = await ext.openSidePanel();
      await sidePanel.waitForSelector('text=AgentSurfer');

      // Start from a clean state.
      await resetDb(sidePanel);
      let snap = await listAll(sidePanel);
      expect(snap.sessions.length).toBe(0);
      expect(snap.modelConfigs.length).toBe(0);

      // 1. db:create-session
      const sessionRes = await dbMsg<{ session: { id: string; title: string } }>(
        sidePanel,
        { type: 'db:create-session', title: 'Test Session' },
      );
      const sessionId = sessionRes.session.id;
      expect(sessionRes.session.title).toBe('Test Session');
      snap = await listAll(sidePanel);
      expect(snap.sessions.length).toBe(1);
      expect(snap.sessions[0]?.id).toBe(sessionId);
      expect(snap.changeCounters.sessions ?? 0).toBeGreaterThan(0);

      // 2. db:rename-session
      await dbMsg(sidePanel, { type: 'db:rename-session', sessionId, title: 'Renamed' });
      snap = await listAll(sidePanel);
      expect(snap.sessions[0]?.title).toBe('Renamed');

      // 3. db:append-message
      const msgRes = await dbMsg<{ message: { id: string; role: string; parts: Array<{ type: string; text?: string }> } }>(
        sidePanel,
        {
          type: 'db:append-message',
          message: {
            sessionId,
            role: 'user',
            parts: [{ type: 'text', text: 'Hello' }],
          },
        },
      );
      const messageId = msgRes.message.id;
      expect(msgRes.message.role).toBe('user');
      expect(msgRes.message.parts[0]?.text).toBe('Hello');
      snap = await listAll(sidePanel);
      expect(snap.messages.length).toBe(1);
      expect(snap.messages[0]?.id).toBe(messageId);
      expect(snap.messages[0]?.text).toBe('Hello');

      // 4. db:append-step
      const stepRes = await dbMsg<{ step: { id: string; stepNumber: number } }>(
        sidePanel,
        {
          type: 'db:append-step',
          step: { messageId, stepNumber: 1, text: '', toolCalls: [], toolResults: [], durationMs: 0 },
        },
      );
      expect(stepRes.step.stepNumber).toBe(1);
      snap = await listAll(sidePanel);
      expect(snap.agentSteps.length).toBe(1);

      // 5. db:upsert-config
      const cfgId = `e2e-cfg-${Date.now()}`;
      await dbMsg(sidePanel, {
        type: 'db:upsert-config',
        config: {
          id: cfgId,
          name: 'Mock config',
          provider: 'mock',
          modelId: 'mock:textOnly',
          apiKey: 'mock-key',
          baseUrl: null,
          isDefault: false,
          createdAt: Date.now(),
        },
      });
      snap = await listAll(sidePanel);
      expect(snap.modelConfigs.find((c) => c.id === cfgId)).toBeTruthy();

      // 6. db:set-active-config
      await dbMsg(sidePanel, { type: 'db:set-active-config', id: cfgId });
      snap = await listAll(sidePanel);
      const active = snap.modelConfigs.find((c) => c.isDefault);
      expect(active?.id).toBe(cfgId);

      // 7. db:set-tool-enabled
      await dbMsg(sidePanel, { type: 'db:set-tool-enabled', name: 'cdpPressKey', enabled: false });
      snap = await listAll(sidePanel);
      const cdpPressKey = snap.toolConfigs.find((t) => t.name === 'cdpPressKey');
      expect(cdpPressKey?.enabled).toBe(false);

      // 8. db:delete-config
      await dbMsg(sidePanel, { type: 'db:delete-config', id: cfgId });
      snap = await listAll(sidePanel);
      expect(snap.modelConfigs.find((c) => c.id === cfgId)).toBeUndefined();

      // 9. db:delete-session (cascades to messages and steps)
      const sessionsBefore = snap.snapshots_count ?? snap.sessions.length;
      await dbMsg(sidePanel, { type: 'db:delete-session', sessionId });
      snap = await listAll(sidePanel);
      expect(snap.sessions.length).toBe(0);
      expect(snap.messages.length).toBe(0); // cascade
      expect(snap.agentSteps.length).toBe(0); // cascade
    } finally {
      await ext.cleanup();
    }
  });
});
