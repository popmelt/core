import type { SpacingElementEvidence } from '../tools/types';
import { createPopmeltTreeWalker } from './componentBoundary';
import { getUniqueSelector } from './cssSelector';
import { getReactComponentInfo } from './reactFiber';

// --- Spacing token element scanner (for live preview) ---

/** Check if an element has an inline style override for a CSS property.
 *  Elements with inline overrides (from a previous token drag) should be
 *  skipped when scanning for natural matches to avoid cross-contamination. */
function hasInlineOverride(el: HTMLElement, property: string): boolean {
  return el.style.getPropertyValue(property) !== '';
}

export type SpacingElement = {
  element: HTMLElement;
  property: string;       // e.g. 'padding-top', 'margin-left', 'gap'
};

/**
 * Walk the visible DOM and find elements whose padding, margin, or gap
 * matches the given px value. Returns { element, property } pairs for
 * applying inline style overrides during drag preview.
 */
export function findSpacingElements(pxValue: number, limit = 30): SpacingElement[] {
  if (pxValue <= 0) return [];

  const results: SpacingElement[] = [];
  const walker = createPopmeltTreeWalker();
  const tolerance = 0.5;
  let node: Node | null = walker.currentNode;

  while ((node = walker.nextNode()) && results.length < limit) {
    const el = node as HTMLElement;
    const r = el.getBoundingClientRect();

    // Skip off-screen or invisible
    if (r.bottom < -50 || r.top > window.innerHeight + 50 ||
        r.right < -50 || r.left > window.innerWidth + 50 ||
        r.width < 1 || r.height < 1) continue;

    const s = getComputedStyle(el);

    // --- Padding (skip inline-overridden properties) ---
    if (!hasInlineOverride(el, 'padding-top') && Math.abs((parseFloat(s.paddingTop) || 0) - pxValue) < tolerance)
      results.push({ element: el, property: 'padding-top' });
    if (!hasInlineOverride(el, 'padding-bottom') && Math.abs((parseFloat(s.paddingBottom) || 0) - pxValue) < tolerance && results.length < limit)
      results.push({ element: el, property: 'padding-bottom' });
    if (!hasInlineOverride(el, 'padding-left') && Math.abs((parseFloat(s.paddingLeft) || 0) - pxValue) < tolerance && results.length < limit)
      results.push({ element: el, property: 'padding-left' });
    if (!hasInlineOverride(el, 'padding-right') && Math.abs((parseFloat(s.paddingRight) || 0) - pxValue) < tolerance && results.length < limit)
      results.push({ element: el, property: 'padding-right' });

    // --- Margin (skip inline-overridden properties) ---
    if (!hasInlineOverride(el, 'margin-top') && Math.abs((parseFloat(s.marginTop) || 0) - pxValue) < tolerance && results.length < limit)
      results.push({ element: el, property: 'margin-top' });
    if (!hasInlineOverride(el, 'margin-bottom') && Math.abs((parseFloat(s.marginBottom) || 0) - pxValue) < tolerance && results.length < limit)
      results.push({ element: el, property: 'margin-bottom' });
    if (!hasInlineOverride(el, 'margin-left') && Math.abs((parseFloat(s.marginLeft) || 0) - pxValue) < tolerance && results.length < limit)
      results.push({ element: el, property: 'margin-left' });
    if (!hasInlineOverride(el, 'margin-right') && Math.abs((parseFloat(s.marginRight) || 0) - pxValue) < tolerance && results.length < limit)
      results.push({ element: el, property: 'margin-right' });

    // --- Gap (flex/grid container, skip inline-overridden) ---
    const display = s.display;
    if ((display.includes('flex') || display.includes('grid')) && results.length < limit) {
      const hasGapOverride = hasInlineOverride(el, 'gap');
      const gap = parseFloat(s.gap) || 0;
      const rowGap = parseFloat(s.rowGap) || 0;
      const colGap = parseFloat(s.columnGap) || 0;
      if (!hasGapOverride && Math.abs(gap - pxValue) < tolerance)
        results.push({ element: el, property: 'gap' });
      else if (!hasInlineOverride(el, 'row-gap') && Math.abs(rowGap - pxValue) < tolerance)
        results.push({ element: el, property: 'row-gap' });
      else if (!hasInlineOverride(el, 'column-gap') && Math.abs(colGap - pxValue) < tolerance)
        results.push({ element: el, property: 'column-gap' });
    }
  }

  return results;
}

