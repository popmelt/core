import { describe, expect, it } from 'vitest';

import { createMockCanvasContext } from './__test-utils__/mock-canvas';
import { drawArrow } from './arrow';
import { drawCircle } from './circle';
import { drawFreehand } from './freehand';
import { drawLine } from './line';
import { drawRectangle } from './rectangle';
import { drawText } from './text';

describe('drawRectangle', () => {
  it('returns early with <2 points', () => {
    const ctx = createMockCanvasContext();
    drawRectangle(ctx, [{ x: 0, y: 0 }], '#ff0000', 2);
    expect(ctx.strokeRect).not.toHaveBeenCalled();
  });

  it('calls strokeRect with correct dimensions', () => {
    const ctx = createMockCanvasContext();
    drawRectangle(ctx, [{ x: 10, y: 20 }, { x: 50, y: 60 }], '#ff0000', 3);
    expect(ctx.strokeRect).toHaveBeenCalledWith(10, 20, 40, 40);
    expect(ctx.strokeStyle).toBe('#ff0000');
    expect(ctx.lineWidth).toBe(3);
  });

  it('handles inverted coordinates (drag up-left)', () => {
    const ctx = createMockCanvasContext();
    drawRectangle(ctx, [{ x: 50, y: 60 }, { x: 10, y: 20 }], '#ff0000', 2);
    expect(ctx.strokeRect).toHaveBeenCalledWith(10, 20, 40, 40);
  });
});

describe('drawCircle', () => {
  it('returns early with <2 points', () => {
    const ctx = createMockCanvasContext();
    drawCircle(ctx, [{ x: 0, y: 0 }], '#ff0000', 2);
    expect(ctx.ellipse).not.toHaveBeenCalled();
  });

  it('calls ellipse with center and radii', () => {
    const ctx = createMockCanvasContext();
    drawCircle(ctx, [{ x: 0, y: 0 }, { x: 100, y: 50 }], '#00ff00', 2);
    expect(ctx.ellipse).toHaveBeenCalledWith(50, 25, 50, 25, 0, 0, Math.PI * 2);
    expect(ctx.strokeStyle).toBe('#00ff00');
  });
});

describe('drawLine', () => {
  it('returns early with <2 points', () => {
    const ctx = createMockCanvasContext();
    drawLine(ctx, [{ x: 0, y: 0 }], '#ff0000', 2);
    expect(ctx.moveTo).not.toHaveBeenCalled();
  });

  it('calls moveTo and lineTo', () => {
    const ctx = createMockCanvasContext();
    drawLine(ctx, [{ x: 10, y: 20 }, { x: 30, y: 40 }], '#ff0000', 2);
    expect(ctx.moveTo).toHaveBeenCalledWith(10, 20);
    expect(ctx.lineTo).toHaveBeenCalledWith(30, 40);
    expect(ctx.stroke).toHaveBeenCalled();
  });
});

describe('drawArrow', () => {
  it('returns early with <2 points', () => {
    const ctx = createMockCanvasContext();
    drawArrow(ctx, [{ x: 0, y: 0 }], '#ff0000', 2);
    expect(ctx.moveTo).not.toHaveBeenCalled();
  });

  it('draws line and fills arrowhead triangle', () => {
    const ctx = createMockCanvasContext();
    drawArrow(ctx, [{ x: 0, y: 0 }, { x: 100, y: 0 }], '#ff0000', 3);
    // Line
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
    expect(ctx.lineTo).toHaveBeenCalledWith(100, 0);
    expect(ctx.stroke).toHaveBeenCalled();
    // Arrowhead
    expect(ctx.closePath).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.fillStyle).toBe('#ff0000');
  });
});

describe('drawFreehand', () => {
  it('returns early with <2 points', () => {
    const ctx = createMockCanvasContext();
    drawFreehand(ctx, [{ x: 0, y: 0 }], '#ff0000', 2);
    expect(ctx.moveTo).not.toHaveBeenCalled();
  });

  it('uses quadraticCurveTo for smooth curves', () => {
    const ctx = createMockCanvasContext();
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 5 },
      { x: 30, y: 15 },
    ];
    drawFreehand(ctx, points, '#ff0000', 2);
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
    expect(ctx.quadraticCurveTo).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it('draws to last point', () => {
    const ctx = createMockCanvasContext();
    drawFreehand(ctx, [{ x: 0, y: 0 }, { x: 50, y: 50 }], '#ff0000', 2);
    expect(ctx.lineTo).toHaveBeenCalledWith(50, 50);
  });
});

describe('drawText', () => {
  it('draws background rect and white text', () => {
    const ctx = createMockCanvasContext();
    drawText(ctx, { x: 10, y: 20 }, 'hello', '#ff0000', 14);
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalledWith('hello', 10, expect.any(Number));
    // Last fillStyle should be white for text
    expect(ctx.fillStyle).toBe('#ffffff');
  });

  it('prepends group number', () => {
    const ctx = createMockCanvasContext();
    drawText(ctx, { x: 10, y: 20 }, 'note', '#ff0000', 14, 3);
    expect(ctx.fillText).toHaveBeenCalledWith('3. note', 10, expect.any(Number));
  });

  it('handles multi-line text', () => {
    const ctx = createMockCanvasContext();
    drawText(ctx, { x: 10, y: 20 }, 'line1\nline2', '#ff0000', 14);
    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });

  it('returns early for empty text', () => {
    const ctx = createMockCanvasContext();
    drawText(ctx, { x: 10, y: 20 }, '', '#ff0000', 14);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});
