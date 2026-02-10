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

// Check if an element is a flex or grid container
export function isFlexOrGrid(el: Element): boolean {
  const d = window.getComputedStyle(el).display;
  return d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid';
}

// Get computed gap values for an element
export function getComputedGap(el: Element): { row: number; column: number } {
  const cs = window.getComputedStyle(el);
  return {
    row: parseFloat(cs.rowGap) || 0,
    column: parseFloat(cs.columnGap) || 0,
  };
}

export type GapZone = {
  axis: 'row' | 'column';
  x: number; y: number; w: number; h: number; // viewport-relative
};

// Deduplicate gap zones that share an axis and overlap on the primary axis
function deduplicateGapZones(zones: GapZone[]): GapZone[] {
  const result: GapZone[] = [];
  for (const zone of zones) {
    const existing = result.find(z => {
      if (z.axis !== zone.axis) return false;
      if (zone.axis === 'row') {
        // Same row gap: similar y position
        return Math.abs(z.y - zone.y) < 2 && Math.abs(z.h - zone.h) < 2;
      }
      // Same column gap: similar x position
      return Math.abs(z.x - zone.x) < 2 && Math.abs(z.w - zone.w) < 2;
    });
    if (existing) {
      // Merge: extend to cover both zones
      if (zone.axis === 'row') {
        const minX = Math.min(existing.x, zone.x);
        const maxX = Math.max(existing.x + existing.w, zone.x + zone.w);
        existing.x = minX;
        existing.w = maxX - minX;
      } else {
        const minY = Math.min(existing.y, zone.y);
        const maxY = Math.max(existing.y + existing.h, zone.y + zone.h);
        existing.y = minY;
        existing.h = maxY - minY;
      }
    } else {
      result.push({ ...zone });
    }
  }
  return result;
}

// Compute gap zones between children of a flex/grid container
export function computeGapZones(container: Element): GapZone[] {
  const children = Array.from(container.children).filter(c => {
    if (!(c instanceof HTMLElement)) return false;
    const s = window.getComputedStyle(c);
    return s.display !== 'none' && s.position !== 'absolute' && s.position !== 'fixed';
  });
  if (children.length < 2) return [];

  const zones: GapZone[] = [];
  const containerRect = container.getBoundingClientRect();

  // Determine main axis from flex-direction for zero-gap detection
  const cs = window.getComputedStyle(container);
  const fd = cs.flexDirection;
  const isColumnLayout = fd === 'column' || fd === 'column-reverse';

  const MIN_ZONE = 6; // minimum hoverable zone size for zero gaps

  for (let i = 0; i < children.length - 1; i++) {
    const a = children[i]!.getBoundingClientRect();
    const b = children[i + 1]!.getBoundingClientRect();

    // Column gap: horizontal space between side-by-side children
    if (b.left > a.right + 0.5) {
      zones.push({
        axis: 'column',
        x: a.right,
        y: containerRect.top,
        w: b.left - a.right,
        h: containerRect.height,
      });
    }

    // Row gap: vertical space between stacked children
    if (b.top > a.bottom + 0.5) {
      zones.push({
        axis: 'row',
        x: containerRect.left,
        y: a.bottom,
        w: containerRect.width,
        h: b.top - a.bottom,
      });
    }

    // Zero gap: siblings are touching — emit thin zone on the main axis
    if (!(b.left > a.right + 0.5) && !(b.top > a.bottom + 0.5)) {
      if (isColumnLayout) {
        const boundary = (a.bottom + b.top) / 2;
        zones.push({
          axis: 'row',
          x: containerRect.left,
          y: boundary - MIN_ZONE / 2,
          w: containerRect.width,
          h: MIN_ZONE,
        });
      } else {
        const boundary = (a.right + b.left) / 2;
        zones.push({
          axis: 'column',
          x: boundary - MIN_ZONE / 2,
          y: containerRect.top,
          w: MIN_ZONE,
          h: containerRect.height,
        });
      }
    }
  }

  return deduplicateGapZones(zones);
}

/** Check if a gap zone axis is auto-justified (space-between/around/evenly) with no explicit gap */
export function isAutoGap(el: Element, axis: 'row' | 'column'): boolean {
  const cs = window.getComputedStyle(el);
  const d = cs.display;
  // Only flex containers have justify-content-driven auto gaps
  if (d !== 'flex' && d !== 'inline-flex') return false;

  const jc = cs.justifyContent;
  if (jc !== 'space-between' && jc !== 'space-around' && jc !== 'space-evenly' && jc !== 'stretch') return false;

  // justify-content affects the main axis
  const fd = cs.flexDirection;
  const justifyAxis: 'row' | 'column' = (fd === 'column' || fd === 'column-reverse') ? 'row' : 'column';
  if (axis !== justifyAxis) return false;

  // If there's an explicit gap on this axis, the gap is fixed (not auto-distributed)
  const gapValue = parseFloat(axis === 'row' ? cs.rowGap : cs.columnGap);
  if (gapValue > 0) return false;

  return true;
}

// Get computed padding values for an element
export function getComputedPadding(el: Element): { top: number; right: number; bottom: number; left: number } {
  const cs = window.getComputedStyle(el);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

export type BorderRadiusCorner = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left';

export function getComputedBorderRadius(el: Element): Record<BorderRadiusCorner, number> {
  const cs = window.getComputedStyle(el);
  return {
    'top-left': parseFloat(cs.borderTopLeftRadius) || 0,
    'top-right': parseFloat(cs.borderTopRightRadius) || 0,
    'bottom-right': parseFloat(cs.borderBottomRightRadius) || 0,
    'bottom-left': parseFloat(cs.borderBottomLeftRadius) || 0,
  };
}

/** Returns true if the element has at least one direct text node with non-whitespace content. */
export function isTextElement(el: Element): boolean {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0) {
      return true;
    }
  }
  return false;
}

/** Returns the bounding rect of direct text nodes within an element, adjusted for line-height. */
export function getTextBoundingRect(el: Element): DOMRect | null {
  const range = document.createRange();
  let hasText = false;
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0) {
      if (!hasText) {
        range.setStart(node, 0);
        hasText = true;
      }
      range.setEnd(node, node.textContent?.length ?? 0);
    }
  }
  if (!hasText) return null;

  const rangeRect = range.getBoundingClientRect();
  // Adjust height to account for line-height (Range rects are glyph-based)
  const cs = window.getComputedStyle(el);
  const fontSize = parseFloat(cs.fontSize) || 16;
  let lineHeight = parseFloat(cs.lineHeight);
  if (isNaN(lineHeight)) lineHeight = fontSize * 1.2;

  // One rect per visual line fragment
  const numLines = Math.max(1, range.getClientRects().length);
  const adjustedHeight = Math.max(rangeRect.height, numLines * lineHeight);
  const dy = (adjustedHeight - rangeRect.height) / 2;

  return new DOMRect(rangeRect.x, rangeRect.y - dy, rangeRect.width, adjustedHeight);
}

/** Reads computed font-size and line-height (resolved to px) from the element. */
export function getComputedTextProperties(el: Element): { fontSize: number; lineHeight: number } {
  const cs = window.getComputedStyle(el);
  const fontSize = parseFloat(cs.fontSize) || 16;
  let lineHeight = parseFloat(cs.lineHeight);
  if (isNaN(lineHeight)) {
    // "normal" keyword — browsers don't resolve to px in getComputedStyle for some edge cases
    lineHeight = fontSize * 1.2;
  }
  return { fontSize, lineHeight };
}
