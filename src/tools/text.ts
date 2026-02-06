import type { Point } from './types';

const PADDING = 4;
const LINE_HEIGHT = 1.4;
const FONT_FAMILY = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

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

  // Measure text for background
  const maxWidth = Math.max(...displayLines.map((line) => ctx.measureText(line).width));
  const totalHeight = displayLines.length * lineHeightPx;

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
  displayLines.forEach((line, i) => {
    ctx.fillText(line, point.x, point.y + i * lineHeightPx + lineHeightPx / 2);
  });
}

export { PADDING, LINE_HEIGHT, FONT_FAMILY };
