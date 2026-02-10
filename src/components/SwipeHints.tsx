'use client';

import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useState } from 'react';

type SwipeHintsProps = {
  element: HTMLElement;
  modifier: 'shift' | 'alt';
  accentColor: string;
  refreshKey?: number;
};

const JUSTIFY_STEPS = ['flex-start', 'center', 'flex-end'] as const;
const ALIGN_STEPS = ['flex-start', 'center', 'flex-end'] as const;

function normalizeJustify(value: string): typeof JUSTIFY_STEPS[number] | null {
  if (value === 'normal' || value === 'flex-start' || value === 'start') return 'flex-start';
  if (value === 'flex-end' || value === 'end') return 'flex-end';
  if (value === 'center') return 'center';
  return null;
}

function normalizeAlign(value: string): typeof ALIGN_STEPS[number] | null {
  if (value === 'normal' || value === 'stretch' || value === 'flex-start' || value === 'start') return 'flex-start';
  if (value === 'flex-end' || value === 'end') return 'flex-end';
  if (value === 'center') return 'center';
  return null;
}

type ArrowDir = 'left' | 'right' | 'up' | 'down';

function getChildrenBounds(el: HTMLElement): DOMRect | null {
  const children = Array.from(el.children) as HTMLElement[];
  if (children.length === 0) return null;
  let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
  for (const child of children) {
    const r = child.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.top < top) top = r.top;
    if (r.left < left) left = r.left;
    if (r.bottom > bottom) bottom = r.bottom;
    if (r.right > right) right = r.right;
  }
  if (top === Infinity) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

export function SwipeHints({ element, modifier, accentColor, refreshKey = 0 }: SwipeHintsProps) {
  const [childBounds, setChildBounds] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!element) { setChildBounds(null); return; }
    const update = () => setChildBounds(getChildrenBounds(element));
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    return () => { window.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [element]);

  useLayoutEffect(() => {
    if (element) setChildBounds(getChildrenBounds(element));
  }, [element, refreshKey]);

  if (!childBounds) return null;
  const bounds = childBounds;

  const cs = window.getComputedStyle(element);
  const d = cs.display;
  if (d !== 'flex' && d !== 'inline-flex') return null;

  const fd = cs.flexDirection;
  const mainAxis: 'horizontal' | 'vertical' = (fd === 'column' || fd === 'column-reverse') ? 'vertical' : 'horizontal';
  const crossAxis: 'horizontal' | 'vertical' = mainAxis === 'horizontal' ? 'vertical' : 'horizontal';

  const arrows: ArrowDir[] = [];

  if (modifier === 'shift') {
    // Shift: justify-content cycling along main axis only
    const jc = normalizeJustify(cs.justifyContent);
    if (jc) {
      const idx = JUSTIFY_STEPS.indexOf(jc);
      if (mainAxis === 'horizontal') {
        if (idx > 0) arrows.push('left');
        if (idx < JUSTIFY_STEPS.length - 1) arrows.push('right');
      } else {
        if (idx > 0) arrows.push('up');
        if (idx < JUSTIFY_STEPS.length - 1) arrows.push('down');
      }
    }
  } else {
    // Alt: align-items cycling along cross axis only
    const ai = normalizeAlign(cs.alignItems);
    if (ai) {
      const idx = ALIGN_STEPS.indexOf(ai);
      if (crossAxis === 'horizontal') {
        if (idx > 0) arrows.push('left');
        if (idx < ALIGN_STEPS.length - 1) arrows.push('right');
      } else {
        if (idx > 0) arrows.push('up');
        if (idx < ALIGN_STEPS.length - 1) arrows.push('down');
      }
    }
  }

  if (arrows.length === 0) return null;

  const GAP = 14; // distance from container edge to arrow center
  const S = 7; // half-size of arrow icon

  return (
    <>
      {arrows.map((dir) => {
        let cx: number, cy: number;
        switch (dir) {
          case 'right':
            cx = bounds.right + GAP;
            cy = bounds.top + bounds.height / 2;
            break;
          case 'left':
            cx = bounds.left - GAP;
            cy = bounds.top + bounds.height / 2;
            break;
          case 'down':
            cx = bounds.left + bounds.width / 2;
            cy = bounds.bottom + GAP;
            break;
          case 'up':
            cx = bounds.left + bounds.width / 2;
            cy = bounds.top - GAP;
            break;
        }

        // Arrow path points right by default; rotated per direction
        const rotation = dir === 'right' ? 0 : dir === 'left' ? 180 : dir === 'down' ? 90 : -90;

        const style: CSSProperties = {
          position: 'fixed',
          left: cx - S,
          top: cy - S,
          width: S * 2,
          height: S * 2,
          pointerEvents: 'none',
          zIndex: 9997,
        };

        return (
          <div key={dir} data-devtools="swipe-hint" style={style}>
            <svg width={S * 2} height={S * 2} viewBox="-7 -7 14 14" style={{ overflow: 'visible' }}>
              <g transform={`rotate(${rotation})`}>
                {/* White outer border */}
                <line x1="-5" y1="0" x2="3" y2="0" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
                <polyline points="0,-4 5,0 0,4" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                {/* Arrow: shaft + chevron head */}
                <line x1="-5" y1="0" x2="3" y2="0" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round" />
                <polyline points="0,-4 5,0 0,4" fill="none" stroke={accentColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </g>
            </svg>
          </div>
        );
      })}
    </>
  );
}
