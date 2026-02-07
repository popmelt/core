import type { ElementInfo, Point, StyleModification } from '../tools/types';

// Get React component info from a DOM element via React fiber
function getReactComponentInfo(element: Element): { name: string; path: string[] } | null {
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
function extractElementInfo(el: Element): ElementInfo {
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
function getDirectTextContent(el: Element): string {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
    }
  }
  return text.trim();
}

// Find the topmost DOM element at a point, filtering out devtools elements
function getTopmostElementAtPoint(x: number, y: number): Element | null {
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

// =========================================
// Style Inspector Utilities
// =========================================

// Get computed style value for a CSS property
export function getComputedStyleValue(el: Element, property: string): string {
  return window.getComputedStyle(el).getPropertyValue(property);
}

// Get the raw style value preserving var() references if present
export function getRawStyleValue(el: Element, property: string): string {
  // First check inline style (preserves var())
  if (el instanceof HTMLElement) {
    const inlineValue = el.style.getPropertyValue(property);
    if (inlineValue) {
      return inlineValue;
    }
  }

  // Check matched CSS rules for var() references
  const varValue = getPropertyFromMatchedRules(el, property);
  if (varValue && varValue.includes('var(')) {
    return varValue;
  }

  // Fall back to computed value
  return getComputedStyleValue(el, property);
}

// Get a property value from matched CSS rules (preserves var() references)
function getPropertyFromMatchedRules(el: Element, property: string): string | null {
  // Convert property to camelCase for style access
  const camelProperty = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

  try {
    // Iterate through all stylesheets
    for (const sheet of document.styleSheets) {
      try {
        const rules = sheet.cssRules || sheet.rules;
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule) {
            // Check if this rule matches our element
            if (el.matches(rule.selectorText)) {
              // Check the raw CSS text for var() usage on this property
              const value = rule.style.getPropertyValue(property);
              if (value && value.includes('var(')) {
                return value;
              }
              // Also check via the style object
              const styleValue = (rule.style as unknown as Record<string, string>)[camelProperty];
              if (styleValue && styleValue.includes('var(')) {
                return styleValue;
              }
            }
          }
        }
      } catch {
        // Cross-origin stylesheet, skip
      }
    }
  } catch {
    // Stylesheets not accessible
  }

  return null;
}

// Check if a CSS property is explicitly set (inline style or stylesheet rule)
// Returns the authored value, or null if the property is just using its default/inherited value
export function getAuthoredStyleValue(el: Element, property: string): string | null {
  // Check inline style first
  if (el instanceof HTMLElement) {
    const inlineValue = el.style.getPropertyValue(property);
    if (inlineValue) return inlineValue;
  }

  const camelProperty = property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

  try {
    for (const sheet of document.styleSheets) {
      try {
        const rules = sheet.cssRules || sheet.rules;
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule && el.matches(rule.selectorText)) {
            const value = rule.style.getPropertyValue(property);
            if (value) return value;
            const styleValue = (rule.style as unknown as Record<string, string>)[camelProperty];
            if (styleValue) return styleValue;
          }
        }
      } catch {
        // Cross-origin stylesheet, skip
      }
    }
  } catch {
    // Stylesheets not accessible
  }

  return null;
}

// Color variable info
export type ColorVariable = {
  name: string;           // e.g., "--primary"
  value: string;          // resolved color value
  usage: string;          // e.g., "var(--primary)"
};

// Recursively scan CSS rules for custom properties
function scanRulesForVariables(
  rules: CSSRuleList | undefined,
  rootStyles: CSSStyleDeclaration,
  seen: Set<string>,
  variables: ColorVariable[]
): void {
  if (!rules) return;

  for (const rule of rules) {
    // Handle @layer, @supports, @media rules (they contain nested rules)
    if (rule instanceof CSSGroupingRule) {
      scanRulesForVariables(rule.cssRules, rootStyles, seen, variables);
      continue;
    }

    // Handle style rules
    if (rule instanceof CSSStyleRule) {
      // Check :root, html, or * selectors for global variables
      const selector = rule.selectorText.toLowerCase();
      if (selector === ':root' || selector === 'html' || selector === '*' || selector.includes(':root')) {
        extractVariablesFromStyle(rule.style, rootStyles, seen, variables);
      }
    }
  }
}

// Extract CSS custom properties from a style declaration
function extractVariablesFromStyle(
  style: CSSStyleDeclaration,
  rootStyles: CSSStyleDeclaration,
  seen: Set<string>,
  variables: ColorVariable[]
): void {
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    if (prop?.startsWith('--')) {
      if (seen.has(prop)) continue;
      seen.add(prop);

      const value = rootStyles.getPropertyValue(prop).trim();
      // Check if it looks like a color
      if (isColorValue(value)) {
        variables.push({
          name: prop,
          value,
          usage: `var(${prop})`,
        });
      }
    }
  }
}

