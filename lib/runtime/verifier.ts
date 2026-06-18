// Verifier — optional second LLM pass that audits the agent's run.
//
// After the main loop's onFinish fires, the Runtime calls
// `invokeVerifier(agent, evidence, modelConfig, emit)`. The verifier
// runs a separate `streamText` call with `agent.verifierPrompt` (or
// a no-op if the agent has no verifierPrompt) and emits a
// `verify_result` event with the verifier's verdict.
//
// Why a separate LLM call (rather than self-eval in the main agent's
// onFinish): the verifier should not be biased by the agent's own
// context. It's a clean slate — just the evidence object + the
// agent's verifierPrompt. The verifier can use the same modelConfig
// (so the same provider) but it's a logically separate run.
//
// What counts as "evidence":
//   - The agent's final text
//   - Step count
//   - Tool call count
//   - Per-step finish reasons
//   - Top finish reason
//   - The self-declared completion flag
//
// What the verifier returns:
//   - A single text blob, parsed heuristically. The verifier's prompt
//     asks for JSON `{ verified: true|false, notes: "..." }` but we
//     don't hard-parse — we just emit the raw text. A future
//     iteration can use the AI SDK's `generateObject` (Zod) for
//     structured output.

import { streamText, type LanguageModelV1 } from 'ai';
import { log } from '@/lib/logger';
import { createModel } from '@/lib/llm';
import type { Agent } from '@/lib/agents';
import type { ModelConfig } from '@/types';
import type { RuntimeEvent } from '@/lib/runtime/events';

export interface Evidence {
  runId: string;
  sessionId: string;
  prompt: string;
  finalText: string;
  finalTextPreview: string;
  stepCount: number;
  toolCallCount: number;
  perStepFinishReasons: Array<{
    step: number;
    finishReason: string;
    stepType: string;
    toolCalls: number;
    textLength: number;
  }>;
  topFinishReason: string;
  llmSelfDeclaredCompletion: boolean;
  usage: { prompt: number; completion: number };
}

export interface VerifierResult {
  verified: boolean;
  notes: string;
  raw: string;
}

/** Invoke the verifier. Returns a VerifierResult. If the agent has no
 *  verifierPrompt, returns `{ verified: true, notes: 'no verifier', raw: '' }`
 *  without making any LLM call. */
export async function invokeVerifier(
  agent: Agent,
  evidence: Evidence,
  modelConfig: ModelConfig,
  emit: (event: RuntimeEvent) => void,
): Promise<VerifierResult> {
  const run = log.scope(evidence.runId);

  if (!agent.verifierPrompt) {
    run.info('verifier skipped (no verifierPrompt)', { agentName: agent.name });
    emit({ type: 'verify_result', runId: evidence.runId, verified: true, notes: 'no verifier configured' });
    return { verified: true, notes: 'no verifier configured', raw: '' };
  }

  const prompt = typeof agent.verifierPrompt === 'function'
    ? agent.verifierPrompt(evidence)
    : agent.verifierPrompt;

  let model: LanguageModelV1;
  try {
    model = await run.timed('verifier.createModel', () => createModel(modelConfig));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    run.error('verifier model creation failed', { error: msg });
    emit({ type: 'verify_result', runId: evidence.runId, verified: false, notes: `verifier model failed: ${msg}` });
    return { verified: false, notes: `verifier model failed: ${msg}`, raw: '' };
  }

  run.info('verifier calling', { agentName: agent.name, modelId: modelConfig.modelId });

  let raw = '';
  try {
    const result = streamText({
      model,
      system: prompt,
      // Verifier doesn't need tools — just a yes/no with notes.
      prompt: evidence.finalText || evidence.finalTextPreview || '(empty agent output)',
      maxSteps: 1,
    });
    // Drain to completion. consumeStream + collect into a string.
    for await (const chunk of result.textStream) {
      raw += chunk;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    run.error('verifier failed', { error: msg });
    emit({ type: 'verify_result', runId: evidence.runId, verified: false, notes: `verifier failed: ${msg}` });
    return { verified: false, notes: `verifier failed: ${msg}`, raw };
  }

  // Heuristic: look for a JSON object in the response. If we find
  // { verified: true|false, notes: "..." }, use it. Otherwise fall
  // back to "contains 'true'" / "contains 'false'" substring match.
  const verified = parseVerifierResult(raw);
  run.info('verifier result', { verified, rawPreview: raw.slice(0, 200) });
  emit({ type: 'verify_result', runId: evidence.runId, verified, notes: extractNotes(raw) });
  return { verified, notes: extractNotes(raw), raw };
}

function parseVerifierResult(raw: string): boolean {
  // Try to find a JSON object with a `verified` field.
  const m = raw.match(/\{[\s\S]*?"verified"\s*:\s*(true|false)[\s\S]*?\}/i);
  if (m) {
    return /true/i.test(m[1]!);
  }
  // Fallback: substring match.
  return /\btrue\b/i.test(raw);
}

function extractNotes(raw: string): string {
  const m = raw.match(/"notes"\s*:\s*"([^"]*)"/i);
  if (m) return m[1]!;
  return raw.slice(0, 500);
}
