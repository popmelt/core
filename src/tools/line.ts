import type { Point } from './types';

export function drawLine(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  strokeWidth: number
): void {
  if (points.length < 2) return;

  const start = points[0];
  const end = points[points.length - 1];
  if (!start || !end) return;

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';

  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}
