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

The Runtime / Agent split lives in `lib/runtime/` and `lib/agents/`. See §7.11 for the module map.
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
// ✅ Wait for SW to register AND for the module to be evaluated.
//    40_000ms is the empirically-reliable value — 20_000 occasionally
//    races. See §6.1 P0.10 and §7.8.
const sw = await ctx.waitForEvent('serviceworker', { timeout: 40_000 });
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

### P0.1: Wall-clock timeout uses `setTimeout` — ✅ FIXED

**Where:** `lib/runtime/loop.ts` (`setWallTimeout` factory), `wxt.config.ts` (`'alarms'` permission), `lib/runtime/checkpoint.ts` (`sweepStaleRuns`).

**Was:** the 120s wall-clock timeout was a hybrid — code path required `chrome.alarms` AND `timeoutMs >= 30_000`, but the manifest was missing the `'alarms'` permission, so the alarm branch was dead code. Production actually fell through to `setTimeout` (which dies with the SW). Additionally, the alarm path kept a redundant `setTimeout` "fast-path" that double-fired, and there was no SW-restart fallback: if the SW was killed mid-run, the persisted alarm fired with no listener in the new SW, leaving the side panel stuck on "Agent is running…" forever.

**Now:**
1. `'alarms'` is in the MV3 `permissions` array (otherwise `chrome.alarms.create` is `undefined`).
2. `setWallTimeout(deps)` factory in `lib/runtime/loop.ts:413` returns `{ usedAlarm, cancel }`. The alarm path is the only path; the `setTimeout` fallback is gated to `timeoutMs < 30_000` or no-`chrome.alarms` (jsdom unit tests). `cancel()` is idempotent and removes the alarm + listener.
3. `RunRecord` now carries `wallTimeoutMs`. `sweepStaleRuns()` (in `lib/runtime/checkpoint.ts`) reads every `status: 'running'` record whose `Date.now() - startMs > wallTimeoutMs` and marks them `cancelled`. Called once on SW startup from `entrypoints/background.ts` IIFE, which also broadcasts `agent_error {reason: 'abandoned'}` for the swept runs.
4. Six grep-able log markers: `[wall-alarm] created`, `[wall-alarm] listener attached`, `[wall-alarm] fired`, `[wall-alarm] cleared`, `[checkpoint-sweep] scanning`, `[checkpoint-sweep] marked`.

**Verification:**
- `lib/runtime/wall-timeout.test.ts` — 10 unit cases (alarm + fallback paths, cancel idempotence, fire once).
- `e2e/specs/38-wall-timeout-mock.spec.ts` — Case A: alarm fires exactly once (mock:hangsForever, 31s); Case B: alarm cleared on natural completion, no late fire (mock:textOnly, 60s, wait 65s).
- `e2e/specs/39-wall-timeout-sw-restart.spec.ts` — Case C: sweep abandons a stale run; Case C2: fresh run untouched; Case C3: only the stale one in a mix is swept.
- `e2e/specs/40-wall-timeout-realllm.spec.ts` — Case D: real MiniMax-M3 stream completes cleanly under alarm-based 35s timeout (`created` + `cleared` markers, no `fired`).

**Note:** `mock:hangsForever` (`lib/mock-scripts.ts:177`) doesn't honor the abort signal — its `ReadableStream` never closes, so `consumeStream` never resolves and the loop's `onError` never runs. This means the `mock:hangsForever` Case A does NOT see `markRunDone` fire from the loop's natural path; it relies on the alarm having been fired (verified by `[wall-alarm] fired` marker + alarm list cleaned up). Fixing the mock to honor abort is out of scope for P0.1.

### P0.2: Inflight state is in-memory only — ✅ FIXED

**Where:** `entrypoints/background.ts` → `lib/runtime/checkpoint.ts`

**Was:** the `inflight` Map (runId → AbortController) lived in module scope and was lost on SW restart. A restarted SW had no way to know a run was still alive, so the AI SDK's `consumeStream` could leak.

