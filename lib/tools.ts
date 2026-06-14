// AI SDK tools — bridge the LLM to the active browser tab.
// All execute() functions run in the service-worker context and use
// chrome.scripting.executeScript to interact with the page (no pre-injected
// content script needed for DOM operations).

import { tool } from 'ai';
import { z } from 'zod';

// ---------- Safe-execute wrapper ----------
//
// Architecture rule (user-clarified 2026-06-13): tool errors are
// OBSERVATIONS, not termination conditions. The agent loop must continue
// after a tool throws so the LLM can recover (retry, try a different
// approach, etc.). The only valid termination signals are:
//   - user cancel (AbortController)
//   - max steps reached
//   - fatal system error (network, provider 5xx)
//   - LLM signals completion
//
// Implementation: wrap each tool's `execute` so thrown errors become a
// regular tool result of shape `{ error: string }`. The AI SDK will pass
// this to the LLM as a tool result on the next step. The LLM sees the
// error and can decide what to do — the loop does NOT terminate.
//
// Content renderers (`experimental_toToolResultContent`) get the error
// shape and return a text-only content block explaining the failure.

type AnyTool = {
  description?: string;
  parameters?: unknown;
  execute?: (...args: unknown[]) => Promise<unknown>;
  experimental_toToolResultContent?: (output: unknown) => unknown;
};

function safeExecute<T extends AnyTool>(t: T): T {
  if (!t.execute) return t;
  const orig = t.execute;
  const origContent = t.experimental_toToolResultContent;
  return {
    ...t,
    execute: (async (...args: unknown[]) => {
      try {
        return await orig(...args);
      } catch (err) {
        // Return as an observation so the AI SDK loop continues.
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }) as T['execute'],
    experimental_toToolResultContent: origContent
      ? ((output: unknown) => {
          if (output && typeof output === 'object' && 'error' in (output as Record<string, unknown>)) {
            return [
              { type: 'text', text: `Tool error: ${(output as { error: string }).error}` },
            ];
          }
          return origContent(output);
        }) as T['experimental_toToolResultContent']
      : undefined,
  };
}

// ---------- Helpers ----------

/**
 * Strip the `data:<mime>;base64,` prefix from a data URL and return the
 * raw base64 string. AI SDK v4's `ToolResultContent` `image` type's `data`
 * field is forwarded verbatim to the Anthropic provider, which then puts
 * it directly into the API's `data` field (per
 * node_modules/@ai-sdk/anthropic/dist/index.js:291). Anthropic expects
 * RAW base64 there — not a data URL — so a `data:image/png;base64,iVBORw0…`
 * value would be rejected (or silently dropped) by the API. Always strip
 * the prefix before passing to the AI SDK.
 */
function stripDataUrlPrefix(dataUrl: string): string {
  const m = dataUrl.match(/^data:[^;]+;base64,(.*)$/);
  return m?.[1] ?? dataUrl;
}

async function getActiveTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return tab as chrome.tabs.Tab & { id: number };
}

async function runOnActiveTab<T>(func: () => T | Promise<T>): Promise<T> {
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id as number },
    // The function is auto-serialized to the MAIN world of the page.
    func,
  });
  if (!result) throw new Error('executeScript returned no result');
  return result.result as T;
}

// ---------- Tools ----------

/**
 * todo — lets the agent maintain a visible plan. The LLM calls this with
 * the full list of todos (not a diff) so the UI can render it cleanly.
 * Status: 'pending' | 'in_progress' | 'completed'.
 * Exactly one todo should be in_progress at a time.
 */
