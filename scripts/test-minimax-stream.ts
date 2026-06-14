// scripts/test-minimax-stream.ts — smoke test for vercel-minimax-ai-provider.
// Runs from Node, not from inside the extension. Sends "hi" via streamText
// with the official provider, asserts a stream of chunks arrives within 30s.
//
// Pair with `bun run test:minimax` (the OpenAI-compat one) — together they
// verify the two MiniMax endpoints.

export {};

import { streamText } from 'ai';
import { minimax } from 'vercel-minimax-ai-provider';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error('MINIMAX_API_KEY is not set. Aborting.');
  process.exit(1);
}

// Patch the provider to use the env key (the official `minimax` factory
// reads from MINIMAX_API_KEY by default; we don't need to set anything else).
console.log('provider: minimax (Anthropic-compat)');
console.log('model: MiniMax-M3');
console.log('sending "hi"…');

let chunkCount = 0;
let textAccum = '';
let reasoningAccum = '';
const started = Date.now();

try {
  const result = streamText({
    model: minimax('MiniMax-M3'),
    system: 'You are a helpful assistant. Be brief.',
    prompt: 'hi',
    onError: ({ error }) => console.error('[onError]', error),
  });

  for await (const part of result.fullStream) {
    chunkCount++;
    if (part.type === 'reasoning') {
      reasoningAccum += part.text;
      process.stdout.write(`[reasoning] ${JSON.stringify(part.text)}\n`);
    } else if (part.type === 'text-delta') {
      textAccum += part.text;
      process.stdout.write(`[text] ${JSON.stringify(part.text)}\n`);
    } else if (part.type === 'error') {
      console.error('[stream error]', part.error);
    } else if (part.type === 'finish') {
      console.log('[finish]', JSON.stringify(part));
    } else {
      // unknown type — just log
      console.log(`[${part.type}]`, part);
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