// --- Spacing token usage scanner ---

export type SpacingRect = {
  x: number;  // viewport coords
  y: number;
  width: number;
  height: number;
  direction: 'horizontal' | 'vertical';
  property: string;
};

/**
 * Walk the visible DOM and find elements whose padding, margin, or gap
 * matches the given px value. Returns redline-ready rects in viewport coords.
 */
export function findSpacingUsages(pxValue: number, limit = 30): SpacingRect[] {
  if (pxValue <= 0) return [];

  const results: SpacingRect[] = [];
  const walker = createPopmeltTreeWalker();
  const tolerance = 0.5;
  let node: Node | null = walker.currentNode;

  while ((node = walker.nextNode()) && results.length < limit) {
    const el = node as HTMLElement;
    const r = el.getBoundingClientRect();

    // Skip off-screen or invisible
    if (r.bottom < -50 || r.top > window.innerHeight + 50 ||
        r.right < -50 || r.left > window.innerWidth + 50 ||
        r.width < 1 || r.height < 1) continue;

    const s = getComputedStyle(el);
    const bT = parseFloat(s.borderTopWidth) || 0;
    const bR = parseFloat(s.borderRightWidth) || 0;
    const bB = parseFloat(s.borderBottomWidth) || 0;
    const bL = parseFloat(s.borderLeftWidth) || 0;
    const cW = el.clientWidth;
    const cH = el.clientHeight;

    // --- Padding (skip inline-overridden properties) ---
    const pT = parseFloat(s.paddingTop) || 0;
    if (!hasInlineOverride(el, 'padding-top') && Math.abs(pT - pxValue) < tolerance)
      results.push({ x: r.left + bL, y: r.top + bT, width: cW, height: pxValue, direction: 'vertical', property: 'padding-top' });

    const pB = parseFloat(s.paddingBottom) || 0;
    if (!hasInlineOverride(el, 'padding-bottom') && Math.abs(pB - pxValue) < tolerance && results.length < limit)
      results.push({ x: r.left + bL, y: r.top + bT + cH - pxValue, width: cW, height: pxValue, direction: 'vertical', property: 'padding-bottom' });

    const pL = parseFloat(s.paddingLeft) || 0;
    if (!hasInlineOverride(el, 'padding-left') && Math.abs(pL - pxValue) < tolerance && results.length < limit)
      results.push({ x: r.left + bL, y: r.top + bT, width: pxValue, height: cH, direction: 'horizontal', property: 'padding-left' });

    const pR = parseFloat(s.paddingRight) || 0;
    if (!hasInlineOverride(el, 'padding-right') && Math.abs(pR - pxValue) < tolerance && results.length < limit)
      results.push({ x: r.left + bL + cW - pxValue, y: r.top + bT, width: pxValue, height: cH, direction: 'horizontal', property: 'padding-right' });

    // --- Margin (skip inline-overridden properties) ---
    const mT = parseFloat(s.marginTop) || 0;
    if (!hasInlineOverride(el, 'margin-top') && Math.abs(mT - pxValue) < tolerance && results.length < limit)
      results.push({ x: r.left, y: r.top - pxValue, width: r.width, height: pxValue, direction: 'vertical', property: 'margin-top' });

    const mB = parseFloat(s.marginBottom) || 0;
    if (!hasInlineOverride(el, 'margin-bottom') && Math.abs(mB - pxValue) < tolerance && results.length < limit)
      results.push({ x: r.left, y: r.bottom, width: r.width, height: pxValue, direction: 'vertical', property: 'margin-bottom' });

    const mL = parseFloat(s.marginLeft) || 0;
    if (!hasInlineOverride(el, 'margin-left') && Math.abs(mL - pxValue) < tolerance && results.length < limit)
      results.push({ x: r.left - pxValue, y: r.top, width: pxValue, height: r.height, direction: 'horizontal', property: 'margin-left' });

    const mR = parseFloat(s.marginRight) || 0;
    if (!hasInlineOverride(el, 'margin-right') && Math.abs(mR - pxValue) < tolerance && results.length < limit)
      results.push({ x: r.right, y: r.top, width: pxValue, height: r.height, direction: 'horizontal', property: 'margin-right' });

    // --- Gap (flex/grid, skip inline-overridden) ---
    const display = s.display;
    if ((display.includes('flex') || display.includes('grid')) && results.length < limit) {
      const hasGapOverride = hasInlineOverride(el, 'gap');
      if (!hasGapOverride) {
        const children = Array.from(el.children).filter(c => {
          const cs = getComputedStyle(c);
          return cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed';
        });
        if (children.length >= 2) {
          for (let i = 0; i < children.length - 1 && results.length < limit; i++) {
            const a = children[i]!.getBoundingClientRect();
            const b = children[i + 1]!.getBoundingClientRect();

            // Vertical gap
            const vGap = b.top - a.bottom;
            if (Math.abs(vGap - pxValue) < tolerance && vGap > 0.5) {
              results.push({
                x: Math.min(a.left, b.left), y: a.bottom,
                width: Math.max(a.right, b.right) - Math.min(a.left, b.left),
                height: vGap, direction: 'vertical', property: 'gap',
              });
            }

            // Horizontal gap
            const hGap = b.left - a.right;
            if (Math.abs(hGap - pxValue) < tolerance && hGap > 0.5) {
              results.push({
                x: a.right, y: Math.min(a.top, b.top),
                width: hGap,
                height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
                direction: 'horizontal', property: 'gap',
              });
            }
          }
        }
      }
    }
  }

  return results;
}

