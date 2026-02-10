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

// Memoization cache for getColorVariables
let _colorVarCache: { variables: ColorVariable[]; timestamp: number } | null = null;
const COLOR_VAR_CACHE_TTL = 5000; // 5 seconds

// Get all CSS color variables from the document
export function getColorVariables(): ColorVariable[] {
  if (_colorVarCache && Date.now() - _colorVarCache.timestamp < COLOR_VAR_CACHE_TTL) {
    return _colorVarCache.variables;
  }

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
  const sorted = variables.sort((a, b) => a.name.localeCompare(b.name));
  _colorVarCache = { variables: sorted, timestamp: Date.now() };
  return sorted;
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