**Now:** every run writes a `RunRecord` to `chrome.storage.session` at start (`saveRun`), updates `lastStepNumber` on each step, and clears the record on terminal events (`markRunDone`). The Runtime class (`lib/runtime/runtime.ts`) owns the in-memory AbortController map, but the checkpoint is the durable layer that survives SW restarts. A restarted SW can call `isActive(runId)` to decide whether to re-attach or abandon a stale run.

### P0.3: Keepalive `setInterval`

`entrypoints/background.ts` uses `setInterval` to keep the SW alive during agent runs. This violates MV3 best practices. **Fix:** remove the keepalive. The SW is alive while processing messages. For long agent runs, the user has the side panel open which keeps the SW alive via the message port.

### P0.4: E2E fixture doesn't wait for SW ready — ✅ FIXED (and bumped to 40_000ms — see P0.10 / §7.8)

`e2e/fixtures/extension.ts:151` does `await ctx.waitForEvent('serviceworker', { predicate: isOurSw, timeout: 40_000 })` before returning the handle. Timeout was bumped from 20_000 in 2026-06-18 to absorb the SW register race documented in P0.10.

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

### P0.10: SW register race + webServer build race cause "manifest missing" dialog + about:blank — 🟡 PARTIAL (race is fixed; build race recipe below)

**Where:** `e2e/fixtures/extension.ts` (launchWithExtension), `playwright.config.ts` (webServer)

**Symptom chain (two races, many faces):**
1. SW register race: `ctx.waitForEvent('serviceworker', { timeout: 20_000 })` times out
2. webServer build race: `wxt build` is a **clean + rebuild** — it wipes `.output/chrome-mv3/` before writing it back. The fixture's pre-flight `existsSync(manifest.json)` fires while the dir is empty, throws "Run `bun run build` and retry" even though a build is in flight.
3. Side panel never opens — user sees only `about:blank`
4. Chrome shows an error dialog: "无法加载以下来源的扩展程序: ...清单文件缺失或不可读取"
5. Test reports failure, user thinks it's a path/build issue

The **dialog is a symptom, not the cause.** Chrome loads the extension early; when the SW registration event races past Playwright's listener, the test never confirms the extension is live. Chrome then mis-reports the half-loaded state as "manifest missing". The build race is a separate trigger that produces the SAME pre-flight error in 7ms — easy to mis-diagnose as "the build is broken".

**Root cause 1 (SW register):** Playwright attaches its `serviceworker` event listener AFTER Chrome has already registered the SW. The `waitForEvent` timeout fires; the event was missed.

**Root cause 2 (webServer build):** `playwright.config.ts:31` runs `bun run build` as a webServer `command`. `wxt build` clears `.output/` first, so the manifest is briefly missing while the build is in progress. The fixture's pre-flight check at `extension.ts:88-99` fires before the webServer command returns, sees no manifest, and throws.

**Why the "manifest missing" path looks wrong on Windows:** the file dialog hides the leading `.` in `.output`, so the displayed path `output\chrome-mv3` looks missing — but the actual file is at `.output\chrome-mv3\manifest.json` and is valid.

**Fix (race 1 — SW register):**
1. `ctx.serviceWorkers().find(isOurSw)` first — catches SWs registered before Playwright's listener
2. Fall back to `ctx.waitForEvent('serviceworker', { predicate: isOurSw, ... })` with a regex that only accepts `/background.js$/`
3. Add a pre-flight `existsSync(EXTENSION_PATH + '/manifest.json')` check that throws FAST with the actual path + CWD if the build is broken
4. **Bump the wait timeout to 40_000ms** (was 20_000). 20s is enough ~80% of the time; 40s is reliable. See `e2e/fixtures/extension.ts:151`.

**Fix (race 2 — webServer build):**
5. **Run `bun run build` manually first, then `SKIP_BUILD=1 bun run e2e …`.** `SKIP_BUILD=1` makes `playwright.config.ts:32` resolve to `undefined` for the webServer, so the test fixture loads the already-built `.output/chrome-mv3/` directly. This is the only reliable way to avoid the build race in dev.

