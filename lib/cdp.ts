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

  /** Send a raw CDP command. Auto-recovers from "Debugger is not attached"
   *  by reattaching once and retrying. Chrome MV3 occasionally drops the
   *  debugger session right after `attach()` resolves (especially after
   *  the tab loses focus or the user changes windows) — the next
   *  sendCommand fails with "Debugger is not attached to the tab with
   *  id: N". The user-visible symptom is the agent getting stuck in a
   *  "debugger not attaching" loop; the fix is to retry the attach+send
   *  one more time so the agent can keep moving. */
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.attached || this.tabId == null) {
      throw new Error('CDP not attached — call attach() first');
    }
    const t0 = Date.now();
    const trySend = (): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId: this.tabId! }, method, params, (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message ?? 'unknown'));
          } else {
            resolve(result as T);
          }
        });
      });
    try {
      return await trySend();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only auto-recover from the specific "not attached" failure.
      const isDetach = /debugger.*not.*attached|invalid.*tab/i.test(msg);
      if (!isDetach) {
        log.error('cdp', 'send failed', { runId: this.runId, method, error: msg, durationMs: Date.now() - t0 });
        throw err;
      }
      log.warn('cdp', 'send saw detach, reattaching', { runId: this.runId, method, error: msg });
      this.attached = false;
      // Force a fresh attach on the same tabId.
      try {
        await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
        this.attached = true;
        log.info('cdp', 'reattach ok', { runId: this.runId, tabId: this.tabId });
      } catch (reattachErr) {
        const reMsg = reattachErr instanceof Error ? reattachErr.message : String(reattachErr);
        log.error('cdp', 'reattach failed', { runId: this.runId, tabId: this.tabId, error: reMsg });
        throw reattachErr;
      }
      return await trySend();
    }
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

  /**
   * Drag from (x1, y1) to (x2, y2) using native CDP mouse events.
   *
   * Semantics differ from `click()` in three critical ways (see P0 test-game
   * plan, §cdpDrag):
   *   1. `mousePressed` and every intermediate `mouseMoved` carry `buttons: 1`.
   *      PixiJS / DOM `mousedown` handlers check `event.buttons` to detect
   *      drag-state — without `buttons: 1`, the move events are treated as
   *      "hover, no button held" and drag is broken.
   *   2. `mouseReleased` carries `clickCount: 0` (not 1). With `clickCount: 1`
   *      Chrome fires a dblclick after the release, which PixiJS would
   *      route to the ball as a separate event, breaking drag handlers.
   *   3. Inter-step delay is 30-40 ms (longer than click()'s 8-15 ms in
   *      `mouseMove`). PixiJS's InteractionManager debounces by frame and
   *      needs visible time between moves to render drag-over states.
   *
   * @param x1 CSS-pixel X of drag start.
   * @param y1 CSS-pixel Y of drag start.
   * @param x2 CSS-pixel X of drag end.
   * @param y2 CSS-pixel Y of drag end.
   * @param steps Number of intermediate `mouseMoved` events. Default 24,
   *              chosen empirically for PixiJS collision detection reliability.
   */
  async drag(x1: number, y1: number, x2: number, y2: number, steps = 24): Promise<void> {
    log.info('cdp', 'drag', { runId: this.runId, x1, y1, x2, y2, steps });
    await this.mouseMove(x1, y1);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      x: x1,
      y: y1,
      clickCount: 1,
      buttons: 1,
    });
    await sleep(50 + Math.random() * 30);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = Math.round(x1 + (x2 - x1) * t);
      const py = Math.round(y1 + (y2 - y1) * t);
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: px,
        y: py,
        buttons: 1,
      });
      await sleep(30 + Math.random() * 10);
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      x: x2,
      y: y2,
      clickCount: 0, // NOT 1 — see method comment
      buttons: 0,
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
    if (!this.lastAimPos) {
      throw new Error('cdp.scroll: no previous aim — call cdpAim(x, y) first to set a scroll position');
    }
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
    if (!tab.active) {
      await chrome.tabs.update(this.tabId, { active: true });
      // Tiny wait for the swap to settle (rendering layer has to update).
      await new Promise((r) => setTimeout(r, 50));
    }
    // Wait for the GPU compositor to paint any pending overlay into the
    // framebuffer (otherwise we get a partial "BEFORE" ~20% of the time).
    await new Promise((r) => setTimeout(r, 200));
    const rawDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

    // Target dimensions — CSS pixels per `chrome.tabs.Tab` docs (window.innerWidth).
    const cssWidth = tab.width ?? 0;
    const cssHeight = tab.height ?? 0;

    // Decode raw PNG bytes (SW has no Buffer — use atob + Uint8Array).
    const base64 = rawDataUrl.startsWith('data:image/png;base64,')
      ? rawDataUrl.slice('data:image/png;base64,'.length)
      : rawDataUrl;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // No target dimensions, or raw capture already matches CSS — return as-is.
    if (!cssWidth || !cssHeight) {
      return { dataUrl: rawDataUrl, width: 0, height: 0 };
    }
    const view = new DataView(bytes.buffer);
    const rawWidth = view.getUint32(16, false);
    const rawHeight = view.getUint32(20, false);
    if (rawWidth === cssWidth && rawHeight === cssHeight) {
      return { dataUrl: rawDataUrl, width: cssWidth, height: cssHeight };
    }

    // Resize device-pixel PNG → CSS-pixel PNG via OffscreenCanvas.
    log.info('cdp', 'screenshot resize', {
      runId: this.runId,
      from: `${rawWidth}x${rawHeight}`,
      to: `${cssWidth}x${cssHeight}`,
    });
    const blob = new Blob([bytes], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(cssWidth, cssHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('cdp.screenshot: OffscreenCanvas 2d context unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, cssWidth, cssHeight);
    bitmap.close();
    const resizedBlob = await canvas.convertToBlob({ type: 'image/png' });
    const resizedDataUrl = await blobToDataUrl(resizedBlob);
    return { dataUrl: resizedDataUrl, width: cssWidth, height: cssHeight };
  }

  private lastAimPos: { x: number; y: number } | null = null;

  /** Get the last aim position (for scroll, etc.). */
  get aimX(): number { return this.lastAimPos?.x ?? 0; }
  get aimY(): number { return this.lastAimPos?.y ?? 0; }

  /**
   * Get the last aim position. Returns null if no aim has been made
   * yet. Used by cdpAim's relative mode (dx/dy) to compute the new
   * aim position from the current one.
   */
  getCurrentAim(): { x: number; y: number } | null {
    return this.lastAimPos;
  }

  /**
   * Read the RGBA pixel at CSS-pixel coordinates (x, y) of the current
   * tab. Returns `{ r, g, b, a }` where each component is 0-255. Used
   * by cdpAim to verify the LLM's visual aim landed on the expected
   * color (e.g. "the red button" → pixel should be red-ish).
   *
   * Implementation: take a fresh screenshot, decode the pixels, read
   * one. This is one extra capture per aim, but only ~50ms and the
   * LLM gets a strong ground-truth signal.
   */
  async readPixel(x: number, y: number): Promise<{ r: number; g: number; b: number; a: number }> {
    const shot = await this.screenshot();
    const base64 = shot.dataUrl.replace(/^data:image\/png;base64,/, '');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(shot.width, shot.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('cdp.readPixel: OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const ix = Math.max(0, Math.min(shot.width - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(shot.height - 1, Math.round(y)));
    const data = ctx.getImageData(ix, iy, 1, 1).data;
    return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! };
  }

  /**
   * Take a screenshot and overlay an N×M grid with cell labels so the
   * LLM can describe targets in grid coordinates (e.g. "row 8, col 5")
   * instead of guessing pixel coords. The grid is thin semi-transparent
   * grey so it doesn't obscure page content; labels are at the top-left
   * of each cell.
   *
   * Default: 10 columns × 8 rows. For a 1280×770 viewport that gives
   * 128×96 cells — large enough that the LLM's ±60px visual error
   * reliably falls in the right cell, small enough to give useful
   * precision.
   */
  async screenshotWithGrid(
    cols: number = 10,
    rows: number = 8,
  ): Promise<{ dataUrl: string; width: number; height: number; cols: number; rows: number }> {
    const shot = await this.screenshot();
    const base64 = shot.dataUrl.replace(/^data:image\/png;base64,/, '');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(shot.width, shot.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('cdp.screenshotWithGrid: OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const W = shot.width, H = shot.height;
    const cellW = W / cols, cellH = H / rows;

    // Draw grid lines (thin, semi-transparent dark grey for visibility on
    // both light and dark backgrounds).
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i < cols; i++) {
      const x = Math.round(i * cellW) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let i = 1; i < rows; i++) {
      const y = Math.round(i * cellH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Cell labels — small dark text on a light pill so it's readable on
    // any background. Top-left corner of each cell.
    const fontPx = Math.max(11, Math.min(18, Math.floor(Math.min(cellW, cellH) / 6)));
    ctx.font = `bold ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = Math.round(c * cellW) + 4;
        const y = Math.round(r * cellH) + 4;
        const label = `r${r}c${c}`;
        // White pill background for legibility.
        const metrics = ctx.measureText(label);
        const padX = 4, padY = 2;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(
          x - padX,
          y - padY,
          metrics.width + padX * 2,
          fontPx + padY * 2,
        );
        ctx.fillStyle = 'rgba(0, 0, 0, 0.95)';
        ctx.fillText(label, x, y);
      }
    }

    const composedBlob = await canvas.convertToBlob({ type: 'image/png' });
    const composedDataUrl = await blobToDataUrl(composedBlob);
    return {
      dataUrl: composedDataUrl,
      width: W,
      height: H,
      cols,
      rows,
    };
  }

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

/** Convert a Blob to a "data:..." URL. Used by screenshot() after resize. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
