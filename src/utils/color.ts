// Convert color to rgba/oklch with alpha
export function colorWithAlpha(color: string, alpha: number): string {
  // Handle OKLCH colors: oklch(L C H) -> oklch(L C H / alpha)
  const oklchMatch = color.match(/^oklch\(([^)]+)\)$/i);
  if (oklchMatch) {
    return `oklch(${oklchMatch[1]} / ${alpha})`;
  }

  // Handle hex colors
  const hexResult = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  if (hexResult) {
    const r = parseInt(hexResult[1]!, 16);
    const g = parseInt(hexResult[2]!, 16);
    const b = parseInt(hexResult[3]!, 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Handle rgb/rgba - just use color-mix
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

// Convert RGB/RGBA to hex
export function rgbToHex(color: string): string {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    const r = parseInt(match[1]!, 10).toString(16).padStart(2, '0');
    const g = parseInt(match[2]!, 10).toString(16).padStart(2, '0');
    const b = parseInt(match[3]!, 10).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return color;
}
