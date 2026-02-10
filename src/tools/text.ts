import type { Point } from './types';

const PADDING = 4;
const LINE_HEIGHT = 1.4;
const FONT_FAMILY = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const MAX_DISPLAY_WIDTH = 400;

export function drawText(
  ctx: CanvasRenderingContext2D,
  point: Point,
  text: string,
  color: string,
  fontSize: number = 12,
  groupNumber?: number
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

  // Measure text for background, capping display width to avoid huge banners
  const rawWidths = displayLines.map((line) => ctx.measureText(line).width);
  const maxWidth = Math.min(MAX_DISPLAY_WIDTH, Math.max(...rawWidths));
  const totalHeight = displayLines.length * lineHeightPx;

  // Truncate lines that exceed max display width
  const truncatedLines = displayLines.map((line, i) => {
    if (rawWidths[i]! <= MAX_DISPLAY_WIDTH) return line;
    let lo = 0, hi = line.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(line.slice(0, mid) + '\u2026').width <= MAX_DISPLAY_WIDTH) lo = mid;
      else hi = mid - 1;
    }
    return line.slice(0, lo) + '\u2026';
  });

  // Draw background
  ctx.fillStyle = color;
  ctx.fillRect(
    point.x - PADDING,
    point.y - PADDING,
    maxWidth + PADDING * 2,
    totalHeight + PADDING * 2
  );

  // Draw text (white) - use middle baseline and center within each line
  ctx.fillStyle = '#ffffff';
  truncatedLines.forEach((line, i) => {
    ctx.fillText(line, point.x, point.y + i * lineHeightPx + lineHeightPx / 2);
  });
}

export { PADDING, LINE_HEIGHT, FONT_FAMILY, MAX_DISPLAY_WIDTH };
