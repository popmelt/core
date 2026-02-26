import type { Point } from './types';

const PADDING = 4;
const LINE_HEIGHT = 1.4;
const FONT_FAMILY = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const MAX_DISPLAY_WIDTH = 400;
const VIEWPORT_MARGIN = 16;
const MIN_WRAP_WIDTH = 60;

/**
 * Word-wrap a single line to fit within maxWidth.
 * Splits on whitespace boundaries; falls back to character-level break for
 * single words wider than the limit.
 */
function wrapLine(ctx: CanvasRenderingContext2D, line: string, maxWidth: number): string[] {
  if (!line || ctx.measureText(line).width <= maxWidth) return [line];

  const words = line.split(/\s+/);
  const wrapped: string[] = [];
  let current = '';

  for (const word of words) {
    const test = current ? current + ' ' + word : word;
    if (current && ctx.measureText(test).width > maxWidth) {
      wrapped.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) wrapped.push(current);

  return wrapped.length > 0 ? wrapped : [line];
}

/**
 * Compute the effective max width for a text annotation given its viewport X.
 * Returns undefined when no constraint is needed.
 */
export function getEffectiveMaxWidth(viewportX: number): number | undefined {
  const rightSpace = window.innerWidth - viewportX - VIEWPORT_MARGIN;
  if (rightSpace < MAX_DISPLAY_WIDTH) {
    return Math.max(MIN_WRAP_WIDTH, rightSpace);
  }
  return undefined;
}

/**
 * Word-wrap text lines to fit within a constrained width. Exported so
 * getTextDimensions can reuse the same logic for textarea sizing.
 */
export function wrapLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  maxWidth: number,
): string[] {
  const result: string[] = [];
  for (const line of lines) {
    result.push(...wrapLine(ctx, line, maxWidth));
  }
  return result;
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  point: Point,
  text: string,
  color: string,
  fontSize: number = 12,
  groupNumber?: number,
  /** Viewport-relative X of the text origin — enables right-edge wrapping */
  viewportX?: number,
): void {
  if (!text) return;

  const lineHeightPx = fontSize * LINE_HEIGHT;
  const lines = text.split('\n');

  // Prepend group number to first line if provided
  const displayLines = groupNumber !== undefined
    ? [groupNumber + '. ' + (lines[0] || ''), ...lines.slice(1)]
    : lines;

  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';

  // Effective width cap: viewport-aware when near right edge
  const effectiveMax = viewportX !== undefined
    ? Math.min(MAX_DISPLAY_WIDTH, Math.max(MIN_WRAP_WIDTH, window.innerWidth - viewportX - VIEWPORT_MARGIN))
    : MAX_DISPLAY_WIDTH;

  // Word-wrap lines that exceed the effective max width
  const wrappedLines = wrapLines(ctx, displayLines, effectiveMax);
  const maxWidth = Math.min(effectiveMax, Math.max(...wrappedLines.map(l => ctx.measureText(l).width)));
  const wrappedHeight = wrappedLines.length * lineHeightPx;
  const originalHeight = displayLines.length * lineHeightPx;

  // Shift upward so the bottom edge stays in place when wrapping adds lines
  const yShift = wrappedHeight - originalHeight;
  const drawY = point.y - yShift;

  // Draw background
  ctx.fillStyle = color;
  ctx.fillRect(
    point.x - PADDING,
    drawY - PADDING,
    maxWidth + PADDING * 2,
    wrappedHeight + PADDING * 2
  );

  // Draw text (white) - use middle baseline and center within each line
  ctx.fillStyle = '#ffffff';
  wrappedLines.forEach((line, i) => {
    ctx.fillText(line, point.x, drawY + i * lineHeightPx + lineHeightPx / 2);
  });
}

export { PADDING, LINE_HEIGHT, FONT_FAMILY, MAX_DISPLAY_WIDTH, VIEWPORT_MARGIN };
