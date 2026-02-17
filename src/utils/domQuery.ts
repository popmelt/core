import type { ElementInfo, Point, SpacingElementEvidence } from '../tools/types';

// Get React component info from a DOM element via React fiber
export function getReactComponentInfo(element: Element): { name: string; path: string[] } | null {
  // Find the fiber key (has random suffix per React instance)
  const fiberKey = Object.keys(element).find(
    key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
  );

  if (!fiberKey) return null;

  let fiber = (element as unknown as Record<string, unknown>)[fiberKey] as {
    type?: { displayName?: string; name?: string };
    return?: unknown;
  } | null;

  const path: string[] = [];

  // Walk up the fiber tree to build component hierarchy
  while (fiber) {
    const type = fiber.type;
    const name = type?.displayName || type?.name;

    // Keep PascalCase names (React components), skip lowercase (DOM elements)
    // Also skip anonymous functions and internal React types
    if (
      name &&
      typeof name === 'string' &&
      /^[A-Z]/.test(name) &&
      !name.startsWith('_') &&
      name !== 'Fragment'
    ) {
      path.unshift(name);
    }

    fiber = fiber.return as typeof fiber;
  }

  return path.length > 0
    ? { name: path[path.length - 1]!, path }
    : null;
}

// Generate a CSS selector for an element
function getElementSelector(el: Element): string {
  if (el.id) {
    return `#${el.id}`;
  }

  const tagName = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).slice(0, 3).join('.');

  if (classes) {
    return `${tagName}.${classes}`;
  }

  return tagName;
}

// Extract useful info from a DOM element
export function extractElementInfo(el: Element): ElementInfo {
  const info: ElementInfo = {
    selector: getElementSelector(el),
    tagName: el.tagName.toLowerCase(),
  };

  if (el.id) {
    info.id = el.id;
  }

  if (el.classList.length > 0) {
    info.className = Array.from(el.classList).join(' ');
  }

  // Get text content (truncated, immediate text only to avoid huge strings)
  const text = getDirectTextContent(el);
  if (text && text.length > 0 && text.length < 200) {
    info.textContent = text;
  }

  // Get data attributes
  const dataAttrs: Record<string, string> = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-')) {
      dataAttrs[attr.name] = attr.value;
    }
  }
  if (Object.keys(dataAttrs).length > 0) {
    info.dataAttributes = dataAttrs;
  }

  // Get React component info if available
  const reactInfo = getReactComponentInfo(el);
  if (reactInfo) {
    info.reactComponent = reactInfo.name;
  }

  // Get context (nearest meaningful ancestor)
  const context = getNearestContext(el);
  if (context) {
    info.context = context;
  }

  return info;
}

// Get direct text content, not from children
export function getDirectTextContent(el: Element): string {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
    }
  }
  return text.trim();
}

// Find the topmost DOM element at a point, filtering out devtools elements
export function getTopmostElementAtPoint(x: number, y: number): Element | null {
  const elements = document.elementsFromPoint(x, y);
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.id === 'devtools-canvas' || el.id === 'devtools-toolbar' || el.id === 'devtools-scrim') continue;
    if (el.closest('#devtools-toolbar')) continue;
    // Skip any devtools annotation elements (badges, highlights, panels, etc.)
    if (el.dataset.devtools || el.closest('[data-devtools]')) continue;
    // Skip html, body
    if (['html', 'body'].includes(el.tagName.toLowerCase())) continue;
    return el;
  }
  return null;
}

// Find nearest meaningful ancestor (section/article/nav/aside with id, or any element with id)
function getNearestContext(el: Element): string | null {
  let current: Element | null = el.parentElement;
  const landmarks = ['section', 'article', 'nav', 'aside', 'header', 'footer', 'main'];

  while (current && current !== document.body) {
    const tag = current.tagName.toLowerCase();
    // Prefer landmarks with ids
    if (landmarks.includes(tag) && current.id) {
      return `${tag}#${current.id}`;
    }
    // Fall back to any element with a meaningful id
    if (current.id && !current.id.startsWith('radix-') && !current.id.startsWith(':')) {
      return `${tag}#${current.id}`;
    }
    current = current.parentElement;
  }
  return null;
}

// Capture DOM elements at annotation bounds (in document coordinates)
// Returns only the topmost (leaf) elements at sample points, deduped
export function captureElementsAtBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
): ElementInfo[] {
  const seen = new Set<Element>();
  const elements: ElementInfo[] = [];

  // Convert bounds to viewport coordinates
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  // Sample points: center and corners
  const points = [
    { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, // center
    { x: bounds.minX, y: bounds.minY }, // top-left
    { x: bounds.maxX, y: bounds.minY }, // top-right
    { x: bounds.minX, y: bounds.maxY }, // bottom-left
    { x: bounds.maxX, y: bounds.maxY }, // bottom-right
  ];

  for (const point of points) {
    // Convert from document to viewport coordinates
    const viewportX = point.x - scrollX;
    const viewportY = point.y - scrollY;

    // Skip if outside viewport
    if (viewportX < 0 || viewportY < 0 || viewportX > window.innerWidth || viewportY > window.innerHeight) {
      continue;
    }

    // Get only the topmost element at this point
    const el = getTopmostElementAtPoint(viewportX, viewportY);
    if (el && !seen.has(el)) {
      seen.add(el);
      elements.push(extractElementInfo(el));
    }
  }

  return elements.slice(0, 3); // Limit to 3 most specific elements
}

// Capture elements from an array of points (for freehand/line annotations)
export function captureElementsAtPoints(points: Point[]): ElementInfo[] {
  if (points.length === 0) return [];

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);

  return captureElementsAtBounds({
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  });
}

