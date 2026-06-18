// Per-run agent entrypoint — wires the Agent + model + tools into the
// Runtime's loop. The actual streaming loop lives in lib/runtime/loop.ts
// (extracted during the 8-step Runtime/Agent split). This file is
// the "before-loop" lifecycle: load MessageStore, build enabled tools,
// resolve the system prompt, create the model, persist the checkpoint,
// then hand off to runAgentLoop.
//
// Architecture rules (unchanged from the original — they still apply
// here and in the runtime):
//   1. Runtime must be event-driven.
//   2. Runtime must never manipulate UI state (Zustand, React).
//      Runtime may write to Dexie (persistence) — but not to UI state.
//   3. Runtime must emit events immediately when available.
//   4. Runtime must never wait for full LLM completion before emitting output.
//   5. Agent execution must not return a final response object.
//   6. Long-running tasks must communicate exclusively through event streams.
//   7. Tool calls, tool results, tokens, todos, progress updates and errors
//      must be represented as distinct event types.
//   8. UI consumes events and owns presentation state.
//
// The 12 distinct event types (added `verify_result` in step 6) are
// defined in lib/runtime/events.ts (single source of truth,
// re-exported here for back-compat).

export {
  RUNTIME_EVENT_TYPES,
  type RuntimeEvent,
  type RuntimeEventType,
  type RuntimeEventBase,
  type UserMessageEvent,
  type ModelReadyEvent,
  type ChunkEvent,
  type ToolResultEvent,
  type TokenUsageEvent,
  type ProgressEvent,
  type TodoUpdateEvent,
  type StepDoneEvent,
  type AgentDoneEvent,
  type AgentErrorEvent,
} from '@/lib/runtime/events';

import { getEnabledToolNames } from '@/lib/db';
import { createModel } from '@/lib/llm';
import { CDPService, setCurrentCDP } from '@/lib/cdp';
import { log } from '@/lib/logger';
import { messageStore } from '@/lib/message-store';
import { type RuntimeEvent } from '@/lib/runtime/events';
import { runAgentLoop } from '@/lib/runtime/loop';
import { buildEnabledTools } from '@/lib/runtime/tool-registry';
import { saveRun, markRunDone, sweepStaleRuns, type RunRecord } from '@/lib/runtime/checkpoint';
import { invokeVerifier, type Evidence } from '@/lib/runtime/verifier';
import type { Agent } from '@/lib/agents';
import type { ModelConfig } from '@/types';

// Default if a ModelConfig has no maxSteps (e.g. rows created before the
// field was added). 99 is plenty for "search → click N links → summarize"
// style multi-step tasks. The user can override per-config from the
// options page.
const DEFAULT_MAX_STEPS = 99;

/** Configurable wall-clock timeout (overridable for E2E tests). */
export let WALL_TIMEOUT = 120_000;
export function setWallTimeout(ms: number) { WALL_TIMEOUT = ms; }

export interface RunAgentInput {
  /** The runId created by background.ts when agent:start is received.
   *  Used as the key for MessageStore.runToMessageId so the agent
   *  loop can route per-run chunks to the correct draft message. */
  runId: string;
  sessionId: string;
  prompt: string;
  /** The agent to run. The Runtime reads `agent.systemPrompt`,
   *  `agent.tools`, and `agent.maxSteps` from this. Required. */
  agent: Agent;
  config: ModelConfig;
  abortSignal: AbortSignal;
  /** Call ac.abort() on the controller in background.ts. */
  abort: () => void;
  /** Emit a raw event to the side panel. No buffering.
   *  Typed against the 11-event RuntimeEvent union — see lib/runtime/events.ts. */
  emit: (event: RuntimeEvent) => void;
}