// --- Code-rooted spacing token types ---

export type TokenBinding = {
  value: string;
  property?: 'gap' | 'padding' | 'margin';
  bindings?: string[];
};

/** Normalize string | TokenBinding -> TokenBinding. Plain strings become { value: raw }. */
export function resolveSpacingToken(raw: string | TokenBinding): TokenBinding {
  if (typeof raw === 'string') return { value: raw };
  return raw;
}

const PROPERTY_SCOPES: Record<string, string[]> = {
  gap: ['gap', 'row-gap', 'column-gap'],
  padding: ['padding-top', 'padding-bottom', 'padding-left', 'padding-right'],
  margin: ['margin-top', 'margin-bottom', 'margin-left', 'margin-right'],
};

function propertyMatchesScope(cssProperty: string, scope: string): boolean {
  const allowed = PROPERTY_SCOPES[scope];
  return allowed ? allowed.includes(cssProperty) : false;
}

/** Check if an element's className contains a target Tailwind class, accounting for responsive prefixes. */
function classListContains(className: string, targetClass: string): boolean {
  const classes = className.split(/\s+/);
  for (const cls of classes) {
    // Exact match
    if (cls === targetClass) return true;
    // Responsive prefix match: "md:gap-2" matches binding "gap-2"
    const colonIdx = cls.lastIndexOf(':');
    if (colonIdx >= 0 && cls.slice(colonIdx + 1) === targetClass) return true;
  }
  return false;
}

