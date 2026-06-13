// Startup trace: timestamp each step of the test launch + run pipeline.
// When a test fails, the last completed step tells us where the hang is.
//
// 90% of about:blank "stuck" failures are an await that never resolves —
// not a browser problem. This trace lets us see exactly which await.

import { appendFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const TRACE_LOG = pathResolve('.e2e-logs/startup-trace.log');
const RUN_ID = `${new Date().toISOString().slice(11, 19)}-${Math.random().toString(36).slice(2, 6)}`;

let t0 = Date.now();
const stepTimers = new Map<string, number>();

function emit(tag: string, payload: Record<string, unknown> = {}) {
  const t = Date.now() - t0;
  const line = `[${RUN_ID}] t+${String(t).padStart(6, ' ')}ms  ${tag.padEnd(36, ' ')} ${JSON.stringify(payload)}\n`;
  try { appendFileSync(TRACE_LOG, line); } catch { /* ignore */ }
  try { console.log(line.trimEnd()); } catch { /* ignore */ }
}

/** Mark the start of a logical step. */
export function traceStart(step: string, payload: Record<string, unknown> = {}) {
  stepTimers.set(step, Date.now());
  emit(`▶ ${step}`, payload);
}

/** Mark the end of a logical step. Logs duration. */
export function traceEnd(step: string, payload: Record<string, unknown> = {}) {
  const start = stepTimers.get(step);
  const dur = start ? Date.now() - start : -1;
  stepTimers.delete(step);
  emit(`✓ ${step}`, { ...payload, durMs: dur });
}

/** Mark a step as failed (e.g., a catch path). */
export function traceFail(step: string, err: unknown, payload: Record<string, unknown> = {}) {
  emit(`✗ ${step}`, { ...payload, error: err instanceof Error ? err.message : String(err) });
}

/** Reset the global t0 (call once at the start of a test). */
export function traceReset() {
  t0 = Date.now();
  stepTimers.clear();
  emit('— RUN START', { runId: RUN_ID });
}

/** Dump the current state of in-progress steps. Useful at error time. */
export function traceSnapshot() {
  return Object.fromEntries(
    Array.from(stepTimers.entries()).map(([k, v]) => [k, { inProgressForMs: Date.now() - v }]),
  );
}