export const createTodoTool = (
  emit: (event: { type: string; [k: string]: unknown }) => void,
) =>
  tool({
    description:
      'Update the agent\'s todo list. Pass the FULL list each time (not a diff). ' +
      'Use this to plan multi-step work: mark one todo in_progress at a time, ' +
      'and mark completed when done. The UI will display the list to the user.',
    parameters: z.object({
      todos: z.array(
        z.object({
          content: z.string().min(1).describe('Short description of the step'),
          status: z.enum(['pending', 'in_progress', 'completed']),
          activeForm: z.string().min(1).describe('Present-continuous form, e.g. "Clicking the submit button"'),
        }),
      ).min(1).max(20),
    }),
    execute: async ({ todos }) => {
      // Emit a distinct event type for todos (architecture rule 7).
      emit({ type: 'todo_update', todos });
      // Echo back the list as the tool result so the LLM sees the current state.
      return { todos };
    },
  });

export const domQuery = tool({
  description:
    'Find DOM elements matching a CSS selector on the active tab. Returns up to `limit` elements with their tag, id, class, visible text (first 200 chars), and key attributes. Use this BEFORE clicking or typing to confirm what is on the page.',
  parameters: z.object({
    selector: z
      .string()
      .describe('CSS selector, e.g. "button.submit", "input[type=email]", "h1", "[data-testid=search]"'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of elements to return (1-50, default 10)'),
  }),
  execute: async ({ selector, limit }) =>
    runOnActiveTab(() => {
      const els = Array.from(document.querySelectorAll(selector)).slice(0, limit);
      return els.map((el, i) => {
        const text = (el.textContent ?? '').trim().slice(0, 200);
        const attrs: Record<string, string> = {};
        for (const a of Array.from(el.attributes)) {
          attrs[a.name] = a.value.slice(0, 100);
        }
        return {
          i,
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          className:
            el.className && typeof el.className === 'string'
              ? el.className.slice(0, 100)
              : undefined,
          text,
          attrs,
        };
      });
    }),
});

export const domClick = tool({
  description:
    'Click the first element on the active tab that matches the given CSS selector. The element is scrolled into view first. Use domQuery first if you are not sure the selector is correct.',
  parameters: z.object({
    selector: z.string().describe('CSS selector of the element to click'),
  }),
  execute: async ({ selector }) =>
    runOnActiveTab(() => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return { ok: false, error: `No element matched "${selector}"` };
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      el.click();
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, 60),
      };
    }),
});

export const domType = tool({
  description:
    'Type text into an <input>, <textarea>, or contenteditable element matched by selector. Uses the native value setter so React/Vue pick up the change, then dispatches `input` and `change` events.',
  parameters: z.object({
    selector: z.string().describe('CSS selector of the input/textarea/contenteditable'),
    text: z.string().describe('The text to type'),
  }),
  execute: async ({ selector, text }) =>
    runOnActiveTab(() => {
      const el = document.querySelector(selector) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      if (!el) return { ok: false, error: `No element matched "${selector}"` };
      el.focus();
      // Use the native setter so React/Vue pick up the value change.
      const proto = Object.getPrototypeOf(el) as object;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        (setter as (v: string) => void).call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, tag: el.tagName.toLowerCase(), length: text.length };
    }),
});

export const screenshot = tool({
  description:
    'Capture a screenshot of the active tab\'s currently visible viewport. ALWAYS call this before any UI action (click/type) so you can see what the page looks like. Returns the image plus viewport dimensions.',
  parameters: z.object({}).strict(),
  execute: async () => {
    const tab = await getActiveTab();
    if (tab.url && !tab.url.startsWith('http')) {
      return { error: `Cannot capture non-http URL (${tab.url}). Switch to an HTTP tab first.` };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId as number, {
      format: 'png',
    });
    return {
      dataUrl,
      width: tab.width ?? 0,
      height: tab.height ?? 0,
    };
  },
  // AI SDK v4: convert the dataURL result into a multi-modal content array
  // so the model actually sees the image. The text caption helps the model
  // know what it's looking at.
  experimental_toToolResultContent: (output: { dataUrl?: string; width?: number; height?: number; error?: string }) => {
    if (!output.dataUrl) return [{ type: 'text', text: output.error ?? 'Screenshot failed' }];
    return [
      { type: 'text', text: `Screenshot captured (${output.width ?? 0}x${output.height ?? 0}px).` },
      { type: 'image', data: stripDataUrlPrefix(output.dataUrl), mimeType: 'image/png' },
    ];
  },
});

