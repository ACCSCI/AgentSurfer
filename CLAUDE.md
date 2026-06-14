# AgentSurfer — Architecture Source of Truth

This document is the **authoritative source** for all architectural rules. Every change must respect these rules. When rules conflict with code, **the code is wrong**, not the rule.

---

## 1. The 8 Architecture Rules (Runtime)

These are non-negotiable. They define the boundary between Runtime (Service Worker + Agent) and UI (Side Panel + Options).

| # | Rule | What it means in practice |
|---|------|---------------------------|
| 1 | **Runtime must be event-driven.** | No request/response, no direct method calls. Output flows through events. |
| 2 | **Runtime must never manipulate UI state.** | Runtime (Zustand, React state) is **read-only** from Runtime. Runtime may write to Dexie (persistence) but not to UI state. |
| 3 | **Runtime must emit events immediately when available.** | No buffering. As soon as data is available, emit it. |
| 4 | **Runtime must never wait for full LLM completion.** | `streamText()` is called and `consumeStream()` is fire-and-forget. Never `await result.text`. |
| 5 | **Agent execution must not return a final response object.** | `runAgent(): Promise<void>`. All output is via `emit()`. |
| 6 | **Long-running tasks must communicate exclusively through event streams.** | Fire-and-forget, never block on agent completion. |
| 7 | **Tool calls, tool results, tokens, todos, progress updates, and errors must be distinct event types.** | No "catch-all" `update` events. Each concept has its own type. |
| 8 | **UI consumes events and owns presentation state.** | UI updates Zustand from events. UI owns what is rendered, how it's animated, when it's cleared. |
| 9 | **Tool errors are Observations, not termination conditions.** | The Agent Loop terminates ONLY for: (a) user cancel, (b) max steps, (c) fatal system error, (d) task complete. Ordinary tool errors are returned to the LLM as `{ error: string }` observations; the LLM decides what to do next. See `safeExecute` in `lib/tools.ts` and `onError` in `lib/agent.ts`. |

### Event types in use

| Event | When | Producer |
|-------|------|-----------|
| `user_message` | User prompt captured | Runtime |
| `model_ready` | LLM instance created | Runtime |
| `chunk` | LLM streaming delta (text/reasoning/tool-call) | Runtime |
| `tool_call` | Full tool call ready (not delta) | Runtime |
| `tool_result` | Tool execution completed | Runtime |
| `token_usage` | Per-step prompt/completion tokens | Runtime |
| `progress` | Step counter update | Runtime |
| `todo_update` | Agent's todo list replaced | Runtime |
| `step_done` | Step boundary, persisted to Dexie | Runtime |
| `agent_done` | Run completed (with total usage) | Runtime |
| `agent_error` | Run failed | Runtime |

---

## 2. MV3 Service Worker Rules (Chrome Platform)

### 2.1 Never store state in module-level variables

The SW can be killed at any time. Anything in a `let` or `const` at module scope is volatile.

```ts
// ❌ BAD
let counter = 0;
const cache = new Map();

// ✅ GOOD
const data = await chrome.storage.local.get('counter');
```

**Exceptions** (state that is allowed in module scope):
- `chrome.runtime.onMessage.addListener` registration (must be sync at top level)
- Static configuration (immutable)

### 2.2 Use `chrome.alarms` for timers, never `setTimeout`/`setInterval`

Alarms persist across SW restarts. Timers die with the SW.

```ts
// ❌ BAD
setTimeout(doWork, 60000);
setInterval(ping, 25000);

// ✅ GOOD
chrome.alarms.create('work', { delayInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'work') doWork();
});
```

Minimum alarm interval: **0.5 minutes** (30 seconds).

### 2.3 No keepalive needed

The SW is **already alive** while processing messages. After the message handler returns and there are no more pending events, Chrome will idle-timeout the SW. **Do not abuse keepalive patterns** — Chrome may enforce stricter limits in future versions.

If you genuinely need the SW to stay alive (e.g., long agent run), use **active port connections** from the side panel, not `setInterval`.

### 2.4 Use `chrome.storage.session` for in-flight state

`chrome.storage.session` survives SW restarts but not browser restarts. Use it for:
- `inflight_runs` (Map of runId → startTime)
- `agent_run_state` (current step, accumulated text)

### 2.5 All event listeners must be registered synchronously at top level

Chrome replays events only to listeners that were registered synchronously when the SW loaded. Don't register listeners inside async functions.

