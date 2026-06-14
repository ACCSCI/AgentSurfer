// Quick smoke test: call MiniMax-M3 with a real PNG image and check
// the model actually sees it (asks it to describe a small red square).
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const png = new PNG({ width: 32, height: 32 });
for (let y = 0; y < 32; y++) {
  for (let x = 0; x < 32; x++) {
    const i = (y * 32 + x) * 4;
    const inSquare = x >= 12 && x < 20 && y >= 12 && y < 20;
    png.data[i] = inSquare ? 255 : 255;
    png.data[i + 1] = inSquare ? 0 : 255;
    png.data[i + 2] = inSquare ? 0 : 255;
    png.data[i + 3] = 255;
  }
}
const pngBuf = PNG.sync.write(png);
writeFileSync('.e2e-logs/m3-smoke.png', pngBuf);
const b64 = pngBuf.toString('base64');

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) { console.error('MINIMAX_API_KEY missing'); process.exit(1); }

const provider = createAnthropic({
  baseURL: 'https://api.minimaxi.com/anthropic/v1',
  apiKey,
});

const result = await generateText({
  model: provider('MiniMax-M3'),
  maxTokens: 200,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What color is the small square in the center of the image? Reply in one short sentence.' },
        // AI SDK `ImagePart` uses `image: string|URL`, NOT `data: string`
        // (the `data` field is for `ToolResultContent` only).
        { type: 'image', image: b64, mimeType: 'image/png' },
      ],
    },
  ],
});

console.log('--- response ---');
console.log(result.text);
console.log('--- usage ---');
console.log(JSON.stringify(result.usage, null, 2));
console.log('--- finishReason ---');
console.log(result.finishReason);
