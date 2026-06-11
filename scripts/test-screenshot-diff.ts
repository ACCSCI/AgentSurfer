// scripts/test-screenshot-diff.ts — Phase A offline test for the diff
// algorithm that the smart screenshot tool will use in the extension.
//
// Generates three synthetic PNGs:
//   1. baseline.png  — solid light gray 1280×800
//   2. modified.png  — same with a 300×100 red rectangle at (200, 300)
//   3. noisy.png     — same as baseline with 100 random 1px pixels (caret blink)
//
// Then computes diff metadata (changed-pixel count, bbox, percentage) for
// (baseline vs modified) and (baseline vs noisy) and prints whether the
// algorithm correctly:
//   • reports the red rectangle region for modified
//   • rejects noisy as "no real change" (under the change threshold)
//   • returns a tight bbox for the real change
//
// Run: `bun run test:diff`

export {};

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = join('.e2e', 'diff-test');
const W = 1280;
const H = 800;
const CHANGE_THRESHOLD = 15; // grayscale diff per pixel to count as "changed"
const MIN_CHANGE_PIXELS = 500; // below this we report "no real change"
const MIN_DENSITY = 0.3; // changed pixels / bbox area; below = noise (e.g. blink)

interface DiffResult {
  width: number;
  height: number;
  changedPixelCount: number;
  changedFraction: number; // 0..1
  bbox: { x: number; y: number; width: number; height: number } | null;
  hadRealChange: boolean;
}

async function makeBaseline(): Promise<Buffer> {
  return sharp({
    create: {
      width: W,
      height: H,
      channels: 3,
      background: { r: 230, g: 230, b: 230 },
    },
  })
    .png()
    .toBuffer();
}

async function makeModified(base: Buffer): Promise<Buffer> {
  // Draw a 300×100 red rectangle at (200, 300) on top of the baseline.
  const overlay = await sharp({
    create: {
      width: W,
      height: H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${W}" height="${H}"><rect x="200" y="300" width="300" height="100" fill="rgb(220,30,30)"/></svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
  return sharp(base).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer();
}

async function makeNoisy(base: Buffer): Promise<Buffer> {
  // Sprinkle 100 random 1×1 dark pixels (mimics caret blink / antialiasing).
  const composites: sharp.OverlayOptions[] = [];
  for (let i = 0; i < 100; i++) {
    const x = Math.floor(Math.random() * (W - 1));
    const y = Math.floor(Math.random() * (H - 1));
    const pixel = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 50, g: 50, b: 50 } },
    })
      .png()
      .toBuffer();
    composites.push({ input: pixel, top: y, left: x });
  }
  return sharp(base).composite(composites).png().toBuffer();
}

async function diff(
  baseline: Buffer,
  candidate: Buffer,
  threshold: number,
  minPixels: number,
  minDensity: number,
): Promise<DiffResult> {
  // Both must be same dimensions — resize candidate to match.
  const aMeta = await sharp(baseline).metadata();
  const bMeta = await sharp(candidate).metadata();
  const w = aMeta.width ?? W;
  const h = aMeta.height ?? H;
  const bResized = await sharp(candidate).resize(w, h).png().toBuffer();

  const aRaw = await sharp(baseline).resize(w, h).greyscale().raw().toBuffer();
  const bRaw = await sharp(bResized).greyscale().raw().toBuffer();

  if (aRaw.length !== bRaw.length) {
    throw new Error(`pixel buffer size mismatch: ${aRaw.length} vs ${bRaw.length}`);
  }

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let changed = 0;

  for (let i = 0; i < aRaw.length; i++) {
    const a = aRaw[i] ?? 0;
    const b = bRaw[i] ?? 0;
    if (Math.abs(a - b) > threshold) {
      changed++;
      const x = i % w;
      const y = Math.floor(i / w);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  // Density filter: a real UI change concentrates pixels; a cursor blink or
  // anti-aliasing scatters them. If the bbox is large but the changed
  // pixel count is small, treat as noise.
  let bbox: DiffResult['bbox'] = null;
  if (changed >= minPixels && maxX >= minX && maxY >= minY) {
    const wB = maxX - minX + 1;
    const hB = maxY - minY + 1;
    const density = changed / (wB * hB);
    if (density >= minDensity) {
      bbox = { x: minX, y: minY, width: wB, height: hB };
    }
  }

  return {
    width: w,
    height: h,
    changedPixelCount: changed,
    changedFraction: changed / (w * h),
    bbox,
    hadRealChange: bbox !== null,
  };
}

function expect(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const baseline = await makeBaseline();
  const modified = await makeModified(baseline);
  const noisy = await makeNoisy(baseline);

  await writeFile(join(OUT_DIR, 'baseline.png'), baseline);
  await writeFile(join(OUT_DIR, 'modified.png'), modified);
  await writeFile(join(OUT_DIR, 'noisy.png'), noisy);
  console.log(`Wrote test images to ${OUT_DIR}/`);

  // Case 1: real change — should report bbox around (200, 300) to (500, 400).
  console.log('\n[case] real change (red rect)');
  const r1 = await diff(baseline, modified, CHANGE_THRESHOLD, MIN_CHANGE_PIXELS, MIN_DENSITY);
  console.log(JSON.stringify(r1, null, 2));
  expect(r1.hadRealChange, 'reports hadRealChange=true');
  expect(r1.bbox !== null, 'reports a bbox');
  if (r1.bbox) {
    expect(r1.bbox.x >= 195 && r1.bbox.x <= 210, `bbox.x ≈ 200 (got ${r1.bbox.x})`);
    expect(r1.bbox.y >= 295 && r1.bbox.y <= 310, `bbox.y ≈ 300 (got ${r1.bbox.y})`);
    expect(r1.bbox.width >= 295 && r1.bbox.width <= 310, `bbox.width ≈ 300 (got ${r1.bbox.width})`);
    expect(r1.bbox.height >= 95 && r1.bbox.height <= 110, `bbox.height ≈ 100 (got ${r1.bbox.height})`);
  }
  expect(r1.changedFraction > 0.02 && r1.changedFraction < 0.05, 'changedFraction ~3%');

  // Case 2: noise (caret blink) — should be filtered out.
  console.log('\n[case] noise (100 random 1px dots)');
  const r2 = await diff(baseline, noisy, CHANGE_THRESHOLD, MIN_CHANGE_PIXELS, MIN_DENSITY);
  console.log(JSON.stringify(r2, null, 2));
  expect(!r2.hadRealChange, 'noise is filtered out (hadRealChange=false)');
  expect(r2.changedPixelCount < 1000, `changedPixelCount < 1000 (got ${r2.changedPixelCount})`);

  // Case 3: identical — should be no change.
  console.log('\n[case] identical (baseline vs baseline)');
  const r3 = await diff(baseline, baseline, CHANGE_THRESHOLD, MIN_CHANGE_PIXELS, MIN_DENSITY);
  console.log(JSON.stringify(r3, null, 2));
  expect(!r3.hadRealChange, 'identical images are no change');
  expect(r3.changedPixelCount === 0, 'changedPixelCount is 0');

  console.log('\nDONE');
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