// ---------- Tab management ----------

export const tabsList = tool({
  description:
    'List all open tabs across all windows. Each entry has id, windowId, title, url, and whether the tab is active. Use this before taking screenshots or acting on the page, so you can pick the right tab and switch to it.',
  parameters: z.object({}).strict(),
  execute: async () => {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => t.id != null)
      .map((t) => ({
        id: t.id as number,
        windowId: t.windowId,
        title: t.title ?? '',
        url: t.url ?? '',
        active: t.active,
        status: t.status,
      }));
  },
});

export const tabsSwitch = tool({
  description:
    'Make a specific tab the active tab. Pass the tab id from tabsList. After this call, screenshot() and DOM tools will see that tab.',
  parameters: z.object({
    tabId: z.number().int().describe('The tab id (from tabsList) to activate.'),
  }),
  execute: async ({ tabId }) => {
    await chrome.tabs.update(tabId, { active: true });
    // Small delay to let the tab finish swapping in.
    await new Promise((r) => setTimeout(r, 200));
    const tab = await chrome.tabs.get(tabId);
    return { ok: true, id: tab.id, url: tab.url, title: tab.title };
  },
});

export const tabsOpen = tool({
  description:
    'Open a new tab at the given URL and make it the active tab. Use this when the page you need is not already open.',
  parameters: z.object({
    url: z.string().url().describe('The full URL to open (must include https://).'),
  }),
  execute: async ({ url }) => {
    const tab = await chrome.tabs.create({ url, active: true });
    // Wait for the tab to start loading; can't easily wait for full load.
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: true, id: tab.id, url: tab.url, title: tab.title };
  },
});

export const tabsClose = tool({
  description:
    'Close one or more tabs by their IDs. Use to clean up tabs opened during the task.',
  parameters: z.object({
    tabIds: z.array(z.number().int()).describe('Array of tab IDs to close'),
  }),
  execute: async ({ tabIds }) => {
    await chrome.tabs.remove(tabIds);
    return { ok: true, closed: tabIds.length };
  },
});

export const pressKey = tool({
  description:
    'Send a keyboard event to the currently focused element. Use after domType to submit forms (Enter) or trigger shortcuts. Supports: Enter, Tab, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Delete.',
  parameters: z.object({
    key: z
      .enum(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'])
      .describe('The key to press.'),
  }),
  execute: async ({ key }) => {
    return runOnActiveTab(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) {
        return { ok: false, error: 'No focused element. Click an input first.' };
      }
      const eventInit = {
        key,
        code: key,
        keyCode: keyCodeFor(key),
        which: keyCodeFor(key),
        bubbles: true,
        cancelable: true,
        composed: true,
      } as KeyboardEventInit;
      el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      if (key === 'Enter') {
        const form = el.closest('form');
        if (form) {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else {
            form.submit();
          }
        }
      }
      el.dispatchEvent(new KeyboardEvent('keypress', eventInit));
      el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
      return { ok: true, key };
    });
  },
});

function keyCodeFor(key: string): number {
  switch (key) {
    case 'Enter': return 13;
    case 'Tab': return 9;
    case 'Escape': return 27;
    case 'ArrowUp': return 38;
    case 'ArrowDown': return 40;
    case 'ArrowLeft': return 37;
    case 'ArrowRight': return 39;
    case 'Backspace': return 8;
    case 'Delete': return 46;
    default: return 0;
  }
}

// ---------- Focus navigation ----------

interface FocusStep {
  step: number;
  direction: 'next' | 'previous';
  element: { tag: string; name: string; role: string; bbox?: { x: number; y: number; width: number; height: number } } | null;
}

const MAX_TABS = 5;

