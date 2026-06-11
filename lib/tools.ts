// AI SDK tools — bridge the LLM to the active browser tab.
// All execute() functions run in the service-worker context and use
// chrome.scripting.executeScript to interact with the page (no pre-injected
// content script needed for DOM operations).

import { tool } from 'ai';
import { z } from 'zod';
import { smartScreenshot } from '@/lib/screenshot-smart';

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
    `Smart screenshot of the active tab's visible viewport. Multiple modes:
- no args: single full-page shot (returned as image + text caption).
- { region: {x,y,width,height} }: crop to a region, returns just that crop.
- { schedule: {durationMs, intervalMs} }: capture N frames over time, return ONLY metadata (index, timestamp, changeFromBaseline, changedFraction, bbox) — NO images. The model picks which indices to view next.
- { refs: [0, 5, 7] }: fetch specific frames from the most recent schedule run.

Use the schedule mode to detect when a page finishes loading, when a modal appears, etc., without paying image-token cost for every frame. The bbox tells you WHERE on the page the change happened.

ALWAYS call screenshot before any UI action so you know the page state.`,
  parameters: z
    .object({
      region: z
        .object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          width: z.number().int().min(1).max(8000),
          height: z.number().int().min(1).max(8000),
        })
        .optional()
        .describe('Crop the screenshot to this viewport region (pixels).'),
      schedule: z
        .object({
          durationMs: z.number().int().min(100).max(60_000),
          intervalMs: z.number().int().min(50).max(5_000),
        })
        .optional()
        .describe('Time-windowed capture: durationMs total, intervalMs between frames.'),
      refs: z
        .array(z.number().int().min(0))
        .max(20)
        .optional()
        .describe('Indices from a previous schedule run whose images you want to view.'),
    })
    .strict(),
  execute: async (opts) => {
    return smartScreenshot(opts as Parameters<typeof smartScreenshot>[0]);
  },
  // Convert the result to model-readable content. The 'schedule' and 'refs'
  // variants return metadata, so we just text-format them.
  experimental_toToolResultContent: (output) => {
    const o = output as Awaited<ReturnType<typeof smartScreenshot>>;
    if (o.kind === 'schedule') {
      return [
        {
          type: 'text',
          text: `Captured ${o.totalFrames} frame(s) over ${o.totalDurationMs}ms (no images sent). ` +
            `Changes vs frame 0:\n` +
            o.frames
              .map(
                (f) =>
                  `  [${f.index}] t=${f.timestamp}ms changed=${f.changeFromBaseline}px ` +
                  `(${(f.changedFraction * 100).toFixed(2)}%)` +
                  (f.bbox ? ` bbox=(${f.bbox.x},${f.bbox.y},${f.bbox.width}x${f.bbox.height})` : ' no-change'),
              )
              .join('\n') +
            `\n\nCall \`screenshot({ refs: [...] })\` to view specific frames.`,
        },
      ];
    }
    if (o.kind === 'refs') {
      if (o.frames.length === 0) {
        return [{ type: 'text', text: 'No frames at those indices (schedule may not have run).' }];
      }
      const cap = o.frames[0];
      return [
        {
          type: 'text',
          text: `Frame(s) ${o.frames.map((f) => f.index).join(', ')} from the most recent schedule (${cap?.width ?? 0}x${cap?.height ?? 0}px).`,
        },
        ...o.frames.map((f) => ({
          type: 'image' as const,
          data: f.dataUrl,
          mimeType: 'image/png',
        })),
      ];
    }
    // 'single' and 'region'
    const w = 'width' in o ? o.width : 0;
    const h = 'height' in o ? o.height : 0;
    return [
      {
        type: 'text',
        text: `Screenshot captured (${w}x${h}px${o.kind === 'region' ? `, region (${o.region.x},${o.region.y},${o.region.width}x${o.region.height})` : ''}).`,
      },
      { type: 'image', data: o.dataUrl, mimeType: 'image/png' },
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
      // For Enter, also try to submit the enclosing form (covers Google etc.).
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
      return { ok: true, key, tag: el.tagName.toLowerCase() };
    });
  },
});

function keyCodeFor(key: string): number {
  switch (key) {
    case 'Enter':
      return 13;
    case 'Tab':
      return 9;
    case 'Escape':
      return 27;
    case 'ArrowUp':
      return 38;
    case 'ArrowDown':
      return 40;
    case 'ArrowLeft':
      return 37;
    case 'ArrowRight':
      return 39;
    case 'Backspace':
      return 8;
    case 'Delete':
      return 46;
    default:
      return 0;
  }
}

// Re-export a11y + focus tools so the agent can use them.
export { a11yTree, focused } from '@/lib/a11y-tree';
export { a11yClick, a11yType, a11yPressKey } from '@/lib/a11y-actions';
export { focusNext, focusPrevious } from '@/lib/focus-nav';

export const allTools = {
  // PRIMARY: a11y-first
  a11yTree,
  focused,
  a11yClick,
  a11yType,
  a11yPressKey,
  focusNext,
  focusPrevious,
  // Smart screenshot (schedule/region/refs)
  screenshot,
  // Tab management
  tabsList,
  tabsSwitch,
  tabsOpen,
  // ESCAPE HATCH: low-level DOM tools. Use only when a11y tree is
  // unavailable or the user asks for a specific selector.
  domQuery,
  domClick,
  domType,
  pressKey,
};
