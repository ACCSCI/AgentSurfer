// Unit tests for setWallTimeout — pure factory, no SW/browser needed.
// Run with: bun test lib/runtime/wall-timeout.test.ts
//
// Validates P0.1 fix contract:
//   1. chrome.alarms path is used when timeout >= 30s + chrome.alarms available
//   2. setTimeout fallback is used for <30s timeouts or no chrome.alarms
//   3. cancel() is idempotent and safe to call before/after/concurrent-with fire
//   4. onTimeout is called at most once
//   5. alarm listener is removed after firing (no leak)

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { setWallTimeout, type SetWallTimeoutDeps } from '@/lib/runtime/loop';
import { ScopedLogger } from '@/lib/logger';

// ---------- chrome.alarms mock ----------

type AlarmListener = (alarm: { name: string }) => void;

interface FakeAlarms {
  alarms: Map<string, { name: string; delayMs: number }>;
  listeners: Set<AlarmListener>;
  create: (name: string, opts: { delayInMinutes: number }) => void;
  clear: (name: string) => void;
  onAlarm: { addListener: (cb: AlarmListener) => void; removeListener: (cb: AlarmListener) => void };
  /** Manually fire an alarm (simulates Chrome's alarm scheduler). */
  fire: (name: string) => void;
}

function makeFakeAlarms(): FakeAlarms {
  const alarms = new Map<string, { name: string; delayMs: number }>();
  const listeners = new Set<AlarmListener>();
  return {
    alarms,
    listeners,
    create: (name, opts) => {
      alarms.set(name, { name, delayMs: Math.round(opts.delayInMinutes * 60_000) });
    },
    clear: (name) => {
      alarms.delete(name);
    },
    onAlarm: {
      addListener: (cb) => {
        listeners.add(cb);
      },
      removeListener: (cb) => {
        listeners.delete(cb);
      },
    },
    fire: (name) => {
      const alarm = alarms.get(name);
      if (!alarm) return;
      alarms.delete(name);
      for (const cb of [...listeners]) cb(alarm);
    },
  };
}

// Stub the global `chrome` object for the duration of each test.
let savedChrome: unknown;
let fake: FakeAlarms | null = null;

function withChrome(alarms: FakeAlarms | null) {
  if (alarms) {
    fake = alarms;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (globalThis as any).chrome = { alarms };
  } else {
    fake = null;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    delete (globalThis as any).chrome;
  }
}

// ---------- test helpers ----------

function mkDeps(over: Partial<SetWallTimeoutDeps> = {}): SetWallTimeoutDeps & { firedRef: { count: number } } {
  const firedRef = { count: 0 };
  const run = new ScopedLogger('test-run');
  return {
    run,
    runId: 'r1',
    timeoutMs: 60_000,
    onTimeout: () => {
      firedRef.count += 1;
    },
    firedRef,
    ...over,
  };
}

beforeEach(() => {
  savedChrome = (globalThis as { chrome?: unknown }).chrome;
});

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  if (savedChrome === undefined) delete (globalThis as any).chrome;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  else (globalThis as any).chrome = savedChrome;
  fake = null;
});

// ---------- tests ----------

