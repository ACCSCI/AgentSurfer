// E2E: prove that the agent loop loads prior-turn conversation history
// into the `streamText({ messages })` call, instead of only the current
// prompt. This is the regression test for the context-loss bug where
// the LLM "forgot" every prior turn.
//
// Strategy (no API key needed — uses the mock LLM):
//   1. Seed mock provider (mock:textOnly) and disable all tools.
//   2. Turn 1: send "hello world" — wait for agent_done.
//   3. Turn 2: send "what did I just say?" — wait for agent_done.
//   4. Read SW log; assert that the SECOND turn's "history loaded"
//      diagnostic shows count >= 1 (i.e. the prior turn was included
//      in the LLM's input). The first turn's count is 0 (no history
//      yet). The "streamText messages" log shows messageCount >= 2
//      for turn 2 (history + current prompt).
//
// The behavioral confirmation — that the LLM actually USES the history
// to answer the second question — is a manual smoke test documented in
// `e2e/specs/38-history-load.MANUAL.md`. This test verifies the
// structural fix (the right messages reach the LLM).
//
// Diagnostic lines (added in lib/runtime/loop.ts, see commit history):
//   - "msgstore snapshot" — what's in the in-memory buffer at streamText time
//   - "history loaded"   — what buildHistoryMessages() produced
//   - "streamText messages" — what the loop actually fed the LLM
//
// Run: `bun run e2e -- e2e/specs/38-history-load.spec.ts`

import { expect, test } from '@playwright/test';

import { launchWithExtension } from '../fixtures/extension';

/**
 * Extract the parsed `history loaded` log lines from the SW log.
 * Each line is `...history loaded — { count, roles, dropped, totalChars }`.
 * We grab every match in order — the i-th match corresponds to the i-th
 * turn of the test (one agent run per turn).
 */
function parseHistoryLoadedLines(log: string): Array<{ count: number; roles: string[]; totalChars: number }> {
  const lines: Array<{ count: number; roles: string[]; totalChars: number }> = [];
  // Tolerate any prefix (scope, timestamp, log level). Look for the
  // distinctive substring "history loaded" then parse the JSON payload
  // that follows it. The logger emits `history loaded {"count":0,...}`
  // (space-separated real JSON), so we grab the first {...} after the tag.
  const re = /history loaded\s+(\{[^\n]*\})/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard while-let pattern
  while ((m = re.exec(log)) !== null) {
    const raw = m[1];
    const count = Number(/"count":\s*(\d+)/.exec(raw)?.[1] ?? -1);
    const rolesRaw = /"roles":\s*\[([^\]]*)\]/.exec(raw)?.[1] ?? '';
    const roles = rolesRaw
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const totalChars = Number(/"totalChars":\s*(\d+)/.exec(raw)?.[1] ?? -1);
    lines.push({ count, roles, totalChars });
  }
  return lines;
}

function parseMsgstoreSnapshotLines(
  log: string,
): Array<{ total: number; statuses: Record<string, number> }> {
  const lines: Array<{ total: number; statuses: Record<string, number> }> = [];
  const re = /msgstore snapshot\s+(\{[^\n]*\})/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard while-let pattern
  while ((m = re.exec(log)) !== null) {
    const raw = m[1];
    const total = Number(/"total":\s*(\d+)/.exec(raw)?.[1] ?? -1);
    const statuses: Record<string, number> = {};
    const statusBlock = /"statuses":\s*\{([^}]*)\}/.exec(raw)?.[1] ?? '';
    for (const pair of statusBlock.split(',')) {
      const [k, v] = pair.split(':').map((s) => s.trim());
      if (k) statuses[k.replace(/['"]/g, '')] = Number(v);
    }
    lines.push({ total, statuses });
  }
  return lines;
}

function parseStreamTextMessages(
  log: string,
): Array<{ messageCount: number; firstMsgRole: string | null }> {
  const lines: Array<{ messageCount: number; firstMsgRole: string | null }> = [];
  // The loop logs `streamText calling {"maxSteps":...,"messageCount":...}`.
  const re = /streamText calling\s+(\{[^\n]*\})/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard while-let pattern
  while ((m = re.exec(log)) !== null) {
    const raw = m[1];
    const messageCount = Number(/"messageCount":\s*(\d+)/.exec(raw)?.[1] ?? -1);
    const firstMsgRole = /"firstMsgRole":\s*"([^"]+)"/.exec(raw)?.[1] ?? null;
    lines.push({ messageCount, firstMsgRole });
  }
  return lines;
}