```ts
// ✅ GOOD — at top level
chrome.runtime.onMessage.addListener(handler);
chrome.alarms.onAlarm.addListener(handler);
```

### 2.6 `return true` in `onMessage` listeners with async responses

```ts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const result = await handle(message);
    sendResponse({ ok: true, data: result });
  })();
  return true; // keep channel open
});
```

---

## 3. Data Layer Rules

### 3.1 Single-writer rule

**Only the Service Worker writes to Dexie.** Side Panel, Options, and Content Scripts must go through `chrome.runtime.sendMessage({ type: 'db:*' })`.

The SW is the only caller of `lib/data-layer.ts`. No other module may import from `data-layer`.

### 3.2 Cross-context sync via `chrome.storage.local` change counters

After every Dexie write, the data layer increments a counter in `chrome.storage.local`:

```
__db_change_sessions
__db_change_messages
__db_change_agentSteps
__db_change_screenshots
__db_change_modelConfigs
__db_change_toolConfigs
```

Other contexts subscribe via `chrome.storage.onChanged` and re-query Dexie.

### 3.3 Concurrent counter writes are serialized

`broadcastChange()` is serialized per-table via an in-process Promise chain. The chain is reset on SW restart, but counters are persisted in `chrome.storage.local` so this is safe.

### 3.4 Project layout for data

```
lib/db.ts          — Dexie schema, READ-ONLY helpers (getActiveConfig, getMessagesBySession, etc.)
lib/data-layer.ts  — WRITE-ONLY functions (createSession, appendMessage, etc.) — SW only
lib/use-change-count.ts — React hook that subscribes to a table's change counter
```

---

## 4. Boundary Rules (Who Can Talk to Whom)

| Module | Can call | Cannot call |
|--------|----------|-------------|
| **Service Worker** (`background.ts`) | `data-layer.ts` writes, `chrome.*` APIs, `runAgent()` | `useAgentStore` (Zustand), React components |
| **Side Panel** (`sidepanel/`) | `chrome.runtime.sendMessage`, `chrome.storage`, `useLiveQuery` (read), `useChangeCount` | `db.*` direct writes, `data-layer.ts` |
| **Options** (`options/`) | Same as Side Panel | Same as Side Panel |
| **Agent Runtime** (`lib/agent.ts`) | `emit()` callback, `data-layer.ts` (for message persistence) | UI state, UI components |
| **Data Layer** (`lib/data-layer.ts`) | Dexie (Dexie is shared across contexts) | UI state, `emit()` (Runtime does this) |

---

## 5. E2E Testing Rules

### 5.1 E2E tests run against a real Chrome instance

MV3 extensions require headed Chrome. The Playwright fixture (`e2e/fixtures/extension.ts`) launches a persistent context and loads the unpacked extension.

### 5.2 Fixtures must wait for SW to be ready

The SW is event-driven and lazily initialized. `openSidePanel()` must wait for the SW registration event before returning, otherwise the first `chrome.runtime.sendMessage` will hang while the SW is still warming up.

```ts
// ✅ Wait for SW to register AND for the module to be evaluated
const sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
```

### 5.3 E2E logs go to `.e2e-logs/sw.log`

The fixture forwards SW console output to `.e2e-logs/sw.log`. Each test should `clearSWLog()` at start for isolation.

### 5.4 Helper functions

- `dbMsg(page, message)` — send a `db:*` message via the `e2e-diag` port, returns the **unwrapped `data` field** (not the `{ok, data, error}` envelope)
- `resetDb(page)` — wipe Dexie via `__e2e:reset`, then wait 200ms (avoids the `db.delete() + db.open()` race noted in §7)
- `clearSWLog()` — truncate `.e2e-logs/sw.log`. **Call BEFORE `launchWithExtension()`** so stale events from previous tests don't pollute assertions
- `readSWLog()` — return the full SW log for post-mortem diagnostics
- `enableOnlyTools(page, names)` — disable every non-todo tool, then enable exactly `names` (pass `[]` to disable everything for baseline streaming tests)
- `setReactTextareaValue(page, selector, value)` — set a React-controlled textarea via the **native value setter** + dispatched `input` event. Playwright's `fill()` does NOT trigger React's onChange on controlled inputs — this pattern is required (see `e2e/specs/04-real-google-search.spec.ts`)
- `captureSnapshots(page, { intervalMs, durationMs, label })` — take periodic full-page screenshots to `.e2e-logs/<label>-t<seconds>s.png` and record `[data-testid="message-bubble"]:last-of-type` text length at each tick
- `inspectTabs(page)` — returns `{ count, urls, ids }` of every tab visible to the extension. Requires the `__e2e:inspect-tabs` SW handler
- `setWallTimeout(page, ms)` — override the agent's wall-clock timeout. Requires the `__e2e:set-wall-timeout` SW handler
- `readApiKey(varName?)` — read `MINIMAX_API_KEY` from `.env` via plain regex (no dotenv loader — see `e2e/specs/00-hi-smoke.spec.ts`)
- `listAgentSteps(page)` — read every persisted agent step (text + toolCall args + toolResults). Critical for replaying what the LLM actually said/called. Requires `__e2e:list-agent-steps` SW handler.
- `listMessages(page)` — read every persisted message (user + assistant). Requires `__e2e:list-messages` SW handler.
  - **Note:** `agentSteps` and `messages` tables don't have `createdAt` indexed (see `lib/db.ts` schema). The SW handlers must read all and sort in memory.