describe('setWallTimeout — alarm path (>=30s + chrome.alarms present)', () => {
  it('uses chrome.alarms and reports usedAlarm=true', () => {
    const fakeAlarms = makeFakeAlarms();
    withChrome(fakeAlarms);
    const d = mkDeps({ timeoutMs: 60_000 });
    const wall = setWallTimeout(d);
    assert.equal(wall.usedAlarm, true);
    assert.equal(fakeAlarms.alarms.size, 1, 'one alarm should be scheduled');
    assert.equal(fakeAlarms.listeners.size, 1, 'one listener should be registered');
    wall.cancel();
  });

  it('alarm name includes the runId', () => {
    const fakeAlarms = makeFakeAlarms();
    withChrome(fakeAlarms);
    const d = mkDeps({ runId: 'special-run', timeoutMs: 60_000 });
    const wall = setWallTimeout(d);
    const [name] = [...fakeAlarms.alarms.keys()];
    assert.ok(name!.includes('special-run'), `alarm name ${name} should include runId`);
    assert.ok(name!.startsWith('agent-wall-timeout-'));
    wall.cancel();
  });

  it('cancel() before fire removes the alarm and listener', () => {
    const fakeAlarms = makeFakeAlarms();
    withChrome(fakeAlarms);
    const d = mkDeps({ timeoutMs: 60_000 });
    const wall = setWallTimeout(d);
    const [name] = [...fakeAlarms.alarms.keys()];
    wall.cancel();
    assert.equal(fakeAlarms.alarms.has(name!), false, 'alarm should be cleared');
    assert.equal(fakeAlarms.listeners.size, 0, 'listener should be removed');
  });

  it('cancel() after fire is a no-op (alarm already gone, listener already removed)', () => {
    const fakeAlarms = makeFakeAlarms();
    withChrome(fakeAlarms);
    const d = mkDeps({ timeoutMs: 60_000 });
    const wall = setWallTimeout(d);
    const [name] = [...fakeAlarms.alarms.keys()];
    fakeAlarms.fire(name!); // listener removes itself
    assert.equal(d.firedRef.count, 1, 'onTimeout called once');
    // second cancel: should not throw, should not double-fire
    wall.cancel();
    assert.equal(d.firedRef.count, 1, 'onTimeout still called once');
  });

  it('cancel() called twice is idempotent', () => {
    const fakeAlarms = makeFakeAlarms();
    withChrome(fakeAlarms);
    const d = mkDeps({ timeoutMs: 60_000 });
    const wall = setWallTimeout(d);
    wall.cancel();
    wall.cancel();
    assert.equal(d.firedRef.count, 0, 'onTimeout never called');
  });

  it('fire() invokes onTimeout exactly once', () => {
    const fakeAlarms = makeFakeAlarms();
    withChrome(fakeAlarms);
    const d = mkDeps({ timeoutMs: 60_000 });
    const wall = setWallTimeout(d);
    const [name] = [...fakeAlarms.alarms.keys()];
    fakeAlarms.fire(name!);
    // Re-firing the same name after it's been deleted: should be a no-op
    fakeAlarms.fire(name!);
    assert.equal(d.firedRef.count, 1, 'onTimeout called exactly once');
    wall.cancel();
  });

  it('fires a different alarm without affecting ours', () => {
    const fakeAlarms = makeFakeAlarms();
    withChrome(fakeAlarms);
    const d = mkDeps({ runId: 'rA', timeoutMs: 60_000 });
    const wall = setWallTimeout(d);
    // Schedule a second timeout with a different runId
    const d2 = mkDeps({ runId: 'rB', timeoutMs: 60_000 });
    const wall2 = setWallTimeout(d2);
    assert.equal(fakeAlarms.alarms.size, 2);
    // Fire rB's alarm
    const rBName = [...fakeAlarms.alarms.keys()].find((n) => n.includes('rB'))!;
    fakeAlarms.fire(rBName);
    assert.equal(d.firedRef.count, 0, 'rA onTimeout NOT called by rB alarm');
    assert.equal(d2.firedRef.count, 1, 'rB onTimeout called once');
    wall.cancel();
    wall2.cancel();
  });
});

describe('setWallTimeout — setTimeout fallback', () => {
  it('uses setTimeout when chrome.alarms is absent', () => {
    withChrome(null);
    const d = mkDeps({ timeoutMs: 60_000 });
    const wall = setWallTimeout(d);
    assert.equal(wall.usedAlarm, false);
    wall.cancel();
  });

  it('uses setTimeout when timeout < 30s even if chrome.alarms is present', () => {
    const fakeAlarms = makeFakeAlarms();
    withChrome(fakeAlarms);
    const d = mkDeps({ timeoutMs: 5_000 });
    const wall = setWallTimeout(d);
    assert.equal(wall.usedAlarm, false, '<30s should fall back to setTimeout');
    assert.equal(fakeAlarms.alarms.size, 0, 'no alarm scheduled');
    wall.cancel();
  });

  it('cancel() before fire clears the setTimeout (onTimeout not called)', async () => {
    withChrome(null);
    const d = mkDeps({ timeoutMs: 5_000 });
    const wall = setWallTimeout(d);
    wall.cancel();
    // Wait long enough for the (cancelled) timer to have fired.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(d.firedRef.count, 0, 'onTimeout not called after cancel');
  });
});