export const focusNext = tool({
  description:
    'Press Tab one or more times to move keyboard focus forward. After each Tab, returns the accessible name and role of the focused element. Use when DOM is obfuscated (Google, Meta) and domQuery fails. The focus ring is a reliable visual marker.',
  parameters: z.object({
    count: z.number().int().min(1).max(MAX_TABS).default(1),
  }),
  execute: async ({ count }) => {
    const steps: FocusStep[] = [];
    for (let i = 0; i < count; i++) {
      const step = await runOnActiveTab(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true,
        }));
        const el = document.activeElement;
        if (!el || el === document.body) return { step: i + 1, direction: 'next' as const, element: null };
        const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 80) ?? '';
        const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
        const rect = el.getBoundingClientRect();
        const bbox = rect.width > 0 && rect.height > 0
          ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          : undefined;
        return { step: i + 1, direction: 'next' as const, element: { tag: el.tagName.toLowerCase(), name, role, bbox } };
      });
      steps.push(step as FocusStep);
    }
    return { pressed: count, steps };
  },
});

export const focusPrevious = tool({
  description:
    'Press Shift+Tab to move focus backward. Same as focusNext but reverse direction.',
  parameters: z.object({
    count: z.number().int().min(1).max(MAX_TABS).default(1),
  }),
  execute: async ({ count }) => {
    const steps: FocusStep[] = [];
    for (let i = 0; i < count; i++) {
      const step = await runOnActiveTab(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab', code: 'Tab', keyCode: 9, which: 9, shiftKey: true, bubbles: true, cancelable: true,
        }));
        const el = document.activeElement;
        if (!el || el === document.body) return { step: i + 1, direction: 'previous' as const, element: null };
        const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 80) ?? '';
        const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
        const rect = el.getBoundingClientRect();
        const bbox = rect.width > 0 && rect.height > 0
          ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          : undefined;
        return { step: i + 1, direction: 'previous' as const, element: { tag: el.tagName.toLowerCase(), name, role, bbox } };
      });
      steps.push(step as FocusStep);
    }
    return { pressed: count, steps };
  },
});

// ---------- Smart screenshot ----------

export const smartScreenshot = tool({
  description:
    `Smart screenshot of the active tab's visible viewport. Multiple modes:
- no args: single full-page shot.
- { region: {x,y,width,height} }: crop to a region.
- { schedule: {durationMs, intervalMs} }: capture N frames over time, return ONLY metadata (index, timestamp, changeFromBaseline, bbox) — NO images.
- { refs: [0, 5, 7] }: fetch specific frames from the most recent schedule run.

Use schedule mode to detect page load completion or animation without paying image-token cost.`,
  parameters: z
    .object({
      region: z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1).max(8000),
        height: z.number().int().min(1).max(8000),
      }).optional().describe('Crop to this viewport region.'),
      schedule: z.object({
        durationMs: z.number().int().min(100).max(60_000),
        intervalMs: z.number().int().min(50).max(5_000),
      }).optional().describe('Time-windowed capture.'),
      refs: z.array(z.number().int().min(0)).max(20).optional()
        .describe('Indices from a previous schedule whose images you want.'),
    })
    .strict(),
  execute: async (opts) => {
    const o = opts as Record<string, unknown>;
    // Route to side panel for schedule/region/refs, or do single shot in SW.
    if (!o.region && !o.schedule && !o.refs) {
      // Single full shot — do it in the SW directly.
      const tab = await getActiveTab();
      if (!tab.url || !tab.url.startsWith('http')) {
        return { error: `Cannot capture non-http URL (${tab.url || 'empty'}). Switch to an HTTP tab first.` };
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { kind: 'single', dataUrl, width: tab.width ?? 0, height: tab.height ?? 0, timestamp: Date.now() };
    }
    // Delegate to the side panel for schedule/region/refs (needs Canvas/ImageBitmap).
    try {
      const res = await chrome.runtime.sendMessage({
        type: '__smart-screenshot:execute',
        options: o,
      });
      if (res?.ok) return res.data;
    } catch {
      // Fall through to error.
    }
    return { error: 'Smart screenshot: side panel not available or unresponsive.' };
  },
});

