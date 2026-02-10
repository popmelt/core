'use client';

import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useState } from 'react';

import type { BorderRadiusCorner } from '../utils/dom';

type BorderRadiusHandlesProps = {
  element: Element;
  radius: Record<BorderRadiusCorner, number>;
  accentColor: string;
  hoveredCorner: BorderRadiusCorner | null;
  draggingCorner: BorderRadiusCorner | null;
  cursorViewport?: { x: number; y: number };
};

function colorWithAlpha(color: string, alpha: number): string {
  const oklchMatch = color.match(/^oklch\(([^)]+)\)$/i);
  if (oklchMatch) {
    return `oklch(${oklchMatch[1]} / ${alpha})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

const ALL_CORNERS: BorderRadiusCorner[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

export function BorderRadiusHandles({ element, radius, accentColor, hoveredCorner, draggingCorner, cursorViewport }: BorderRadiusHandlesProps) {
  const [bounds, setBounds] = useState<DOMRect | null>(null);
  const [cmdHeld, setCmdHeld] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') setCmdHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') setCmdHeld(false);
    };
    const blur = () => setCmdHeld(false);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useEffect(() => {
    if (!element) {
      setBounds(null);
      return;
    }

    const updateBounds = () => {
      setBounds(element.getBoundingClientRect());
    };

    updateBounds();

    window.addEventListener('scroll', updateBounds, { passive: true });
    window.addEventListener('resize', updateBounds, { passive: true });

    return () => {
      window.removeEventListener('scroll', updateBounds);
      window.removeEventListener('resize', updateBounds);
    };
  }, [element]);

  // Re-read bounds synchronously before paint when radius changes (element reflows during drag)
  useLayoutEffect(() => {
    if (element) {
      setBounds(element.getBoundingClientRect());
    }
  }, [element, radius['top-left'], radius['top-right'], radius['bottom-right'], radius['bottom-left']]);

  if (!bounds) return null;

  const W = bounds.width;
  const H = bounds.height;

  const borderColor = colorWithAlpha(accentColor, 0.2);

  const cornerPositions: Record<BorderRadiusCorner, { x: number; y: number }> = {
    'top-left': { x: 0, y: radius['top-left'] },
    'top-right': { x: W, y: radius['top-right'] },
    'bottom-right': { x: W, y: H - radius['bottom-right'] },
    'bottom-left': { x: 0, y: H - radius['bottom-left'] },
  };

  // Determine which corners are active (highlighted)
  const activeCorners = new Set<BorderRadiusCorner>();
  const activeCorner = draggingCorner ?? hoveredCorner;
  if (activeCorner) {
    if (cmdHeld) {
      activeCorners.add(activeCorner);
    } else {
      for (const c of ALL_CORNERS) activeCorners.add(c);
    }
  }

  const containerStyle: CSSProperties = {
    position: 'fixed',
    top: bounds.top,
    left: bounds.left,
    width: W,
    height: H,
    pointerEvents: 'none',
    zIndex: 9996,
    overflow: 'visible',
  };

  return (
    <div data-devtools="border-radius-handles" style={containerStyle}>
      <svg
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}
        viewBox={`0 0 ${W} ${H}`}
      >
        {/* Element outline */}
        <rect
          x="0.5"
          y="0.5"
          width={Math.max(0, W - 1)}
          height={Math.max(0, H - 1)}
          fill="none"
          stroke={borderColor}
          strokeWidth="1"
        />

        {/* Corner circle handles */}
        {ALL_CORNERS.map(corner => {
          const pos = cornerPositions[corner];
          const isActive = activeCorners.has(corner);
          return (
            <circle
              key={corner}
              cx={pos.x}
              cy={pos.y}
              r={corner === (draggingCorner ?? hoveredCorner) ? 3 : 2.5}
              fill={accentColor}
              stroke="#ffffff"
              strokeWidth={corner === (draggingCorner ?? hoveredCorner) ? 4 : 2}
              paintOrder="stroke"
            />
          );
        })}
      </svg>

      {/* Value badge near cursor */}
      {cursorViewport && activeCorner && (() => {
        const value = Math.round(radius[activeCorner]);
        return (
          <div
            style={{
              position: 'fixed',
              left: cursorViewport.x + 8,
              top: cursorViewport.y - 28,
              background: accentColor,
              color: '#fff',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
              lineHeight: 1,
              padding: '4px 4px',
              borderRadius: 0,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 9997,
            }}
          >
            {value}
          </div>
        );
      })()}
    </div>
  );
}