**Recipe (one-liner that always works):**
```bash
bun run build && SKIP_BUILD=1 bun run e2e e2e/specs/<spec>.spec.ts
```

**Rule:** Whenever a Chrome extension E2E shows "manifest missing" + about:blank + flaky pass rate, suspect the SW register race FIRST, then check for the webServer build race SECOND. Don't go down the path/build debugging rabbit hole — the path is fine, `ls .output/chrome-mv3/manifest.json` will tell you so.

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

### 7.8 Chrome E2E: the "manifest missing" dialog is almost always an SW register race + webServer build race, not a build issue

When a Playwright-based E2E for a Chrome extension shows:
- A Windows error dialog: "无法加载以下来源的扩展程序: ...清单文件缺失或不可读取"
- The browser showing only `about:blank` (no side panel, no target tab)
- Flaky pass rate — sometimes works, sometimes doesn't

**The actual cause is usually TWO races**, not a missing manifest:

1. **SW register race** — Playwright attaches its `serviceworker` event listener AFTER Chrome has registered the SW; `ctx.waitForEvent('serviceworker', { timeout: 20_000 })` then times out. The dialog appears because Chrome half-loaded the extension.
2. **webServer build race** — `playwright.config.ts:31` runs `bun run build` as the webServer. `wxt build` is a **clean + rebuild** that wipes `.output/chrome-mv3/` before writing it back. The fixture's pre-flight `existsSync(manifest.json)` fires while the dir is empty and throws "Run `bun run build` and retry" — same symptom, different cause. Identifiable because the test fails in <10ms (pre-flight) vs the SW race which fails at 20s+.

**The Windows cosmetic twist:** the file dialog hides the leading `.` in `.output`, so the displayed path `output\chrome-mv3` looks missing. But the actual file is at `.output\chrome-mv3` and is valid.

**Don't go down the path/build debugging rabbit hole.** Instead:

1. **Add a pre-flight check** at fixture startup: `existsSync(EXTENSION_PATH + '/manifest.json')` and `JSON.parse(...)`. Throws with the actual path + CWD if anything is wrong. Catches real build issues FAST — but be aware the SAME error fires during the webServer build race, so check whether the file is actually missing (vs the build is in progress).

2. **Use predicate-filtered SW register** to be race-safe AND reject other extensions' SWs. Bump the timeout to 40_000ms — 20_000 occasionally races:
   ```ts
   const isOurSw = (w) => /\/background\.js$/.test(w.url());
   const sw = ctx.serviceWorkers().find(isOurSw)
     ?? await ctx.waitForEvent('serviceworker', { predicate: isOurSw, timeout: 40_000 });
   ```

3. **Add a startup trace** (`e2e/fixtures/trace.ts`) with timestamped markers for each await boundary. When a test fails, the trace log shows exactly which await it was stuck at. 90% of "about:blank hang" failures are an await that never returns.

4. **Avoid the webServer build race with `SKIP_BUILD=1`**. `playwright.config.ts:32` checks `process.env.SKIP_BUILD` and sets the webServer to `undefined` when set. The fixture then loads `.output/chrome-mv3/` directly. The reliable dev loop is:
   ```bash
   bun run build && SKIP_BUILD=1 bun run e2e e2e/specs/<spec>.spec.ts
   ```
   Build manually first, then run tests. This is the only way to be sure the manifest is on disk BEFORE the fixture pre-flight fires.

### 7.9 Use Playwright `predicate` to filter events to exactly what you want

`ctx.waitForEvent('serviceworker', { predicate: w => w.url().endsWith('/background.js') })` only matches your extension's SW, not any other extension's or Chrome's internal SW. Without predicate, `waitForEvent` accepts any matching event. The predicate pattern is also race-safe because if the event has already fired, `ctx.serviceWorkers()` has it.

