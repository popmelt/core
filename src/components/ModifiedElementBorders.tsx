'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';

import type { StyleModification } from '../tools/types';
import { findElementBySelector, getComputedBorderRadius } from '../utils/dom';

// Convert color to oklch/rgba with alpha
function colorWithAlpha(color: string, alpha: number): string {
  const oklchMatch = color.match(/^oklch\(([^)]+)\)$/i);
  if (oklchMatch) {
    return `oklch(${oklchMatch[1]} / ${alpha})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

type ModifiedElementBordersProps = {
  styleModifications: StyleModification[];
  accentColor: string;
};

type BorderData = {
  selector: string;
  top: number;
  left: number;
  width: number;
  height: number;
  borderRadius: string;
};

export function ModifiedElementBorders({ styleModifications, accentColor }: ModifiedElementBordersProps) {
  const [borders, setBorders] = useState<BorderData[]>([]);

  useEffect(() => {
    let rafId: number | null = null;

    const update = () => {
      const result: BorderData[] = [];
      for (const mod of styleModifications) {
        const el = findElementBySelector(mod.selector);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const br = getComputedBorderRadius(el);
        result.push({
          selector: mod.selector,
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          borderRadius: `${br['top-left']}px ${br['top-right']}px ${br['bottom-right']}px ${br['bottom-left']}px`,
        });
      }
      setBorders(result);
    };

    const schedule = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(update);
    };

    update();

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['style', 'class'],
    });

    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [styleModifications]);

  if (borders.length === 0) return null;

  const borderColor = colorWithAlpha(accentColor, 0.2);

  return (
    <>
      {borders.map((b) => {
        const style: CSSProperties = {
          position: 'fixed',
          top: b.top,
          left: b.left,
          width: b.width,
          height: b.height,
          pointerEvents: 'none',
          zIndex: 9995,
          border: `1px solid ${borderColor}`,
          borderRadius: b.borderRadius,
          boxSizing: 'border-box',
        };
        return <div key={b.selector} data-devtools="mod-border" style={style} />;
      })}
    </>
  );
}
