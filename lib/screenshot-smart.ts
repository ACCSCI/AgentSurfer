// Smart screenshot — capture + diff in the side panel (which has Canvas/
// ImageBitmap), fallback to a single shot from the SW when the side panel
// is unavailable.
//
// The SW calls `smartScreenshot(opts)` and forwards it to the side panel via
// chrome.runtime.sendMessage. The side panel maintains an in-memory frame
// cache scoped to the current agent run and runs the diff.

import type { Region } from './screenshot-types';

export type { Region };

export interface SmartSchedule {
  durationMs: number;
  intervalMs: number;
}

export type SmartScreenshotOpts =
  | Record<string, never> // empty object = single full shot
  | { region: Region }
  | { schedule: SmartSchedule }
  | { refs: number[] };

export interface FrameMeta {
  index: number;
  timestamp: number;
  changeFromBaseline: number; // changed pixels vs frame 0
  changedFraction: number; // 0..1
  bbox: { x: number; y: number; width: number; height: number } | null;
  hadRealChange: boolean;
}

export interface FrameImage {
  index: number;
  dataUrl: string;
  width: number;
  height: number;
  timestamp: number;
}

export type SmartScreenshotResult =
  | { kind: 'single'; dataUrl: string; width: number; height: number; timestamp: number }
  | { kind: 'region'; dataUrl: string; region: Region; timestamp: number }
  | { kind: 'schedule'; frames: FrameMeta[]; totalFrames: number; totalDurationMs: number }
  | { kind: 'refs'; frames: FrameImage[] };

/**
 * Called from the SW. Tries the side panel first (full smart features),
 * falls back to a simple single shot from the SW.
 */
export async function smartScreenshot(
  opts: SmartScreenshotOpts,
): Promise<SmartScreenshotResult> {
  // Empty opts → single full shot. Always handle in the SW (no need to
  // bounce through the side panel for a vanilla capture).
  if (isEmpty(opts)) {
    return captureSingleInSw();
  }

  // Everything else (region / schedule / refs) needs the side panel.
  try {
    const res = await chrome.runtime.sendMessage({
      type: '__smart-screenshot:execute',
      options: opts,
    });
    if (res && (res as { ok?: boolean }).ok) {
      return (res as { data: SmartScreenshotResult }).data;
    }
    // Fall through on error
    const errMsg = (res as { error?: string })?.error ?? 'unknown';
    console.warn('[AgentSurfer] smart-screenshot: side panel refused:', errMsg);
  } catch (e) {
    console.warn('[AgentSurfer] smart-screenshot: side panel unreachable:', e);
  }

  // Hard fallback: only single shots without region are supported in SW.
  return captureSingleInSw();
}

function isEmpty(opts: SmartScreenshotOpts): boolean {
  return Object.keys(opts).length === 0;
}

async function captureSingleInSw(): Promise<SmartScreenshotResult> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || tab.windowId == null) throw new Error('No active tab');
  if (tab.url && !tab.url.startsWith('http')) {
    throw new Error(`Cannot capture non-http URL: ${tab.url}`);
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return {
    kind: 'single',
    dataUrl,
    width: tab.width ?? 0,
    height: tab.height ?? 0,
    timestamp: Date.now(),
  };
}
