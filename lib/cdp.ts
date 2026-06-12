// CDP (Chrome DevTools Protocol) wrapper — provides native-level control
// of the browser via chrome.debugger API. Used for:
// - Native mouse/keyboard (Input.dispatchMouseEvent / Input.dispatchKeyEvent)
// - Screenshots (Page.captureScreenshot)
// - Accessibility tree (Accessibility.getFullAXTree)
//
// Requires "debugger" permission in manifest.json.

/** Attach to a tab's debugger. Ignores "already attached" errors. */
export async function cdpAttach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "Already attached" is safe to ignore.
    if (!msg.includes('Already attached')) {
      throw err;
    }
  }
}

/** Detach from a tab's debugger. Ignores "not attached" errors. */
export async function cdpDetach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached — safe to ignore.
  }
}

/** Send a CDP command to a tab. Attaches first if needed. */
export async function cdpSend<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  await cdpAttach(tabId);
  // chrome.debugger.sendCommand types are loose, so we cast.
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result as T);
      }
    });
  });
}

// ---------- Input helpers ----------

let lastMousePos: Record<number, { x: number; y: number }> = {};

/** Move the mouse to (x, y) with a human-like trajectory. */
export async function cdpMouseMove(
  tabId: number,
  x: number,
  y: number,
): Promise<void> {
  const start = lastMousePos[tabId] ?? { x: 0, y: 0 };
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = Math.round(start.x + (x - start.x) * t);
    const py = Math.round(start.y + (y - start.y) * t);
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: px,
      y: py,
    });
    await sleep(8 + Math.random() * 7);
  }
  lastMousePos[tabId] = { x, y };
}

/** Click at (x, y) with human-like timing. */
export async function cdpClick(
  tabId: number,
  x: number,
  y: number,
): Promise<void> {
  await cdpMouseMove(tabId, x, y);
  await cdpSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    x,
    y,
    clickCount: 1,
  });
  await sleep(30 + Math.random() * 40);
  await cdpSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    x,
    y,
    clickCount: 1,
  });
}

/** Type text character by character with human-like delays. */
export async function cdpType(
  tabId: number,
  text: string,
): Promise<void> {
  for (const char of text) {
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      unmodifiedText: char,
    });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      text: char,
      unmodifiedText: char,
    });
    await sleep(30 + Math.random() * 50);
  }
}

/** Press a special key (Enter, Tab, Escape, etc.). */
export async function cdpPressKey(
  tabId: number,
  key: string,
): Promise<void> {
  const keyMap: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
    Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
    ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  };
  const km = keyMap[key] ?? { code: key, windowsVirtualKeyCode: 0 };
  await cdpSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code: km.code,
    windowsVirtualKeyCode: km.windowsVirtualKeyCode,
    nativeVirtualKeyCode: km.windowsVirtualKeyCode,
  });
  await cdpSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: km.code,
    windowsVirtualKeyCode: km.windowsVirtualKeyCode,
    nativeVirtualKeyCode: km.windowsVirtualKeyCode,
  });
}

/** Take a screenshot via CDP. Returns base64 PNG data. */
export async function cdpScreenshot(tabId: number): Promise<string> {
  const result = await cdpSend<{ data: string }>(tabId, 'Page.captureScreenshot', {
    format: 'png',
    quality: undefined,
  });
  return `data:image/png;base64,${result.data}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
