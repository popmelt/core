import { describe, expect, it } from 'vitest';

import { angle, distance, getBounds, midpoint } from './geometry';

describe('distance', () => {
  it('returns 0 for the same point', () => {
    expect(distance({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });

  it('computes 3-4-5 triangle hypotenuse', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('handles negative coordinates', () => {
    expect(distance({ x: -3, y: -4 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('midpoint', () => {
  it('returns midpoint of two integer coords', () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 10 })).toEqual({ x: 5, y: 5 });
  });

  it('returns midpoint with float coords', () => {
    expect(midpoint({ x: 1, y: 3 }, { x: 4, y: 8 })).toEqual({ x: 2.5, y: 5.5 });
  });

  it('handles negative coords', () => {
    expect(midpoint({ x: -10, y: -10 }, { x: 10, y: 10 })).toEqual({ x: 0, y: 0 });
  });
});

describe('angle', () => {
  it('returns 0 for horizontal rightward', () => {
    expect(angle({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
  });

  it('returns PI/2 for vertical downward', () => {
    expect(angle({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(Math.PI / 2);
  });

  it('returns PI/4 for diagonal', () => {
    expect(angle({ x: 0, y: 0 }, { x: 10, y: 10 })).toBeCloseTo(Math.PI / 4);
  });

  it('returns negative for upward angle', () => {
    expect(angle({ x: 0, y: 0 }, { x: 10, y: -10 })).toBeCloseTo(-Math.PI / 4);
  });
});

describe('getBounds', () => {
  it('returns zeroes for empty array', () => {
    expect(getBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('returns zero-size bounds for single point', () => {
    expect(getBounds([{ x: 5, y: 10 }])).toEqual({ x: 5, y: 10, width: 0, height: 0 });
  });

  it('computes bounds for multiple points', () => {
    const points = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 5, y: 15 },
    ];
    expect(getBounds(points)).toEqual({ x: 5, y: 15, width: 25, height: 25 });
  });

  it('handles negative coordinates', () => {
    const points = [
      { x: -10, y: -5 },
      { x: 10, y: 5 },
    ];
    expect(getBounds(points)).toEqual({ x: -10, y: -5, width: 20, height: 10 });
  });
});