/** Fire-and-forget agent loop. All output goes through emit(). */
export async function runAgent(input: RunAgentInput): Promise<void> {
  const run = log.scope(input.sessionId);
  run.info('runAgent start', { sessionId: input.sessionId });

  // Wrap emit so every emitted event is also logged (useful for E2E
  // assertions and post-mortem debugging — events leave a trail in
  // .e2e-logs/sw.log without needing the side panel to be open).
  const userEmit = input.emit;
  const wrappedEmit = (event: RuntimeEvent) => {
    run.debug('emit', { type: event.type });
    userEmit(event);
  };
  const wrappedInput: RunAgentInput = { ...input, emit: wrappedEmit };

  const cdpService = new CDPService(input.sessionId);
  setCurrentCDP(cdpService);

  // CDP cleanup runs ONLY from the onFinish / onError callbacks inside
  // runAgentInner — NOT from this `finally` block. The finally block runs
  // immediately when runAgentInner returns (because consumeStream is
  // fire-and-forget), which is WAY before the stream actually finishes,
  // which used to null out currentCDP and break every subsequent tool call.
  // If onFinish/onError never fire (e.g., SW killed mid-stream), Chrome
  // detaches the debugger when the extension unloads.
  const cleanupCdp = async (reason: string) => {
    setCurrentCDP(null);
    await cdpService.detach();
    run.info('cdp cleanup', { reason });
  };
  (wrappedInput as RunAgentInput & { __cleanupCdp: typeof cleanupCdp }).__cleanupCdp = cleanupCdp;

  try {
    await runAgentInner(wrappedInput, cdpService, run);
    run.info('runAgent complete', { totalDurationMs: run.elapsed() });
  } finally {
    // No CDP cleanup here. See comment above.
    run.info('runAgent finally (no cleanup — handled by onFinish/onError)');
  }
}