// ---------- CDP-based tools (native input, singleton connection) ----------

import { getCurrentCDP } from '@/lib/cdp';

export const cdpClick = tool({
  description:
    'Click at a SCREENSHOT coordinate (x, y) using native CDP mouse events. Use domQuery first to find the element and get its bounding box, then pass the center coordinates here (in SCREENSHOT pixel space, the same as the image you see).',
  parameters: z.object({
    x: z.number().int().min(0).describe('SCREENSHOT X coordinate (same units as the image you see)'),
    y: z.number().int().min(0).describe('SCREENSHOT Y coordinate (same units as the image you see)'),
  }),
  execute: async ({ x, y }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    // Convert screenshot px -> CSS px using the cached dpr.
    const dpr = cdp.dpr;
    const cssX = Math.round(x / dpr);
    const cssY = Math.round(y / dpr);
    await cdp.click(cssX, cssY);
    return { ok: true, x, y };
  },
});

export const cdpType = tool({
  description:
    'Type text character by character using native CDP keyboard events. More reliable than domType.',
  parameters: z.object({
    text: z.string().describe('The text to type'),
  }),
  execute: async ({ text }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    await cdp.type(text);
    return { ok: true, length: text.length };
  },
});

export const cdpPressKey = tool({
  description:
    'Press a special key (Enter, Tab, Escape, etc.) using native CDP keyboard events.',
  parameters: z.object({
    key: z
      .enum(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
      .describe('The key to press'),
  }),
  execute: async ({ key }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    await cdp.pressKey(key);
    return { ok: true, key };
  },
});

export const cdpScreenshot = tool({
  description:
    'Take a screenshot of the active tab using CDP (more reliable than the JS-based screenshot).',
  parameters: z.object({}).strict(),
  execute: async () => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    if (!tab.url || !tab.url.startsWith('http')) {
      return { error: `Cannot capture non-http URL (${tab.url || 'empty'}).` };
    }
    await cdp.attach(tab.id);
    const shot = await cdp.screenshot();
    const dpr = tab.width ? shot.width / tab.width : 1;
    return {
      dataUrl: shot.dataUrl,
      width: tab.width ?? 0,
      height: tab.height ?? 0,
      screenshotWidth: shot.width,
      screenshotHeight: shot.height,
      dpr,
    };
  },
  experimental_toToolResultContent: (output: { dataUrl?: string; width?: number; height?: number; error?: string }) => {
    if (!output.dataUrl) return [{ type: 'text', text: output.error ?? 'Screenshot failed' }];
    return [
      { type: 'text', text: `Screenshot captured (${output.width ?? 0}x${output.height ?? 0}px).` },
      { type: 'image', data: stripDataUrlPrefix(output.dataUrl), mimeType: 'image/png' },
    ];
  },
});

// ---------- CDP Aim / Confirm / Cancel (visual feedback loop) ----------