// --- Component boundary detection for model tool ---

export type ComponentBoundary = {
  name: string;
  path: string[];       // Full PascalCase ancestor chain, root-first
  depthIndex: number;   // Currently selected index in path
  rootElement: Element;  // Component's outermost DOM node
};

type FiberNode = {
  type?: { displayName?: string; name?: string } | string;
  return?: FiberNode | null;
  child?: FiberNode | null;
  sibling?: FiberNode | null;
  stateNode?: unknown;
  tag?: number;
};

/** Collect PascalCase component fibers from a DOM element up to the root. */
function collectComponentFibers(element: Element): { name: string; fiber: FiberNode }[] {
  const fiberKey = Object.keys(element).find(
    key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
  );
  if (!fiberKey) return [];

  let fiber = (element as unknown as Record<string, unknown>)[fiberKey] as FiberNode | null;
  const results: { name: string; fiber: FiberNode }[] = [];

  while (fiber) {
    const type = fiber.type;
    const name = typeof type === 'function' || typeof type === 'object'
      ? (type as Record<string, unknown>)?.displayName || (type as Record<string, unknown>)?.name
      : null;
    if (
      name &&
      typeof name === 'string' &&
      /^[A-Z]/.test(name) &&
      !name.startsWith('_') &&
      name !== 'Fragment'
    ) {
      results.push({ name, fiber });
    }
    fiber = fiber.return as FiberNode | null;
  }

  // Reverse so root is first, leaf is last
  results.reverse();
  return results;
}

/** Find the outermost DOM element owned by a fiber (walk fiber.child until a host fiber with stateNode Element). */
function findFiberRootElement(fiber: FiberNode): Element | null {
  // Host fibers have tag 5 (HostComponent) and a stateNode that is an Element
  let current: FiberNode | null = fiber;
  const visited = new Set<FiberNode>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current.stateNode instanceof Element) {
      return current.stateNode;
    }
    // Walk into children
    if (current.child) {
      current = current.child;
    } else {
      current = null;
    }
  }
  return null;
}

/**
 * Get the component boundary at a DOM element.
 * Default selection = innermost component. depthOffset moves toward root (positive = shallower).
 */
export function getComponentBoundary(element: Element, depthOffset = 0): ComponentBoundary | null {
  const fibers = collectComponentFibers(element);
  if (fibers.length === 0) return null;

  const path = fibers.map(f => f.name);
  // Default = innermost (last). Offset moves toward root.
  const defaultIndex = fibers.length - 1;
  const targetIndex = Math.max(0, Math.min(fibers.length - 1, defaultIndex - depthOffset));

  const selected = fibers[targetIndex]!;
  const rootElement = findFiberRootElement(selected.fiber) ?? element;

  return {
    name: selected.name,
    path,
    depthIndex: targetIndex,
    rootElement,
  };
}

/** Walk the page DOM to find a component by name and return its boundary. */
export function findComponentBoundaryByName(name: string): ComponentBoundary | null {
  const results = findAllComponentBoundariesByName(name);
  return results[0] ?? null;
}

/** Find a named component in a DOM element's fiber chain (any depth, not just innermost).
 *  Tries exact match first, then fuzzy (one name contains the other, min 4 chars). */
function findNamedBoundary(element: Element, name: string): ComponentBoundary | null {
  const fibers = collectComponentFibers(element);
  const nameLower = name.toLowerCase();
  let fuzzyIdx = -1;
  for (let i = fibers.length - 1; i >= 0; i--) {
    const fiberName = fibers[i]!.name;
    if (fiberName === name) {
      const rootElement = findFiberRootElement(fibers[i]!.fiber) ?? element;
      return { name, path: fibers.map(f => f.name), depthIndex: i, rootElement };
    }
    // Fuzzy: one name contains the other (min 4 chars for the shorter string)
    if (fuzzyIdx === -1) {
      const fiberLower = fiberName.toLowerCase();
      if (
        (fiberLower.length >= 4 && nameLower.includes(fiberLower)) ||
        (nameLower.length >= 4 && fiberLower.includes(nameLower))
      ) {
        fuzzyIdx = i;
      }
    }
  }
  if (fuzzyIdx >= 0) {
    const rootElement = findFiberRootElement(fibers[fuzzyIdx]!.fiber) ?? element;
    return { name, path: fibers.map(f => f.name), depthIndex: fuzzyIdx, rootElement };
  }
  return null;
}

