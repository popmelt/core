import type { ManifestEntry } from '../tools/types';
import { getDirectTextContent, getReactComponentInfo } from './dom';

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea']);
const INTERACTIVE_ROLES = new Set(['button', 'link']);
const LANDMARK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside']);

const STYLE_PROPS = [
  'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing',
  'color', 'backgroundColor', 'padding', 'gap', 'borderRadius', 'boxShadow',
] as const;

const SOFT_LIMIT = 100;
const HARD_CAP = 150;

type Candidate = {
  el: Element;
  entry: ManifestEntry;
};

function getDepth(el: Element): number {
  let depth = 0;
  let current: Element | null = el.parentElement;
  while (current && current !== document.body) {
    depth++;
    current = current.parentElement;
  }
  return depth;
}

function isMeaningfulClass(c: string): boolean {
  if (c.startsWith('_')) return false;
  if (c.startsWith('css-')) return false;
  if (c.length > 30) return false;
  return true;
}

function extractClasses(el: Element): string | undefined {
  const meaningful = Array.from(el.classList).filter(isMeaningfulClass).slice(0, 3);
  return meaningful.length > 0 ? meaningful.join(' ') : undefined;
}

function extractStyles(el: Element, parent: Element | null): Record<string, string> | undefined {
  const computed = window.getComputedStyle(el);
  const parentComputed = parent ? window.getComputedStyle(parent) : null;
  const styles: Record<string, string> = {};

  for (const prop of STYLE_PROPS) {
    let value = computed.getPropertyValue(
      prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)
    );

    if (!value) continue;

    // Skip transparent backgrounds
    if (prop === 'backgroundColor' && (value === 'rgba(0, 0, 0, 0)' || value === 'transparent')) continue;
    // Skip boxShadow: none
    if (prop === 'boxShadow' && value === 'none') continue;

    // Simplify boxShadow to just "yes"
    if (prop === 'boxShadow') {
      value = 'yes';
    }

    // fontFamily: first font only
    if (prop === 'fontFamily') {
      value = value.split(',')[0]!.trim().replace(/['"]/g, '');
    }

    // Skip if identical to parent
    if (parentComputed) {
      const parentValue = parentComputed.getPropertyValue(
        prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)
      );
      if (value === parentValue) continue;
    }

    styles[prop] = value;
  }

  return Object.keys(styles).length > 0 ? styles : undefined;
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;

  const style = window.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;

  // offsetParent === null means hidden, except for body/html and fixed/sticky elements
  if (el.offsetParent === null) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') return true;
    const pos = style.position;
    if (pos === 'fixed' || pos === 'sticky') return true;
    return false;
  }

  return true;
}

function isDevtools(el: Element): boolean {
  if (el instanceof HTMLElement && el.dataset.devtools) return true;
  if (el.closest('[data-devtools]')) return true;
  if (el.id === 'devtools-canvas' || el.id === 'devtools-toolbar' || el.id === 'devtools-scrim') return true;
  return false;
}

function shouldInclude(el: Element): boolean {
  const tag = el.tagName.toLowerCase();

  // Has direct text content
  const text = getDirectTextContent(el);
  if (text && text.length > 0) return true;

  // Is interactive
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;

  // Is semantic landmark
  if (LANDMARK_TAGS.has(tag)) return true;

  // Is img/svg with alt or aria-label
  if ((tag === 'img' || tag === 'svg') && (el.getAttribute('alt') || el.getAttribute('aria-label'))) return true;

  return false;
}

/**
 * Build a structured page manifest of visible DOM elements.
 * Used to ground the planner with real element data alongside the screenshot.
 */
