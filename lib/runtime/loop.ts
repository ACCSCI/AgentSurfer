// Agent loop — the LLM streaming orchestration extracted from
// lib/agent.ts. Owns:
//   - the streamText() call
//   - per-chunk routing (MessageStore.appendChunk + emit)
//   - per-step event fanout (tool_result / token_usage / progress / step_done)
//   - onError classification (abort vs fatal vs non-fatal)
//   - onFinish aggregation (agent_done with usage + per-step finish reasons)
//   - consumeStream await (the fix for fire-and-forget)
//   - wall-clock timeout (chrome.alarms >= 30s, setTimeout otherwise)
//
// In step 2 (this step) the loop still takes hard-coded `maxSteps` and
// `systemPrompt` parameters. Step 5 (Agent extraction) will thread
// `agent.maxSteps` and `agent.systemPrompt` through the new Agent
// interface, and step 6 will add verifier invocation in onFinish.
//
// Event types emitted (per Architecture Rule #7 — no catch-all events):
//   chunk, tool_result, token_usage, progress, step_done, agent_done,
//   agent_error. `user_message` and `model_ready` are emitted by the
// caller (runAgent) before the loop starts.

import { streamText, type LanguageModel } from 'ai';
import { newId } from '@/lib/db';
import { appendStep } from '@/lib/data-layer';
import { ScopedLogger } from '@/lib/logger';
import { messageStore, type StreamChunk } from '@/lib/message-store';
import type { RuntimeEvent } from '@/lib/runtime/events';
import type { StepUpdate } from '@/types/messages';
import { CDPService } from '@/lib/cdp';
import { buildHistoryMessages } from '@/lib/runtime/history';
import type { Evidence, VerifierResult } from '@/lib/runtime/verifier';

export interface RunAgentLoopInput {
  runId: string;
  sessionId: string;
  prompt: string;
  abortSignal: AbortSignal;
  abort: () => void;
  emit: (event: RuntimeEvent) => void;
  /** Optional reasoning effort (low/medium/high) — StepFun step-3.7-flash
   *  honors this; other providers silently ignore it. Read from
   *  ModelConfig.reasoningEffort in lib/agent.ts. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Provider id from ModelConfig. Used to decide whether to enable
   *  Anthropic-style `thinking` so reasoning chunks are surfaced.
   *  MiniMax (Anthropic-compatible endpoint) only returns reasoning
   *  when `providerOptions.anthropic.thinking` is enabled. */
  provider?: string;
  /** The draft assistant messageId returned by messageStore.beginRun().
   *  Captured here so appendStep() can link each persisted step to its
   *  message WITHOUT re-looking-it-up via messageIdForRun(runId) at
   *  step-time (which returned undefined in some races / SW-restart
   *  paths, orphaning every step with messageId:''). */
  draftMessageId?: string;
}

export interface RunAgentLoopDeps {
  input: RunAgentLoopInput;
  cdpService: CDPService;
  run: ScopedLogger;
  model: LanguageModel;
  enabledTools: Record<string, unknown>;
  systemPrompt: string;
  maxSteps: number;
  wallTimeoutMs: number;
  /**
   * Called at the true end of the run (after onFinish or onError) to
   * release the CDP debugger. In the current code this is the
   * cleanupCdp closure from lib/agent.ts. In a future step we'll move
   * the CDP service into the runtime module too.
   */
  cleanupCdp: (reason: string) => Promise<void>;
  /** Optional: called after each onStepFinish to persist checkpoint
   *  progress (lastStepNumber). Falls back to a no-op if omitted —
   *  used by background.ts / runtime wiring to fix P0.2. */
  onStepAdvanced?: (stepNumber: number) => void;
  /** Optional: called once when the run terminates (success or
   *  error). Used to clear the checkpoint entry. No-op if omitted. */
  onRunTerminated?: (status: 'completed' | 'errored' | 'abandoned') => void;
  /** Optional: called once on successful run completion with the
   *  collected evidence. The caller (lib/agent.ts) is responsible
   *  for invoking the verifier (lib/runtime/verifier.ts) and emitting
   *  the `verify_result` event. The loop just hands off the data.
   *  No-op if omitted. */
  onVerifyRequest?: (evidence: Evidence) => Promise<VerifierResult | void>;
}

