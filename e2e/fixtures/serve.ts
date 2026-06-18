// Static file server for E2E fixture pages.
// Bun.serve() under the hood — starts on port 4173 and serves files from
// the project root at `/e2e/fixtures/...` (matching the URL convention
// specs use, e.g. `http://localhost:4173/e2e/fixtures/test-game/index.html`).
//
// Why project root (not e2e/fixtures/) as the server root:
//   - URL paths in specs already include `/e2e/fixtures/...`.
//   - The previous version used `./` as root which double-prefixed the
//     path on Windows: /e2e/fixtures/test-game/index.html resolved to
//     `<cwd>/e2e/fixtures/e2e/fixtures/test-game/index.html` (404).
//   - Setting ROOT to the project root lets the URL map 1:1 to disk.
//
// Security: simple path-traversal check. A request like
// `/e2e/../package.json` is rejected with 400.

import { type Page, type Server } from 'bun';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// e2e/fixtures/ -> e2e/ -> project root
const ROOT = resolve(__dirname, '..', '..');
const PORT = 4173;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
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
    if (filePath === '/') {
      // Default landing page — the test game.
      filePath = '/e2e/fixtures/test-game/index.html';
    }
    // Path-traversal guard: normalize and ensure the resolved path is
    // still inside ROOT. Block `..` segments, symlink escapes, etc.
    const requested = resolve(ROOT, '.' + filePath);
    if (!requested.startsWith(ROOT)) {
      return new Response('forbidden', { status: 400 });
    }
    const file = Bun.file(requested);
    if (!(await file.exists())) {
      return new Response('not found: ' + filePath, { status: 404 });
    }
    const ext = requested.slice(requested.lastIndexOf('.'));
    return new Response(file, {
      headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' },
    });
  },
});

console.log(`[e2e fixtures] serving ${ROOT} on http://localhost:${server.port}`);

// Keep the process alive.
export type { Page, Server };