test('agent loop loads prior-turn history into streamText (mock LLM)', async () => {
  // Chrome can be slow to start when other Chrome windows are open on
  // the same machine. The fixture's sw-register already waits up to 20s
  // for the SW; we add 30s of headroom for the rest.
  test.setTimeout(90_000);
  const ext = await launchWithExtension();
  ext.clearSWLog();

  try {
    const { page: sidePanel } = await ext.openSidePanel();
    await sidePanel.waitForSelector('text=AgentSurfer');
    await ext.resetDb(sidePanel);

    // Seed a mock config directly via the SW (the same way seedLiveConfig
    // does for MiniMax/mimo). Avoids the Options UI entirely — more
    // reliable than `ext.seedMockConfig(sidePanel)` which navigates to
    // the Options form.
    await sidePanel.evaluate(async () => {
      const cfg = {
        id: `e2e-mock-${Date.now()}`,
        name: 'Mock (history-load E2E)',
        provider: 'mock',
        modelId: 'mock:happy',
        apiKey: 'mock-key-not-used',
        baseUrl: null,
        isDefault: true,
        createdAt: Date.now(),
      };
      await new Promise<void>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: '__e2e:seed-config', config: cfg }, (response) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
    });
    await sidePanel.reload();
    await sidePanel.waitForSelector('text=Mock', { timeout: 10_000 });

    // Disable every non-todo tool. The mock is a static script so tool
    // results don't matter — we just need the LLM to produce *some*
    // text we can wait on.
    await ext.enableOnlyTools(sidePanel, []);

    // ---------- Turn 1: "hello world" ----------
    await ext.setReactTextareaValue(sidePanel, 'textarea', 'hello world');
    await sidePanel.locator('button[title="Send"]').click();

    // Wait for turn 1 to finish.
    {
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        const running = await ext.isAgentRunning(sidePanel).catch(() => false);
        const bubbles = sidePanel.locator('[data-testid="message-bubble"]');
        const count = await bubbles.count();
        if (!running && count >= 2) break; // user + assistant
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // ---------- Turn 2: "what did I just say?" ----------
    await ext.setReactTextareaValue(sidePanel, 'textarea', 'what did I just say?');
    await sidePanel.locator('button[title="Send"]').click();

    {
      const start = Date.now();
      while (Date.now() - start < 15_000) {
        const running = await ext.isAgentRunning(sidePanel).catch(() => false);
        const bubbles = sidePanel.locator('[data-testid="message-bubble"]');
        const count = await bubbles.count();
        // 4 bubbles: user1, assistant1, user2, assistant2
        if (!running && count >= 4) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // Give Dexie a moment to flush.
    await new Promise((r) => setTimeout(r, 500));

    // ---------- Assertions ----------
    const log = ext.readSWLog();

    // Structural check 1: the SW log has TWO "history loaded" lines,
    // one per turn. If the diagnostic logging wasn't reached, the
    // loop never started — that's a much bigger problem than history.
    const hist = parseHistoryLoadedLines(log);
    expect(hist.length, '"history loaded" should appear at least twice (one per turn)').toBeGreaterThanOrEqual(2);

    // Turn 1: no prior history → count must be 0.
    expect(hist[0].count, 'turn 1: history should be empty (no prior turns)').toBe(0);

    // Turn 2: one prior turn in MessageStore. The prior USER message
    // ("hello world") is carried into history. The prior ASSISTANT
    // message is dropped by buildHistoryMessages when it has no text
    // and no tool calls — which is exactly the case for the mock LLM
    // (mock:textOnly streams an empty assistant turn here). Dropping a
    // content-less assistant message is correct: some providers reject
    // empty assistant messages. So history = [prior user] = count 1.
    expect(
      hist[1].count,
      'turn 2: history should contain the prior user message (empty assistant dropped) = 1',
    ).toBe(1);
    expect(
      hist[1].roles,
      'turn 2: history roles should be [user] (empty assistant dropped)',
    ).toEqual(['user']);
    expect(
      hist[1].totalChars,
      'turn 2: history totalChars should be > 0 (prior user text is non-empty)',
    ).toBeGreaterThan(0);

    // Structural check 2: msgstore snapshot — turn 2 should see
    // complete: 3 (user1, assistant1, user2) + draft: 1 (beginRun placeholder).
    const snaps = parseMsgstoreSnapshotLines(log);
    expect(snaps.length, '"msgstore snapshot" should appear at least twice').toBeGreaterThanOrEqual(2);
    expect(
      snaps[1].total,
      'turn 2: msgstore snapshot should see 4 messages (user1, assistant1, user2, draft assistant)',
    ).toBe(4);
    expect(
      snaps[1].statuses.complete,
      'turn 2: msgstore snapshot should have 3 complete messages',
    ).toBe(3);
    expect(
      snaps[1].statuses.draft,
      'turn 2: msgstore snapshot should have 1 draft (beginRun placeholder)',
    ).toBe(1);

    // Structural check 3: streamText calling — turn 2 should send
    // history + current = 1 + 1 = 2 messages to the LLM. (The prior
    // empty assistant message is dropped, so history is just [user].)
    const streamMsgs = parseStreamTextMessages(log);
    expect(
      streamMsgs.length,
      '"streamText calling" should appear at least twice',
    ).toBeGreaterThanOrEqual(2);
    expect(
      streamMsgs[1].messageCount,
      'turn 2: LLM should receive 2 messages (history[1] + current[1])',
    ).toBe(2);
    expect(
      streamMsgs[1].firstMsgRole,
      'turn 2: first message fed to LLM should be a user (from prior turn)',
    ).toBe('user');

    // Persistence check: the Dexie message store should hold 4 messages
    // (2 user + 2 assistant).
    const msgs = await ext.listMessages(sidePanel);
    expect(msgs.count, 'Dexie should have 4 persisted messages').toBe(4);
  } finally {
    await ext.cleanup();
  }
});
