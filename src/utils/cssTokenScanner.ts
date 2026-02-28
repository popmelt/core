// Scan :root CSS custom properties and categorize them

export type ScannedTokens = {
  colors: [string, string][];
  fonts: [string, string][];
  typeScale: [string, string][];
  spacing: [string, string][];
  radii: [string, string][];
  shadows: [string, string][];
  other: [string, string][];
  /** Maps var name → referenced var name for semantic/alias tokens */
  references: Record<string, string>;
};

const EMPTY: ScannedTokens = { colors: [], fonts: [], typeScale: [], spacing: [], radii: [], shadows: [], other: [], references: {} };

// --- Value detection ---

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const FN_COLOR_RE = /^(?:rgba?|hsla?|oklch|oklab|lch|lab)\(/;
const NAMED_COLORS = new Set([
  'transparent', 'currentcolor', 'inherit', 'white', 'black', 'red', 'green',
  'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey', 'cyan',
  'magenta', 'brown', 'navy', 'teal', 'maroon', 'olive', 'silver', 'aqua',
  'fuchsia', 'lime',
]);

function isColorValue(v: string): boolean {
  const t = v.trim().toLowerCase();
  return HEX_RE.test(t) || FN_COLOR_RE.test(t) || NAMED_COLORS.has(t);
}

const CSS_LENGTH_RE = /^-?\d+(\.\d+)?(px|rem|em|%)$/;
function isCssLength(v: string): boolean {
  return CSS_LENGTH_RE.test(v.trim());
}

const FONT_GENERIC = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
]);
function isFontFamily(v: string): boolean {
  const t = v.trim().toLowerCase();
  if (FONT_GENERIC.has(t)) return true;
  // Comma-separated list of font names
  if (t.includes(',') && t.split(',').some(part => FONT_GENERIC.has(part.trim().replace(/['"]/g, '')))) return true;
  return false;
}

function isShadowValue(v: string): boolean {
  const t = v.trim().toLowerCase();
  // Shadows typically have multiple px/number values + a color-like substring
  const pxMatches = t.match(/\d+(\.\d+)?px/g);
  if (pxMatches && pxMatches.length >= 2 && (isColorValue(t.replace(/[^#()\w,.\s/%]/g, '').split(/\s+/).pop() || '') || t.includes('rgb') || t.includes('hsl') || t.includes('#'))) {
    return true;
  }
  return false;
}

// --- Name-based patterns ---

const COLOR_NAME_RE = /(?:^--(color|bg|fg|accent|border-color|text-color|surface|background|foreground))|(?:-(color|bg|fg)$)/i;
const FONT_NAME_RE = /^--(font-family|font|ff|family)/i;
const TYPE_SCALE_NAME_RE = /^--(font-size|text-size|fs|text-(?:xs|sm|base|md|lg|xl|2xl|3xl|4xl|5xl))/i;
const SPACING_NAME_RE = /^--(space|gap|padding|margin|inset)/i;
const RADII_NAME_RE = /^--(radius|rounded|br|border-radius)/i;
const SHADOW_NAME_RE = /^--(shadow|elevation|drop-shadow)/i;

// --- Categorize a single variable ---

function categorize(name: string, value: string): keyof ScannedTokens {
  const n = name.toLowerCase();

  // Name-first checks for unambiguous categories
  if (SHADOW_NAME_RE.test(n)) return 'shadows';
  if (RADII_NAME_RE.test(n)) return 'radii';
  if (FONT_NAME_RE.test(n)) return 'fonts';

  // Type scale: name suggests size AND value is a length
  if (TYPE_SCALE_NAME_RE.test(n) && isCssLength(value)) return 'typeScale';

  // Colors: name match OR value is a color
  if (COLOR_NAME_RE.test(n)) return 'colors';
  if (isColorValue(value)) return 'colors';

  // Fonts by value
  if (isFontFamily(value)) return 'fonts';

  // Shadows by value
  if (isShadowValue(value)) return 'shadows';

  // Spacing: name match, or unmatched CSS lengths
  if (SPACING_NAME_RE.test(n) && isCssLength(value)) return 'spacing';
  if (isCssLength(value)) return 'spacing';

  return 'other';
}

// --- Stylesheet iteration ---

function scanRulesForVars(
  rules: CSSRuleList | undefined,
  rootStyles: CSSStyleDeclaration,
  seen: Set<string>,
  result: ScannedTokens,
): void {
  if (!rules) return;
  for (const rule of rules) {
    if (rule instanceof CSSGroupingRule) {
      scanRulesForVars(rule.cssRules, rootStyles, seen, result);
      continue;
    }
    if (rule instanceof CSSStyleRule) {
      const sel = rule.selectorText.toLowerCase();
      if (sel === ':root' || sel === 'html' || sel === '*' || sel.includes(':root')) {
        extractVars(rule.style, rootStyles, seen, result);
      }
    }
  }
}

const VAR_REF_RE = /var\((--[^,)]+)/;

function extractVars(
  style: CSSStyleDeclaration,
  rootStyles: CSSStyleDeclaration,
  seen: Set<string>,
  result: ScannedTokens,
): void {
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    if (!prop?.startsWith('--')) continue;
    if (seen.has(prop)) continue;
    seen.add(prop);
    const value = rootStyles.getPropertyValue(prop).trim();
    if (!value) continue;
    const cat = categorize(prop, value);
    result[cat].push([prop, value]);
    // Check raw authored value for var() references
    const raw = style.getPropertyValue(prop).trim();
    const ref = raw.match(VAR_REF_RE);
    if (ref) result.references[prop] = ref[1]!;
  }
}

// --- Sorting ---

/** Extract leading number from a CSS value ("1.5rem" → 1.5, "400" → 400) */
function numericValue(v: string): number | null {
  const m = v.trim().match(/^(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]!) : null;
}

/** Approximate perceptual lightness [0..1] from a resolved color value.
 *  0 = black, 1 = white. Returns null if unparseable. */
export function perceivedLightness(v: string): number | null {
  const t = v.trim().toLowerCase();

  // oklch(L C H) — L is already 0..1 lightness
  const oklch = t.match(/oklch\(\s*([\d.]+%?)/);
  if (oklch) {
    const l = oklch[1]!;
    return l.endsWith('%') ? parseFloat(l) / 100 : parseFloat(l);
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgb = t.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgb) {
    const [r, g, b] = [parseInt(rgb[1]!, 10), parseInt(rgb[2]!, 10), parseInt(rgb[3]!, 10)];
    // Relative luminance (simplified sRGB)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  // hsl(h, s%, l%) — L is lightness
  const hsl = t.match(/hsla?\(\s*[\d.]+[,\s]+[\d.]+%?[,\s]+([\d.]+)%?/);
  if (hsl) return parseFloat(hsl[1]!) / 100;

  // Hex
  if (t.startsWith('#')) {
    let hex = t.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = hex[0]! + hex[0]! + hex[1]! + hex[1]! + hex[2]! + hex[2]!;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (!isNaN(r)) return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  return null;
}

/** Per-category comparator: numeric ascending for scales, dark→light for colors */
function sortForCategory(cat: keyof ScannedTokens): (a: [string, string], b: [string, string]) => number {
  if (cat === 'colors') {
    return (a, b) => {
      const la = perceivedLightness(a[1]);
      const lb = perceivedLightness(b[1]);
      if (la !== null && lb !== null) return la - lb;
      // Fall back to name
      return a[0].localeCompare(b[0]);
    };
  }
  if (cat === 'typeScale' || cat === 'spacing' || cat === 'radii') {
    return (a, b) => {
      const na = numericValue(a[1]);
      const nb = numericValue(b[1]);
      if (na !== null && nb !== null) return na - nb;
      return a[0].localeCompare(b[0]);
    };
  }
  // "other" — try numeric (catches font-weights), fall back to name
  if (cat === 'other') {
    return (a, b) => {
      const na = numericValue(a[1]);
      const nb = numericValue(b[1]);
      if (na !== null && nb !== null) return na - nb;
      return a[0].localeCompare(b[0]);
    };
  }
  // fonts, shadows — alphabetical by name
  return (a, b) => a[0].localeCompare(b[0]);
}

/** Extract the namespace prefix from a color var name.
 *  e.g. "--color-red-500" → "red", "--sidebar-primary" → "sidebar", "--muted" → "muted"
 *  Strips leading "--" and common prefixes like "color-", then drops the trailing numeric segment. */
export function colorNamespace(varName: string): string {
  let n = varName.replace(/^--/, '');
  // Strip common prefixes
  n = n.replace(/^(?:color|clr)-/, '');
  // Split on hyphens, drop trailing segment if it looks numeric (50, 100, 500, etc.)
  const parts = n.split('-');
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1]!)) {
    parts.pop();
  }
  return parts.join('-');
}

/** Group flat color entries into namespace rows, each sorted dark→light.
 *  Returns [namespace, entries[]][] with namespaces ordered by darkest member. */
export function groupColorsByNamespace(colors: [string, string][]): [string, [string, string][]][] {
  const map = new Map<string, [string, string][]>();
  for (const entry of colors) {
    const ns = colorNamespace(entry[0]);
    let group = map.get(ns);
    if (!group) { group = []; map.set(ns, group); }
    group.push(entry);
  }
  // Sort within each group: dark → light
  const cmp = sortForCategory('colors');
  for (const group of map.values()) {
    group.sort(cmp);
  }
  // Sort groups by their darkest (first) member's lightness
  const groups = [...map.entries()];
  groups.sort((a, b) => {
    const la = perceivedLightness(a[1][0]![1]) ?? 0;
    const lb = perceivedLightness(b[1][0]![1]) ?? 0;
    return la - lb;
  });
  return groups;
}

const SORTABLE_CATEGORIES: Exclude<keyof ScannedTokens, 'references'>[] = ['colors', 'fonts', 'typeScale', 'spacing', 'radii', 'shadows', 'other'];

// --- Cache ---

let _cache: { tokens: ScannedTokens; timestamp: number } | null = null;
const CACHE_TTL = 5000;

export function scanRootTokens(): ScannedTokens {
  if (typeof document === 'undefined') return EMPTY;
  if (_cache && Date.now() - _cache.timestamp < CACHE_TTL) return _cache.tokens;

  const result: ScannedTokens = { colors: [], fonts: [], typeScale: [], spacing: [], radii: [], shadows: [], other: [], references: {} };
  const seen = new Set<string>();
  const rootStyles = getComputedStyle(document.documentElement);

  // Scan stylesheets
  try {
    for (const sheet of document.styleSheets) {
      try {
        scanRulesForVars(sheet.cssRules || sheet.rules, rootStyles, seen, result);
      } catch {
        // Cross-origin stylesheet
      }
    }
  } catch {
    // Stylesheets not accessible
  }

  // Inline styles on <html>
  const htmlStyle = document.documentElement.style;
  for (let i = 0; i < htmlStyle.length; i++) {
    const prop = htmlStyle[i];
    if (!prop?.startsWith('--') || seen.has(prop)) continue;
    seen.add(prop);
    const value = rootStyles.getPropertyValue(prop).trim();
    if (!value) continue;
    const cat = categorize(prop, value);
    result[cat].push([prop, value]);
    const raw = htmlStyle.getPropertyValue(prop).trim();
    const ref = raw.match(VAR_REF_RE);
    if (ref) result.references[prop] = ref[1]!;
  }

  // Sort each category by value (scales: small→large, colors: dark→light)
  for (const cat of SORTABLE_CATEGORIES) {
    result[cat].sort(sortForCategory(cat));
  }

  _cache = { tokens: result, timestamp: Date.now() };
  return result;
}