// Get all CSS color variables from the document
export function getColorVariables(): ColorVariable[] {
  const variables: ColorVariable[] = [];
  const seen = new Set<string>();

  // Get from :root computed styles
  const rootStyles = getComputedStyle(document.documentElement);

  // Method 1: Scan all stylesheets for custom properties in :root, html, *, @layer rules
  try {
    for (const sheet of document.styleSheets) {
      try {
        scanRulesForVariables(sheet.cssRules || sheet.rules, rootStyles, seen, variables);
      } catch {
        // Cross-origin stylesheet, skip
      }
    }
  } catch {
    // Stylesheets not accessible
  }

  // Method 2: Also get variables from inline styles on :root/html
  const htmlStyle = document.documentElement.style;
  for (let i = 0; i < htmlStyle.length; i++) {
    const prop = htmlStyle[i];
    if (prop?.startsWith('--') && !seen.has(prop)) {
      seen.add(prop);
      const value = rootStyles.getPropertyValue(prop).trim();
      if (isColorValue(value)) {
        variables.push({
          name: prop,
          value,
          usage: `var(${prop})`,
        });
      }
    }
  }

  // Sort by name
  return variables.sort((a, b) => a.name.localeCompare(b.name));
}

// Check if a value looks like a color
function isColorValue(value: string): boolean {
  if (!value) return false;
  const v = value.toLowerCase().trim();

  // Hex colors
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return true;

  // RGB/RGBA
  if (v.startsWith('rgb')) return true;

  // HSL/HSLA
  if (v.startsWith('hsl')) return true;

  // OKLCH/OKLAB
  if (v.startsWith('oklch') || v.startsWith('oklab')) return true;

  // LCH/LAB
  if (v.startsWith('lch') || v.startsWith('lab')) return true;

  // Named colors (common ones)
  const namedColors = ['transparent', 'currentcolor', 'inherit', 'white', 'black', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey'];
  if (namedColors.includes(v)) return true;

  return false;
}

// Resolve a color value (handles var() references)
export function resolveColorValue(el: Element, value: string): string {
  // If it's a var() reference, resolve it
  const varMatch = value.match(/var\((--[^,)]+)(?:,\s*([^)]+))?\)/);
  if (varMatch) {
    const varName = varMatch[1]!;
    const fallback = varMatch[2];
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return resolved || fallback || value;
  }
  return value;
}

// Find a CSS variable that matches a given color value
export function findMatchingColorVariable(
  colorValue: string,
  variables: ColorVariable[]
): ColorVariable | null {
  if (!colorValue) return null;

  const normalizedTarget = normalizeColorForComparison(colorValue);
  if (!normalizedTarget) return null;

  for (const variable of variables) {
    const normalizedVar = normalizeColorForComparison(variable.value);
    if (normalizedVar && normalizedTarget === normalizedVar) {
      return variable;
    }
  }

  return null;
}

// Normalize a color value for comparison (handles oklch, rgb, hex)
function normalizeColorForComparison(color: string): string | null {
  if (!color) return null;
  const c = color.trim().toLowerCase();

  // For oklch values, normalize spacing and precision
  if (c.startsWith('oklch(')) {
    // Handle various formats: oklch(0.97 0 0), oklch(97% 0 0), oklch(0.97 0.01 180 / 0.5)
    const match = c.match(/oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)/);
    if (match) {
      // Convert percentage to decimal if needed
      let l = match[1]!.endsWith('%') ? parseFloat(match[1]!) / 100 : parseFloat(match[1]!);
      let ch = match[2]!.endsWith('%') ? parseFloat(match[2]!) / 100 : parseFloat(match[2]!);
      const h = parseFloat(match[3]!);
      // Round to 2 decimal places for comparison
      l = Math.round(l * 100) / 100;
      ch = Math.round(ch * 1000) / 1000;
      const hRound = Math.round(h);
      return `oklch(${l} ${ch} ${hRound})`;
    }
  }

  // For rgb values
  if (c.startsWith('rgb')) {
    const match = c.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (match) {
      return `rgb(${match[1]},${match[2]},${match[3]})`;
    }
  }

  // For hex values
  if (c.startsWith('#')) {
    // Expand shorthand
    if (c.length === 4) {
      return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    }
    return c.slice(0, 7); // Ignore alpha
  }

  return c;
}

// Apply an inline style to an element
export function applyInlineStyle(el: Element, property: string, value: string): void {
  if (el instanceof HTMLElement) {
    el.style.setProperty(property, value, 'important');
  }
}

// Revert an inline style to its original value
export function revertInlineStyle(el: Element, property: string, original: string): void {
  if (el instanceof HTMLElement) {
    // Remove the inline style
    el.style.removeProperty(property);
    // If there was an original inline value (not from stylesheet), restore it
    // The original value from getComputedStyle includes both inline and stylesheet styles
    // We only need to remove our override - the stylesheet/inline value will take over
  }
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

// Find an element by its selector
export function findElementBySelector(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    // Invalid selector
    return null;
  }
}

// Apply all style modifications to the DOM (used on restore)
export function applyStyleModifications(modifications: StyleModification[]): void {
  for (const mod of modifications) {
    const el = findElementBySelector(mod.selector);
    if (el) {
      for (const change of mod.changes) {
        applyInlineStyle(el, change.property, change.modified);
      }
    }
  }
}

// Revert all style modifications on an element
export function revertElementStyles(selector: string, modifications: StyleModification[]): void {
  const el = findElementBySelector(selector);
  if (!el) return;

  const mod = modifications.find(m => m.selector === selector);
  if (!mod) return;

  for (const change of mod.changes) {
    revertInlineStyle(el, change.property, change.original);
  }
}

// Revert all style modifications
export function revertAllStyles(modifications: StyleModification[]): void {
  for (const mod of modifications) {
    const el = findElementBySelector(mod.selector);
    if (el) {
      for (const change of mod.changes) {
        revertInlineStyle(el, change.property, change.original);
      }
    }
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

// Export extractElementInfo for use in components
export { extractElementInfo, getTopmostElementAtPoint };
