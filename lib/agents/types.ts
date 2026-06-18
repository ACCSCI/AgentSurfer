// Agent — a thin, declarative description of "what kind of agent am I".
//
// An Agent is configuration, not state. It has no methods, no
// in-memory fields, no lifecycle hooks. The Runtime drives the Agent
// by reading its fields:
//
//   - name:    identifier for logs / E2E
//   - description:  human-readable, for the options UI
//   - tools:   which tools the LLM is allowed to call (intersected
//              with the user's enabled-tool set in Dexie)
//   - systemPrompt:  either a string OR a function of
//              `enabledTools: Set<string>` (lets the prompt self-customize
//              based on which tools the user has on/off)
//   - verifierPrompt:  optional, used by the Runtime's verifier
//              (step 6) to invoke a second LLM call after the main
//              run to audit the result. Typed loosely here;
//              lib/runtime/verifier.ts (step 6) defines the
//              Evidence shape.
//   - maxSteps:  optional override for the AI SDK's maxSteps. Defaults
//              to 30 if absent.
//
// An Agent is plain data. It can be JSON.stringify'd, fetched from
// a remote config, A/B tested, etc. Future: a list of agents could
// live in chrome.storage and the side panel could let the user pick.

export type SystemPrompt = string | ((enabledTools: Set<string>) => string);

export type VerifierPrompt = string | ((evidence: unknown) => string);

export interface Agent {
  name: string;
  description: string;
  /** Names of tools this agent is allowed to call. The Runtime
   *  intersects this with the user's enabled-tool set. The `todo`
   *  tool is always added regardless. */
  tools: readonly string[];
  systemPrompt: SystemPrompt;
  /** Optional prompt used by the verifier. If absent, verifier is
   *  a no-op for this agent. */
  verifierPrompt?: VerifierPrompt;
  /** AI SDK maxSteps override. Defaults to 30. */
  maxSteps?: number;
}