async function runAgentInner(input: RunAgentInput, cdpService: CDPService, run: ReturnType<typeof log.scope>): Promise<void> {
  const { emit, sessionId, prompt, config, runId, agent } = input;

  // 1. Add the user message to the MessageStore. The store persists it
  //    incrementally (batched flush). UI gets it via the next notify().
  messageStore.addUserMessage(sessionId, prompt);
  emit({ type: 'user_message', sessionId, prompt });
  run.info('user_message added to MessageStore', { sessionId, agentName: agent.name });

  // 2. Open a draft message for this run. Subsequent appendChunk calls
  //    find it via runToMessageId.
  messageStore.beginRun(sessionId, runId);
  run.info('run draft message opened', { runId, sessionId, agentName: agent.name });

  // 3. Filter tools. The agent declares which tools it knows about
  //    (`agent.tools`); the user's tool config in Dexie says which
  //    are toggled on. We intersect the two and inject `todo`
  //    regardless. See lib/runtime/tool-registry.ts.
  const userEnabledNames = await getEnabledToolNames();
  const agentAllowed = new Set(agent.tools);
  const enabledNames = new Set(
    [...userEnabledNames].filter((n) => agentAllowed.has(n)),
  );
  const enabledTools = buildEnabledTools(enabledNames, emit);
  run.info('enabled tools', { tools: Object.keys(enabledTools), agentName: agent.name });

  // 4. Build the system prompt. The agent's `systemPrompt` is either
  //    a string or a function of the enabled-tool set; we always
  //    pass the intersected set (not the user's full set) so the
  //    prompt only references tools the agent actually has access to.
  const systemPrompt =
    typeof agent.systemPrompt === 'function'
      ? agent.systemPrompt(enabledNames)
      : agent.systemPrompt;

  // 5. Create model.
  const model = await run.timed('createModel', () => createModel(config));
  emit({ type: 'model_ready', modelId: config.modelId });
  run.info('model ready', { modelId: config.modelId, agentName: agent.name });

  // 5b. Persist the run record to chrome.storage.session. This is the
  //     P0.2 fix — the previous in-memory `inflight` Map was lost on SW
  //     restart. With this, a restarted SW can look up "is this runId
  //     still alive?" and decide whether to re-attach the abort signal.
  //     See lib/runtime/checkpoint.ts.
  const runRecord: RunRecord = {
    runId,
    sessionId,
    startMs: Date.now(),
    modelId: config.modelId,
    wallTimeoutMs: WALL_TIMEOUT,
    status: 'running',
    lastStepNumber: 0,
  };
  await saveRun(runRecord);
  run.info('run checkpoint saved', { runId, agentName: agent.name });

  // 6. Hand off to the loop. The loop owns:
  //    - wall-clock timeout (chrome.alarms >= 30s, setTimeout otherwise)
  //    - streamText() + consumeStream() (the fix for fire-and-forget)
  //    - onChunk → messageStore.appendChunk + emit('chunk')
  //    - onStepFinish → tool_result / token_usage / progress / step_done + persist
  //    - onError → markAbandoned (user cancel) or markError (fatal) + cleanupCdp
  //    - onFinish → markComplete + emit('agent_done') + cleanupCdp
  // CDP cleanup closure is passed in so the loop can release the
  // debugger on the right lifecycle events.
  const cleanup = (input as RunAgentInput & { __cleanupCdp: (r: string) => Promise<void> }).__cleanupCdp;

  // Resolve maxSteps. Precedence:
  //   1. agent.maxSteps  — hardcoded per-agent override (escape hatch for
  //                        agent authors to enforce a hard ceiling)
  //   2. config.maxSteps — user-configurable, set in the Options page
  //                        (ModelConfigSchema default is 99)
  //   3. DEFAULT_MAX_STEPS (99) — last-resort fallback for configs created
  //                              before the field was added
  const agentMaxSteps = agent.maxSteps;
  const configMaxSteps = config.maxSteps;
  const effectiveMaxSteps = agentMaxSteps ?? configMaxSteps ?? DEFAULT_MAX_STEPS;
  // Single source of truth for "what value did the loop actually use".
  // Visible in .e2e-logs/sw.log; readable from any test that scrapes the
  // SW log. If maxSteps is being ignored, the log line is the first place
  // to look.
  run.info('run start', {
    agentName: agent.name,
    agentMaxSteps,
    configMaxSteps,
    effectiveMaxSteps,
  });

  await runAgentLoop({
    input: {
      runId: input.runId,
      sessionId: input.sessionId,
      prompt: input.prompt,
      abortSignal: input.abortSignal,
      abort: input.abort,
      emit: input.emit,
    },
    cdpService,
    run,
    model,
    enabledTools: enabledTools as Record<string, unknown>,
    systemPrompt,
    maxSteps: effectiveMaxSteps,
    wallTimeoutMs: WALL_TIMEOUT,
    cleanupCdp: cleanup,
    // Checkpoint callbacks: the loop reports back as the run
    // progresses so a SW restart can resume or re-attach.
    onStepAdvanced: (stepNumber) => {
      void saveRun({ ...runRecord, lastStepNumber: stepNumber });
    },
    onRunTerminated: (status) => {
      // Map the loop's "abandoned" (user cancel) / "errored" (fatal) /
      // "completed" (success) onto the checkpoint's terminal statuses.
      void markRunDone(runId, status === 'abandoned' ? 'cancelled' : status);
    },
    // Step 6: verifier. After the main run finishes, fire a second
    // LLM call with `agent.verifierPrompt` + the run's evidence.
    // The verifier is the SAME modelConfig (same provider/model) but
    // a clean prompt — it audits, doesn't continue. emit('verify_result')
    // is fired by the verifier itself.
    //
    // Fire-and-forget: the verifier's LLM call is slow (it adds
    // another round-trip to MiniMax, which can rate-limit the next
    // main-agent call) and we don't want it to block agent_done.
    // The agent_done event was already emitted above (before this
    // callback runs), so the test sees the run as complete; the
    // verify_result event arrives later when the verifier finishes.
    onVerifyRequest: (evidence: Evidence): Promise<void> => {
      return invokeVerifier(agent, evidence, config, input.emit)
        .then(() => undefined)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          run.warn('verifier error (non-fatal)', { error: msg });
        });
    },
  });
}

// Note: `buildSystemPrompt` previously lived here. It has been moved
// to lib/agents/browser-agent.ts as `browserAgentSystemPrompt` —
// the system prompt is now part of the Agent's data, not the
// runtime's. The Runtime calls `agent.systemPrompt(enabledTools)`
// to construct the prompt at run start.