/** Map Tailwind class prefix -> CSS property. */
function inferPropertyFromTailwindClass(twClass: string): string | null {
  // Strip responsive prefix
  const colonIdx = twClass.lastIndexOf(':');
  const base = colonIdx >= 0 ? twClass.slice(colonIdx + 1) : twClass;
  // Match prefix-value pattern
  const dashIdx = base.indexOf('-');
  if (dashIdx < 0) return null;
  const prefix = base.slice(0, dashIdx);
  const prefixMap: Record<string, string> = {
    gap: 'gap', 'gap-x': 'column-gap', 'gap-y': 'row-gap',
    p: 'padding', pt: 'padding-top', pb: 'padding-bottom',
    pl: 'padding-left', pr: 'padding-right', px: 'padding-left', py: 'padding-top',
    m: 'margin', mt: 'margin-top', mb: 'margin-bottom',
    ml: 'margin-left', mr: 'margin-right', mx: 'margin-left', my: 'margin-top',
  };
  // Check 2-char prefix first (gap-x, gap-y), then 1-char
  const twoChar = base.slice(0, base.indexOf('-', dashIdx + 1) > 0 ? base.indexOf('-', dashIdx + 1) : dashIdx);
  return prefixMap[twoChar] ?? prefixMap[prefix] ?? null;
}

/**
 * Walk the visible DOM and find elements that use a token, by class binding or value fallback.
 * Returns { element, property } pairs for applying inline style overrides during drag.
 */
export function findElementsByTokenBinding(token: TokenBinding, limit = 30): SpacingElement[] {
  const px = parseFloat(token.value);
  if (isNaN(px) || px <= 0) return [];

  // If bindings exist, match by class name
  if (token.bindings && token.bindings.length > 0) {
    const results: SpacingElement[] = [];
    const walker = createPopmeltTreeWalker();
    let node: Node | null = walker.currentNode;

    while ((node = walker.nextNode()) && results.length < limit) {
      const el = node as HTMLElement;
      const r = el.getBoundingClientRect();
      if (r.bottom < -50 || r.top > window.innerHeight + 50 ||
          r.right < -50 || r.left > window.innerWidth + 50 ||
          r.width < 1 || r.height < 1) continue;

      const className = el.className;
      if (typeof className !== 'string') continue;

      for (const binding of token.bindings!) {
        if (!classListContains(className, binding)) continue;
        const cssProperty = inferPropertyFromTailwindClass(binding);
        if (!cssProperty) continue;
        // Filter by property scope if set
        if (token.property && !propertyMatchesScope(cssProperty, token.property)) continue;
        results.push({ element: el, property: cssProperty });
        break; // one match per element is enough
      }
    }
    return results;
  }

  // Fallback: value-based scan, with optional property scope filter
  const all = findSpacingElements(px, limit * 2);
  if (!token.property) return all.slice(0, limit);
  return all.filter(t => propertyMatchesScope(t.property, token.property!)).slice(0, limit);
}

/**
 * Redline variant — same matching as findElementsByTokenBinding but returns SpacingRect[]
 * with viewport coordinates for rendering redline overlays.
 */
