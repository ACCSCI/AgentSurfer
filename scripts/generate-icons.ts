// Generates the AgentSurfer logo at multiple sizes for the Chrome Web Store
// and the extension manifest. Run: `bun run icons`
//
// Design: white rounded-square background, red "O" (annulus) with a small red
// dot at the center — suggests an "O" with a watchful focus point (the agent).

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ICON_DIR = join(__dirname, '..', 'public', 'icon');

const SIZES = [16, 32, 48, 128] as const;
const RED = '#dc2626'; // Tailwind red-600
const WHITE = '#ffffff';

// The single source of truth — rendered at multiple resolutions.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect width="128" height="128" rx="24" ry="24" fill="${WHITE}"/>
  <circle cx="64" cy="64" r="30" fill="none" stroke="${RED}" stroke-width="14"/>
  <circle cx="64" cy="64" r="6" fill="${RED}"/>
</svg>`;

async function main() {
  await mkdir(PUBLIC_ICON_DIR, { recursive: true });

  // Save the SVG too — useful for the README and the website later.
  await writeFile(join(PUBLIC_ICON_DIR, 'logo.svg'), SVG, 'utf8');
  console.log(`✓ ${join(PUBLIC_ICON_DIR, 'logo.svg')}`);

  for (const size of SIZES) {
    const out = join(PUBLIC_ICON_DIR, `${size}.png`);
    await sharp(Buffer.from(SVG))
      .resize(size, size, { kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(`✓ ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