/** Build the `providerOptions` for streamText based on the model config.
 *  Merges OpenAI reasoning_effort (StepFun) and Anthropic thinking
 *  (MiniMax) so each provider surfaces its reasoning correctly. Returns
 *  an empty object when no provider-specific options apply, so we never
 *  pollute the request body with empty namespaces. */
function buildProviderOptions(
  input: RunAgentLoopInput,
): { providerOptions?: Record<string, Record<string, unknown>> } {
  const opts: Record<string, Record<string, unknown>> = {};
  if (input.reasoningEffort) {
    opts.openai = { reasoningEffort: input.reasoningEffort };
  }
  // MiniMax talks the Anthropic protocol but only returns thinking blocks
  // (→ `reasoning` chunks) when thinking is explicitly enabled. Enabling
  // it for the anthropic provider too is harmless (real Anthropic models
  // accept the same shape). Verified via scripts/probe-reasoning-chunks.ts
  // 2026-06-19: 0 reasoning chunks without the opt, 5 with it.
  if (input.provider === 'MiniMax' || input.provider === 'anthropic') {
    opts.anthropic = { thinking: { type: 'enabled', budgetTokens: 4096 } };
  }
  return Object.keys(opts).length > 0 ? { providerOptions: opts } : {};
}

/** Maximum number of retries for transient LLM-provider errors
 *  (rate-limit / 429 / 5xx / network blip). Passed as `maxRetries` to
 *  `streamText()`. The AI SDK v4 implements this as
 *  `retryWithExponentialBackoff` with a default initial delay of 2s
 *  and backoffFactor of 2 (so retries land at ~2s, ~4s, ~8s after the
 *  initial attempt). Bumping from the AI SDK default (2) to 3 covers
 *  the bing-search silent-hang pattern where the provider throttles
 *  mid-conversation. See CLAUDE.md §6.1 P0.1 for the wall-alarm
 *  companion fix — these are orthogonal: alarms cap the wall-clock
 *  budget, retries cap the in-flight attempt count. */
const STREAM_MAX_RETRIES = 3;

/** Classify an error as "transient / retryable" for logging + the
 *  outer-retry decision. Matches APICallError.isRetryable, HTTP 429 /
 *  5xx, and common rate-limit text phrases (in case a custom fetch
 *  adapter swallowed the status code). AbortError and cancel messages
 *  are explicitly NOT retryable — user cancel must propagate. */
function isRetryableStreamError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return false;
    if (/abort|cancel/i.test(err.message)) return false;
    const maybeApiCall = err as { isRetryable?: boolean; statusCode?: number };
    if (maybeApiCall.isRetryable === true) return true;
    if (typeof maybeApiCall.statusCode === 'number'
        && (maybeApiCall.statusCode === 429 || maybeApiCall.statusCode >= 500)) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /rate.?limit|too many requests|provider.?5\d\d|ECONN|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(msg);
}

/** Run the agent loop. Awaits stream consumption — never returns before
 *  the LLM stream terminates. Throws if consumeStream rejects (the
 *  caller in lib/agent.ts surfaces this to the side panel).
 *
 *  Rate-limit resilience: `streamText` is invoked with
 *  `maxRetries: STREAM_MAX_RETRIES` so the AI SDK's exponential-backoff
 *  retry handles transient 429/5xx/network blips automatically. The
 *  `onError` callback also classifies rate-limit errors as non-fatal
 *  (logged + loop continues) so a per-step retry doesn't surface as a
 *  fatal agent_error. */
