import type { Point } from './types';

export function drawFreehand(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  strokeWidth: number
): void {
  if (points.length < 2) return;

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return;

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.moveTo(first.x, first.y);

  // Use quadratic curves for smooth lines
  for (let i = 1; i < points.length - 1; i++) {
    const current = points[i];
    const next = points[i + 1];
    if (!current || !next) continue;

    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    ctx.quadraticCurveTo(current.x, current.y, midX, midY);
  }

  // Draw to the last point
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}
