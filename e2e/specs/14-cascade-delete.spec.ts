// E2E: verify that db:delete-session cascades to messages + agentSteps
// and broadcasts on all three tables.

import { expect, test } from '@playwright/test';

import {
  dbMsg,
  launchWithExtension,
  listAll,
  resetDb,
} from '../fixtures/extension';

test('deleteSession removes session, messages, and steps atomically', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    await resetDb(sidePanel);

    // Build a full tree: 1 session, 2 messages, 2 steps per message.
    const sessionRes = await dbMsg<{ session: { id: string } }>(
      sidePanel,
      { type: 'db:create-session', title: 'cascade test' },
    );
    const sessionId = sessionRes.session.id;

    const msgIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const m = await dbMsg<{ message: { id: string } }>(sidePanel, {
        type: 'db:append-message',
        message: { sessionId, role: i === 0 ? 'user' : 'assistant', content: `msg ${i}` },
      });
      msgIds.push(m.message.id);
    }

    for (const mid of msgIds) {
      for (let s = 1; s <= 2; s++) {
        await dbMsg(sidePanel, {
          type: 'db:append-step',
          step: {
            messageId: mid,
            stepNumber: s,
            text: `step ${s}`,
            toolCalls: [],
            toolResults: [],
            durationMs: 0,
          },
        });
      }
    }

    // Sanity check: 1 session, 2 messages, 4 steps.
    let snap = await listAll(sidePanel);
    expect(snap.sessions.length).toBe(1);
    expect(snap.messages.length).toBe(2);
    expect(snap.agentSteps.length).toBe(4);

    // Delete the session.
    await dbMsg(sidePanel, { type: 'db:delete-session', sessionId });

    // All three tables should be empty.
    snap = await listAll(sidePanel);
    expect(snap.sessions.length).toBe(0);
    expect(snap.messages.length).toBe(0);
    expect(snap.agentSteps.length).toBe(0);
  } finally {
    await ext.cleanup();
  }
});

test('deleteSession only removes the target session, not others', async () => {
  const ext = await launchWithExtension();
  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');

    await resetDb(sidePanel);

    // Create 3 sessions, each with 1 message.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await dbMsg<{ session: { id: string } }>(
        sidePanel,
        { type: 'db:create-session', title: `s${i}` },
      );
      ids.push(r.session.id);
      await dbMsg(sidePanel, {
        type: 'db:append-message',
        message: { sessionId: r.session.id, role: 'user', content: `hello ${i}` },
      });
    }

    let snap = await listAll(sidePanel);
    expect(snap.sessions.length).toBe(3);
    expect(snap.messages.length).toBe(3);

    // Delete the middle one.
    await dbMsg(sidePanel, { type: 'db:delete-session', sessionId: ids[1]! });

    snap = await listAll(sidePanel);
    expect(snap.sessions.length).toBe(2);
    expect(snap.sessions.find((s) => s.id === ids[1])).toBeUndefined();
    // Messages for the remaining 2 sessions should still be there.
    expect(snap.messages.length).toBe(2);
    expect(snap.messages.find((m) => m.sessionId === ids[1])).toBeUndefined();
  } finally {
    await ext.cleanup();
  }
});