---

## 6. Known Issues (P0)

These are the violations identified by the architecture audit. They are the next priorities for fixes.

### P0.1: Wall-clock timeout uses `setTimeout`

`lib/agent.ts` uses `setTimeout` for the 120-second agent timeout. This breaks if the SW is killed. **Fix:** use `chrome.alarms` or remove the timeout entirely (the AI SDK's `abortSignal` is sufficient).

### P0.2: Inflight state is in-memory only

`entrypoints/background.ts` keeps the `inflight` Map in module scope. The comment claims it's persisted to `chrome.storage.session` but it isn't. **Fix:** persist on agent start, clear on agent done/error/cancel.

### P0.3: Keepalive `setInterval`

`entrypoints/background.ts` uses `setInterval` to keep the SW alive during agent runs. This violates MV3 best practices. **Fix:** remove the keepalive. The SW is alive while processing messages. For long agent runs, the user has the side panel open which keeps the SW alive via the message port.

### P0.4: E2E fixture doesn't wait for SW ready — ✅ FIXED

`e2e/fixtures/extension.ts:52` now does `await ctx.waitForEvent('serviceworker', { timeout: 20_000 })` before returning the handle.

---

## 6.1 Recently Fixed (audit)

### P0.5: Streaming text invisible during first response — ✅ FIXED

**Where:** `entrypoints/sidepanel/components/ChatThread.tsx`

**Symptom:** User sends "hi" → side panel shows only the user bubble + a pulsing dot ("Agent is running…"). The streaming `accumulatedText` is in Zustand but never rendered. The complete reply appears all-at-once at `agent_done`. Screenshots show only "no reply" and "complete reply" — exactly the "streaming not implemented" failure mode.

**Root cause:** `ChatThread` only set `liveText` for the LAST assistant message. But on the FIRST response, no assistant message exists yet in Dexie (`appendMessage` is called in `onFinish`). So `liveText` was always `''` during streaming.

**Fix:** Render a synthetic "streaming bubble" when `isRunning && last message is user && (accumulatedText || accumulatedReasoning || liveToolCalls.length > 0)`. See ChatThread.tsx.

### P0.6: `isRunning` reset on every `appendMessage` — ✅ FIXED

**Where:** `entrypoints/sidepanel/App.tsx`

**Symptom:** Cancel button never visible during agent run. `useAgentStore.isRunning` was set to `true` on `start()` then immediately reset to `false`. SW log showed the agent running normally (chunks emitted, `agent_done` arrived), but the UI's `isRunning` was already false by the time the test queried it.

**Root cause:** `useEffect([currentSessionId, mostRecentSession, ...])` called `resetAgent()` whenever `mostRecentSession` changed. `mostRecentSession` is a `useLiveQuery` result, so it returns a **new object reference** on every Dexie write that touches the session row — including `appendMessage`'s `db.sessions.update({ updatedAt })`. Effect re-runs → `resetAgent()` → `isRunning=false`.

**Fix:** Track the previous `currentSessionId` with a `useRef`. Only call `resetAgent()` when the session ID actually changes. Same-session `updatedAt` bumps no longer trigger a reset.

### P0.7: E2E `dbMsg` didn't unwrap the port envelope — ✅ FIXED

**Where:** `e2e/fixtures/extension.ts` (`dbMsg` / `inspectTabs`)

**Symptom:** `inspectTabs(page).urls.join(',')` threw `TypeError: Cannot read properties of undefined (reading 'join')` because `urls` was undefined.

**Root cause:** `dbMsgPort` returns the full `{ ok, data, error }` envelope. New helpers (`inspectTabs`) treated the envelope as the data and dereferenced `urls` on the envelope.

**Fix:** `dbMsg` now unwraps `res.data` and throws on `!ok`. `inspectTabs` and other consumers use `dbMsg`.

### P0.8: `Buffer` is undefined in Service Worker — ✅ FIXED

**Where:** `lib/cdp.ts`

**Symptom:** `cdpScreenshot` returned `{ error: "Buffer is not defined" }` after introducing PNG IHDR parsing with `Buffer.from(result.data, 'base64')`.

**Root cause:** Service Worker context has no `Buffer` global (no Node.js APIs). MV3 SW is browser-only.

**Fix:** Use pure Web APIs — `atob()` + `Uint8Array` + `DataView` to parse binary data. See §7.5.

### P0.9: `window.devicePixelRatio` is unreliable in Playwright/headless Chrome — ✅ FIXED

**Where:** `lib/cdp.ts`, `lib/tools.ts`

**Symptom:** `cdpAim` reported `dpr: 1` but the actual screenshot was 2x (e.g., 2566×1540 from a 1283×770 viewport). LLM miscalculated CSS coordinates by 2x.

**Root cause:** Playwright/headless Chrome can return `window.devicePixelRatio = 1` even when the rendered screenshot is at 2x. Don't trust the API.

**Fix:** Compute dpr from the actual screenshot dimensions vs the tab's CSS viewport: `dpr = screenshotWidth / tab.width`. Return the dpr in the tool result so the LLM knows the conversion factor. See §7.6.

### P0.10: SW register race causes "manifest missing" dialog + about:blank — ✅ FIXED

**Where:** `e2e/fixtures/extension.ts` (launchWithExtension)

**Symptom chain (one root cause, many faces):**
1. `ctx.waitForEvent('serviceworker', { timeout: 20_000 })` times out
2. Side panel never opens — user sees only `about:blank`
3. Chrome shows an error dialog: "无法加载以下来源的扩展程序: ...清单文件缺失或不可读取"
4. Test reports failure, user thinks it's a path/build issue

The **dialog is a symptom, not the cause.** Chrome loads the extension early; when the SW registration event races past Playwright's listener, the test never confirms the extension is live. Chrome then mis-reports the half-loaded state as "manifest missing".

**Root cause:** Playwright attaches its `serviceworker` event listener AFTER Chrome has already registered the SW. The `waitForEvent` timeout fires 20s later; the event was missed.

**Why the "manifest missing" path looks wrong on Windows:** the file dialog hides the leading `.` in `.output`, so the displayed path `output\chrome-mv3` looks missing — but the actual file is at `.output\chrome-mv3\manifest.json` and is valid.

**Fix:**
1. `ctx.serviceWorkers().find(isOurSw)` first — catches SWs registered before Playwright's listener
2. Fall back to `ctx.waitForEvent('serviceworker', { predicate: isOurSw, ... })` with a regex that only accepts `/background.js$/`
3. Add a pre-flight `existsSync(EXTENSION_PATH + '/manifest.json')` check that throws FAST with the actual path + CWD if the build is broken

**Verify:** after the fix, 5/5 Playwright runs complete cleanly in ~8s with the side panel + Bing + red crosshair all visible. No dialog.

**Rule:** Whenever a Chrome extension E2E shows "manifest missing" + about:blank + flaky pass rate, suspect the SW register race FIRST — don't go down the path/build debugging rabbit hole.

---

## 7. Lessons Learned (UI + E2E patterns — read before touching these areas)

These are pitfalls that have already cost real debugging time. Read before touching the side panel or the E2E fixture.

### 7.1 `useLiveQuery` results change reference on every Dexie write — don't use them as `useEffect` deps without a guard

`useLiveQuery` returns a fresh object reference whenever ANY row in the queried table changes. Putting the result in a `useEffect` dep array means the effect re-runs on every related Dexie write, even when the underlying data is logically the same. For session queries, `appendMessage` updates `sessions.updatedAt` → effect re-runs → if the effect calls a state-reset, you reset mid-run.

**Rule:** When a `useEffect` should fire on a *logical* change (e.g., session ID changed), guard it with a `useRef` of the previous value and compare inside the effect. Don't rely on reference equality.

### 7.2 First response vs. subsequent responses have different UI state machines

On the FIRST agent response, no assistant message exists in Dexie yet (`appendMessage` runs in `onFinish`). So any UI code that does "find the last assistant message and update it" is a no-op during the first stream. The streaming state must be rendered independently of the persisted message (synthetic streaming bubble).

On SUBSEQUENT responses, the assistant message from the previous turn is the last message, so the same code works.

**Rule:** Code that renders live streaming content must handle BOTH cases. If it depends on an assistant message existing, it breaks on the first response.

### 7.3 SW message helpers must unwrap the port envelope

The SW's port handler in `background.ts` wraps every response as `{ ok: boolean, data?: T, error?: string }`. Test helpers that don't unwrap the envelope end up dereferencing fields on the wrapper instead of on `data`. This silently works for tools that don't return data, then explodes on `inspectTabs` / any future helper that does.

**Rule:** New SW-message helpers in `e2e/fixtures/extension.ts` MUST call `dbMsg()` (which unwraps) — never `dbMsgPort()` directly unless the consumer explicitly wants the envelope.

### 7.4 Tool errors must be Observations, not termination conditions

See Architecture Rule #9. The implementation pattern:

```ts
function safeExecute(t: Tool): Tool {
  return { ...t, execute: async (...args) => {
    try { return await t.execute(...args); }
    catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  }};
}
// All tools in `allTools` must be wrapped.
```

The `onError` callback in `streamText` then only emits `agent_error` for abort or fatal errors (network, 5xx, model-not-found). Everything else is logged and the loop continues.

### 7.5 Service Worker has no Node.js globals

MV3 Service Workers are browser-only — no `Buffer`, no `process`, no `require`. To parse binary data in the SW:
- Use `atob(string)` to decode base64
- Wrap the result in `Uint8Array` via charCodeAt loop
- Use `DataView` for endian-aware reads

`Buffer.from(b64, 'base64')` will throw `Buffer is not defined` at runtime.

### 7.6 `window.devicePixelRatio` is unreliable in Playwright/headless Chrome

Don't trust it. Get the real DPR from the actual rendered pixel data (PNG IHDR for screenshots, `ImageData.width` for canvas, etc.). For `cdpAim`, the source of truth is `screenshotWidth / tab.width` — both available in the tool's context.

### 7.7 LLM spatial reasoning — the tool handles dpr, the LLM just looks at pixels

LLMs (including MiniMax-M3) are bad at:
1. Knowing that screenshots are at devicePixelRatio scale (they assume 1:1)
2. Converting between screenshot pixels and CSS pixels
3. Iterating when an aim misses — they often declare success after 1-2 tries

**Fix: the tool does the dpr math, the LLM only thinks in screenshot pixels.** `cdpAim`, `cdpConfirm`, `cdpClick` all accept SCREENSHOT coordinates (the same units as the BEFORE/AFTER images). The tool caches the dpr from the most recent `chrome.tabs.captureVisibleTab` call (`CDPService.lastDpr`) and converts internally before calling `Overlay.highlightQuad` / `Input.dispatchMouseEvent`. This removes a whole class of LLM dpr-arithmetic bugs that we hit hard with M2.7.

What the tool result still reports (for transparency, NOT for LLM arithmetic):
- `screenshotWidth` / `screenshotHeight` — so the LLM knows what coordinate space it's in
- `dpr` — kept for debugging
- `width` / `height` (CSS) — kept for debugging

Visual-servoing discipline is still needed — that part of §7.7 is unchanged. Force a verify-cancel-re-aim loop: cdpAim returns BEFORE + AFTER images; the system prompt tells the LLM to COMPARE them. If off-target, cdpCancel + cdpAim with corrected SCREENSHOT coordinates. Iterate until accurate.

### 7.8 Chrome E2E: the "manifest missing" dialog is almost always an SW register race, not a build issue

When a Playwright-based E2E for a Chrome extension shows:
- A Windows error dialog: "无法加载以下来源的扩展程序: ...清单文件缺失或不可读取"
- The browser showing only `about:blank` (no side panel, no target tab)
- Flaky pass rate — sometimes works, sometimes doesn't

**The actual cause is usually a SW register race**, not a missing manifest. Playwright attaches its `serviceworker` event listener AFTER Chrome has registered the SW; `ctx.waitForEvent('serviceworker', { timeout: 20_000 })` then times out. The dialog appears because Chrome half-loaded the extension.

**The Windows cosmetic twist:** the file dialog hides the leading `.` in `.output`, so the displayed path `output\chrome-mv3` looks missing. But the actual file is at `.output\chrome-mv3` and is valid.

**Don't go down the path/build debugging rabbit hole.** Instead:

1. **Add a pre-flight check** at fixture startup: `existsSync(EXTENSION_PATH + '/manifest.json')` and `JSON.parse(...)`. Throws with the actual path + CWD if anything is wrong. Catches real build issues FAST.

2. **Use predicate-filtered SW register** to be race-safe AND reject other extensions' SWs:
   ```ts
   const isOurSw = (w) => /\/background\.js$/.test(w.url());
   const sw = ctx.serviceWorkers().find(isOurSw)
     ?? await ctx.waitForEvent('serviceworker', { predicate: isOurSw, timeout: 20_000 });
   ```

3. **Add a startup trace** (`e2e/fixtures/trace.ts`) with timestamped markers for each await boundary. When a test fails, the trace log shows exactly which await it was stuck at. 90% of "about:blank hang" failures are an await that never returns.

### 7.9 Use Playwright `predicate` to filter events to exactly what you want

`ctx.waitForEvent('serviceworker', { predicate: w => w.url().endsWith('/background.js') })` only matches your extension's SW, not any other extension's or Chrome's internal SW. Without predicate, `waitForEvent` accepts any matching event. The predicate pattern is also race-safe because if the event has already fired, `ctx.serviceWorkers()` has it.

Pattern for race-safe + filtered registration:
```ts
// 1. poll already-registered (handles "event fired before listener attached")
// 2. fall back to waitForEvent with predicate (handles "event hasn't fired yet")
const isOurs = (w) => /\/background\.js$/.test(w.url());
const sw = ctx.serviceWorkers().find(isOurs)
  ?? await ctx.waitForEvent('serviceworker', { predicate: isOurs, timeout: 20_000 });
```

### 7.10 Visual servoing — the cdpAim closed-loop pattern (DON'T compute exact coordinates)

Stop trying to derive `overlayX = a*reqX + b` formulas from DPR / viewport / layoutViewport / captureVisibleTab. That's a localization problem, and it's fragile across browsers.

**Instead, treat cdpAim as a control problem** (visual servoing / gradient descent). The cdpAim tool already returns BEFORE + AFTER images so the LLM can OBSERVE the offset each round.

**Two-phase pattern** (NEVER change BOTH x/y and size in the same step — mixing them makes the visual feedback ambiguous):

```
PHASE 1 — FIX POSITION (size locked at ~200):
  aim(x, y, size=200)        # big box — as long as target is COVERED, position is close
  compare BEFORE/AFTER
  if off-target:
    describe offset ("red box is right of target by ~100px")
    cdpCancel + cdpAim(corrected_x, corrected_y, size=200)   # KEEP size=200
  repeat until target is centered in box (3-4 rounds typical)

PHASE 2 — SHRINK SIZE (position locked):
  once centered, shrink size only: 200 → 100 → 50 → 20
  verify at each step that target is still fully covered

PHASE 3 — CONFIRM:
  cdpConfirm(x, y)
```

**Why this is the right approach:**
- Doesn't depend on DPR / viewport / captureVisibleTab internals — those can change between Chrome versions
- Self-corrects: the LLM observes the actual offset and adjusts
- The LLM expresses offsets in natural language ("偏左 100 像素"), not exact coordinates
- Each phase has one variable, making the visual feedback unambiguous

**System prompt and tool description** (`lib/agent.ts` and `lib/tools.ts`) MUST enforce this. If they don't, the LLM will try to one-shot the aim with a small box and fail.

**Verified empirically:** the 32-visual-servoing test shows the LLM executing exactly this pattern (sizes `[200, 200, 100, 50]`, two-phase, position locked in phase 1, size locked in phase 2).

---

## 8. Future Work (not yet started)

- Migrate `wrappedEmit` debug log wrapper — currently all events are logged at debug level for E2E tracing. This is acceptable for now but should be conditional on `__e2e` mode.
- Implement `chrome.runtime.onInstalled` to re-initialize tool configs on extension update.
- Add `host_permissions` narrowing for CWS submission (currently `['<all_urls>']` is too broad).
- Move from `chrome.runtime.sendMessage` (broadcast) to `chrome.runtime.connect` (port) for SW → Side Panel event delivery.
- Investigate Dexie `db.delete() + db.open()` race after `__e2e:reset` — currently relying on sequential timing.
- E2E SW registration flake: Playwright's `ctx.waitForEvent('serviceworker', { timeout: 20_000 })` occasionally times out. Bump to 30-40s or retry-on-fail in CI.