/** Walk the page DOM to find all instances of a component by name (checks full fiber chain). */
export function findAllComponentBoundariesByName(name: string): ComponentBoundary[] {
  const walker = createPopmeltTreeWalker();
  const results: ComponentBoundary[] = [];
  const seen = new Set<Element>();
  let node: Node | null = walker.currentNode;
  while ((node = walker.nextNode())) {
    const boundary = findNamedBoundary(node as Element, name);
    if (boundary && !seen.has(boundary.rootElement)) {
      seen.add(boundary.rootElement);
      results.push(boundary);
    }
  }
  return results;
}

/**
 * Single DOM walk to find the vertical position (top of first instance) for each
 * component name in the given set. Returns a Map<name, y>.
 * Checks the full fiber chain at each element, not just the innermost.
 * Components not found on the page get `Infinity` so they sort last.
 */
export function getComponentPositions(names: Set<string>): Map<string, number> {
  const positions = new Map<string, number>();
  if (names.size === 0) return positions;
  const remaining = new Set(names);
  const walker = createPopmeltTreeWalker();
  const seen = new Set<Element>();
  let node: Node | null = walker.currentNode;
  while ((node = walker.nextNode()) && remaining.size > 0) {
    for (const modelName of remaining) {
      const boundary = findNamedBoundary(node as Element, modelName);
      if (!boundary || seen.has(boundary.rootElement)) continue;
      seen.add(boundary.rootElement);
      const rect = boundary.rootElement.getBoundingClientRect();
      positions.set(modelName, rect.top + window.scrollY);
      remaining.delete(modelName);
      break;
    }
  }
  // Components not found on the page sort last
  for (const name of remaining) {
    positions.set(name, Infinity);
  }
  return positions;
}

function createPopmeltTreeWalker(): TreeWalker {
  return document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as HTMLElement;
      if (el.closest('#devtools-toolbar, #devtools-canvas, #devtools-scrim, [data-popmelt-panel]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
}

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

// Generate a unique, stable selector for an element
export function getUniqueSelector(el: Element): string {
  // First, try ID (most reliable)
  if (el.id && !el.id.startsWith('radix-') && !el.id.startsWith(':')) {
    return `#${CSS.escape(el.id)}`;
  }

  // Build path from element to document
  const path: string[] = [];
  let current: Element | null = el;

  while (current && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();

    // Add id if available
    if (current.id && !current.id.startsWith('radix-') && !current.id.startsWith(':')) {
      path.unshift(`#${CSS.escape(current.id)}`);
      break; // ID is unique, stop here
    }

    // Add class names (first 2 meaningful ones)
    const classes = Array.from(current.classList)
      .filter(c => !c.startsWith('_') && c.length < 30)
      .slice(0, 2);
    if (classes.length > 0) {
      selector += '.' + classes.map(c => CSS.escape(c)).join('.');
    }

    // Add nth-child if needed to disambiguate
    const parentEl: Element | null = current.parentElement;
    if (parentEl) {
      const siblings = Array.from(parentEl.children).filter(
        (child) => child.tagName === current!.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    path.unshift(selector);
    current = parentEl;
  }

  return path.join(' > ');
}

// --- Code-rooted spacing token types ---

export type TokenBinding = {
  value: string;
  property?: 'gap' | 'padding' | 'margin';
  bindings?: string[];
};

/** Normalize string | TokenBinding → TokenBinding. Plain strings become { value: raw }. */
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

/** Map Tailwind class prefix → CSS property. */
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
 * E.g. ["gap-8"] with 32px→40px becomes ["gap-10"].
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
 * full className, and Tailwind class mapping (old → new).
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

// Find an element by its selector
export function findElementBySelector(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    // Invalid selector
    return null;
  }
}

/**
 * Resolve a page-coordinate region to a DOM element.
 * Uses elementFromPoint at the region center, tags it with data-pm,
 * and returns the selector, element info, and bounding rect.
 */
export function resolveRegionToElement(
  region: { x: number; y: number; width: number; height: number },
): { selector: string; info: ElementInfo; rect: DOMRect } | null {
  const centerX = region.x + region.width / 2;
  const centerY = region.y + region.height / 2;

  // Convert from page coordinates to viewport coordinates
  const viewportX = centerX - window.scrollX;
  const viewportY = centerY - window.scrollY;

  const el = getTopmostElementAtPoint(viewportX, viewportY);
  if (!el || !(el instanceof HTMLElement)) return null;

  // Tag with data-pm for selector stability
  if (!el.hasAttribute('data-pm')) {
    const pmId = Math.random().toString(36).substring(2, 9);
    el.setAttribute('data-pm', pmId);
  }

  const pmValue = el.getAttribute('data-pm')!;
  const selector = `[data-pm="${pmValue}"]`;
  const info = extractElementInfo(el);
  const rect = el.getBoundingClientRect();

  return { selector, info, rect };
}
