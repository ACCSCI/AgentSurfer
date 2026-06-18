// ResearchAgent — STUB demo agent. Not wired up to a real workflow
// yet; exists to prove the agent registration path works end-to-end.
//
// Purpose: when a second production agent is needed (e.g., a
// "research agent" that summarizes search results without clicking,
// or a "tab manager" that only opens/closes tabs), copy this file,
// fill in a real systemPrompt, and add the import in
// lib/agents/index.ts. The Runtime, tool-registry, and verifier
// don't need to change — the Agent interface is the contract.

import type { Agent } from './types';

export const ResearchAgent: Agent = {
  name: 'research-agent',
  description: '[STUB] Read-only research agent. Will be implemented in a future iteration; today it returns a no-op response to prove the agent registry wires through.',
  tools: ['tabsList', 'smartScreenshot', 'cdpScreenshot'],
  systemPrompt: 'You are a placeholder research agent. Reply with a single short sentence acknowledging the prompt. Do not call any tools.',
  verifierPrompt: undefined,
  maxSteps: 5,
};
