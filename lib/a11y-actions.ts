// AI SDK tools that act on a11y tree refIds. The agent passes the refId
// returned by a11yTree(); the tool resolves it back to a CSS selector
// stored at snapshot time, then runs the action via chrome.scripting.

import { tool } from 'ai';
import { z } from 'zod';
import { runOnActiveTab } from '@/lib/tools-helpers';
import { resolveRefId } from '@/lib/a11y-tree';

function mustResolve(refId: string): string {
  const sel = resolveRefId(refId);
  if (!sel) {
    throw new Error(
      `Unknown refId "${refId}" — re-run a11yTree() first; refs are invalidated when the page changes.`,
    );
  }
  return sel;
}

export const a11yClick = tool({
  description:
    'Click the element with the given a11y refId. The selector is resolved from the most recent a11yTree() snapshot. If the ref is stale (page changed), this fails — re-tree and try again.',
  inputSchema: z.object({
    refId: z.string().describe('The refId of the element to click (from a11yTree).'),
  }),
  execute: async ({ refId }) => {
    const sel = mustResolve(refId);
    return runOnActiveTab(() => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `selector not found: ${sel}` };
      if (!(el instanceof HTMLElement)) return { ok: false, error: 'not an HTMLElement' };
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      el.click();
      return { ok: true, refId, tag: el.tagName.toLowerCase() };
    });
  },
});

export const a11yType = tool({
  description:
    'Set the value of an editable element (input/textarea/contenteditable) with the given a11y refId. Uses the native value setter so React/Vue pick up the change, then dispatches `input` + `change` events. Optionally press Enter after.',
  inputSchema: z.object({
    refId: z.string().describe('The refId of the editable element.'),
    text: z.string().describe('The text to type.'),
    pressEnter: z
      .boolean()
      .default(false)
      .describe('If true, also press Enter after typing (e.g. to submit a search).'),
  }),
  execute: async ({ refId, text, pressEnter }) => {
    const sel = mustResolve(refId);
    return runOnActiveTab(() => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `selector not found: ${sel}` };
      if (
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement) &&
        !(el instanceof HTMLElement && el.isContentEditable)
      ) {
        return { ok: false, error: 'not editable' };
      }
      (el as HTMLElement).focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) (setter as (v: string) => void).call(el, text);
        else (el as HTMLInputElement).value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // contenteditable
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      }
      if (pressEnter) {
        const ev = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(ev);
        const form = (el as HTMLElement).closest('form');
        if (form && typeof (form as HTMLFormElement).requestSubmit === 'function') {
          (form as HTMLFormElement).requestSubmit();
        }
      }
      return { ok: true, refId, length: text.length, pressedEnter: pressEnter };
    });
  },
});

export const a11yPressKey = tool({
  description:
    'Press a key on the element with the given a11y refId. The element must be focused first (a11yClick or .focus() via a11yType will focus it).',
  inputSchema: z.object({
    refId: z.string().describe('The refId of the element to focus and send the key to.'),
    key: z
      .enum(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'])
      .describe('The key to press.'),
  }),
  execute: async ({ refId, key }) => {
    const sel = mustResolve(refId);
    return runOnActiveTab(() => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: `selector not found: ${sel}` };
      (el as HTMLElement).focus();
      const init = {
        key,
        code: key,
        keyCode: keyCodeFor(key),
        which: keyCodeFor(key),
        bubbles: true,
        cancelable: true,
        composed: true,
      } as KeyboardEventInit;
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      if (key === 'Enter') {
        const form = (el as HTMLElement).closest('form');
        if (form) {
          const f = form as HTMLFormElement;
          if (typeof f.requestSubmit === 'function') f.requestSubmit();
          else f.submit();
        }
      }
      el.dispatchEvent(new KeyboardEvent('keypress', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      return { ok: true, refId, key };
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