export function findSpacingUsagesByBinding(token: TokenBinding, limit = 30): SpacingRect[] {
  const elements = findElementsByTokenBinding(token, limit);
  const results: SpacingRect[] = [];

  for (const t of elements) {
    const el = t.element;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const bT = parseFloat(s.borderTopWidth) || 0;
    const bR = parseFloat(s.borderRightWidth) || 0;
    const bL = parseFloat(s.borderLeftWidth) || 0;
    const cW = el.clientWidth;
    const cH = el.clientHeight;

    switch (t.property) {
      case 'padding-top': {
        const v = parseFloat(s.paddingTop) || 0;
        results.push({ x: r.left + bL, y: r.top + bT, width: cW, height: v, direction: 'vertical', property: t.property });
        break;
      }
      case 'padding-bottom': {
        const v = parseFloat(s.paddingBottom) || 0;
        results.push({ x: r.left + bL, y: r.top + bT + cH - v, width: cW, height: v, direction: 'vertical', property: t.property });
        break;
      }
      case 'padding-left': {
        const v = parseFloat(s.paddingLeft) || 0;
        results.push({ x: r.left + bL, y: r.top + bT, width: v, height: cH, direction: 'horizontal', property: t.property });
        break;
      }
      case 'padding-right': {
        const v = parseFloat(s.paddingRight) || 0;
        results.push({ x: r.left + bL + cW - v, y: r.top + bT, width: v, height: cH, direction: 'horizontal', property: t.property });
        break;
      }
      case 'margin-top': {
        const v = parseFloat(s.marginTop) || 0;
        results.push({ x: r.left, y: r.top - v, width: r.width, height: v, direction: 'vertical', property: t.property });
        break;
      }
      case 'margin-bottom': {
        const v = parseFloat(s.marginBottom) || 0;
        results.push({ x: r.left, y: r.bottom, width: r.width, height: v, direction: 'vertical', property: t.property });
        break;
      }
      case 'margin-left': {
        const v = parseFloat(s.marginLeft) || 0;
        results.push({ x: r.left - v, y: r.top, width: v, height: r.height, direction: 'horizontal', property: t.property });
        break;
      }
      case 'margin-right': {
        const v = parseFloat(s.marginRight) || 0;
        results.push({ x: r.right, y: r.top, width: v, height: r.height, direction: 'horizontal', property: t.property });
        break;
      }
      case 'gap':
      case 'row-gap':
      case 'column-gap': {
        // For gap properties, compute gap rects between visible children
        const children = Array.from(el.children).filter(c => {
          const cs = getComputedStyle(c);
          return cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed';
        });
        for (let i = 0; i < children.length - 1 && results.length < limit; i++) {
          const a = children[i]!.getBoundingClientRect();
          const b = children[i + 1]!.getBoundingClientRect();
          const vGap = b.top - a.bottom;
          if (vGap > 0.5) {
            results.push({
              x: Math.min(a.left, b.left), y: a.bottom,
              width: Math.max(a.right, b.right) - Math.min(a.left, b.left),
              height: vGap, direction: 'vertical', property: 'gap',
            });
          }
          const hGap = b.left - a.right;
          if (hGap > 0.5) {
            results.push({
              x: a.right, y: Math.min(a.top, b.top),
              width: hGap,
              height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
              direction: 'horizontal', property: 'gap',
            });
          }
        }
        break;
      }
    }
  }

  return results;
}

/**
 * Auto-populate helper. Given SpacingElement[] from a value-based scan,
 * extracts the Tailwind class names producing that value. Strips responsive prefixes.
 */
export function captureBindingsFromTargets(targets: SpacingElement[], px: number): string[] {
  const bindings = new Set<string>();
  const scale = pxToTailwindScale(px);

  for (const t of targets) {
    const prefixes = PROPERTY_TO_PREFIXES[t.property];
    if (!prefixes) continue;
    const className = t.element.className;
    if (typeof className !== 'string') continue;

    for (const prefix of prefixes) {
      const target = `${prefix}-${scale}`;
      // Check for exact match or responsive-prefixed match
      for (const cls of className.split(/\s+/)) {
        const colonIdx = cls.lastIndexOf(':');
        const base = colonIdx >= 0 ? cls.slice(colonIdx + 1) : cls;
        if (base === target) {
          bindings.add(base); // Store without responsive prefix
          break;
        }
      }
    }
  }

  return [...bindings];
}

/** Infer property scope from a set of SpacingElements. Returns undefined if mixed. */
export function inferPropertyScope(targets: SpacingElement[]): 'gap' | 'padding' | 'margin' | undefined {
  const scopes = new Set<string>();
  for (const t of targets) {
    for (const [scope, props] of Object.entries(PROPERTY_SCOPES)) {
      if (props.includes(t.property)) {
        scopes.add(scope);
        break;
      }
    }
  }
  if (scopes.size === 1) return [...scopes][0] as 'gap' | 'padding' | 'margin';
  return undefined;
}

/**
 * When a token's value changes via drag, update the Tailwind class names in the bindings array.
 * E.g. ["gap-8"] with 32px->40px becomes ["gap-10"].
 */
