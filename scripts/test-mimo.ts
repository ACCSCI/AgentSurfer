// scripts/test-mimo.ts — Task #20 live verification.
// Sends one real request to https://api.xiaomimimo.com/v1/chat/completions
// with the `api-key` header (NOT `Authorization: Bearer`), confirms 200,
// and asserts the request actually used the custom header. Does NOT run as
// part of CI.

export {};

interface MiMoResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
}

const API_KEY = process.env.MIMO_API_KEY;
const ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
const MODEL = 'mimo-v2.5-pro';

if (!API_KEY) {
  console.error('MIMO_API_KEY is not set. Aborting.');
  process.exit(1);
}

const body = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'You are MiMo, an AI assistant developed by Xiaomi.' },
    { role: 'user', content: 'please introduce yourself' },
  ],
  max_completion_tokens: 64,
  temperature: 1.0,
  top_p: 0.95,
  stream: false,
};

// Per the MiMo docs, the auth header is `api-key: <key>`, NOT
// `Authorization: Bearer <key>`. We send only the custom header.
const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'api-key': API_KEY,
  },
  body: JSON.stringify(body),
});

console.log('status:', res.status);
const text = await res.text();
if (!res.ok) {
  console.error('FAIL — response body:\n', text.slice(0, 500));
  process.exit(2);
}
const json = JSON.parse(text) as MiMoResponse;
const reply = json.choices?.[0]?.message?.content ?? '';
console.log('reply:', JSON.stringify(reply));
console.log('model:', json.model);
if (!reply) {
  console.error('FAIL — no content in response');
  process.exit(3);
}
console.log('OK — MiMo responded via api-key header.');
