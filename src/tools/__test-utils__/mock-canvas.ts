import { vi } from 'vitest';

export function createMockCanvasContext() {
  const ctx = {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    strokeRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    ellipse: vi.fn(),
    quadraticCurveTo: vi.fn(),
    measureText: vi.fn(() => ({ width: 50 })),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    font: '',
    textBaseline: 'alphabetic' as CanvasTextBaseline,
  };
  return ctx as unknown as CanvasRenderingContext2D & {
    beginPath: ReturnType<typeof vi.fn>;
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
    fill: ReturnType<typeof vi.fn>;
    closePath: ReturnType<typeof vi.fn>;
    strokeRect: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>;
    fillText: ReturnType<typeof vi.fn>;
    ellipse: ReturnType<typeof vi.fn>;
    quadraticCurveTo: ReturnType<typeof vi.fn>;
    measureText: ReturnType<typeof vi.fn>;
  };
}
