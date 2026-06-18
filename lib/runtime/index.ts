// Public API for the runtime module.
//
// Consumers (background.ts, future useRuntimeFromSidepanel, etc.)
// should import from '@/lib/runtime', not from individual files. This
// barrel keeps the module's surface stable as we add more files.

export { Runtime, type RuntimeDeps, type StartInput } from './runtime';
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
  type VerifyResultEvent,
  type AgentDoneEvent,
  type AgentErrorEvent,
} from './events';
export { runAgentLoop } from './loop';
export { buildEnabledTools } from './tool-registry';
export {
  saveRun,
  getRun,
  listRuns,
  deleteRun,
  isActive,
  markRunDone,
  type RunRecord,
  type RunStatus,
} from './checkpoint';
export { invokeVerifier, type Evidence, type VerifierResult } from './verifier';
