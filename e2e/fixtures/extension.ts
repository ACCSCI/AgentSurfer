// E2E launcher: starts a persistent Chromium context with the unpacked
// extension, waits for the service worker, and returns helpers for navigating
// the side panel / options page and seeding Dexie with a test config.

import { type BrowserContext, chromium, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import path from 'node:path';

import { traceStart, traceEnd, traceFail } from './trace';

const SW_LOG = path.resolve('.e2e-logs/sw.log');
const USER_DATA_ROOT = path.resolve('.e2e-logs/chrome-userdata');
const SHOTS_ROOT = path.resolve('.e2e-logs');

/**
 * Module-level log helpers. Specs that need to call these BEFORE
 * `launchWithExtension()` (e.g. to truncate the log so a prior run
 * doesn't pollute the new one) cannot reach them through the handle
 * — the handle doesn't exist yet. So we also export them here at
 * module scope. See CLAUDE.md §5.3 (clearSWLog before launch).
 */
export function readSWLog(): string {
  try { return readFileSync(SW_LOG, 'utf-8'); } catch { return ''; }
}

export function clearSWLog(): void {
  try { writeFileSync(SW_LOG, ''); } catch { /* ignore */ }
}

/**
 * Find all SW-log lines containing `haystack`. The `label` arg is kept
 * for readability at call sites (e.g. `'wall-alarm fired'`) but is not
 * used in matching — it's purely a doc string.
 *
 * Despite the name, this does NOT throw on zero matches. The caller is
 * expected to wrap the result in `expect(...).toHaveLength(N)`.
 */
export function assertLogContains(haystack: string, _label: string): string[] {
  return readSWLog().split('\n').filter((line) => line.includes(haystack));
}

/**
 * Inverse of assertLogContains: returns lines that do NOT contain the
 * substring. Use to assert "log should be free of X" — e.g.
 * `expect(assertLogClean('consumeStream error', 'no stream errors')).toHaveLength(0)`.
 */
export function assertLogClean(needle: string, _label: string): string[] {
  return readSWLog().split('\n').filter((line) => line && !line.includes(needle));
}

/**
 * Send a `db:*` message to the SW via the `e2e-diag` port and return
 * the unwrapped `data` field. Throws on `!ok` so callers don't have to
 * check the envelope (see CLAUDE.md §7.3).
 */
export async function dbMsg(page: Page, message: { type: string; [k: string]: unknown }): Promise<unknown> {
  const res = (await dbMsgPort(page, message)) as { ok: boolean; data?: unknown; error?: string };
  if (!res?.ok) throw new Error(res?.error ?? `dbMsg ${message.type} failed`);
  return res.data;
}

/** Send a raw `db:*` message via the `e2e-diag` port. Returns the full
 *  `{ok, data, error}` envelope. Prefer `dbMsg` for typed reads. */
export async function dbMsgPort(page: Page, message: { type: string; [k: string]: unknown }): Promise<unknown> {
  return page.evaluate(async (msg) => {
    const port = chrome.runtime.connect({ name: 'e2e-diag' });
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('port timeout: ' + msg.type)), 10000);
      port.onMessage.addListener(function handler(response) {
        clearTimeout(timeout);
        port.disconnect();
        resolve(response);
      });
      port.postMessage(msg);
    });
    return result;
  }, message);
}

/** Wipe Dexie via the `__e2e:reset` SW handler. Wait 200ms after to
 *  avoid the `db.delete() + db.open()` race noted in CLAUDE.md §7. */
export async function resetDb(page: Page): Promise<void> {
  await dbMsgPort(page, { type: '__e2e:reset' });
  await new Promise((r) => setTimeout(r, 200));
}

/** E2E helper: list every active chrome.alarms entry. */
export async function listAlarms(page: Page): Promise<string[]> {
  return (await dbMsg(page, { type: '__e2e:list-alarms' })) as string[];
}

