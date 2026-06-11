// Static file server for E2E fixture pages.
// Bun.serve() under the hood — starts on port 4173 and serves files from
// ./e2e/fixtures/ at `/e2e/fixtures/...`.

import { type Page, type Server } from 'bun';

const ROOT = new URL('./', import.meta.url).pathname;
const PORT = 4173;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server: Server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let filePath = url.pathname;
    if (filePath === '/') filePath = '/e2e/fixtures/pages/search.html';
    const fullPath = ROOT + filePath.replace(/^\/+/, '');
    const file = Bun.file(fullPath);
    if (!(await file.exists())) {
      return new Response('not found: ' + filePath, { status: 404 });
    }
    const ext = fullPath.slice(fullPath.lastIndexOf('.'));
    return new Response(file, { headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' } });
  },
});

console.log(`[e2e fixtures] serving ${ROOT} on http://localhost:${server.port}`);

// Keep the process alive.
export type { Page, Server };
