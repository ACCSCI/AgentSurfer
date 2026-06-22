// Accessibility tree — the model's PRIMARY way to find and act on
// elements. Much cheaper than screenshots (no image tokens), more
// reliable than CSS selectors on obfuscated pages, and matches what
// screen readers see.

import { tool } from 'ai';
import { z } from 'zod';
import { runOnActiveTab } from '@/lib/tools-helpers';

export interface A11yNode {
  refId: string; // 'n0', 'n1', ... stable for the lifetime of this snapshot
  tag: string; // 'INPUT', 'BUTTON', ...
  role: string; // 'searchbox', 'button', 'link', ...
  name: string; // accessible name (aria-label > labelledby > placeholder > text)
  value?: string;
  state?: Record<string, string | boolean | undefined>;
  selector: string; // CSS path to the element; opaque ref for low-level tools
  bbox?: { x: number; y: number; width: number; height: number };
  children?: A11yNode[]; // omitted unless expanded
}

export interface A11ySnapshot {
  url: string;
  title: string;
  root: A11yNode;
  totalNodes: number;
}

// In-memory registry: refId → CSS selector (or selector chain) for the
// most recent a11yTree() call. Cleared on every a11yTree() to avoid
// stale references; the model is expected to re-tree when the page
// changes.
let latestSelectors = new Map<string, string>();

export function clearA11yRegistry() {
  latestSelectors.clear();
}

export function resolveRefId(refId: string): string | null {
  return latestSelectors.get(refId) ?? null;
}

export const a11yTree = tool({
  description:
    `Take a structured accessibility tree of the active page and return it as a nested object. Each node has a \`refId\` (e.g. "n42") that you can pass to a11yClick/a11yType/a11yPressKey. The tree only includes elements that are interactive, have accessible meaning, or are landmark structure (forms, headings, nav, main). Refs are valid until the next a11yTree() call — if the page changes, re-tree.

The DEFAULT view is a 2-level shallow dump (head, nav, main, footer). Pass \`maxDepth: 6\` or \`path: ['n12', 'n15']\` to expand specific subtrees.`,
  inputSchema: z.object({
    maxDepth: z
      .number()
      .int()
      .min(0)
      .max(12)
      .default(2)
      .describe('Tree depth to expand. 0 = just the root. 2 = root + direct children (default).'),
    scope: z
      .enum(['page', 'main', 'role:form', 'role:navigation', 'role:complementary'])
      .default('page')
      .describe('Where to start: page (whole body), main (skip nav/aside), or a role filter.'),
    path: z
      .array(z.string())
      .max(5)
      .optional()
      .describe('refId path to expand specifically, e.g. ["n12", "n15"]. Overrides scope/maxDepth.'),
  }),
  execute: async ({ maxDepth, scope, path }) => {
    const result = await runOnActiveTab(() => {
      const root = pickRoot(scope);
      const counter = { value: 0 };
      const out = snapshot(root, 0, maxDepth, counter);
      return {
        url: location.href,
        title: document.title,
        root: out,
        totalNodes: counter.value,
      } as A11ySnapshot;
    });

    // Push the registry for the SW side to look up later.
    latestSelectors.clear();
    collectSelectors(result.root, latestSelectors);

    return result;
  },
});

export const focused = tool({
  description:
    'Return the accessible info of the currently focused element. Cheap — call anytime to know "where am I right now".',
  inputSchema: z.object({}).strict(),
  execute: async () => runOnActiveTab(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return describeOne(el, `n${0}`);
  }),
});

// ---------------------------------------------------------------------
// Page-side helpers (run inside executeScript).
// ---------------------------------------------------------------------

function pickRoot(scope: string): Element {
  if (scope === 'main') {
    return document.querySelector('main, [role="main"]') ?? document.body;
  }
  const sel =
    scope === 'role:form'
      ? 'form, [role="form"]'
      : scope === 'role:navigation'
        ? 'nav, [role="navigation"]'
        : scope === 'role:complementary'
          ? 'aside, [role="complementary"]'
          : 'body';
  return document.querySelector(sel) ?? document.body;
}

const MAX_NODES = 200;

function snapshot(el: Element, depth: number, maxDepth: number, counter: { value: number }): A11yNode {
  const refId = `n${counter.value++}`;
  const node: A11yNode = describeOne(el, refId);
  if (depth < maxDepth && counter.value < MAX_NODES) {
    const kids: A11yNode[] = [];
    for (const child of Array.from(el.children)) {
      if (counter.value >= MAX_NODES) break;
      if (!isInteresting(child)) continue;
      kids.push(snapshot(child, depth + 1, maxDepth, counter));
    }
    if (kids.length > 0) node.children = kids;
  }
  return node;
}