/** E2E helper: read every RunRecord from the checkpoint. */
export async function readCheckpoint(page: Page): Promise<Array<{
  runId: string;
  sessionId: string;
  startMs: number;
  modelId: string;
  wallTimeoutMs: number;
  status: string;
  lastStepNumber: number;
}>> {
  return (await dbMsg(page, { type: '__e2e:read-checkpoint' })) as Array<{
    runId: string; sessionId: string; startMs: number; modelId: string;
    wallTimeoutMs: number; status: string; lastStepNumber: number;
  }>;
}

/** E2E helper: force the SW to reload via chrome.runtime.reload().
 *  The Playwright fixture will detect the new SW automatically. */
export async function simulateSWRestart(page: Page): Promise<void> {
  await dbMsgPort(page, { type: '__e2e:simulate-sw-restart' });
}

/** E2E helper: force checkpoint.sweepStaleRuns() to run now. Returns
 *  the list of abandoned RunRecords. */
export async function armSweep(page: Page): Promise<Array<{
  runId: string;
  sessionId: string;
  startMs: number;
  wallTimeoutMs: number;
}>> {
  const res = (await dbMsg(page, { type: '__e2e:arm-sweep' })) as {
    abandonedCount: number;
    abandoned: Array<{ runId: string; sessionId: string; startMs: number; wallTimeoutMs: number }>;
  };
  return res.abandoned;
}

/** E2E helper: override the agent's wall-clock timeout. */
export async function setWallTimeout(page: Page, ms: number): Promise<void> {
  await dbMsgPort(page, { type: '__e2e:set-wall-timeout', ms });
}

/** E2E helper: read MINIMAX_API_KEY (or other var) from .env. */
export function readApiKey(varName: string = 'MINIMAX_API_KEY'): string {
  const txt = readFileSync(pathResolve('.env'), 'utf-8');
  const m = txt.match(new RegExp(`^${varName}=(.+)$`, 'm'));
  const v = m?.[1]?.trim();
  if (!v) throw new Error(`${varName} missing from .env`);
  return v;
}

/** E2E helper: poll the SW log until a marker line appears, or throw
 *  after `timeoutMs`. Use to assert asynchronous events without
 *  arbitrary setTimeout waits in the test body. */
