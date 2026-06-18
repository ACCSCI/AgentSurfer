// Agent registry — the public API for looking up an Agent by name.
//
// This is a flat record. To add a new agent: create a file in
// lib/agents/, export the Agent, and add it to the `agents` map
// below. The Runtime imports `getAgent()` from here.
//
// The side panel will eventually use this to populate a "pick an
// agent" dropdown. For now, background.ts hardcodes
// `getAgent('browser-agent')` when an agent:start comes in.

import { BrowserAgent } from './browser-agent';
import { ResearchAgent } from './research-agent';
import type { Agent } from './types';

export const agents: Record<string, Agent> = {
  [BrowserAgent.name]: BrowserAgent,
  [ResearchAgent.name]: ResearchAgent,
};

export function getAgent(name: string): Agent {
  const agent = agents[name];
  if (!agent) {
    throw new Error(`Unknown agent: ${name}. Registered: ${Object.keys(agents).join(', ')}`);
  }
  return agent;
}

export function listAgents(): Agent[] {
  return Object.values(agents);
}

export type { Agent } from './types';
export type { SystemPrompt, VerifierPrompt } from './types';
