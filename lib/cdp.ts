// CDP (Chrome DevTools Protocol) singleton service.
// One debugger connection per agent run, shared by all CDP tools.
// Requires "debugger" permission in manifest.json.

import { log } from '@/lib/logger';

// ---------- Singleton ----------

let currentCDP: CDPService | null = null;

/** Set the active CDP service for the current agent run. */
export function setCurrentCDP(cdp: CDPService | null) {
  currentCDP = cdp;
}

/** Get the active CDP service. Returns null if no agent run is active. */
export function getCurrentCDP(): CDPService | null {
  return currentCDP;
}

// ---------- CDPService ----------

export class CDPService {
  private tabId: number | null = null;
  private attached = false;
  readonly runId: string;

  constructor(runId = 'unknown') {
    this.runId = runId;
  }

  /** Attach to a tab. No-op if already attached to the same tab. */
  async attach(tabId: number): Promise<void> {
    if (this.attached && this.tabId === tabId) return;
    if (this.attached) await this.detach();

    log.info('cdp', 'attach start', { runId: this.runId, tabId });
    const t0 = Date.now();
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      this.tabId = tabId;
      this.attached = true;
      log.info('cdp', 'attach ok', { runId: this.runId, tabId, durationMs: Date.now() - t0 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "Another debugger" (DevTools open) or "Already attached" — treat as attached.
      if (msg.includes('Another debugger') || msg.includes('Already attached')) {
        this.tabId = tabId;
        this.attached = true;
        log.warn('cdp', 'CDP conflict: another debugger is attached', {
          runId: this.runId, tabId, error: msg,
        });
      } else {
        log.error('cdp', 'attach failed', { runId: this.runId, tabId, error: msg });
        throw err;
      }
    }
  }

  /** Detach from the current tab. Safe to call multiple times. */
  async detach(): Promise<void> {
    if (!this.attached || this.tabId == null) return;
    log.info('cdp', 'detach', { runId: this.runId, tabId: this.tabId });
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // ignore
    }
    this.attached = false;
    this.tabId = null;
    // Reset highlight flag — when we re-attach to a different tab, the
    // DOM element we injected is gone (it's per-tab). Don't think a
    // highlight is still visible.
    this.highlightVisible = false;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  get currentTabId(): number | null {
    return this.tabId;
  }

  /** Send a raw CDP command. */
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.attached || this.tabId == null) {
      throw new Error('CDP not attached — call attach() first');
    }
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId: this.tabId! }, method, params, (result) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message ?? 'unknown';
          log.error('cdp', 'send failed', { runId: this.runId, method, error: errMsg, durationMs: Date.now() - t0 });
          reject(new Error(errMsg));
        } else {
          log.debug('cdp', 'send ok', { runId: this.runId, method, durationMs: Date.now() - t0 });
          resolve(result as T);
        }
      });
    });
  }

  // ---------- High-level actions ----------

  private lastMousePos: { x: number; y: number } = { x: 0, y: 0 };

  async click(x: number, y: number): Promise<void> {
    log.info('cdp', 'click', { runId: this.runId, x, y });
    await this.mouseMove(x, y);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      x,
      y,
      clickCount: 1,
    });
    await sleep(30 + Math.random() * 40);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      x,
      y,
      clickCount: 1,
    });
  }

  async mouseMove(x: number, y: number): Promise<void> {
    const start = this.lastMousePos;
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = Math.round(start.x + (x - start.x) * t);
      const py = Math.round(start.y + (y - start.y) * t);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
      await sleep(8 + Math.random() * 7);
    }
    this.lastMousePos = { x, y };
  }

  async type(text: string): Promise<void> {
    log.info('cdp', 'type', { runId: this.runId, length: text.length });
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char,
        unmodifiedText: char,
      });
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char,
        unmodifiedText: char,
      });
      await sleep(30 + Math.random() * 50);
    }
  }

  async pressKey(key: string): Promise<void> {
    log.info('cdp', 'pressKey', { runId: this.runId, key });
    const km = KEY_MAP[key] ?? { code: key, windowsVirtualKeyCode: 0 };
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: km.code,
      windowsVirtualKeyCode: km.windowsVirtualKeyCode,
      nativeVirtualKeyCode: km.windowsVirtualKeyCode,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: km.code,
      windowsVirtualKeyCode: km.windowsVirtualKeyCode,
      nativeVirtualKeyCode: km.windowsVirtualKeyCode,
    });
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    log.info('cdp', 'scroll', { runId: this.runId, deltaX, deltaY });
    const { x, y } = this.lastAimPos;
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
  }

  /**
   * Capture the active tab's current viewport as a PNG dataUrl.
   *
   * IMPORTANT: We use the extension's native `chrome.tabs.captureVisibleTab`
   * rather than CDP's `Page.captureScreenshot` because:
   *   - `Page.captureScreenshot` captures only the page's rendered surface
   *     and EXCLUDES the DevTools overlay (so `Overlay.highlightQuad` would
   *     be invisible in the returned image — both to the LLM and the user).
   *   - `chrome.tabs.captureVisibleTab` captures the entire visible viewport
   *     including the DevTools overlay layer, so the red crosshair from
   *     `highlightQuad` IS visible in the dataUrl.
   *
   * Side effects:
   *   - Requires the tab to be the active tab in its window
   *     (call `tabsSwitch` or focus it first).
   *   - The user can also see the crosshair in their browser.
   *   - PNG dimensions come from the IHDR header. dpr = screenshotWidth / tab.width.
   */
  async screenshot(): Promise<{ dataUrl: string; width: number; height: number }> {
    log.info('cdp', 'screenshot', { runId: this.runId });
    if (this.tabId == null) {
      throw new Error('cdp.screenshot: no active tab — call attach() first');
    }
    const tab = await chrome.tabs.get(this.tabId);
    if (tab.windowId == null) {
      throw new Error('cdp.screenshot: tab has no windowId');
    }
    // chrome.tabs.captureVisibleTab requires the captured tab to be the
    // ACTIVE tab in its window. If the user has another tab focused in
    // the same window, the call throws "Tab cannot be captured".
    // We activate the target tab first, then capture.
    if (!tab.active) {
      await chrome.tabs.update(this.tabId, { active: true });
      // Tiny wait for the swap to settle (rendering layer has to update).
      await new Promise((r) => setTimeout(r, 50));
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    // dataUrl is "data:image/png;base64,<base64>" — strip the prefix.
    const base64 = dataUrl.startsWith('data:image/png;base64,')
      ? dataUrl.slice('data:image/png;base64,'.length)
      : dataUrl;
    // Parse PNG IHDR to get real pixel dimensions (dpr-aware).
    // SW has no `Buffer` — use atob + Uint8Array + DataView.
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    // Cache dpr so cdpAim / cdpConfirm / cdpClick can convert
    // screenshot pixels → CSS pixels without re-screenshotting.
    if (tab.width && width) this.lastDpr = width / tab.width;
    return { dataUrl, width, height };
  }

  private lastAimPos: { x: number; y: number } = { x: 0, y: 0 };
  /**
   * dpr from the most recent screenshot() call. Computed as
   * `screenshotWidth / tab.width`. Tools that need to convert
   * screenshot pixels → CSS pixels (cdpAim / cdpConfirm / cdpClick)
   * read this. Without this they'd have to take their own screenshot
   * every call (slow) or use a stale value.
   */
  private lastDpr = 1;

  /** Get the last aim position (for scroll, etc.). */
  get aimX(): number { return this.lastAimPos.x; }
  get aimY(): number { return this.lastAimPos.y; }
  /** dpr from the most recent screenshot() — used by tools to convert screenshot px → CSS px. */
  get dpr(): number { return this.lastDpr; }

  // ---------- Visual feedback (CDP Overlay, with LLM-chosen color) ----------
  //
  // We use CDP `Overlay.highlightQuad` which draws on Chrome's overlay
  // layer. NO DOM INJECTION — the page stays 100% clean.
  //
  // CRITICAL: The Overlay domain is LAZY by default. We MUST explicitly
  // call `Overlay.enable` before `Overlay.highlightQuad` — otherwise
  // Chrome (to save GPU work) refuses to render the highlight in
  // normal browsing mode. With `Overlay.enable` called, the highlight
  // is visible in the user's browser AND captured by
  // `chrome.tabs.captureVisibleTab` (which is what the screenshot tool
  // uses).
  //
  // The LLM picks the color (CSS name or #rrggbb) so the crosshair
  // contrasts with the page background. We always draw a WHITE outline
  // around the colored fill so the highlight stays visible on any
  // background (including pages with red/pink themes).

  private highlightVisible = false;
  private overlayEnabled = false;

  /**
   * Enable the Overlay domain. Must be called before highlightQuad
   * for the highlight to actually render in normal browsing mode.
   *
   * CRITICAL: `Overlay.enable` REQUIRES `DOM.enable` to be called first
   * (Chrome DevTools Protocol order: DOM domain is the dependency).
   * Calling `Overlay.enable` alone returns -32000 "DOM should be
   * enabled first" and the highlight is silently dropped.
   */
  async enableOverlay(): Promise<void> {
    if (this.overlayEnabled) return;
    log.info('cdp', 'Overlay.enable (incl DOM.enable)', { runId: this.runId, tabId: this.tabId });
    await this.send('DOM.enable');
    await this.send('Overlay.enable');
    this.overlayEnabled = true;
  }

  /** Parse a CSS color name or #rrggbb into {r,g,b,a}. Throws on invalid input. */
  private parseColor(color: string): { r: number; g: number; b: number } {
    const c = color.trim().toLowerCase();
    const named: Record<string, [number, number, number]> = {
      red: [255, 0, 0],
      green: [0, 200, 0],
      blue: [0, 100, 255],
      yellow: [255, 255, 0],
      cyan: [0, 255, 255],
      magenta: [255, 0, 255],
      white: [255, 255, 255],
      black: [0, 0, 0],
      orange: [255, 165, 0],
      purple: [160, 32, 240],
      lime: [0, 255, 0],
      pink: [255, 105, 180],
    };
    if (c in named) {
      const [r, g, b] = named[c]!;
      return { r, g, b };
    }
    const hex = c.match(/^#([0-9a-f]{6})$/);
    if (hex) {
      const v = parseInt(hex[1]!, 16);
      return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
    }
    throw new Error(`Invalid color "${color}" — use a CSS name (red/blue/lime/...) or #rrggbb`);
  }

  /**
   * Draw a colored square at viewport (x, y) with side length `size`.
   * The square is filled with the LLM-chosen color and outlined in
   * WHITE (so it's always visible regardless of page background).
   * Coordinates are CSS pixels (in viewport coordinate space).
   */
  async highlightQuad(
    x: number, y: number, size = 80,
    color: string = 'red',
  ): Promise<void> {
    log.info('cdp', 'highlightQuad', { runId: this.runId, x, y, size, color });
    this.lastAimPos = { x, y };
    // Enable the overlay domain first — without this, the highlight
    // is NOT rendered in normal browsing mode (Chrome optimizes away
    // the overlay layer until something explicitly enables it).
    await this.enableOverlay();
    const { r, g, b } = this.parseColor(color);
    const half = size / 2;
    // 4 corners, clockwise from top-left, in CSS pixels.
    const quad = [
      x - half, y - half, // top-left
      x + half, y - half, // top-right
      x + half, y + half, // bottom-right
      x - half, y + half, // bottom-left
    ];
    await this.send('Overlay.highlightQuad', {
      quad,
      color: { r, g, b, a: 0.5 },                // 50% transparent fill
      outlineColor: { r: 255, g: 255, b: 255, a: 1 }, // WHITE outline for contrast
    });
    this.highlightVisible = true;
  }

  /** Clear the highlight. Also disables the Overlay domain to release GPU resources. */
  async clearHighlight(): Promise<void> {
    if (!this.highlightVisible && !this.overlayEnabled) return;
    log.info('cdp', 'clearHighlight', { runId: this.runId });
    try { await this.send('Overlay.hideHighlight'); } catch { /* ignore */ }
    try { await this.send('Overlay.disable'); } catch { /* ignore */ }
    this.highlightVisible = false;
    this.overlayEnabled = false;
  }
}

// ---------- Helpers ----------

const KEY_MAP: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