export async function runAgentLoop(deps: RunAgentLoopDeps): Promise<void> {
  const { input, cdpService, run, model, enabledTools, systemPrompt, maxSteps, wallTimeoutMs, cleanupCdp } = deps;
  const { emit, runId, abortSignal, abort, prompt } = input;
  // Prefer the draft messageId captured at beginRun() time (passed
  // straight through from lib/agent.ts). The messageIdForRun(runId)
  // lookup below is only a fallback for callers that don't supply it.
  const draftMessageId = input.draftMessageId;

  // 1. Wall-clock timeout for the entire run. See setWallTimeout() below
  //    for the alarm + setTimeout fallback contract. The alarm path is
  //    preferred because it survives SW restarts; the setTimeout fallback
  //    is for E2E <30s timeouts and unit tests.
  const wall = setWallTimeout({
    run,
    runId,
    timeoutMs: wallTimeoutMs,
    onTimeout: () => {
      run.warn('wall-clock timeout reached — aborting', { timeout: wallTimeoutMs });
      abort();
    },
  });

  let stepCounter = 0;

  // Guarantee exactly one terminal event (agent_done | agent_error)
  // reaches the side panel. The AI SDK can resolve consumeStream()
  // WITHOUT firing onFinish (provider drops the connection mid-stream,
  // returns a malformed final part, etc.) and WITHOUT firing onError —
  // in that case neither onFinish nor onError emits, the run mapping may
  // already be cleared (so the old hasLiveRun safety net no-ops), and
  // the UI hangs forever on "Agent is running…". This flag + the
  // emitTerminal() helper make the `finally` block below an
  // unconditional backstop. See the bing-search silent-hang post-mortem.
  let terminalEmitted = false;
  const emitTerminal = (event: Extract<RuntimeEvent, { type: 'agent_done' | 'agent_error' }>) => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    emit(event);
  };

  // 2. Load conversation history from MessageStore.
  //    Without this the LLM only ever sees the current prompt and
  //    "forgets" every prior turn — the original context-loss bug.
  //    The helper:
  //      - filters drafts (beginRun placeholder) / abandoned / error
  //      - dedupes the just-added user message (runAgentInner pushes
  //        the current prompt via addUserMessage, we re-append it
  //        below as the final user turn)
  //      - converts to AI SDK v4 CoreMessage shape, splitting
  //        tool-call + tool-result into two messages
  //    See lib/runtime/history.ts for the exact rules.
  const sessionMessages = messageStore
    .getState()
    .messages.filter((m) => m.sessionId === input.sessionId);
  run.info('msgstore snapshot', {
    sessionId: input.sessionId,
    total: sessionMessages.length,
    statuses: sessionMessages.reduce<Record<string, number>>((acc, m) => {
      acc[m.status] = (acc[m.status] ?? 0) + 1;
      return acc;
    }, {}),
    lastMessage: sessionMessages.length
      ? {
          role: sessionMessages[sessionMessages.length - 1].role,
          status: sessionMessages[sessionMessages.length - 1].status,
          textPreview: (sessionMessages[sessionMessages.length - 1].text ?? '').slice(0, 80),
        }
      : null,
  });

  const history = buildHistoryMessages({
    messages: sessionMessages,
    currentPrompt: prompt,
  });
  run.info('history loaded', {
    count: history.messages.length,
    roles: history.messages.map((m) => m.role),
    dropped: history.dropped,
    totalChars: history.totalChars,
  });

  // 3. Stream — emit each chunk immediately. No buffering.
  run.info('streamText calling', {
    maxSteps,
    messageCount: history.messages.length + 1,
    firstMsgRole: history.messages[0]?.role ?? null,
    firstMsgTextPreview:
      (history.messages[0]?.content &&
        (typeof history.messages[0].content === 'string'
          ? history.messages[0].content
          : (history.messages[0].content[0] as { text?: string } | undefined)?.text
              ?.slice(0, 80))) ??
      null,
    lastUserPreview: prompt.slice(0, 80),
  });
  const result = streamText({
    model,
    system: systemPrompt,
    messages: [
      ...history.messages,
      { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] },
    ],
    tools: enabledTools as Parameters<typeof streamText>[0]['tools'],
    maxSteps,
    abortSignal,
    // Rate-limit / 429 / 5xx / network blip resilience. AI SDK's
    // `retryWithExponentialBackoff` retries the HTTP request up to
    // STREAM_MAX_RETRIES times with backoff (default 2s × 2^n). Each
    // retry is invisible to the user — chunks continue flowing through
    // the existing onChunk callback. Without this, a single 429 mid-
    // conversation (the bing-search silent-hang trigger) aborts the
    // stream and falls through to the consumeStream-backstop.
    maxRetries: STREAM_MAX_RETRIES,
    // Provider-specific options:
    //  - OpenAI-compatible (StepFun step-3.7-flash) reads
    //    `providerOptions.openai.reasoningEffort` → `reasoning_effort`.
    //  - Anthropic-compatible (MiniMax) only emits `reasoning` chunks when
    //    `providerOptions.anthropic.thinking` is enabled. Without it the
    //    model's thinking is never returned (verified via
    //    scripts/probe-reasoning-chunks.ts on 2026-06-19: 0 reasoning
    //    chunks without the opt, 5 reasoning chunks with it). We enable
    //    thinking for the MiniMax + anthropic providers so the side panel
    //    can show the model's reasoning. budgetTokens must be < maxTokens;
    //    we don't set maxTokens here (AI SDK default is provider-side), so
    //    we keep the budget conservative.
    ...buildProviderOptions(input),

    onChunk: ({ chunk }) => {
      const c = chunk as { type: string; [k: string]: unknown };
      run.debug('chunk', { chunkType: c.type });
      // Route every chunk to MessageStore — it's the single source of
      // truth for the in-memory message buffer. UI subscribes via port
      // and never needs to handle 'chunk' events directly.
      messageStore.appendChunk(runId, c as StreamChunk);
      // Keep the emit for debug logs (E2E sees it in .e2e-logs/sw.log).
      emit({ type: 'chunk', chunkType: c.type, data: c });
    },

    onStepFinish: async (step) => {
      stepCounter += 1;
      // The AI SDK provides a rich `StepResult` (see node_modules/ai/dist/index.d.ts:2111)
      // but we historically only logged {text, toolCalls, toolResults, usage}. The
      // missing fields — `finishReason`, `stepType`, `isContinued` — are exactly
      // what we'd need to detect "LLM self-declared completion" (text-only final
      // step with finishReason='stop'). This logging is the diagnostic layer
      // for the premature-completion investigation (see CLAUDE.md + the trace
      // analysis that triggered the Runtime-owned TodoState refactor).
      const stepFinishReason = (step as { finishReason?: string }).finishReason;
      const stepType = (step as { stepType?: string }).stepType;
      const isContinued = (step as { isContinued?: boolean }).isContinued;
      run.info('onStepFinish', {
        stepNumber: stepCounter,
        textLength: step.text?.length ?? 0,
        textPreview: (step.text ?? '').slice(0, 200),
        toolCallCount: step.toolCalls?.length ?? 0,
        toolResultCount: step.toolResults?.length ?? 0,
        finishReason: stepFinishReason ?? 'unknown',
        stepType: stepType ?? 'unknown',
        isContinued: isContinued ?? false,
        // Heuristic: this step alone could end the run.
        wouldTerminate: (step.toolCalls?.length ?? 0) === 0 && stepFinishReason === 'stop',
      });

      // Emit distinct event for each tool result (architecture rule 7).
      // These are emitted BEFORE step_done so the UI can render the result
      // before the step transitions to "done".
      for (const tr of step.toolResults ?? []) {
        emit({
          type: 'tool_result',
          toolCallId: (tr as { toolCallId?: string }).toolCallId ?? '',
          name: (tr as { toolName?: string }).toolName ?? 'unknown',
          result: (tr as { result?: unknown }).result,
          isError: (tr as { isError?: boolean }).isError ?? false,
          stepNumber: stepCounter,
        });
      }

      // Emit incremental token usage (architecture rule 7 — distinct from
      // the aggregate usage in agent_done).
      const stepUsage = step.usage;
      if (stepUsage) {
        emit({
          type: 'token_usage',
          stepNumber: stepCounter,
          prompt: stepUsage.promptTokens ?? 0,
          completion: stepUsage.completionTokens ?? 0,
        });
      }

      // Emit progress (architecture rule 7).
      emit({
        type: 'progress',
        current: stepCounter,
        total: maxSteps,
        percentage: Math.round((stepCounter / maxSteps) * 100),
      });

      const update: StepUpdate = {
        stepNumber: stepCounter,
        text: step.text ?? '',
        toolCalls: (step.toolCalls ?? []).map((tc) => ({
          id: (tc as { toolCallId?: string }).toolCallId ?? newId(),
          name: (tc as { toolName?: string }).toolName ?? 'unknown',
          args: (tc as { args?: Record<string, unknown> }).args ?? {},
        })),
        toolResults: (step.toolResults ?? []).map((tr) => ({
          toolCallId: (tr as { toolCallId?: string }).toolCallId ?? '',
          name: (tr as { toolName?: string }).toolName ?? 'unknown',
          result: (tr as { result?: unknown }).result,
          isError: (tr as { isError?: boolean }).isError ?? false,
        })),
        durationMs: 0,
      };
      // Link the persisted step to its draft/assistant message. Passing
      // an empty messageId (the previous bug) orphaned every step — they
      // were never associated with the message the UI renders. Prefer the
      // closure-captured draftMessageId (set at beginRun time); fall back
      // to the live runToMessageId lookup, then '' as a last resort.
      const stepMessageId = draftMessageId
        ?? messageStore.messageIdForRun(runId)
        ?? '';
      if (!stepMessageId) {
        run.warn('appendStep has empty messageId', {
          runId,
          hasDraftId: draftMessageId != null,
          mapHasRun: messageStore.messageIdForRun(runId) != null,
        });
      }
      await appendStep({ messageId: stepMessageId, ...update } as any).catch(() => {});
      emit({ type: 'step_done', stepNumber: stepCounter, update });
      // Checkpoint progress (P0.2 fix). No-op if no callback wired.
      deps.onStepAdvanced?.(stepCounter);
    },

    onError: ({ error }) => {
      const msg = error instanceof Error ? error.message : String(error);
      const isAbort = abortSignal?.aborted === true
        || (error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(msg)));
      if (isAbort) {
        // User cancel — terminate cleanly. Emit a terminal event so the
        // side panel stops showing "Agent is running…". We use a
        // non-error agent_done (with finishReason 'cancelled') rather
        // than agent_error so the UI doesn't flash a red error banner —
        // cancel is an expected outcome, not a failure. Without this the
        // mapping is cleared (markAbandoned+endRun) and the finally
        // backstop's hasLiveRun check would no-op, leaving the UI hung.
        run.info('onError: abort (user cancel)', { error: msg });
        messageStore.markAbandoned(runId);
        messageStore.endRun(runId);
        emitTerminal({
          type: 'agent_done',
          usage: { prompt: 0, completion: 0 },
          stepCount: stepCounter,
          finishReason: 'cancelled',
          perStepFinishReasons: [],
          llmSelfDeclaredCompletion: false,
          finalTextPreview: '',
        });
        deps.onRunTerminated?.('abandoned');
      } else {
        // Tool errors are caught by safeExecute (lib/tools.ts) and returned
        // as { error: string } observations — they should never reach this
        // callback. If we ARE here with a non-abort error, it's either a
        // network/provider failure or a stream-level error.
        //
        // Transient rate-limit / 5xx / network errors are handled by
        // the AI SDK's maxRetries (set on streamText above) with
        // exponential backoff. If we still get here after those retries
        // exhausted, the provider is genuinely down — surface as
        // non-fatal warning and let the SDK's loop continue. Only
        // model-not-found / API-key errors are truly fatal (no amount
        // of retry will fix a typo'd model id).
        const isRetryable = isRetryableStreamError(error);
        const isFatal = !isRetryable
          && /model.*not.*found|api.*key|invalid.*key|unauthorized|forbidden|401|403/i.test(msg);
        if (isRetryable) {
          // Logged but NOT terminal — the SDK's maxRetries already
          // attempted up to STREAM_MAX_RETRIES retries before us. The
          // [stream-retry] marker tells post-mortem readers how many
          // attempts were burned through.
          run.warn('[stream-retry] rate-limit / transient error after retries exhausted', {
            error: msg,
            stepCount: stepCounter,
          });
        } else if (isFatal) {
          run.error('onError (fatal)', { error: msg });
          messageStore.markError(runId, msg);
          messageStore.endRun(runId);
          emitTerminal({ type: 'agent_error', message: msg });
          deps.onRunTerminated?.('errored');
        } else {
          run.warn('onError (non-fatal, loop continues)', { error: msg });
        }
      }
      // CDP cleanup runs in both cases — once the stream is done or aborted.
      cleanupCdp('onError').catch(() => {});
    },

    onFinish: async ({ steps, finishReason: topFinishReason }) => {
      const totalUsage = steps.reduce(
        (acc, s) => ({
          prompt: acc.prompt + (s.usage?.promptTokens ?? 0),
          completion: acc.completion + (s.usage?.completionTokens ?? 0),
        }),
        { prompt: 0, completion: 0 },
      );
      // The assistant message was already created by beginRun() and is
      // being incrementally persisted via MessageStore.flushNow(). We just
      // need to mark it 'complete' so the UI stops showing the streaming
      // cursor and the in-memory runId mapping is cleaned up.
      // Normalize the AI SDK finishReason into the business-level stopReason
      // (Rule #9) so bug-report exports can tell "task complete" apart from
      // "hit max steps". 'length' is the AI SDK's signal for the maxSteps cap.
      const stopReason =
        topFinishReason === 'stop'
          ? 'completed'
          : topFinishReason === 'length'
            ? 'max_steps'
            : 'unknown';
      messageStore.markComplete(runId, {
        finishReason: topFinishReason ?? 'unknown',
        stopReason,
      });
      messageStore.endRun(runId);
      // Detailed termination trace. top-level finishReason is the FINAL
      // step's finishReason (per the AI SDK flush() at index.mjs:5520).
      // We also dump every per-step finishReason so the diagnostic
      // E2E test can see exactly which step "self-declared completion".
      const stepFinishReasons = steps.map((s, i) => ({
        step: i + 1,
        finishReason: (s as { finishReason?: string }).finishReason ?? 'unknown',
        stepType: (s as { stepType?: string }).stepType ?? 'unknown',
        toolCalls: (s.toolCalls ?? []).length,
        textLength: (s.text ?? '').length,
      }));
      const lastStep = steps[steps.length - 1];
      const lastWasTextOnly = lastStep
        && (lastStep.toolCalls?.length ?? 0) === 0
        && (lastStep as { finishReason?: string }).finishReason === 'stop';
      const finalText = lastStep?.text ?? '';
      const totalToolCalls = steps.reduce(
        (acc, s) => acc + (s.toolCalls ?? []).length,
        0,
      );
      run.info('onFinish', {
        usage: totalUsage,
        stepCount: steps.length,
        durationMs: run.elapsed(),
        topFinishReason: topFinishReason ?? 'unknown',
        perStepFinishReasons: stepFinishReasons,
        // The smoking-gun field: if true, the LLM finished by emitting
        // a final text-only response — the canonical "完成感" signature.
        llmSelfDeclaredCompletion: lastWasTextOnly,
        finalTextPreview: finalText.slice(0, 300),
      });

      // Emit agent_done FIRST so the side panel can mark the
      // message complete and the SW can free resources. The verifier
      // runs AFTER as a best-effort audit — its verdict comes in
      // via a separate `verify_result` event. This ordering matters
      // for the 10s hi-stream test: if we awaited the verifier
      // before emitting agent_done, the slow verifier LLM call would
      // delay agent_done beyond the test window and the test would
      // fail with `agent_done not emitted`.
      emitTerminal({
        type: 'agent_done',
        usage: totalUsage,
        stepCount: steps.length,
        finishReason: topFinishReason ?? 'unknown',
        perStepFinishReasons: stepFinishReasons,
        llmSelfDeclaredCompletion: lastWasTextOnly,
        finalTextPreview: finalText.slice(0, 300),
      });
      // CDP cleanup at the true end of the run (not when runAgentInner
      // returns, which happens immediately because consumeStream is
      // fire-and-forget).
      await cleanupCdp('onFinish');
      // Checkpoint cleanup (P0.2 fix). No-op if no callback wired.
      deps.onRunTerminated?.('completed');

      // Step 6: invoke the verifier (if wired). The verifier is a
      // separate LLM pass that audits the run. The actual call lives
      // in lib/runtime/verifier.ts; we just hand off the evidence
      // here. Errors in the verifier do NOT block agent_done — the
      // main run is already done, the verifier is best-effort. It
      // emits its own `verify_result` event with the verdict.
      if (deps.onVerifyRequest) {
        try {
          const evidence: Evidence = {
            runId,
            sessionId: input.sessionId,
            prompt: input.prompt,
            finalText,
            finalTextPreview: finalText.slice(0, 300),
            stepCount: steps.length,
            toolCallCount: totalToolCalls,
            perStepFinishReasons: stepFinishReasons,
            topFinishReason: topFinishReason ?? 'unknown',
            llmSelfDeclaredCompletion: lastWasTextOnly,
            usage: totalUsage,
          };
          await deps.onVerifyRequest(evidence);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          run.warn('verifier call failed (non-fatal)', { error: msg });
        }
      }
    },
  });

  // 3. Consume stream — AWAIT it so the run doesn't return before the
  // stream terminates. Otherwise the agent returns immediately while
  // the stream is still draining, the side panel sees `runAgent complete`
  // with zero chunks, and the user gets an empty assistant message.
  // The previous fire-and-forget `.catch()` was a known-bug: the catch
  // never fired because the promise stayed pending after the function
  // returned.
  try {
    await result.consumeStream();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    run.error('consumeStream error', { error: msg });
    // Surface the failure to the side panel so the user sees something.
    messageStore.markError(runId, msg);
    messageStore.endRun(runId);
    emitTerminal({ type: 'agent_error', message: msg });
    // Checkpoint cleanup on stream error.
    deps.onRunTerminated?.('errored');
    // Re-throw so the caller (background.ts) sees the failure too.
    throw err;
  } finally {
    // UNCONDITIONAL terminal-event backstop. The AI SDK can resolve
    // consumeStream() without firing onFinish OR onError (provider
    // drops the connection mid-stream, returns a malformed final part,
    // etc.). In that case neither handler above emits a terminal event,
    // and — critically — the run mapping may already have been cleared
    // by a silent onError path, so the old `hasLiveRun` check no-ops and
    // the side panel hangs forever on "Agent is running…". This was the
    // bing-search silent-hang: 5 steps ran, the stream went quiet for
    // 26s, consumeStream resolved, and NO agent_done/agent_error ever
    // reached the UI. We now guarantee a terminal event regardless of
    // which (if any) callback fired.
    if (!terminalEmitted) {
      run.warn('consumeStream resolved without a terminal event — force-emitting agent_done', {
        stepCount: stepCounter,
      });
      // Best-effort cleanup of the message/run mapping if it's still live.
      if (messageStore.hasLiveRun(runId)) {
        messageStore.markComplete(runId);
        messageStore.endRun(runId);
      }
      emitTerminal({
        type: 'agent_done',
        usage: { prompt: 0, completion: 0 },
        stepCount: stepCounter,
        finishReason: 'incomplete',
        perStepFinishReasons: [],
        llmSelfDeclaredCompletion: false,
        finalTextPreview: '',
      });
      deps.onRunTerminated?.('completed');
      // Release the CDP debugger — onFinish/onError never got the chance.
      cleanupCdp('consumeStream-backstop').catch(() => {});
    }
  }

  // 4. Clean up wall-clock timer.
  wall.cancel();
}

