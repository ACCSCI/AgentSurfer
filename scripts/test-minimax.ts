// scripts/test-minimax.ts — Task #21 live verification.
// Sends one real request to https://api.minimaxi.com/v1/chat/completions
// with `Authorization: Bearer <key>`. Confirms the endpoint responds with
// 200 + a body containing at least one choice. Does NOT run as part of CI.
//
// Verified on 2026-06-11:
//   path: /v1/chat/completions (OpenAI-compatible, NOT Anthropic)
//   auth: Authorization: Bearer <key>
//   model: MiniMax-M3

export {};

interface MiniMaxResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
}

const API_KEY = process.env.MINIMAX_API_KEY;
const ENDPOINT = 'https://api.minimaxi.com/v1/chat/completions';
const MODEL = 'MiniMax-M3';

if (!API_KEY) {
  console.error('MINIMAX_API_KEY is not set. Aborting.');
  process.exit(1);
}

const body = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'You are a helpful assistant. Be brief.' },
    { role: 'user', content: 'Reply with the single word: pong' },
  ],
  max_tokens: 32,
  temperature: 0.1,
};

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  },
  body: JSON.stringify(body),
});

console.log('status:', res.status);
const text = await res.text();
if (!res.ok) {
  console.error('FAIL — response body:\n', text.slice(0, 500));
  process.exit(2);
}
const json = JSON.parse(text) as MiniMaxResponse;
const reply = json.choices?.[0]?.message?.content ?? '';
console.log('reply:', JSON.stringify(reply));
console.log('model:', json.model);
if (!reply) {
  console.error('FAIL — no content in response');
  process.exit(3);
}
console.log('OK — MiniMax responded via OpenAI-compatible endpoint.');
