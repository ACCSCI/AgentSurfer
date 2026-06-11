// Side-panel side of the smart screenshot bridge.
// The SW tool calls chrome.runtime.sendMessage → this module handles the
// actual capture + diff (side panel has Canvas + ImageBitmap).

import type {
  FrameImage,
  FrameMeta,
  Region,
  SmartSchedule,
  SmartScreenshotOpts,
  SmartScreenshotResult,
} from '@/lib/screenshot-smart';

const CHANGE_THRESHOLD = 15; // grayscale diff per pixel to count as "changed"
const MIN_CHANGE_PIXELS = 500; // below this we report "no real change"
const MIN_DENSITY = 0.3; // changed pixels / bbox area; below = noise (e.g. blink)

interface CachedFrame {
  dataUrl: string;
  width: number;
  height: number;
  timestamp: number;
}

let frames: CachedFrame[] = []; // reset on each new schedule

export function installSmartScreenshotHandler() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || (message as { type?: string }).type !== '__smart-screenshot:execute') {
      return false;
    }
    const opts = (message as { options: SmartScreenshotOpts }).options;
    (async () => {
      try {
        const result = await handle(opts);
        sendResponse({ ok: true, data: result });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true; // keep channel open for async response
  });
}

async function handle(opts: SmartScreenshotOpts): Promise<SmartScreenshotResult> {
  if (isEmpty(opts)) {
    const single = await captureSingle();
    return { kind: 'single', ...single };
  }
  if ('region' in opts) {
    const single = await captureSingle();
    const cropped = await crop(single.dataUrl, opts.region);
    return {
      kind: 'region',
      dataUrl: cropped,
      region: opts.region,
      timestamp: single.timestamp,
    };
  }
  if ('schedule' in opts) {
    return captureSchedule(opts.schedule);
  }
  if ('refs' in opts) {
    return getFrames(opts.refs);
  }
  throw new Error('unreachable');
}

function isEmpty(opts: SmartScreenshotOpts): boolean {
  return Object.keys(opts).length === 0;
}

async function captureSingle(): Promise<CachedFrame> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || tab.windowId == null) throw new Error('No active tab');
  if (tab.url && !tab.url.startsWith('http')) {
    throw new Error(`Cannot capture non-http URL: ${tab.url}`);
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return {
    dataUrl,
    width: tab.width ?? 0,
    height: tab.height ?? 0,
    timestamp: Date.now(),
  };
}

async function crop(dataUrl: string, region: Region): Promise<string> {
  // Use createImageBitmap + OffscreenCanvas to crop the PNG to the region.
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(region.width, region.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
  ctx.drawImage(bitmap, -region.x, -region.y);
  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  return URL.createObjectURL(croppedBlob);
}

async function captureSchedule(schedule: SmartSchedule): Promise<SmartScreenshotResult> {
  const { durationMs, intervalMs } = schedule;
  const interval = Math.max(50, Math.min(intervalMs, durationMs));
  const total = Math.max(1, Math.ceil(durationMs / interval));
  const start = Date.now();
  frames = []; // reset cache for the new schedule

  const meta: FrameMeta[] = [];
  for (let i = 0; i < total; i++) {
    const target = start + i * interval;
    const now = Date.now();
    if (target > now) await sleep(target - now);
    const frame = await captureSingle();
    frames.push(frame);
    if (i === 0) {
      meta.push({
        index: 0,
        timestamp: frame.timestamp - start,
        changeFromBaseline: 0,
        changedFraction: 0,
        bbox: null,
        hadRealChange: false,
      });
      continue;
    }
    const baseline = frames[0];
    if (!baseline) continue;
    const d = await diffFrames(baseline, frame);
    meta.push({
      index: i,
      timestamp: frame.timestamp - start,
      changeFromBaseline: d.changedPixelCount,
      changedFraction: d.changedFraction,
      bbox: d.bbox,
      hadRealChange: d.hadRealChange,
    });
  }
  return {
    kind: 'schedule',
    frames: meta,
    totalFrames: total,
    totalDurationMs: durationMs,
  };
}

async function getFrames(refs: number[]): Promise<SmartScreenshotResult> {
  const out: FrameImage[] = [];
  for (const i of refs) {
    const f = frames[i];
    if (f) {
      out.push({ index: i, dataUrl: f.dataUrl, width: f.width, height: f.height, timestamp: f.timestamp });
    }
  }
  return { kind: 'refs', frames: out };
}

interface DiffStats {
  changedPixelCount: number;
  changedFraction: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  hadRealChange: boolean;
}

async function diffFrames(a: CachedFrame, b: CachedFrame): Promise<DiffStats> {
  const aBitmap = await createImageBitmap(await (await fetch(a.dataUrl)).blob());
  const bBitmap = await createImageBitmap(await (await fetch(b.dataUrl)).blob());
  const w = Math.min(aBitmap.width, bBitmap.width);
  const h = Math.min(aBitmap.height, bBitmap.height);

  const canvasA = new OffscreenCanvas(w, h);
  const canvasB = new OffscreenCanvas(w, h);
  const ctxA = canvasA.getContext('2d');
  const ctxB = canvasB.getContext('2d');
  if (!ctxA || !ctxB) throw new Error('OffscreenCanvas 2d context unavailable');
  ctxA.drawImage(aBitmap, 0, 0, w, h);
  ctxB.drawImage(bBitmap, 0, 0, w, h);
  const dataA = ctxA.getImageData(0, 0, w, h).data;
  const dataB = ctxB.getImageData(0, 0, w, h).data;

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let changed = 0;
  for (let i = 0; i < dataA.length; i += 4) {
    // ITU-R BT.601 luminance from RGB. Skip alpha.
    const ga = (dataA[i] ?? 0) * 0.299 + (dataA[i + 1] ?? 0) * 0.587 + (dataA[i + 2] ?? 0) * 0.114;
    const gb = (dataB[i] ?? 0) * 0.299 + (dataB[i + 1] ?? 0) * 0.587 + (dataB[i + 2] ?? 0) * 0.114;
    if (Math.abs(ga - gb) > CHANGE_THRESHOLD) {
      changed++;
      const p = i / 4;
      const x = p % w;
      const y = Math.floor(p / w);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  let bbox: DiffStats['bbox'] = null;
  if (changed >= MIN_CHANGE_PIXELS && maxX >= minX && maxY >= minY) {
    const wB = maxX - minX + 1;
    const hB = maxY - minY + 1;
    const density = changed / (wB * hB);
    if (density >= MIN_DENSITY) {
      bbox = { x: minX, y: minY, width: wB, height: hB };
    }
  }
  return {
    changedPixelCount: changed,
    changedFraction: changed / (w * h),
    bbox,
    hadRealChange: bbox !== null,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
