// Focus navigation — press Tab/Shift+Tab in the page, return the
// accessible name of the element that received focus. This is the
// universal "find the next focusable thing" mechanism that works
// regardless of DOM structure or CSS obfuscation.

import { tool } from 'ai';
import { z } from 'zod';
import { runOnActiveTab } from '@/lib/tools-helpers';

interface FocusedA11y {
  tag: string;
  type?: string;
  id?: string;
  name: string;
  role?: string;
  href?: string;
  value?: string;
  bbox?: { x: number; y: number; width: number; height: number };
}

interface FocusStep {
  step: number;
  direction: 'next' | 'previous';
  element: FocusedA11y | null;
  dataUrl?: string;
  url: string;
}

const MAX_TABS = 5;

export const focusNext = tool({
  description:
    'Press Tab one or more times to move keyboard focus forward in the page. After each Tab, returns the accessible name + role + bbox of the newly focused element. Use this when the a11y tree is too noisy, the element you want is not in the tree, or the DOM is obfuscated (Google, Meta, etc.) so domQuery selectors fail. The page draws a focus ring around the focused element, so a screenshot will show exactly where focus is. ESC cancels a focus trap (modal, iframe).',
  parameters: z.object({
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_TABS)
      .default(1)
      .describe(`Number of Tab presses. Capped at ${MAX_TABS} to avoid runaway loops.`),
    screenshot: z
      .boolean()
      .default(false)
      .describe('If true, take a screenshot after each Tab so you can see the focus ring.'),
  }),
  execute: async ({ count, screenshot }) => {
    const steps: FocusStep[] = [];
    for (let i = 0; i < count; i++) {
      const step = await runOnActiveTab(() => {
        // Dispatch a Tab keydown at the document level so the browser's
        // native focus traversal runs, even if the page has a custom
        // focus manager that would override el.focus().
        const ev = new KeyboardEvent('keydown', {
          key: 'Tab',
          code: 'Tab',
          keyCode: 9,
          which: 9,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(ev);
        return describeActive();
      });
      let dataUrl: string | undefined;
      if (screenshot) {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id && tab.windowId != null && tab.url?.startsWith('http')) {
          dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        }
      }
      steps.push({
        step: i + 1,
        direction: 'next',
        element: step as FocusedA11y | null,
        dataUrl,
        url: '',
      });
    }
    return { pressed: count, steps };
  },
});

export const focusPrevious = tool({
  description:
    'Press Shift+Tab to move keyboard focus backward. Same return shape as focusNext. Use to "go back" when you overshot, or to exit a focus trap by re-pressing repeatedly.',
  parameters: z.object({
    count: z.number().int().min(1).max(MAX_TABS).default(1),
    screenshot: z.boolean().default(false),
  }),
  execute: async ({ count, screenshot }) => {
    const steps: FocusStep[] = [];
    for (let i = 0; i < count; i++) {
      const step = await runOnActiveTab(() => {
        const ev = new KeyboardEvent('keydown', {
          key: 'Tab',
          code: 'Tab',
          keyCode: 9,
          which: 9,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(ev);
        return describeActive();
      });
      let dataUrl: string | undefined;
      if (screenshot) {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id && tab.windowId != null && tab.url?.startsWith('http')) {
          dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        }
      }
      steps.push({
        step: i + 1,
        direction: 'previous',
        element: step as FocusedA11y | null,
        dataUrl,
        url: '',
      });
    }
    return { pressed: count, steps };
  },
});

/** Computed inside the page via runOnActiveTab. */
function describeActive(): FocusedA11y | null {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  return describe(el);
}

function describe(el: Element): FocusedA11y {
  const tag = el.tagName.toLowerCase();
  const out: FocusedA11y = {
    tag,
    name: accessibleName(el),
    role: el.getAttribute('role') ?? implicitRole(el),
  };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    out.type = el.type;
    out.value = el.value || undefined;
  }
  if (el instanceof HTMLAnchorElement) {
    out.href = el.href;
  }
  const id = el.id;
  if (id) out.id = id;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    out.bbox = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  }
  return out;
}

function implicitRole(el: Element): string | undefined {
  switch (el.tagName) {
    case 'A':
      return el.hasAttribute('href') ? 'link' : undefined;
    case 'BUTTON':
      return 'button';
    case 'INPUT':
      return inputRole(el as HTMLInputElement);
    case 'TEXTAREA':
      return 'textbox';
    case 'SELECT':
      return 'combobox';
    case 'IMG':
      return 'img';
    case 'NAV':
      return 'navigation';
    case 'MAIN':
      return 'main';
    case 'FORM':
      return 'form';
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'heading';
    default:
      return undefined;
  }
}

function inputRole(el: HTMLInputElement): string {
  const t = el.type.toLowerCase();
  if (t === 'search') return 'searchbox';
  if (t === 'email' || t === 'tel' || t === 'url' || t === 'text' || t === '') return 'textbox';
  if (t === 'checkbox') return 'checkbox';
  if (t === 'radio') return 'radio';
  if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
  if (t === 'range') return 'slider';
  if (t === 'file') return 'button';
  return 'textbox';
}

/** Accessible-name computation in priority order. */
function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }
  if (el instanceof HTMLInputElement && el.placeholder) return el.placeholder;
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();
  if (el instanceof HTMLInputElement && el.value) return el.value;
  // For buttons/links, prefer the visible text. For inputs, fall back to label[for].
  const text = (el.textContent ?? '').trim().slice(0, 80);
  if (text) return text;
  if (el instanceof HTMLInputElement) {
    const id = el.id;
    if (id) {
      const lbl = document.querySelector(`label[for="${cssEscape(id)}"]`);
      if (lbl?.textContent?.trim()) return lbl.textContent.trim();
    }
  }
  if (el.id) return `#${el.id}`;
  return `<${el.tagName.toLowerCase()}>`;
}

function cssEscape(s: string): string {
  // Minimal escape for the label[for="…"] selector — covers common cases.
  return s.replace(/(["\\])/g, '\\$1');
}