Pattern for race-safe + filtered registration:
```ts
// 1. poll already-registered (handles "event fired before listener attached")
// 2. fall back to waitForEvent with predicate (handles "event hasn't fired yet")
// 3. timeout 40_000ms (20_000 races occasionally — see §6.1 P0.10, §7.8)
const isOurs = (w) => /\/background\.js$/.test(w.url());
const sw = ctx.serviceWorkers().find(isOurs)
  ?? await ctx.waitForEvent('serviceworker', { predicate: isOurs, timeout: 40_000 });
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

### 7.11 Runtime / Agent split — module map

The Runtime is the "how" (lifecycle, loop, state, events, verifier, checkpoint). The Agent is the "what" (name, tools, system prompt, verifier prompt). Both are plain TypeScript — no DI framework, no inheritance.

```
lib/agents/
  types.ts            — Agent interface (name, tools, systemPrompt, verifierPrompt, maxSteps)
  browser-agent.ts    — Production agent. ~310-line system prompt
                        that adapts to enabled toolset.
  research-agent.ts   — STUB demo. Single-sentence "ack" reply.
  index.ts            — getAgent(name) registry. Add new agents here.

lib/runtime/
  index.ts            — Public API barrel.
  runtime.ts          — Runtime class: start/pause/resume/cancel, inflight
                        AbortController map, agent resolution, fire-and-forget
                        loop dispatch.
  events.ts           — 12 distinct RuntimeEvent types. Single source of truth
                        for the event surface (Rule #7).
  loop.ts             — runAgentLoop: streamText + consumeStream, the
                        per-chunk / per-step / onError / onFinish event fanout.
                        Takes a `systemPrompt` + `enabledTools` (Runtime-owned)
                        not an Agent (loop is Agent-agnostic).
  tool-registry.ts    — buildEnabledTools(agent.tools ∩ userEnabled, emit).
                        Injects `todo` always. Centralizes safeExecute wrapping.
  checkpoint.ts       — saveRun / getRun / listRuns / markRunDone.
                        chrome.storage.session, survives SW restarts.
                        P0.2 fix.
  verifier.ts         — invokeVerifier(agent, evidence, modelConfig, emit).
                        Same modelConfig, clean prompt. Emits `verify_result`.
                        Fire-and-forget (don't block agent_done).

lib/agent.ts          — Per-run setup. Loads MessageStore, builds the
                        enabled tool set, creates the model, persists
                        the checkpoint, then calls runAgentLoop.
                        Owns the Agent → loop bridge. setWallTimeout
                        still lives here for E2E override.
```

**Why this split:**
- Adding a new agent (e.g., a "research" agent or a "tab-manager" agent) is a 1-file change. No runtime changes.
- Swapping the loop implementation (e.g., adding a verifier mid-loop) doesn't touch the Agent.
- The verifier is opt-in per-Agent. BrowserAgent has `verifierPrompt: undefined` by default to avoid MiniMax rate-limit pressure; a future "audit" agent can opt in.
- The 12 event types are stable. UI consumers (side panel, options) don't care which Agent is running — they only see RuntimeEvents.

**Don't:**
- Don't put state on the Agent. Agents are plain data — JSON-stringify-able, A/B-testable, future-remote-fetchable.
- Don't put the system prompt in the loop. It's a property of the Agent, not the loop.
- Don't await the verifier in the loop. The verifier's LLM call is slow and would block agent_done. It's fire-and-forget.
- Don't import `lib/agent.ts` from a UI surface (side panel, options). Use `lib/runtime/` for the public API.

---

## 8. Future Work (not yet started)

- Migrate `wrappedEmit` debug log wrapper — currently all events are logged at debug level for E2E tracing. This is acceptable for now but should be conditional on `__e2e` mode.
- Implement `chrome.runtime.onInstalled` to re-initialize tool configs on extension update.
- Add `host_permissions` narrowing for CWS submission (currently `['<all_urls>']` is too broad).
- Move from `chrome.runtime.sendMessage` (broadcast) to `chrome.runtime.connect` (port) for SW → Side Panel event delivery.
- Investigate Dexie `db.delete() + db.open()` race after `__e2e:reset` — currently relying on sequential timing.