export const cdpAim = tool({
  description:
    'Draw a colored highlight square (crosshair) at SCREENSHOT coordinates (x, y) using CDP Overlay, then take a screenshot so you can visually verify the position BEFORE clicking. The x, y, size parameters are in the same coordinate space as the BEFORE/AFTER images you see (screenshot pixel coordinates) — the tool converts to CSS internamente using the cached dpr. You do NOT need to think about dpr. This tool AUTOMATICALLY captures a BEFORE screenshot (no crosshair) AND an AFTER screenshot (with crosshair drawn) so you can compare them and decide if the position is correct. If the crosshair is ON target, call cdpConfirm(x, y) with the same coordinates. If NOT, call cdpCancel() then call cdpAim again with corrected SCREENSHOT coordinates. MANDATORY verification loop: aim -> compare before/after -> if off-target, cancel and re-aim -> repeat until on target, THEN cdpConfirm. Do NOT call cdpClick directly — always use the aim->confirm flow.\n\nVISUAL SERVOING — two phases, separate position from size:\n  Phase 1 (FIX POSITION, size locked at 200): aim with a large box. Compare BEFORE/AFTER. If target is inside the red box, advance. If off-target, cancel and re-aim with corrected x/y. Keep size=200. Iterate 3-4 rounds until the target is centered.\n  Phase 2 (SHRINK SIZE, position locked): once centered, shrink the box: 200->100->50->20. Verify the target is still fully covered at each size.\n  CRITICAL: never change BOTH x/y and size in the same step. Phase 1 changes only x/y. Phase 2 changes only size. Mixing them makes the visual feedback ambiguous.\n\nCOLOR: pick a color that CONTRASTS with the page background (e.g., red on white, cyan/yellow on dark pages, green on red pages). Defaults to red. CSS names (red/blue/lime/cyan/yellow/magenta/orange/purple/white/black) or #rrggbb.',
  parameters: z.object({
    x: z.number().int().min(0).describe('SCREENSHOT X coordinate to aim at (the same units as the BEFORE/AFTER image you see)'),
    y: z.number().int().min(0).describe('SCREENSHOT Y coordinate to aim at (the same units as the BEFORE/AFTER image you see)'),
    size: z.number().int().min(8).max(400).default(80).describe('Side length of the highlight square in SCREENSHOT pixels. DEFAULT 80 — must be large enough to see (8px is invisible on HiDPI).'),
    color: z.string().default('red').describe('CSS color name (red/blue/lime/cyan/yellow/orange/purple/white/black) or #rrggbb. Pick a color contrasting the page background.'),
  }),
  execute: async ({ x, y, size, color }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    // Pre-screenshot BEFORE drawing the crosshair so the LLM can compare
    // before/after and verify the crosshair actually landed where it asked.
    const before = await cdp.screenshot();
    // x, y, size arrive in SCREENSHOT pixels (what the LLM sees in the
    // image). Convert to CSS pixels using the cached dpr from the previous
    // screenshot() call — the LLM never has to think about dpr, DPR, or
    // any device-vs-CSS distinction.
    const dpr = cdp.dpr;
    const cssX = Math.round(x / dpr);
    const cssY = Math.round(y / dpr);
    const cssSize = Math.round(size / dpr);
    await cdp.highlightQuad(cssX, cssY, cssSize, color);
    const after = await cdp.screenshot();
    return {
      dataUrl: after.dataUrl,
      beforeDataUrl: before.dataUrl,
      // Report the screenshot dimensions so the LLM knows the coordinate
      // space it should keep using. dpr and CSS dimensions are kept for
      // debugging but the LLM is no longer expected to divide by dpr.
      width: tab.width ?? 0,
      height: tab.height ?? 0,
      screenshotWidth: after.width,
      screenshotHeight: after.height,
      dpr,
      aimX: x,                           // screenshot px (matches the caller's intent)
      aimY: y,
      color,
    };
  },
  experimental_toToolResultContent: (output: {
    dataUrl: string; beforeDataUrl?: string;
    width: number; height: number; dpr: number;
    aimX: number; aimY: number;
  }) => {
    const text = [
      `AIMED at SCREENSHOT pixel (${output.aimX}, ${output.aimY}) on a ${output.screenshotWidth}x${output.screenshotHeight} image.`,
      `The tool converted your screenshot coordinates to CSS internamente — no dpr math needed.`,
      `COMPARE the BEFORE and AFTER images: is the red square on your target? If YES -> cdpConfirm(${output.aimX}, ${output.aimY}). If NO -> cdpCancel() + cdpAim with corrected SCREENSHOT coordinates.`,
      `Always pass the same coordinate space as the image (screenshot pixels).`,
    ].join(' ');
    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
      { type: 'text', text },
    ];
    if (output.beforeDataUrl) {
      content.push({ type: 'text', text: 'BEFORE (no crosshair):' });
      content.push({ type: 'image', data: stripDataUrlPrefix(output.beforeDataUrl), mimeType: 'image/png' });
    }
    content.push({ type: 'text', text: `AFTER (red crosshair at SCREENSHOT ${output.aimX}, ${output.aimY}):` });
    content.push({ type: 'image', data: stripDataUrlPrefix(output.dataUrl), mimeType: 'image/png' });
    return content;
  },
});

