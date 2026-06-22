// AI SDK tools — bridge the LLM to the active browser tab.
// All execute() functions run in the service-worker context and use
// chrome.scripting.executeScript to interact with the page (no pre-injected
// content script needed for DOM operations).

import { tool } from 'ai';
import { z } from 'zod';
import type { RuntimeEvent } from '@/lib/runtime/events';

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
// Content renderers (`toModelOutput`) get the error
// shape and return a text-only content block explaining the failure.

type AnyTool = {
  description?: string;
  // v6's `Tool<INPUT, OUTPUT>` is generic over the input/output types, so we
  // can only duck-type here. We accept `unknown` and let the SDK apply the
  // proper generic constraints at the boundary.
  execute?: (...args: unknown[]) => Promise<unknown>;
  toModelOutput?: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown;
};

function safeExecute<T extends AnyTool>(t: T): T {
  if (!t.execute) return t;
  const orig = t.execute;
  const origContent = t.toModelOutput;
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
    toModelOutput: origContent
      ? ((options: { toolCallId: string; input: unknown; output: unknown }) => {
          const o = options.output;
          if (o && typeof o === 'object' && 'error' in (o as Record<string, unknown>)) {
            return [
              { type: 'text', text: `Tool error: ${(o as { error: string }).error}` },
            ];
          }
          return origContent(options);
        }) as T['toModelOutput']
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
  emit: (event: RuntimeEvent) => void,
) =>
  tool({
    description:
      'Update the agent\'s todo list. Pass the FULL list each time (not a diff). ' +
      'Use this to plan multi-step work: mark one todo in_progress at a time, ' +
      'and mark completed when done. The UI will display the list to the user.',
    inputSchema: z.object({
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
  inputSchema: z.object({
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
  inputSchema: z.object({
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
  inputSchema: z.object({
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
  inputSchema: z.object({}),
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
  // AI SDK v6: convert the dataURL result into a multi-part content output so
  // the model actually sees the image. v6 requires a single ToolResultOutput
  // (not an array); we use the `{type:'content', value:[...]}` shape to pack
  // a text caption + image into one output.
  toModelOutput: ({ output }: { output: { dataUrl?: string; width?: number; height?: number; error?: string } }) => {
    if (!output.dataUrl) return { type: 'text', value: output.error ?? 'Screenshot failed' };
    return {
      type: 'content',
      value: [
        { type: 'text', text: `Screenshot captured (${output.width ?? 0}x${output.height ?? 0}px).` },
        { type: 'file-data', data: stripDataUrlPrefix(output.dataUrl), mediaType: 'image/png' },
      ],
    };
  },
});

// ---------- Tab management ----------

export const tabsList = tool({
  description:
    'List all open tabs across all windows. Each entry has id, windowId, title, url, and whether the tab is active. Use this before taking screenshots or acting on the page, so you can pick the right tab and switch to it.',
  inputSchema: z.object({}),
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
  inputSchema: z.object({
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
  inputSchema: z.object({
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
  inputSchema: z.object({
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
  inputSchema: z.object({
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
  inputSchema: z.object({
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
  inputSchema: z.object({
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
  inputSchema: z
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

/**
 * cdpClick is intentionally NOT registered in `allTools` below — it was
 * being abused as a "skip visual feedback" shortcut by the LLM (no aim →
 * no crosshair → blind click). The only sanctioned click path is now
 * cdpAim → cdpConfirm. The function is kept here so internal callers
 * (e.g. E2E probes) can still use it directly via `cdpClick.execute(...)`.
 */
export const cdpClick = tool({
  description:
    'Click at (x, y) using native CDP mouse events. Coordinates are in the same space as the image you see (CSS pixels, since cdpScreenshot now resizes to CSS dimensions).',
  inputSchema: z.object({
    x: z.number().int().min(0).describe('X coordinate (same units as the image you see from cdpScreenshot)'),
    y: z.number().int().min(0).describe('Y coordinate (same units as the image you see from cdpScreenshot)'),
  }),
  execute: async ({ x, y }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    // Coordinates are already in CSS pixels (cdpScreenshot now resizes
    // the captured PNG to tab.width × tab.height so it matches what the
    // LLM sees in the image). Pass through directly.
    await cdp.click(x, y);
    return { ok: true, x, y };
  },
});

export const cdpType = tool({
  description:
    'Type text character by character using native CDP keyboard events. More reliable than domType.',
  inputSchema: z.object({
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
  inputSchema: z.object({
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
    'Take a screenshot of the active tab using CDP. The returned image is at CSS pixel dimensions (the same as the rendered page), so the (x, y) you pass to cdpAim / cdpConfirm / cdpDrag / cdpType are in the SAME space as what you see in the image — no conversion needed.',
  inputSchema: z.object({}),
  execute: async () => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    if (!tab.url || !tab.url.startsWith('http')) {
      return { error: `Cannot capture non-http URL (${tab.url || 'empty'}).` };
    }
    await cdp.attach(tab.id);
    const shot = await cdp.screenshot();
    // shot.width / shot.height are already CSS pixels — cdp.screenshot()
    // resizes the device-pixel PNG to tab.width × tab.height before
    // returning, so the LLM, the image, and click coords share one space.
    return {
      dataUrl: shot.dataUrl,
      width: shot.width,
      height: shot.height,
    };
  },
  toModelOutput: ({ output }: { output: { dataUrl?: string; width?: number; height?: number; error?: string } }) => {
    if (!output.dataUrl) return { type: 'text', value: output.error ?? 'Screenshot failed' };
    return {
      type: 'content',
      value: [
        { type: 'text', text: `Screenshot captured (${output.width ?? 0}x${output.height ?? 0}px, CSS pixels — same as the rendered page).` },
        { type: 'file-data', data: stripDataUrlPrefix(output.dataUrl), mediaType: 'image/png' },
      ],
    };
  },
});

// ---------- CDP Aim / Confirm / Cancel (visual feedback loop) ----------

export const cdpAim = tool({
  description:
    'Draw a colored highlight square (crosshair) and return BEFORE/AFTER screenshots so you can see where the box actually landed.\n\nTWO MODES (auto-detected from which params you pass):\n\n  ABSOLUTE: cdpAim(x, y, ...) — sets aim to (x, y). Use for the FIRST aim or to RESET position. Get coords from the grid: call cdpGridScreenshot() and identify the cell (e.g. r7c5), then convert to pixels (y = row*cellH + cellH/2, x = col*cellW + cellW/2).\n\n  RELATIVE: cdpAim(dx, dy) — offsets from the CURRENT aim position. dx>0 = right, dx<0 = left; dy>0 = down, dy<0 = up. Pass only one axis to move along just that axis (e.g. cdpAim(dx: -20) shifts left 20px, y unchanged). Use for visual servoing after the first aim.\n\n  If both (x, y) and (dx, dy) are provided, (x, y) WINS (absolute resets position).\n  If NEITHER is provided, the tool errors.\n\nRETURNS: BEFORE + AFTER screenshots, the current aim position (aimX, aimY in CSS pixels), the mode ("absolute" or "relative"), and pixelColor at the aim center. The pixelColor is your GROUND TRUTH — aimed at a "red button" and got rgb(255,255,255) means you missed white background; cdpCancel + re-aim with adjusted dx/dy.\n\nNEXT STEP: if the crosshair is on your target → cdpConfirm(aimX, aimY) using the values from THIS response. If not → cdpCancel + cdpAim(dx, dy) to nudge from the current position.\n\nCOLOR (same-color aim is nearly invisible — the fill is 50% transparent):\n  - red target    → cyan, yellow, or lime\n  - blue target   → yellow, orange, or red\n  - green target  → magenta, red, or orange\n  - yellow target → blue or purple\n  - white target  → red, blue, or black\n  - black target  → yellow, cyan, or white\nDefaults to red. Accepts CSS names (red/blue/lime/cyan/yellow/magenta/orange/purple/white/black/pink/green) or #rrggbb.',
  inputSchema: z.object({
    // Absolute mode (first aim / reset)
    x: z.number().int().min(0).optional().describe('Absolute X coordinate (CSS pixels). Use for the FIRST aim or to RESET. Pair with y.'),
    y: z.number().int().min(0).optional().describe('Absolute Y coordinate (CSS pixels). Use for the FIRST aim or to RESET. Pair with x.'),
    // Relative mode (visual servoing fine-tune)
    dx: z.number().int().optional().describe('Relative X offset from the current aim (CSS pixels). +right, -left. Pass alone to move along X only.'),
    dy: z.number().int().optional().describe('Relative Y offset from the current aim (CSS pixels). +down, -up. Pass alone to move along Y only.'),
    size: z.number().int().min(8).max(400).default(80).describe('Side length of the highlight square. Larger = easier to see but covers more of the target.'),
    color: z.string().default('red').describe('CSS color name or #rrggbb. MUST contrast with the target — see color guidance above.'),
  }),
  execute: async ({ x, y, dx, dy, size, color }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    // Pre-screenshot BEFORE drawing the crosshair so the LLM can compare
    // before/after and verify the crosshair actually landed where it asked.
    const before = await cdp.screenshot();
    const sw = before.width;
    const sh = before.height;

    // --- 1. Resolve mode: (x,y) wins over (dx,dy). ---
    let aimX: number;
    let aimY: number;
    let mode: 'absolute' | 'relative';
    const hasAbs = typeof x === 'number' && typeof y === 'number';
    const hasRel = typeof dx === 'number' || typeof dy === 'number';
    if (hasAbs) {
      mode = 'absolute';
      aimX = x;
      aimY = y;
    } else if (hasRel) {
      mode = 'relative';
      const cur = cdp.getCurrentAim();
      if (!cur) {
        throw new Error(
          'cdpAim: relative mode (dx/dy) requires a previous aim. ' +
          'Call cdpAim(x, y) first with ABSOLUTE coords from cdpGridScreenshot() ' +
          '(e.g. row*cellH + cellH/2, col*cellW + cellW/2).',
        );
      }
      aimX = cur.x + (dx ?? 0);
      aimY = cur.y + (dy ?? 0);
    } else {
      throw new Error(
        'cdpAim: must provide EITHER absolute (x, y) OR relative (dx and/or dy). ' +
        'Both empty is ambiguous.',
      );
    }

    // --- 2. Clamp to viewport (CSS-pixel bounds). ---
    if (sw > 0 && sh > 0) {
      aimX = Math.max(0, Math.min(sw - 1, Math.round(aimX)));
      aimY = Math.max(0, Math.min(sh - 1, Math.round(aimY)));
    } else {
      aimX = Math.round(aimX);
      aimY = Math.round(aimY);
    }

    // x, y, size are CSS pixels (same as what the LLM sees — cdp.screenshot
    // resizes the PNG to tab.width × tab.height before returning).
    // Pass them straight through to highlightQuad (which also uses CSS px).
    await cdp.highlightQuad(aimX, aimY, size, color);
    const after = await cdp.screenshot();
    // Read the actual pixel color at the aim center. The LLM knows what
    // color the target SHOULD be (e.g. "red button") and can use this
    // as a strong ground-truth signal without having to visually inspect
    // the AFTER image pixel-by-pixel.
    const pixel = await cdp.readPixel(aimX, aimY);
    // E2E: when __AGENT_DEBUG__ is set (by the E2E test), dump the
    // AFTER screenshot to the console so a developer watching the test
    // can see where the crosshair actually landed. The test harness
    // captures SW console output and saves the dataUrl to a PNG file.
    // SW can't use node:fs so we go through console.log.
    if ((globalThis as { __AGENT_DEBUG__?: boolean }).__AGENT_DEBUG__) {
      const step = ((globalThis as { __AGENT_STEP__?: number }).__AGENT_STEP__ ?? 0) + 1;
      (globalThis as { __AGENT_STEP__?: number }).__AGENT_STEP__ = step;
      console.log(`[AGENT_DEBUG_AIM_STEP] step=${step} mode=${mode} x=${aimX} y=${aimY} size=${size} color=${color} dataUrl=${after.dataUrl}`);
    }
    return {
      dataUrl: after.dataUrl,
      beforeDataUrl: before.dataUrl,
      width: after.width,
      height: after.height,
      aimX,
      aimY,
      mode,
      color,
      pixelColor: pixel,
    };
  },
  toModelOutput: ({ output }: {
    output: {
      dataUrl: string; beforeDataUrl?: string;
      width: number; height: number;
      aimX: number; aimY: number;
      mode?: 'absolute' | 'relative';
      pixelColor?: { r: number; g: number; b: number; a: number };
    };
  }) => {
    const sw = output.width ?? 0;
    const sh = output.height ?? 0;
    const cx = Math.floor(sw / 2);
    const cy = Math.floor(sh / 2);
    const pixelInfo = output.pixelColor
      ? ` Pixel color at aim center: rgb(${output.pixelColor.r}, ${output.pixelColor.g}, ${output.pixelColor.b}).`
      : '';
    const modeLabel = output.mode ? ` [${output.mode} mode]` : '';
    const text = [
      `AIMED at (${output.aimX}, ${output.aimY})${modeLabel}.`,
      `Screen center: (${cx}, ${cy}).`,
      `If the crosshair is on your target → cdpConfirm(${output.aimX}, ${output.aimY}).`,
      `If off-target → cdpCancel + cdpAim(dx, dy) to nudge from the current position (dx>0 right, dy>0 down).`,
      `GROUND TRUTH:${pixelInfo} If you aimed at a "red button" and got rgb(255,255,255), you missed white background — try again.`,
    ].join(' ');
    const content: Array<{ type: 'text'; text: string } | { type: 'file-data'; data: string; mediaType: string }> = [
      { type: 'text', text },
    ];
    if (output.beforeDataUrl) {
      content.push({ type: 'text', text: 'BEFORE (no crosshair):' });
      content.push({ type: 'file-data', data: stripDataUrlPrefix(output.beforeDataUrl), mediaType: 'image/png' });
    }
    content.push({ type: 'text', text: `AFTER (crosshair at ${output.aimX}, ${output.aimY}):` });
    content.push({ type: 'file-data', data: stripDataUrlPrefix(output.dataUrl), mediaType: 'image/png' });
    return { type: 'content', value: content };
  },
});

export const cdpGridScreenshot = tool({
  description:
    'Take a screenshot of the active tab WITH a numbered grid overlay. Each cell is labeled "r{row}c{col}" (e.g. r0c0, r5c3). Use this when you know approximately WHERE a target is on the screen but cannot guess exact pixel coordinates — describe the target in grid terms (e.g. "the red button is around r7c5") and the tool will translate to pixel coords. Then call cdpAim with those coords. The grid lines are thin and semi-transparent so the underlying page is still visible.',
  inputSchema: z.object({
    cols: z.number().int().min(2).max(20).default(10).describe('Number of columns in the grid (default 10). More columns = finer horizontal precision.'),
    rows: z.number().int().min(2).max(20).default(8).describe('Number of rows in the grid (default 8). More rows = finer vertical precision.'),
  }),
  execute: async ({ cols, rows }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    if (!tab.url || !tab.url.startsWith('http')) {
      return { error: `Cannot capture non-http URL (${tab.url || 'empty'}).` };
    }
    await cdp.attach(tab.id);
    const shot = await cdp.screenshotWithGrid(cols, rows);
    // The cell width/height in pixels — useful so the LLM can convert
    // grid coords (rN, cM) → pixel coords.
    const cellW = Math.floor(shot.width / cols);
    const cellH = Math.floor(shot.height / rows);
    return {
      dataUrl: shot.dataUrl,
      width: shot.width,
      height: shot.height,
      cols: shot.cols,
      rows: shot.rows,
      cellW,
      cellH,
    };
  },
  toModelOutput: ({ output }: {
    output: {
      dataUrl?: string; width?: number; height?: number;
      cols?: number; rows?: number; cellW?: number; cellH?: number;
      error?: string;
    };
  }) => {
    if (output.error || !output.dataUrl) {
      return { type: 'text', value: output.error ?? 'Screenshot failed' };
    }
    const text = `Grid: ${output.cols} cols × ${output.rows} rows. Each cell is ${output.cellW}×${output.cellH}px. ` +
      `Describe a target's grid cell (e.g. "r7c5"), then call cdpAim(7*${output.cellH}+${output.cellH}/2, 5*${output.cellW}+${output.cellW}/2, ...).`;
    return {
      type: 'content',
      value: [
        { type: 'text', text },
        { type: 'file-data', data: stripDataUrlPrefix(output.dataUrl), mediaType: 'image/png' },
      ],
    };
  },
});

export const cdpConfirm = tool({
  description:
    'Confirm the aim position and execute the click. Clears the red crosshair. Use this AFTER cdpAim — it is the ONLY way to click. x, y are in the same space as cdpAim coordinates (CSS pixels).',
  inputSchema: z.object({
    x: z.number().int().min(0).describe('X coordinate (same units as the image and as cdpAim)'),
    y: z.number().int().min(0).describe('Y coordinate (same units as the image and as cdpAim)'),
  }),
  execute: async ({ x, y }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    await cdp.clearHighlight();
    await cdp.click(x, y);
    return { ok: true, x, y };
  },
});

/**
 * Drag from (x1, y1) to (x2, y2) using native CDP mouse events.
 *
 * Use for canvas drag-and-drop interactions (PixiJS, Konva, native HTML5
 * drag, etc.). The button stays pressed (`buttons: 1`) throughout the move,
 * which is required for drag-state in PixiJS InteractionManager.
 *
 * Coordinates are CSS pixels (the same units as the image you see from
 * cdpScreenshot).
 */
export const cdpDrag = tool({
  description:
    'Drag from (x1, y1) to (x2, y2) using native CDP mouse events (buttons:1 held throughout). ' +
    'Use for canvas drag-and-drop interactions. Coordinates are CSS pixels (same as the image from cdpScreenshot).',
  inputSchema: z.object({
    x1: z.number().int().min(0).describe('X of drag start'),
    y1: z.number().int().min(0).describe('Y of drag start'),
    x2: z.number().int().min(0).describe('X of drag end'),
    y2: z.number().int().min(0).describe('Y of drag end'),
  }),
  execute: async ({ x1, y1, x2, y2 }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    // Coordinates are already in CSS pixels — same as the cdpScreenshot
    // image the LLM sees, same as cdpConfirm / highlightQuad.
    await cdp.drag(x1, y1, x2, y2);
    return { ok: true, x1, y1, x2, y2 };
  },
});

export const cdpScroll = tool({
  description:
    'Scroll the page at the position of the last cdpAim crosshair. Use after cdpAim to scroll while keeping the aim position. deltaY > 0 = scroll down, deltaY < 0 = scroll up. deltaX > 0 = scroll right, deltaX < 0 = scroll left.',
  inputSchema: z.object({
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
  inputSchema: z.object({}),
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
  cdpDrag: safeExecute(cdpDrag),
  cdpScroll: safeExecute(cdpScroll),
  cdpCancel: safeExecute(cdpCancel),
  cdpType: safeExecute(cdpType),
  cdpPressKey: safeExecute(cdpPressKey),
  cdpScreenshot: safeExecute(cdpScreenshot),
  cdpGridScreenshot: safeExecute(cdpGridScreenshot),
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
