import type { ElementInfo, Point } from '../tools/types';
import { getElementSelector } from './cssSelector';
import { getReactComponentInfo } from './reactFiber';

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