export const cdpConfirm = tool({
  description:
    'Confirm the aim position and execute the click. Clears the red crosshair. Use this AFTER cdpAim — never call cdpClick directly. The x, y must be in SCREENSHOT pixel space (the same as the cdpAim coordinates).',
  parameters: z.object({
    x: z.number().int().min(0).describe('SCREENSHOT X coordinate (must match the cdpAim coordinates)'),
    y: z.number().int().min(0).describe('SCREENSHOT Y coordinate (must match the cdpAim coordinates)'),
  }),
  execute: async ({ x, y }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    // Convert screenshot px -> CSS px using the cached dpr.
    const dpr = cdp.dpr;
    const cssX = Math.round(x / dpr);
    const cssY = Math.round(y / dpr);
    await cdp.clearHighlight();
    await cdp.click(cssX, cssY);
    return { ok: true, x, y };
  },
});

export const cdpScroll = tool({
  description:
    'Scroll the page at the position of the last cdpAim crosshair. Use after cdpAim to scroll while keeping the aim position. deltaY > 0 = scroll down, deltaY < 0 = scroll up. deltaX > 0 = scroll right, deltaX < 0 = scroll left.',
  parameters: z.object({
    deltaY: z.number().int().describe('Vertical scroll amount in pixels (positive=down, negative=up)'),
    deltaX: z.number().int().default(0).describe('Horizontal scroll amount in pixels'),
  }),
  execute: async ({ deltaX, deltaY }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    await cdp.scroll(deltaX, deltaY);
    return { ok: true, deltaX, deltaY, atX: cdp.aimX, atY: cdp.aimY };
  },
});

export const cdpCancel = tool({
  description:
    'Clear the red crosshair without clicking. Use this if you decide NOT to click or scroll at the aimed position.',
  parameters: z.object({}).strict(),
  execute: async () => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    await cdp.clearHighlight();
    return { ok: true };
  },
});

// ---------- Tool registry ----------

// All tool errors must be OBSERVATIONS, not termination conditions. Every
// entry here is wrapped in safeExecute so a throw becomes a normal
// { error: string } tool result and the AI SDK loop continues.
export const allTools = {
  // CDP native input + visual feedback.
  cdpAim: safeExecute(cdpAim),
  cdpConfirm: safeExecute(cdpConfirm),
  cdpScroll: safeExecute(cdpScroll),
  cdpCancel: safeExecute(cdpCancel),
  cdpClick: safeExecute(cdpClick),
  cdpType: safeExecute(cdpType),
  cdpPressKey: safeExecute(cdpPressKey),
  cdpScreenshot: safeExecute(cdpScreenshot),
  // Focus navigation (Tab key traversal).
  focusNext: safeExecute(focusNext),
  focusPrevious: safeExecute(focusPrevious),
  // Smart screenshot
  smartScreenshot: safeExecute(smartScreenshot),
  // Tab management
  tabsList: safeExecute(tabsList),
  tabsSwitch: safeExecute(tabsSwitch),
  tabsOpen: safeExecute(tabsOpen),
  tabsClose: safeExecute(tabsClose),
  // DOM tools (escape hatch — use CDP tools first).
  domQuery: safeExecute(domQuery),
  domClick: safeExecute(domClick),
  domType: safeExecute(domType),
  pressKey: safeExecute(pressKey),
};
