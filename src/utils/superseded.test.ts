import { describe, expect, it } from 'vitest';

import type { Annotation } from '../tools/types';
import { computeSupersededAnnotations } from './superseded';

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-' + Math.random().toString(36).slice(2, 7),
    type: 'freehand',
    points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
    color: '#ff0000',
    strokeWidth: 3,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('computeSupersededAnnotations', () => {
  it('returns empty set for empty annotations', () => {
    const result = computeSupersededAnnotations([]);
    expect(result.size).toBe(0);
  });

  it('returns empty set when no annotations have linkedSelector', () => {
    const a = makeAnnotation();
    const b = makeAnnotation();
    const result = computeSupersededAnnotations([a, b]);
    expect(result.size).toBe(0);
  });

  it('returns empty set for single annotation per selector', () => {
    const a = makeAnnotation({ linkedSelector: 'div.card' });
    const result = computeSupersededAnnotations([a]);
    expect(result.size).toBe(0);
  });

  it('supersedes older annotation, keeps newer', () => {
    const older = makeAnnotation({ linkedSelector: 'div.card', timestamp: 1000 });
    const newer = makeAnnotation({ linkedSelector: 'div.card', timestamp: 2000 });
    const result = computeSupersededAnnotations([older, newer]);
    expect(result.size).toBe(1);
    expect(result.has(older)).toBe(true);
    expect(result.has(newer)).toBe(false);
  });

  it('supersedes two oldest when 3 annotations share same selector', () => {
    const a = makeAnnotation({ linkedSelector: 'div.card', timestamp: 1000 });
    const b = makeAnnotation({ linkedSelector: 'div.card', timestamp: 2000 });
    const c = makeAnnotation({ linkedSelector: 'div.card', timestamp: 3000 });
    const result = computeSupersededAnnotations([a, b, c]);
    expect(result.size).toBe(2);
    expect(result.has(a)).toBe(true);
    expect(result.has(b)).toBe(true);
    expect(result.has(c)).toBe(false);
  });

  it('supersedes group mates of superseded annotation', () => {
    const rect = makeAnnotation({ linkedSelector: 'div.card', timestamp: 1000, groupId: 'g1', type: 'rectangle' });
    const text = makeAnnotation({ groupId: 'g1', type: 'text', text: 'old note' });
    const newer = makeAnnotation({ linkedSelector: 'div.card', timestamp: 2000 });
    const result = computeSupersededAnnotations([rect, text, newer]);
    expect(result.has(rect)).toBe(true);
    expect(result.has(text)).toBe(true);
    expect(result.has(newer)).toBe(false);
  });

  it('does NOT supersede group mates of kept annotation', () => {
    const older = makeAnnotation({ linkedSelector: 'div.card', timestamp: 1000 });
    const keptRect = makeAnnotation({ linkedSelector: 'div.card', timestamp: 2000, groupId: 'g2', type: 'rectangle' });
    const keptText = makeAnnotation({ groupId: 'g2', type: 'text', text: 'kept note' });
    const result = computeSupersededAnnotations([older, keptRect, keptText]);
    expect(result.has(older)).toBe(true);
    expect(result.has(keptRect)).toBe(false);
    expect(result.has(keptText)).toBe(false);
  });

  it('duplicate IDs: only the actual superseded object is in the set (regression)', () => {
    const a = makeAnnotation({ id: 'same-id', linkedSelector: 'div.card', timestamp: 1000 });
    const b = makeAnnotation({ id: 'same-id', linkedSelector: 'div.card', timestamp: 2000 });
    const result = computeSupersededAnnotations([a, b]);
    // Object-reference check: a is superseded, b is not
    expect(result.has(a)).toBe(true);
    expect(result.has(b)).toBe(false);
  });

  it('handles mixed linked and unlinked annotations', () => {
    const linked1 = makeAnnotation({ linkedSelector: 'div.card', timestamp: 1000 });
    const linked2 = makeAnnotation({ linkedSelector: 'div.card', timestamp: 2000 });
    const unlinked = makeAnnotation({ timestamp: 1500 });
    const result = computeSupersededAnnotations([linked1, linked2, unlinked]);
    expect(result.size).toBe(1);
    expect(result.has(linked1)).toBe(true);
    expect(result.has(linked2)).toBe(false);
    expect(result.has(unlinked)).toBe(false);
  });

  it('different selectors are independent', () => {
    const a1 = makeAnnotation({ linkedSelector: 'div.a', timestamp: 1000 });
    const a2 = makeAnnotation({ linkedSelector: 'div.a', timestamp: 2000 });
    const b1 = makeAnnotation({ linkedSelector: 'div.b', timestamp: 1000 });
    const b2 = makeAnnotation({ linkedSelector: 'div.b', timestamp: 2000 });
    const result = computeSupersededAnnotations([a1, a2, b1, b2]);
    expect(result.size).toBe(2);
    expect(result.has(a1)).toBe(true);
    expect(result.has(b1)).toBe(true);
    expect(result.has(a2)).toBe(false);
    expect(result.has(b2)).toBe(false);
  });
});