export function updateBindingClasses(bindings: string[], oldPx: number, newPx: number): string[] {
  if (oldPx === newPx) return bindings;
  const oldScale = pxToTailwindScale(oldPx);
  const newScale = pxToTailwindScale(newPx);

  return bindings.map(binding => {
    // binding is a base class like "gap-8" — replace the scale suffix
    const dashIdx = binding.lastIndexOf('-');
    if (dashIdx < 0) return binding;
    const prefix = binding.slice(0, dashIdx);
    const currentScale = binding.slice(dashIdx + 1);
    // Only update if the current scale matches the old value
    if (currentScale === oldScale || currentScale === `[${oldPx}px]`) {
      return `${prefix}-${newScale}`;
    }
    return binding;
  });
}

// --- Tailwind spacing class mapping (for AI context) ---

const PX_TO_TAILWIND_SCALE: Record<number, string> = {
  0: '0', 1: 'px', 2: '0.5', 4: '1', 6: '1.5', 8: '2', 12: '3', 16: '4',
  20: '5', 24: '6', 28: '7', 32: '8', 40: '10', 48: '12', 64: '16', 80: '20', 96: '24',
};

function pxToTailwindScale(px: number): string {
  return PX_TO_TAILWIND_SCALE[px] ?? `[${px}px]`;
}

const PROPERTY_TO_PREFIXES: Record<string, string[]> = {
  'padding-top': ['pt', 'py', 'p'],
  'padding-bottom': ['pb', 'py', 'p'],
  'padding-left': ['pl', 'px', 'p'],
  'padding-right': ['pr', 'px', 'p'],
  'margin-top': ['mt', 'my', 'm'],
  'margin-bottom': ['mb', 'my', 'm'],
  'margin-left': ['ml', 'mx', 'm'],
  'margin-right': ['mr', 'mx', 'm'],
  'gap': ['gap'],
  'row-gap': ['gap-y', 'gap'],
  'column-gap': ['gap-x', 'gap'],
};

function findMatchingTailwindClass(
  className: string,
  property: string,
  oldPx: number,
  newPx: number,
): { matched: string; suggested: string } | null {
  const prefixes = PROPERTY_TO_PREFIXES[property];
  if (!prefixes) return null;

  const oldScale = pxToTailwindScale(oldPx);

  for (const prefix of prefixes) {
    // Match e.g. "gap-6", "pt-[24px]", or responsive variants like "md:gap-6"
    const re = new RegExp('(?:^|\\s)((?:[\\w-]+:)*' + prefix + '-(?:' + escapeRegex(oldScale) + '|\\[' + oldPx + 'px\\]))(?:\\s|$)');
    const m = className.match(re);
    if (m?.[1]) {
      const newScale = pxToTailwindScale(newPx);
      // Preserve any responsive prefix (e.g. "md:")
      const colonIdx = m[1].lastIndexOf(':');
      const responsivePrefix = colonIdx >= 0 ? m[1].slice(0, colonIdx + 1) : '';
      return {
        matched: m[1],
        suggested: `${responsivePrefix}${prefix}-${newScale}`,
      };
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Enrich spacing elements with code-level context for AI consumption.
 * For each SpacingElement, captures unique selector, React component name,
 * full className, and Tailwind class mapping (old -> new).
 */
export function buildSpacingChangeContext(
  targets: SpacingElement[],
  originalPx: number,
  newPx: number,
): SpacingElementEvidence[] {
  const seen = new Set<string>();
  const results: SpacingElementEvidence[] = [];

  for (const t of targets) {
    const selector = getUniqueSelector(t.element);
    // Dedupe by selector + property
    const key = `${selector}::${t.property}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const reactInfo = getReactComponentInfo(t.element);
    const className = t.element.className || '';
    const twMatch = findMatchingTailwindClass(className, t.property, originalPx, newPx);

    results.push({
      selector,
      reactComponent: reactInfo?.name,
      className,
      property: t.property,
      matchedClass: twMatch?.matched,
      suggestedClass: twMatch?.suggested,
    });
  }

  return results;
}
