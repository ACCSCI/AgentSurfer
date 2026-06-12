// CDP (Chrome DevTools Protocol) singleton service.
// One debugger connection per agent run, shared by all CDP tools.
// Requires "debugger" permission in manifest.json.

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

  /** Attach to a tab. No-op if already attached to the same tab. */
  async attach(tabId: number): Promise<void> {
    if (this.attached && this.tabId === tabId) return;
    if (this.attached) await this.detach();
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      this.tabId = tabId;
      this.attached = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "Another debugger" (DevTools open) or "Already attached" — treat as attached.
      if (msg.includes('Another debugger') || msg.includes('Already attached')) {
        this.tabId = tabId;
        this.attached = true;
      } else {
        throw err;
      }
    }
  }

  /** Detach from the current tab. Safe to call multiple times. */
  async detach(): Promise<void> {
    if (!this.attached || this.tabId == null) return;
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // ignore
    }
    this.attached = false;
    this.tabId = null;
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
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId: this.tabId! }, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result as T);
        }
      });
    });
  }

  // ---------- High-level actions ----------

  private lastMousePos: { x: number; y: number } = { x: 0, y: 0 };

  async click(x: number, y: number): Promise<void> {
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

  async screenshot(): Promise<string> {
    const result = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return `data:image/png;base64,${result.data}`;
  }

  // ---------- Overlay (visual feedback) ----------

  private highlightVisible = false;
  private overlayEnabled = false;

  /** Enable DOM + Overlay domains (must be called before highlightQuad). */
  async enableOverlay(): Promise<void> {
    if (this.overlayEnabled) return;
    await this.send('DOM.enable');
    await this.send('Overlay.enable');
    this.overlayEnabled = true;
  }

  /**
   * Draw a highlight quad (small colored square) at (x, y) with the given
   * side length. Uses CDP Overlay.highlightQuad — no DOM modification.
   * The quad is centered on (x, y).
   */
  async highlightQuad(x: number, y: number, size = 6): Promise<void> {
    await this.enableOverlay();
    const half = size / 2;
    // Four corners of the square, centered on (x, y).
    const quad = [
      x - half, y - half, // top-left
      x + half, y - half, // top-right
      x + half, y + half, // bottom-right
      x - half, y + half, // bottom-left
    ];
    await this.send('Overlay.highlightQuad', {
      quad,
      highlightConfig: {
        fillColor: 'rgba(255, 0, 0, 0.6)',
        borderColor: 'rgba(255, 0, 0, 1)',
        borderWidth: 2,
      },
    });
    this.highlightVisible = true;
  }

  /** Clear all overlay highlights. */
  async clearHighlight(): Promise<void> {
    if (!this.highlightVisible) return;
    await this.send('Overlay.hideHighlight');
    this.highlightVisible = false;
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
