// Runtime — top-level orchestrator for agent runs.
//
// Owns:
//   - lifecycle (start / pause / resume / cancel)
//   - the in-memory AbortController map (backed by checkpoint for SW
//     restart resilience — see lib/runtime/checkpoint.ts)
//   - dispatch to runAgentLoop with the right Agent / modelConfig /
//     verifier / checkpoint callbacks
//   - emit bridging to the side panel
//
// Public API:
//   - runtime.start({ sessionId, prompt, agentName?, config? }):
//     creates a runId, returns it. Fires-and-forgets the agent loop.
//     All output flows through emit() (which background.ts wires to
//     chrome.runtime.sendMessage).
//   - runtime.cancel(runId): aborts the in-flight run. No-op if the
//     runId isn't known.
//   - runtime.listInflight(): enumerates active runIds (for E2E).
//
// The Runtime does NOT write to Dexie directly — that lives in the
// per-event handlers (data-layer, MessageStore, etc.). Per
// Architecture Rule #4 (no awaits on LLM completion), start() is
// fire-and-forget.

import { getActiveConfig } from '@/lib/db';
import { runAgent } from '@/lib/agent';
import { getAgent } from '@/lib/agents';
import { log } from '@/lib/logger';
import { listRuns, isActive } from '@/lib/runtime/checkpoint';
import type { RuntimeEvent } from '@/lib/runtime/events';
import type { ModelConfig } from '@/types';

export interface StartInput {
  sessionId: string;
  prompt: string;
  agentName?: string;
  /** Optional override; defaults to the active config from Dexie. */
  config?: ModelConfig;
}

export interface RuntimeDeps {
  /** Emit a raw event to the side panel. Wired by background.ts to
   *  chrome.runtime.sendMessage with `__fromSW: true` tagging. */
  emit: (event: RuntimeEvent) => void;
  /** Default agent when startInput.agentName is absent. */
  defaultAgentName?: string;
}

export class Runtime {
  private inflight = new Map<string, AbortController>();
  private emit: (event: RuntimeEvent) => void;
  private defaultAgentName: string;

  constructor(deps: RuntimeDeps) {
    this.emit = deps.emit;
    this.defaultAgentName = deps.defaultAgentName ?? 'browser-agent';
  }

  /** Begin a new agent run. Returns the runId. The actual loop runs
   *  fire-and-forget; all output flows through emit(). */
  async start(input: StartInput): Promise<{ runId: string }> {
    const runId = crypto.randomUUID();
    const agentName = input.agentName ?? this.defaultAgentName;
    const agent = getAgent(agentName);
    const config = input.config ?? (await getActiveConfig());
    if (!config) throw new Error('No active model config — set one in the options page');
    if (this.inflight.has(runId)) throw new Error(`Run ${runId} already in flight`);

    const ac = new AbortController();
    this.inflight.set(runId, ac);
    log.info('runtime', 'start', { runId, sessionId: input.sessionId, agentName });

    // Fire-and-forget. Agent emits events; never returns a result.
    runAgent({
      runId,
      sessionId: input.sessionId,
      prompt: input.prompt,
      agent,
      config,
      abortSignal: ac.signal,
      abort: () => ac.abort(),
      emit: this.emit,
    }).catch((err) => {
      log.error('runtime', 'start: agent threw', { runId, error: err instanceof Error ? err.message : String(err) });
      this.emit({ type: 'agent_error', runId, message: err instanceof Error ? err.message : String(err) });
      this.inflight.delete(runId);
    });

    return { runId };
  }

  /** Abort an in-flight run. No-op if the runId is unknown. */
  cancel(runId: string): { cancelled: boolean; reason?: string } {
    const ac = this.inflight.get(runId);
    if (ac) {
      ac.abort();
      this.inflight.delete(runId);
      log.info('runtime', 'cancel', { runId });
      return { cancelled: true };
    }
    return { cancelled: false, reason: 'no-such-run' };
  }

  /** True if the runId is in the in-memory inflight map. Does NOT
   *  consult the checkpoint (the checkpoint can be stale across SW
   *  restarts). For cross-restart checks, use isActiveCheckpoint. */
  isInflight(runId: string): boolean {
    return this.inflight.has(runId);
  }

  /** Enumerate active runIds from the in-memory map. */
  listInflight(): string[] {
    return Array.from(this.inflight.keys());
  }

  /** Diagnostic: read checkpoint state. For E2E + future cross-restart
   *  logic. */
  async listCheckpoint(): Promise<string[]> {
    const runs = await listRuns();
    return runs.map((r) => r.runId);
  }

  async isActiveCheckpoint(runId: string): Promise<boolean> {
    return isActive(runId);
  }
}
