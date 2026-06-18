// Vendors PixiJS v8 ESM build into e2e/fixtures/test-game/vendor/.
//
// The E2E test game (e2e/fixtures/test-game/index.html) is served by the
// e2e:serve Bun server on port 4173. To stay self-contained (no CDN, no
// network in CI), we copy the minified PixiJS build from node_modules into
// a vendored directory next to the HTML.
//
// Run: `bun run vendor` (or auto-run after `bun install` is not wired —
// the file is .gitignored so each clone must run this once).
//
// Why ESM (pixi.min.mjs) and not IIFE/UMD (pixi.min.js):
//   - PixiJS v8 ships NO IIFE/UMD build. The minified .js file is a
//     self-executing wrapper that does NOT assign to window/global.
//     Only the .mjs file is a proper ES module with `export { ... }`.
//   - The test page uses <script type="module"> + relative import to load
//     PixiJS into the page scope. Bun.serve serves .mjs as
//     application/javascript (see e2e/fixtures/serve.ts MIME map).
//
// Implementation note: this script uses Node's `fs/promises` instead of
// Bun's `Bun.file` / `Bun.write` to keep it type-checkable in plain
// `tsc --noEmit` (the project's tsconfig doesn't depend on @types/bun).
// Runs under Bun at runtime via the `vendor` npm script — Node's fs is
// fully supported by Bun.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SRC = join(ROOT, 'node_modules', 'pixi.js', 'dist', 'pixi.min.mjs');
const DST_DIR = join(ROOT, 'e2e', 'fixtures', 'test-game', 'vendor');
const DST = join(DST_DIR, 'pixi.min.mjs');

async function main() {
  try {
    await stat(SRC);
  } catch {
    throw new Error(
      `pixi.js not found at ${SRC}. Run \`bun install\` first to add it as a devDep.`,
    );
  }
  await mkdir(DST_DIR, { recursive: true });
  // Clean any stale IIFE build from a previous vendor invocation.
  await rm(join(DST_DIR, 'pixi.min.js'), { force: true });
  const bytes = await readFile(SRC);
  await writeFile(DST, bytes);
  const sizeKB = (bytes.length / 1024).toFixed(1);
  console.log(`[vendor-pixi] copied ${SRC} -> ${DST} (${sizeKB} KB)`);
}

await main();

