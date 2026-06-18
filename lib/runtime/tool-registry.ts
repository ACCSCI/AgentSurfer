// Tool registry — single point of truth for which tools are available
// to the agent run, and how each is wrapped.
//
// In step 3 this is a small extracted helper from runAgentInner in
// lib/agent.ts. In step 5 (Agent extraction) it will also accept an
// Agent's `tools: string[]` declaration and intersect it with the
// user's tool config — the resulting set is the set of tools visible
// to the LLM.
//
// Why a separate module:
//   - safeExecute wrapping is policy. Centralizing it here means a
//     future change (e.g., add a retry counter, or structured error
//     capture) only touches one file.
//   - The `todo` tool is ALWAYS injected regardless of user prefs.
//     Centralizing that here makes the invariant explicit.
//   - The enabledTools shape returned is what the AI SDK's
//     `streamText({ tools })` expects — a `Record<string, Tool>`.
//
// Inputs:
//   - enabledNames: a Set<string> of tool names the user has enabled
//     in their tool config (Dexie toolConfigs table). Comes from
//     `getEnabledToolNames()` in lib/db.ts.
//   - emit: the RuntimeEvent emitter, passed in to the `todo` tool
//     so it can emit `todo_update` events on each call.
//   - safeExecute: optional override for the tool wrapper. Defaults
//     to the production one from lib/tools.ts. Tests can inject a
//     spy/mock here without monkey-patching module state.
//
// Output:
//   A `Record<string, unknown>` keyed by tool name. Each value is an
//   AI SDK Tool (already wrapped in safeExecute). Pass directly to
//   `streamText({ tools: enabledTools })`.

import { allTools, createTodoTool } from '@/lib/tools';
import type { RuntimeEvent } from '@/lib/runtime/events';

// Type alias for the AI SDK Tool shape. We don't import it directly
// because the SDK's Tool type is generic over the Zod schema and would
// force a circular dep. `unknown` is fine here — the AI SDK
// internally validates the shape.
type AnyTool = unknown;

/** Wraps a tool's execute so thrown errors become `{ error: string }`
 *  observations (Architecture Rule #9 + §7.4). Override hook for tests. */
type SafeExecuteFn = (t: AnyTool) => AnyTool;

const defaultSafeExecute: SafeExecuteFn = (t) => t;

/** Build the set of tools the agent run can call.
 *
 *  The `todo` tool is always injected, regardless of the user's
 *  enabled-tool set. The LLM uses it to plan multi-step work, and
 *  removing it would break the architecture's planning contract
 *  (see CLAUDE.md §6 P0.5 and the system prompt's "MULTI-STEP TASKS"
 *  section).
 *
 *  The returned object can be passed directly to `streamText({ tools })`.
 */
export function buildEnabledTools(
  enabledNames: Set<string>,
  emit: (event: RuntimeEvent) => void,
  safeExecute: SafeExecuteFn = defaultSafeExecute,
): Record<string, AnyTool> {
  const tools: Record<string, AnyTool> = {
    todo: safeExecute(createTodoTool(emit)),
  };
  for (const [name, tool] of Object.entries(allTools)) {
    if (enabledNames.has(name)) {
      tools[name] = safeExecute(tool);
    }
  }
  return tools;
}
