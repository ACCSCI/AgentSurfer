// AI SDK tools — bridge the LLM to the active browser tab.
// All execute() functions run in the service-worker context and use
// chrome.scripting.executeScript to interact with the page (no pre-injected
// content script needed for DOM operations).

import { tool } from 'ai';
import { z } from 'zod';

// ---------- Helpers ----------

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return tab;
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
  experimental_toToolResultContent: (output) => [
    {
      type: 'text',
      text: `Screenshot captured (${output.width}x${output.height}px).`,
    },
    {
      type: 'image',
      data: output.dataUrl,
      mimeType: 'image/png',
    },
  ],
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

export const allTools = {
  // Focus navigation (Tab key traversal).
  focusNext,
  focusPrevious,
  // Smart screenshot
  smartScreenshot,
  screenshot,
  // Tab management
  tabsList,
  tabsSwitch,
  tabsOpen,
  // DOM tools
  domQuery,
  domClick,
  domType,
  pressKey,
};