function collectSelectors(node: A11yNode, into: Map<string, string>) {
  into.set(node.refId, node.selector);
  if (node.children) for (const c of node.children) collectSelectors(c, into);
}

function isInteresting(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true') return false;
  if (el.hasAttribute('inert')) return false;
  const tag = el.tagName;
  if (
    tag === 'A' ||
    tag === 'BUTTON' ||
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'SUMMARY' ||
    tag === 'DETAILS' ||
    tag === 'OPTION'
  ) {
    return true;
  }
  if (el.hasAttribute('role')) return true;
  if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return true;
  if (el.hasAttribute('contenteditable')) return true;
  if (el.hasAttribute('tabindex')) return true;
  // Landmark regions
  if (
    tag === 'NAV' ||
    tag === 'MAIN' ||
    tag === 'ASIDE' ||
    tag === 'FORM' ||
    tag === 'HEADER' ||
    tag === 'FOOTER' ||
    /^(H[1-6])$/.test(tag)
  ) {
    return true;
  }
  return false;
}

function describeOne(el: Element, refId: string): A11yNode {
  const tag = el.tagName.toLowerCase();
  const node: A11yNode = {
    refId,
    tag,
    role: el.getAttribute('role') ?? implicitRole(el),
    name: accessibleName(el),
    selector: buildSelector(el),
  };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    node.value = el.value || undefined;
    const state: Record<string, string | boolean> = {};
    if (el.disabled) state.disabled = true;
    if (el.required) state.required = true;
    if (el instanceof HTMLInputElement) {
      if (el.checked) state.checked = true;
      if (el.placeholder) state.placeholder = el.placeholder;
    }
    if (el.getAttribute('aria-expanded') != null) {
      state.expanded = el.getAttribute('aria-expanded') === 'true';
    }
    if (Object.keys(state).length > 0) node.state = state;
  } else if (el instanceof HTMLAnchorElement) {
    node.value = el.href;
  } else if (el.hasAttribute('aria-expanded')) {
    node.state = { expanded: el.getAttribute('aria-expanded') === 'true' };
  }
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    node.bbox = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }
  return node;
}

function implicitRole(el: Element): string {
  switch (el.tagName) {
    case 'A':
      return el.hasAttribute('href') ? 'link' : 'generic';
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
    case 'ASIDE':
      return 'complementary';
    case 'HEADER':
      return 'banner';
    case 'FOOTER':
      return 'contentinfo';
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'heading';
    default:
      return 'generic';
  }
}

function inputRole(el: HTMLInputElement): string {
  const t = (el.type || 'text').toLowerCase();
  if (t === 'search') return 'searchbox';
  if (t === 'email' || t === 'tel' || t === 'url' || t === 'text') return 'textbox';
  if (t === 'checkbox') return 'checkbox';
  if (t === 'radio') return 'radio';
  if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
  if (t === 'range') return 'slider';
  if (t === 'file') return 'button';
  if (t === 'password') return 'textbox';
  if (t === 'number') return 'spinbutton';
  if (t === 'email') return 'textbox';
  return 'textbox';
}

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
  const text = (el.textContent ?? '').trim().slice(0, 80);
  if (text) return text;
  if (el instanceof HTMLInputElement && el.id) {
    const lbl = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
    if (lbl?.textContent?.trim()) return lbl.textContent.trim();
  }
  if (el.id) return `#${el.id}`;
  return `<${el.tagName.toLowerCase()}>`;
}

function cssEscape(s: string): string {
  return s.replace(/(["\\])/g, '\\$1');
}

/**
 * Build a CSS selector that uniquely targets this element. We prefer
 * tag + #id, then tag + [name=…], then a path of tag:nth-of-type.
 * The result is opaque — the model never sees it, it just passes refIds
 * around.
 */
function buildSelector(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const name = el.getAttribute('name');
  if (name) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  // Build a :nth-of-type path from the element up to the body.
  const path: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    const tag = cur.tagName.toLowerCase();
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
    if (sameTag.length === 1) {
      path.unshift(tag);
    } else {
      const i = sameTag.indexOf(cur) + 1;
      path.unshift(`${tag}:nth-of-type(${i})`);
    }
    if (parent.id) {
      path.unshift(`#${cssEscape(parent.id)}`);
      break;
    }
    cur = parent;
  }
  return path.length > 0 ? path.join(' > ') : el.tagName.toLowerCase();
}