export function buildPageManifest(): ManifestEntry[] {
  const candidates: Candidate[] = [];

  // Phase A: Collect candidates
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = walker.nextNode();

  while (node) {
    const el = node as Element;
    node = walker.nextNode();

    if (isDevtools(el)) continue;
    if (!isVisible(el)) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    if (!shouldInclude(el)) continue;

    const tag = el.tagName.toLowerCase();
    const text = getDirectTextContent(el);
    const depth = getDepth(el);
    const role = el.getAttribute('role') || undefined;
    const href = tag === 'a' ? (el as HTMLAnchorElement).getAttribute('href') || undefined : undefined;
    const alt = tag === 'img' ? el.getAttribute('alt') || undefined : undefined;
    const component = getReactComponentInfo(el)?.name;
    const classes = extractClasses(el);
    const styles = extractStyles(el, el.parentElement);

    const entry: ManifestEntry = {
      tag,
      rect: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      depth,
    };

    if (text) entry.text = text.length > 80 ? text.slice(0, 80) + '...' : text;
    if (component) entry.component = component;
    if (classes) entry.classes = classes;
    if (styles) entry.styles = styles;
    if (role) entry.role = role;
    if (href) entry.href = href;
    if (alt) entry.alt = alt;

    candidates.push({ el, entry });
  }

  // Phase B: Deduplication — if child's full textContent equals parent's, drop child
  // Sort deepest-first for dedup
  candidates.sort((a, b) => b.entry.depth - a.entry.depth);

  const dedupSet = new Set<Element>();
  for (let i = 0; i < candidates.length; i++) {
    const child = candidates[i]!;
    if (dedupSet.has(child.el)) continue;

    const parentEl = child.el.parentElement;
    if (!parentEl) continue;

    const parentCandidate = candidates.find(c => c.el === parentEl);
    if (!parentCandidate) continue;

    const childText = child.el.textContent?.trim();
    const parentText = parentEl.textContent?.trim();
    if (childText && parentText && childText === parentText) {
      dedupSet.add(child.el);
    }
  }

  let filtered = candidates.filter(c => !dedupSet.has(c.el));

  // Phase C: Repeated pattern compression
  const groups = new Map<string, Candidate[]>();
  for (const c of filtered) {
    const parent = c.el.parentElement;
    const key = [
      parent ? Array.from(parent.classList).join('.') : '',
      c.entry.tag,
      c.entry.component ?? '',
      c.entry.styles ? JSON.stringify(c.entry.styles) : '',
    ].join('|');
    const group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }

  const compressed: ManifestEntry[] = [];
  const compressedElements = new Set<Element>();

  for (const [, group] of groups) {
    if (group.length > 3) {
      // Keep first 2, summarize rest
      compressed.push(group[0]!.entry, group[1]!.entry);
      compressedElements.add(group[0]!.el);
      compressedElements.add(group[1]!.el);

      // Union bounding box for summary
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 2; i < group.length; i++) {
        const r = group[i]!.entry.rect;
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w);
        maxY = Math.max(maxY, r.y + r.h);
      }

      compressed.push({
        tag: group[0]!.entry.tag,
        text: `(+${group.length - 2} similar items)`,
        rect: { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) },
        depth: group[0]!.entry.depth,
      });

      for (const c of group) compressedElements.add(c.el);
    }
  }

  // Add non-compressed entries
  for (const c of filtered) {
    if (!compressedElements.has(c.el)) {
      compressed.push(c.entry);
    }
  }

  // Phase D: Sort by visual prominence
  const pageHeight = Math.max(document.documentElement.scrollHeight, 1);
  compressed.sort((a, b) => {
    const areaA = a.rect.w * a.rect.h;
    const areaB = b.rect.w * b.rect.h;
    const scoreA = areaA * (1 + 0.5 * (1 - a.rect.y / pageHeight));
    const scoreB = areaB * (1 + 0.5 * (1 - b.rect.y / pageHeight));
    return scoreB - scoreA;
  });

  // Phase E: Truncation
  if (compressed.length > HARD_CAP) {
    const truncated = compressed.slice(0, HARD_CAP);
    truncated.push({
      tag: 'truncated',
      text: `${compressed.length - HARD_CAP} additional elements omitted`,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      depth: 0,
    });
    return truncated;
  }

  return compressed;
}
