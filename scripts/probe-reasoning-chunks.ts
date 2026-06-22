// Probe: stream from MiniMax-M3 (and optionally StepFun) and print EVERY
// chunk type the AI SDK surfaces. Tells us whether reasoning arrives as
// `reasoning` chunks, inline `<think>` text in `text-delta`, or not at all.
//
// Run: bun run scripts/probe-reasoning-chunks.ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { stepfunReasoningFetch } from '../lib/llm';
import { readFileSync } from 'node:fs';

function readEnv(name: string): string | undefined {
  try {
    const env = readFileSync('.env', 'utf8');
    const m = env.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const PROMPT = 'Think step by step: what is 17 * 23? Show your reasoning, then give the answer.';

async function probe(label: string, model: Parameters<typeof streamText>[0]['model']) {
  console.log(`\n===== ${label} =====`);
  const chunkTypes: Record<string, number> = {};
  let textOut = '';
  let reasoningOut = '';
  const result = streamText({
    model,
    maxTokens: 500,
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    onChunk: ({ chunk }) => {
      const c = chunk as { type: string; [k: string]: unknown };
      chunkTypes[c.type] = (chunkTypes[c.type] ?? 0) + 1;
      if (c.type === 'text-delta') textOut += (c.textDelta as string) ?? '';
      if (c.type === 'reasoning' || c.type === 'reasoning-delta') {
        reasoningOut += (c.textDelta as string) ?? (c.value as string) ?? '';
      }
    },
  });
  await result.consumeStream();
  console.log('chunk types seen:', JSON.stringify(chunkTypes, null, 2));
  console.log('reasoning length:', reasoningOut.length);
  console.log('reasoning preview:', reasoningOut.slice(0, 300));
  console.log('text length:', textOut.length);
  console.log('text preview:', textOut.slice(0, 300));
  console.log('has <think> in text:', /<think>/i.test(textOut));
}

async function probeWithThinking(label: string, model: Parameters<typeof streamText>[0]['model'], providerOptions: Record<string, unknown>) {
  console.log(`\n===== ${label} =====`);
  const chunkTypes: Record<string, number> = {};
  let textOut = '';
  let reasoningOut = '';
  const result = streamText({
    model,
    maxTokens: 2000,
    providerOptions: providerOptions as Parameters<typeof streamText>[0]['providerOptions'],
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    onChunk: ({ chunk }) => {
      const c = chunk as { type: string; [k: string]: unknown };
      chunkTypes[c.type] = (chunkTypes[c.type] ?? 0) + 1;
      if (c.type === 'text-delta') textOut += (c.textDelta as string) ?? '';
      if (c.type === 'reasoning' || c.type === 'reasoning-delta') {
        reasoningOut += (c.textDelta as string) ?? (c.value as string) ?? '';
      }
    },
  });
  await result.consumeStream().catch((e) => console.log('stream error:', String(e).slice(0, 200)));
  console.log('chunk types seen:', JSON.stringify(chunkTypes, null, 2));
  console.log('reasoning length:', reasoningOut.length);
  console.log('reasoning preview:', reasoningOut.slice(0, 300));
  console.log('text length:', textOut.length);
  console.log('text preview:', textOut.slice(0, 200));
}

const minimaxKey = readEnv('MINIMAX_API_KEY');
if (minimaxKey) {
  const provider = createAnthropic({
    baseURL: 'https://api.minimaxi.com/anthropic/v1',
    apiKey: minimaxKey,
  });
  await probe('MiniMax-M3 (no thinking opt)', provider('MiniMax-M3'));
  await probeWithThinking('MiniMax-M3 (thinking enabled)', provider('MiniMax-M3'), {
    anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } },
  });
} else {
  console.log('MINIMAX_API_KEY missing — skipping MiniMax probe');
}

const stepfunKey = readEnv('STEPFUN_API_KEY');
if (stepfunKey) {
  const provider = createOpenAI({
    baseURL: 'https://api.stepfun.com/step_plan/v1',
    apiKey: stepfunKey,
  });
  await probe('StepFun step-3.7-flash (no opts)', provider('step-3.7-flash'));
  await probeWithThinking(
    'StepFun step-3.7-flash (reasoningEffort high)',
    provider('step-3.7-flash'),
    { openai: { reasoningEffort: 'high' } },
  );
  // Probe through the production fetch transform: stepfunReasoningFetch folds
  // StepFun's reasoning_content into the content stream wrapped in
  // <think>…</think>, so the AI SDK now surfaces it as text-delta chunks that
  // CONTAIN the sentinels. This validates the end-to-end fix.
  const wrappedProvider = createOpenAI({
    baseURL: 'https://api.stepfun.com/step_plan/v1',
    apiKey: stepfunKey,
    fetch: stepfunReasoningFetch,
  });
  await probe(
    'StepFun step-3.7-flash (via stepfunReasoningFetch)',
    wrappedProvider('step-3.7-flash'),
  );
  // Raw SSE probe: hit StepFun directly and dump the delta keys so we can see
  // whether reasoning arrives as `reasoning_content` (which AI SDK v4's OpenAI
  // provider does NOT surface as a `reasoning` chunk).
  await probeRawStepFun(stepfunKey, 'step-3.7-flash');
} else {
  console.log('STEPFUN_API_KEY missing — skipping StepFun probe');
}

async function probeRawStepFun(apiKey: string, modelId: string) {
  console.log(`\n===== RAW SSE: StepFun ${modelId} =====`);
  const res = await fetch('https://api.stepfun.com/step_plan/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      stream: true,
      max_tokens: 500,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });
  if (!res.ok || !res.body) {
    console.log('raw probe failed:', res.status, (await res.text()).slice(0, 300));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deltaKeys = new Set<string>();
  let reasoningContent = '';
  let reasoningField = '';
  let content = '';
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta;
        if (delta) {
          for (const k of Object.keys(delta)) deltaKeys.add(k);
          if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content;
          if (typeof delta.reasoning === 'string') reasoningField += delta.reasoning;
          if (typeof delta.content === 'string') content += delta.content;
        }
      } catch {
        // ignore
      }
    }
  }
  console.log('delta keys seen:', JSON.stringify([...deltaKeys]));
  console.log('reasoning_content length:', reasoningContent.length);
  console.log('reasoning_content preview:', reasoningContent.slice(0, 300));
  console.log('reasoning (field) length:', reasoningField.length);
  console.log('reasoning (field) preview:', reasoningField.slice(0, 200));
  console.log('content length:', content.length);
  console.log('content preview:', content.slice(0, 200));
}