export async function waitForLogMarker(
  marker: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = assertLogContains(marker, marker);
    if (last.length > 0) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitForLogMarker: marker "${marker}" not seen within ${timeoutMs}ms. ` +
      `Last SW log tail: ${readSWLog().split('\n').slice(-5).join(' | ')}`,
  );
}

/**
 * List every Dexie row + change counter — used by error-handling /
 * cascade-delete / data-layer specs. Returns a structured snapshot.
 */
export async function listAll(page: Page): Promise<{
  sessions: unknown[];
  messages: unknown[];
  agentSteps: unknown[];
  screenshots: unknown[];
  modelConfigs: unknown[];
  toolConfigs: unknown[];
  changeCounters: Record<string, number>;
}> {
  const data = (await dbMsg(page, { type: '__e2e:list-all' })) as {
    sessions: unknown[];
    messages: unknown[];
    agentSteps: unknown[];
    screenshots: unknown[];
    modelConfigs: unknown[];
    toolConfigs: unknown[];
    changeCounters: Record<string, number>;
  };
  return data;
}

// Always use ABSOLUTE path for the extension dir. Relative paths get
// normalized by Chrome on Windows which can strip the leading "." —
// then Chrome reports "清单文件缺失" (manifest missing) because it
// looks at `output\chrome-mv3` (no dot) instead of `.output\chrome-mv3`.
const PROJECT_ROOT = path.resolve('.');
// Allow override via env var (e.g. when wxt's `.output` build dir is
// being stripped of its leading dot by Chrome on Windows — point the
// fixture at a junction/symlink with a non-dot name, e.g.
//   mklink /J D:\Projects\BrowserAI\chrome-mv3 D:\Projects\BrowserAI\.output\chrome-mv3
//   EXTENSION_PATH=D:\Projects\BrowserAI\chrome-mv3 bun run e2e -- ...
// ).
const EXTENSION_PATH = process.env.EXTENSION_PATH
  ? path.resolve(process.env.EXTENSION_PATH)
  : path.join(PROJECT_ROOT, '.output', 'chrome-mv3');

// All non-todo tool names. `todo` is always added by the agent runtime
// (lib/agent.ts) and cannot be disabled.
// `cdpClick` was removed on 2026-06-19 — the LLM was abusing it as a
// "skip visual feedback" shortcut. The only sanctioned click path is
// cdpAim → cdpConfirm. cdpClick.execute() is still available in
// lib/tools.ts for internal/E2E use, just not exposed as an LLM tool.
const ALL_NON_TODO_TOOLS = [
  'cdpAim', 'cdpConfirm', 'cdpScroll', 'cdpCancel',
  'cdpType', 'cdpPressKey', 'cdpScreenshot', 'cdpGridScreenshot',
  'focusNext', 'focusPrevious',
  'smartScreenshot', 'screenshot',
  'tabsList', 'tabsSwitch', 'tabsOpen', 'tabsClose',
  'domQuery', 'domClick', 'domType', 'pressKey',
] as const;

// Per-launch Chrome user data dir. We use a unique fresh dir to prevent
// Chrome from serving a cached older version of the extension's SW JS
// (manifest version bumps alone don't always force Chrome to reload).
let launchCounter = 0;

export interface SnapshotResult {
  tMs: number;
  textLength: number;
  screenshot: string;
  isDone: boolean;
}

export interface ExtensionHandle {
  ctx: BrowserContext;
  extId: string;
  sw: import('@playwright/test').Worker;
  /** Opens sidepanel.html in a new tab-like page (not actually in the side panel — Playwright can't open the real side panel UI, but it can load the sidepanel.html directly). */
  openSidePanel: () => Promise<{ page: Page; url: string }>;
  openOptions: () => Promise<Page>;
  seedMockConfig: (page: Page) => Promise<void>;
  seedLiveConfig: (
    page: Page,
    provider: 'MiniMax' | 'mimo' | 'stepfun',
    apiKey: string,
    options?: { modelId?: string; reasoningEffort?: 'low' | 'medium' | 'high' },
  ) => Promise<void>;
  cleanup: () => Promise<void>;
  // ---- Live-LLM E2E helpers (used by specs 20/21/22) ----
  clearSWLog: () => void;
  dbMsg: (page: Page, msg: { type: string; [k: string]: unknown }) => Promise<unknown>;
  resetDb: (page: Page) => Promise<void>;
  enableOnlyTools: (page: Page, names: readonly string[]) => Promise<void>;
  setReactTextareaValue: (page: Page, selector: string, value: string) => Promise<void>;
  captureSnapshots: (page: Page, opts: {
    intervalMs: number; durationMs: number; label: string;
  }) => Promise<SnapshotResult[]>;
  readApiKey: (varName?: string) => string;
  inspectTabs: (page: Page) => Promise<{ count: number; urls: string[]; ids: number[] }>;
  setWallTimeout: (page: Page, ms: number) => Promise<void>;
  getAssistantTextLength: (page: Page) => Promise<number>;
  isAgentRunning: (page: Page) => Promise<boolean>;
  readSWLog: () => string;
  listAgentSteps: (page: Page) => Promise<{ steps: unknown[]; count: number }>;
  listMessages: (page: Page) => Promise<{ messages: unknown[]; count: number }>;
}

export async function launchWithExtension(): Promise<ExtensionHandle> {
  // Pre-flight: verify the extension manifest is present BEFORE Chrome
  // launches. If the build hasn't finished or the path is wrong, fail
  // fast with a clear message — don't let Chrome report "manifest
  // missing" in a Windows file dialog (which hides the leading dot and
  // makes the error look like a path bug instead of a build issue).
  const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
  // Loud diagnostic: print the actual path the test is using. This
  // makes it obvious in the test output whether Chrome is loading
  // from the right place, even if the Windows file dialog hides
  // the leading dot.
  console.log(`[fixture] EXTENSION_PATH = ${EXTENSION_PATH}`);
  console.log(`[fixture] manifest.json  = ${manifestPath}`);
  console.log(`[fixture] manifest exists = ${existsSync(manifestPath)}`);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Extension manifest missing at ${manifestPath}\n` +
      `EXTENSION_PATH=${EXTENSION_PATH}\n` +
      `CWD=${process.cwd()}\n` +
      `Run \`bun run build\` and retry.`
    );
  }
  try {
    JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new Error(`Extension manifest is not valid JSON: ${manifestPath}\n${err}`);
  }

  traceStart('1 browser launch');
  // Fresh per-launch user data dir. We use a timestamped subdir of
  // USER_DATA_ROOT so Chrome doesn't reuse a previously-installed
  // version of the extension (which can be cached even with manifest
  // version bumps, and would cause tests to silently run against stale JS).
  const userDataDir = path.join(USER_DATA_ROOT, `run-${Date.now()}-${++launchCounter}`);
  mkdirSync(userDataDir, { recursive: true });

  traceStart('2 context create');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  traceEnd('2 context create', { userDataDir });

  // Wait for the service worker to register. The SW URL is
  // `chrome-extension://<extId>/background.js`.
  //
  // Strategy (race-safe, predicate-filtered):
  //   1. Poll already-registered SWs first. Catches SWs registered
  //      before Playwright's listener was attached.
  //   2. If not found, waitForEvent with a `predicate` that EXACTLY
  //      matches `/background.js$` at the end of the URL. This
  //      rejects any other extension's SW or Chrome's internal SW.
  traceStart('3 sw register');
  const isOurSw = (w: { url: () => string }) => /\/background\.js$/.test(w.url());
  const existing = ctx.serviceWorkers().find(isOurSw);
  let sw: { url: () => string } | null = null;
  if (existing) {
    sw = existing;
    traceEnd('3 sw register (poll)', { swUrl: existing.url(), via: 'poll' });
  } else {
    const ev = await ctx.waitForEvent('serviceworker', {
      predicate: isOurSw,
      // Bumped from 20s → 40s to absorb the SW register race documented
      // in CLAUDE.md §7.8 / §6.1 P0.10. Chrome can half-load the
      // extension and report "manifest missing" before Playwright's
      // listener attaches; the longer window gives the SW a real
      // chance to register. The race-safe pattern above (poll first,
      // then predicate-filtered wait) is unchanged.
      timeout: 40_000,
    }).catch(() => null);
    if (ev) {
      sw = ev;
      traceEnd('3 sw register (event)', { swUrl: ev.url(), via: 'event+predicate' });
    } else {
      traceFail('3 sw register', new Error('SW never registered in 40s'));
      throw new Error('Service worker did not register within 40s. Check .output/chrome-mv3/manifest.json exists and has no syntax errors. See CLAUDE.md §7.8.');
    }
  }
  // Forward SW console + network to the test runner so we can see what's
  // happening. SW pages are also Pages from Playwright's perspective.
  const swLog = (line: string) => {
    console.log(line);
    try {
      appendFileSync(SW_LOG, line + '\n');
    } catch {
      // ignore
    }
  };
  sw.on('console', (msg) => {
    swLog(`[SW:${msg.type()}] ${msg.text()}`);
  });
  sw.on('request', (req) => {
    if (req.url().includes('anthropic') || req.url().includes('minimaxi') || req.url().includes('xiaomimimo') || req.url().includes('stepfun')) {
      swLog(`[SW:req] ${req.method()} ${req.url()} ${JSON.stringify(req.postData()?.slice(0, 200))}`);
    }
  });
  sw.on('response', (res) => {
    if (res.url().includes('anthropic') || res.url().includes('minimaxi') || res.url().includes('xiaomimimo') || res.url().includes('stepfun')) {
      swLog(`[SW:res] ${res.status()} ${res.url()}`);
    }
  });
  sw.on('requestfailed', (req) => {
    if (req.url().includes('anthropic') || req.url().includes('minimaxi') || req.url().includes('xiaomimimo') || req.url().includes('stepfun')) {
      swLog(`[SW:req-failed] ${req.url()} ${req.failure()?.errorText}`);
    }
  });

  const swUrl = new URL(sw.url());
  const extId = swUrl.host;

  // Open the side panel IMMEDIATELY (right after SW is ready) so the
  // user never sees the "only about:blank" initial state. Retry up to
  // 3× since chrome-extension:// navigation is occasionally flaky in
  // Playwright headless (the page can end up stuck at about:blank).
  const sidePanelUrl = `chrome-extension://${extId}/sidepanel.html`;
  let sidePanel: Awaited<ReturnType<typeof openSidePanelOnce>>['page'] | null = null;
  async function openSidePanelOnce() {
    traceStart('4 page create (side panel)');
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('[AgentSurfer]')) console.log(`[SP:console]`, t);
    });
    page.on('pageerror', (err) => {
      console.log(`[SP:pageerror]`, err.message);
    });
    traceStart('5 goto side panel');
    await page.goto(sidePanelUrl);
    traceEnd('5 goto side panel', { url: page.url() });
    return { page, url: page.url() };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await openSidePanelOnce();
      traceEnd('4 page create (side panel)');
      // Verify the navigation actually landed on the extension URL.
      // If page.url() is still about:blank, the goto failed silently.
      if (r.url.startsWith('chrome-extension://')) {
        sidePanel = r.page;
        break;
      }
      console.log(`[fixture] side panel goto returned URL ${r.url}, retrying (attempt ${attempt}/3)`);
      await r.page.close().catch(() => {});
    } catch (err) {
      traceFail('4 page create (side panel)', err, { attempt });
      console.log(`[fixture] side panel goto threw: ${err instanceof Error ? err.message : err} (attempt ${attempt}/3)`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
  }
  if (!sidePanel) throw new Error('Side panel failed to load after 3 attempts. Check SW registration.');

  // Wait for the React app to mount (look for the AgentSurfer heading).
  traceStart('6 extension ready (AgentSurfer heading)');
  try {
    await sidePanel.waitForSelector('text=AgentSurfer', { timeout: 10_000 });
    traceEnd('6 extension ready (AgentSurfer heading)');
  } catch (err) {
    traceFail('6 extension ready (AgentSurfer heading)', err);
    // Best-effort. Test code can wait again if needed.
  }

  function openSidePanel() {
    // The side panel is already open. Return the existing one (don't
    // create a duplicate tab). Tests that previously called this
    // expecting a fresh page will keep working — they get the same page.
    return Promise.resolve({ page: sidePanel!, url: sidePanel!.url() });
  }

  function openOptions() {
    const url = `chrome-extension://${extId}/options.html`;
    return ctx.newPage().then(async (page) => {
      await page.goto(url);
      return page;
    });
  }

  /** Seed a mock provider config via the options form. */
  async function seedMockConfig(page: Page) {
    await page.click('button[title="Settings"]');
    await page.waitForSelector('text=Add model configuration', { timeout: 10_000 });
    await page.selectOption('#provider', 'mock');
    await page.fill('#model', 'mock:happy');
    await page.fill('#key', 'mock-key-not-used');
    await page.click('button[type="submit"]');
    await page.waitForSelector('text=Saved', { timeout: 5_000 });
  }

  /**
   * Seed a live LLM config directly via the SW (bypasses the options form
   * so we don't have to type a real API key into the form). Provider-specific
   * defaults come from types/model.ts.
   *
   * Optional `options.modelId` overrides the provider's default model
   * (useful for spec-specific cases like MiniMax's M2 vs M3 or StepFun's
   * 3.5-flash-2603 vs 3.7-flash). `options.reasoningEffort` is forwarded
   * to the ModelConfig (only meaningful for StepFun today).
   */
  async function seedLiveConfig(
    page: Page,
    provider: 'MiniMax' | 'mimo' | 'stepfun',
    apiKey: string,
    options?: { modelId?: string; reasoningEffort?: 'low' | 'medium' | 'high' },
  ) {
    const configId = `e2e-${provider}-${Date.now()}`;
    const seedRes = await page.evaluate(
      async ({ configId, provider, apiKey, options }) => {
        const modelId =
          options?.modelId
          ?? (provider === 'MiniMax'
            ? 'MiniMax-M3'
            : provider === 'mimo'
              ? 'mimo-v2.5-pro'
              : 'step-3.7-flash');
        const cfg: Record<string, unknown> = {
          id: configId,
          name: `${provider} (live E2E)`,
          provider,
          modelId,
          apiKey,
          baseUrl: null,
          isDefault: true,
          createdAt: Date.now(),
        };
        if (options?.reasoningEffort) cfg.reasoningEffort = options.reasoningEffort;
        const seed = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: '__e2e:seed-config', config: cfg }, (response) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(response);
          });
        });
        return seed;
      },
      { configId, provider, apiKey, options: options ?? null },
    );
    return seedRes;
  }

  /** Send a db:* message via port (reliable async response). */
  async function dbMsgPort(page: Page, message: { type: string; [k: string]: unknown }): Promise<unknown> {
    return page.evaluate(async (msg) => {
      const port = chrome.runtime.connect({ name: 'e2e-diag' });
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('port timeout: ' + msg.type)), 10000);
        port.onMessage.addListener(function handler(response) {
          clearTimeout(timeout);
          port.disconnect();
          resolve(response);
        });
        port.postMessage(msg);
      });
      return result;
    }, message);
  }

  async function cleanup() {
    await ctx.close().catch(() => {});
    // Best-effort cleanup of the per-launch user data dir to avoid
    // accumulating hundreds of MB of cached Chrome state.
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }

  // ============================================================
  // Live-LLM E2E helpers (specs 20 / 21 / 22)
  // ============================================================
  // The log helpers (clearSWLog / readSWLog / assertLogContains) are
  // exported at module scope (see top of file) so specs can call them
  // BEFORE launchWithExtension returns. The handle returned below
  // re-exports the same functions for callers that already hold the
  // handle — there's only one implementation, both bindings point to it.

  /** Send a db:* SW message and return the unwrapped data (ok branch). */
  async function dbMsg(page: Page, message: { type: string; [k: string]: unknown }): Promise<unknown> {
    const res = (await dbMsgPort(page, message)) as { ok: boolean; data?: unknown; error?: string };
    if (!res?.ok) throw new Error(res?.error ?? `dbMsg ${message.type} failed`);
    return res.data;
  }

  /** Wipe Dexie. Wait 200ms after to avoid the open/close race noted in CLAUDE.md §7. */
  async function resetDb(page: Page): Promise<void> {
    await dbMsgPort(page, { type: '__e2e:reset' });
    await new Promise((r) => setTimeout(r, 200));
  }

  /** Disable every non-todo tool, then enable exactly `names`. */
  async function enableOnlyTools(page: Page, names: readonly string[]): Promise<void> {
    const want = new Set(names);
    for (const n of ALL_NON_TODO_TOOLS) {
      const enabled = want.has(n);
      await dbMsgPort(page, { type: 'db:set-tool-enabled', name: n, enabled });
    }
  }

  /**
   * Set the value of a React-controlled textarea via the native value setter
   * (Playwright's `fill()` does not trigger React's onChange on controlled inputs).
   * Pattern copied from e2e/specs/04-real-google-search.spec.ts.
   */
  async function setReactTextareaValue(page: Page, selector: string, value: string): Promise<void> {
    await page.locator(selector).waitFor({ state: 'visible' });
    await page.locator(selector).evaluate((el, v) => {
      const ta = el as HTMLTextAreaElement;
      const proto = Object.getPrototypeOf(ta) as object;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) (setter as (v: string) => void).call(ta, v);
      else ta.value = v;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }

  /** Length of the LAST [data-testid="message-bubble"] text content. */
  async function getAssistantTextLength(page: Page): Promise<number> {
    const bubbles = page.locator('[data-testid="message-bubble"]');
    const count = await bubbles.count();
    if (count === 0) return 0;
    const last = bubbles.nth(count - 1);
    const txt = await last.textContent();
    return txt?.length ?? 0;
  }

  /** True if the agent is running (Cancel button is visible in InputBar). */
  async function isAgentRunning(page: Page): Promise<boolean> {
    return page.locator('button[title="Cancel run"]').isVisible().catch(() => false);
  }

  /**
   * Take periodic screenshots of the side panel and record assistant text length.
   * Each screenshot is saved to `.e2e-logs/<label>-t<seconds>s.png`.
   * The loop also stops early if the agent is no longer running AND a t=0 snapshot
   * was taken at least once, so a fast "hi" reply doesn't waste the full window.
   */
  async function captureSnapshots(
    page: Page,
    opts: { intervalMs: number; durationMs: number; label: string },
  ): Promise<SnapshotResult[]> {
    const out: SnapshotResult[] = [];
    const t0 = Date.now();
    let tick = 0;
    // Take the first snapshot immediately (t=0).
    for (;;) {
      const tMs = Date.now() - t0;
      const sec = Math.round(tMs / 1000);
      const fname = `${opts.label}-t${sec}s.png`;
      const fpath = path.join(SHOTS_ROOT, fname);
      try { await page.screenshot({ path: fpath, fullPage: true }); } catch { /* ignore */ }
      const textLength = await getAssistantTextLength(page).catch(() => 0);
      const running = await isAgentRunning(page).catch(() => false);
      const isDone = !running && tMs > 500; // give SP 500ms to mount Cancel button
      out.push({ tMs, textLength, screenshot: fpath, isDone });
      console.log(`[${opts.label}] t=${sec}s textLength=${textLength} running=${running} done=${isDone} -> ${fpath}`);
      if (tMs >= opts.durationMs) break;
      if (isDone && tick >= 1) {
        // Agent finished before window closed. Take one final shot + exit.
        const finalSec = Math.round((Date.now() - t0) / 1000);
        const ffinal = path.join(SHOTS_ROOT, `${opts.label}-t${finalSec}s-final.png`);
        try { await page.screenshot({ path: ffinal, fullPage: true }); } catch { /* ignore */ }
        out.push({ tMs: Date.now() - t0, textLength, screenshot: ffinal, isDone: true });
        console.log(`[${opts.label}] agent finished early at t=${finalSec}s`);
        break;
      }
      tick += 1;
      await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
    return out;
  }

  /** Read a single var from `.env`. Throws if missing. */
  function readApiKey(varName: string = 'MINIMAX_API_KEY'): string {
    const txt = readFileSync(pathResolve('.env'), 'utf-8');
    const m = txt.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    const v = m?.[1]?.trim();
    if (!v) throw new Error(`${varName} missing from .env`);
    return v;
  }

  /** Snapshot of every tab visible to the extension. */
  async function inspectTabs(page: Page): Promise<{ count: number; urls: string[]; ids: number[] }> {
    return (await dbMsg(page, { type: '__e2e:inspect-tabs' })) as { count: number; urls: string[]; ids: number[] };
  }

  /** Override the agent's wall-clock timeout (ms). */
  async function setWallTimeout(page: Page, ms: number): Promise<void> {
    await dbMsgPort(page, { type: '__e2e:set-wall-timeout', ms });
  }

  /** Read every persisted agent step (text, toolCalls, toolResults). */
  async function listAgentSteps(page: Page): Promise<{ steps: unknown[]; count: number }> {
    return (await dbMsg(page, { type: '__e2e:list-agent-steps' })) as { steps: unknown[]; count: number };
  }

  /** Read every persisted message (user + assistant). */
  async function listMessages(page: Page): Promise<{ messages: unknown[]; count: number }> {
    return (await dbMsg(page, { type: '__e2e:list-messages' })) as { messages: unknown[]; count: number };
  }

  /**
   * Build the side panel's base64-free session export via the SW. Screenshot
   * blobs are excluded (metadata only). Pass a sessionId or omit to use the
   * most recently created session.
   */
  async function exportSession(
    page: Page,
    sessionId?: string,
  ): Promise<{ export: Record<string, unknown> | null; error?: string }> {
    return (await dbMsg(page, { type: '__e2e:export-session', sessionId })) as {
      export: Record<string, unknown> | null;
      error?: string;
    };
  }

  return {
    ctx, extId, sw, openSidePanel, openOptions, seedMockConfig, seedLiveConfig, cleanup,
    clearSWLog, dbMsg, resetDb, enableOnlyTools, setReactTextareaValue, captureSnapshots,
    readApiKey, inspectTabs, setWallTimeout, getAssistantTextLength, isAgentRunning, readSWLog,
    assertLogContains, listAgentSteps, listMessages, exportSession,
  };
}
