// --- Unit-aware input support ---
// Supported CSS units per property (first entry is the default for new edits)
export const PROPERTY_UNITS: Record<string, string[]> = {
  'font-size': ['rem', 'px', 'em'],
  'line-height': ['', 'rem', 'px', 'em'],
  'letter-spacing': ['rem', 'px', 'em'],
  'gap': ['rem', 'px', 'em'],
  'column-gap': ['rem', 'px', 'em'],
  'row-gap': ['rem', 'px', 'em'],
  'padding': ['rem', 'px', 'em', '%'],
  'margin': ['rem', 'px', 'em', '%'],
  'width': ['rem', 'px', '%', 'em'],
  'height': ['rem', 'px', '%', 'em'],
  'min-width': ['rem', 'px', '%', 'em'],
  'max-width': ['rem', 'px', '%', 'em'],
  'min-height': ['rem', 'px', '%', 'em'],
  'max-height': ['rem', 'px', '%', 'em'],
  'border-width': ['px', 'rem', 'em'],
  'border-radius': ['rem', 'px', '%', 'em'],
};

export function getDefaultUnit(property: string): string {
  return PROPERTY_UNITS[property]?.[0] ?? 'px';
}

// Parse a CSS value to extract number and unit
export function parseValue(value: string): { num: number; unit: string } {
  const match = value.match(/^([\d.-]+)(.*)$/);
  if (match) {
    return { num: parseFloat(match[1]!), unit: match[2] || '' };
  }
  return { num: 0, unit: '' };
}

// Resolve user input to a full CSS value, inferring unit from typed suffix or falling back
export function resolveUnitValue(input: string, property: string, currentValue: string, isModified: boolean): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  // Check for explicit unit in input
  const unitMatch = trimmed.match(/^(-?[\d.]+)\s*(rem|em|px|%)$/i);
  if (unitMatch) {
    return `${parseFloat(unitMatch[1]!)}${unitMatch[2]!.toLowerCase()}`;
  }

  // Bare number - determine unit
  const num = parseFloat(trimmed);
  if (!isNaN(num)) {
    if (isModified) {
      // Preserve the unit from the current modified value
      const { unit } = parseValue(currentValue);
      return `${num}${unit || getDefaultUnit(property)}`;
    }
    // First edit - use default unit for this property
    return `${num}${getDefaultUnit(property)}`;
  }

  // Pass through keywords (auto, none, etc.)
  return trimmed;
}

// Convert a px value to the target unit
export function convertFromPx(px: number, targetUnit: string): number {
  if (!targetUnit || targetUnit === 'px') return px;
  if (targetUnit === 'rem') {
    const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return Math.round((px / rootFontSize) * 1000) / 1000;
  }
  // em/% are context-dependent, can't convert generically — show px value as-is
  return px;
}