/**
 * Wall-clock timeout for an agent run.
 *
 * - Prefers `chrome.alarms` when the timeout is >= 30s (Chrome's minimum
 *   alarm delay) — alarms persist across SW restarts, so the timeout
 *   fires even if Chrome idles out the SW mid-run.
 * - Falls back to `setTimeout` for sub-30s timeouts (E2E tests) and
 *   environments without `chrome.alarms` (jsdom unit tests).
 *
 * The returned `cancel()` is idempotent and safe to call before, after,
 * or concurrently with the timeout firing. `onTimeout` is guaranteed
 * to be called at most once.
 */
export interface SetWallTimeoutDeps {
  run: ScopedLogger;
  runId: string;
  timeoutMs: number;
  onTimeout: () => void;
}

export interface SetWallTimeoutResult {
  /** True if chrome.alarms was used; false if setTimeout fallback. */
  usedAlarm: boolean;
  /** Idempotent. Clears the alarm/listener/timer as appropriate. */
  cancel: () => void;
}

export function setWallTimeout(deps: SetWallTimeoutDeps): SetWallTimeoutResult {
  const { run, runId, timeoutMs, onTimeout } = deps;
  run.info('wall-clock timer set', { timeout: timeoutMs, runId });

  if (timeoutMs >= 30_000 && typeof chrome !== 'undefined' && chrome.alarms) {
    const alarmName = `agent-wall-timeout-${runId}-${Date.now()}`;
    chrome.alarms.create(alarmName, { delayInMinutes: timeoutMs / 60_000 });
    run.info('[wall-alarm] created', { runId, alarmName, delayMs: timeoutMs });

    let fired = false;
    let cancelled = false;
    const alarmListener = (alarm: chrome.alarms.Alarm) => {
      if (alarm.name !== alarmName) return;
      if (fired || cancelled) return;
      fired = true;
      chrome.alarms.onAlarm.removeListener(alarmListener);
      run.info('[wall-alarm] fired', { runId, alarmName });
      onTimeout();
    };
    chrome.alarms.onAlarm.addListener(alarmListener);
    run.info('[wall-alarm] listener attached', { runId, alarmName });

    return {
      usedAlarm: true,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        chrome.alarms.clear(alarmName);
        chrome.alarms.onAlarm.removeListener(alarmListener);
        run.info('[wall-alarm] cleared', { runId, reason: 'cancelled' });
      },
    };
  }

  // Fallback: setTimeout. Used for sub-30s timeouts and tests.
  let fired = false;
  const handle = setTimeout(() => {
    if (fired) return;
    fired = true;
    run.info('[wall-alarm] fired (setTimeout fallback)', { runId });
    onTimeout();
  }, timeoutMs);
  return {
    usedAlarm: false,
    cancel: () => {
      if (fired) return;
      clearTimeout(handle);
      run.info('[wall-alarm] cleared', { runId, reason: 'cancelled' });
    },
  };
}
