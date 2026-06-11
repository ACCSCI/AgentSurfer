// scripts/test-anthropic-compat.ts — smoke test for hand-rolled
// Anthropic-compatible call to MiniMax via @ai-sdk/anthropic@1.x.
// Uses the same code path as lib/llm.ts (createAnthropic + custom baseURL)
// to validate that path before running the E2E.

export {};

import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText } from 'ai';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error('MINIMAX_API_KEY is not set. Aborting.');
  process.exit(1);
}

console.log('provider: @ai-sdk/anthropic (v1) with custom baseURL');
console.log('baseURL:  https://api.minimaxi.com/anthropic/v1');
console.log('model:    MiniMax-M2.7-highspeed');
console.log('sending "hi"…');

const anthropic = createAnthropic({
  baseURL: 'https://api.minimaxi.com/anthropic/v1',
  apiKey,
});

let textAccum = '';
let reasoningAccum = '';
let chunkCount = 0;
const started = Date.now();

try {
  const result = streamText({
    model: anthropic('MiniMax-M2.7-highspeed'),
    system: 'You are a helpful assistant. Be brief.',
    prompt: 'hi',
    onError: ({ error }) => console.error('[onError]', error),
  });

  for await (const part of result.fullStream) {
    chunkCount++;
    if (part.type === 'reasoning') {
      // v1 reasoning chunks use textDelta
      const t = (part as { textDelta?: string }).textDelta ?? '';
      reasoningAccum += t;
      process.stdout.write(`[reasoning] ${JSON.stringify(t)}\n`);
    } else if (part.type === 'text-delta') {
      const t = (part as { textDelta: string }).textDelta;
      textAccum += t;
      process.stdout.write(`[text] ${JSON.stringify(t)}\n`);
    } else if (part.type === 'error') {
      console.error('[stream error]', part.error);
    } else if (part.type === 'finish') {
      console.log('[finish]', JSON.stringify(part));
    }
  }

  const elapsed = Date.now() - started;
  console.log(`\n--- done in ${elapsed}ms ---`);
  console.log(`chunks: ${chunkCount}`);
  console.log(`reasoning length: ${reasoningAccum.length}`);
  console.log(`text length: ${textAccum.length}`);
  console.log(`text: ${JSON.stringify(textAccum)}`);

  if (textAccum.length === 0 && reasoningAccum.length === 0) {
    console.error('FAIL — no text or reasoning chunks');
    process.exit(2);
  }
  console.log('OK');
} catch (err) {
  console.error('FAIL', err);
  process.exit(3);
}
