'use client';

import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useState } from 'react';

export type PaddingSide = 'top' | 'right' | 'bottom' | 'left';

type PaddingHandlesProps = {
  element: Element;
  padding: { top: number; right: number; bottom: number; left: number };
  accentColor: string;
  hoveredSide: PaddingSide | null;
  draggingSide: PaddingSide | null;
  cursorViewport?: { x: number; y: number };
  refreshKey?: number;
};

// Convert color to oklch with alpha
function colorWithAlpha(color: string, alpha: number): string {
  const oklchMatch = color.match(/^oklch\(([^)]+)\)$/i);
  if (oklchMatch) {
    return `oklch(${oklchMatch[1]} / ${alpha})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

const OPPOSITE: Record<PaddingSide, PaddingSide> = {
  top: 'bottom', bottom: 'top', left: 'right', right: 'left',
};

export function PaddingHandles({ element, padding, accentColor, hoveredSide, draggingSide, cursorViewport, refreshKey }: PaddingHandlesProps) {
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

  // Re-read bounds synchronously before paint when padding changes (element reflows during drag)
  useLayoutEffect(() => {
    if (element) {
      setBounds(element.getBoundingClientRect());
    }
  }, [element, padding.top, padding.right, padding.bottom, padding.left, refreshKey]);

  if (!bounds) return null;

  const W = bounds.width;
  const H = bounds.height;
  const { top: pT, right: pR, bottom: pB, left: pL } = padding;

  const patternId = 'pm-stripe-pattern';
  const stripeColor = colorWithAlpha(accentColor, 0.25);
  const bgColor = colorWithAlpha(accentColor, 0.1);
  const borderColor = colorWithAlpha(accentColor, 0.2);

  // Handle dimensions: long thin bars
  const HANDLE_LEN = 8;
  const HANDLE_THK = 2;

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

  const sides: PaddingSide[] = ['top', 'right', 'bottom', 'left'];

  // Trapezoid polygons for each padding zone
  const polygons: Record<PaddingSide, string> = {
    top: `0,0 ${W},0 ${W - pR},${pT} ${pL},${pT}`,
    right: `${W},0 ${W},${H} ${W - pR},${H - pB} ${W - pR},${pT}`,
    bottom: `0,${H} ${pL},${H - pB} ${W - pR},${H - pB} ${W},${H}`,
    left: `0,0 ${pL},${pT} ${pL},${H - pB} 0,${H}`,
  };

  // Handle positions (centered within the padding zone, not at the edge)
  const handles: Record<PaddingSide, { x: number; y: number; w: number; h: number }> = {
    top:    { x: W / 2 - HANDLE_LEN / 2, y: pT / 2 - HANDLE_THK / 2,           w: HANDLE_LEN, h: HANDLE_THK },
    bottom: { x: W / 2 - HANDLE_LEN / 2, y: H - pB / 2 - HANDLE_THK / 2,       w: HANDLE_LEN, h: HANDLE_THK },
    left:   { x: pL / 2 - HANDLE_THK / 2,           y: H / 2 - HANDLE_LEN / 2,  w: HANDLE_THK, h: HANDLE_LEN },
    right:  { x: W - pR / 2 - HANDLE_THK / 2,       y: H / 2 - HANDLE_LEN / 2,  w: HANDLE_THK, h: HANDLE_LEN },
  };

  // Compute which sides are highlighted:
  // - During drag: only the dragging side (axis-sync is visual from the padding change itself)
  // - Hover + no CMD: hovered side + its opposite (axis-sync preview)
  // - Hover + CMD: only the hovered side (single-side mode)
  const activeSides = new Set<PaddingSide>();
  if (draggingSide) {
    activeSides.add(draggingSide);
  } else if (hoveredSide) {
    activeSides.add(hoveredSide);
    if (!cmdHeld) {
      activeSides.add(OPPOSITE[hoveredSide]);
    }
  }

  return (
    <div data-devtools="padding-handles" style={containerStyle}>
      <svg
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}
        viewBox={`0 0 ${W} ${H}`}
      >
        <defs>
          <pattern
            id={patternId}
            patternUnits="userSpaceOnUse"
            width="4"
            height="4"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="4" stroke={stripeColor} strokeWidth="1.5" />
          </pattern>
        </defs>

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

        {/* Padding zone trapezoids: bg tint + diagonal stripes */}
        {sides.map(side => {
          const p = padding[side];
          if (p <= 0) return null;
          const isActive = activeSides.has(side);
          return (
            <g key={side} opacity={isActive ? 1 : 0.6}>
              <polygon points={polygons[side]} fill={bgColor} />
              <polygon points={polygons[side]} fill={`url(#${patternId})`} />
            </g>
          );
        })}

        {/* Handle indicators */}
        {sides.map(side => {
          const h = handles[side];
          const isActive = activeSides.has(side);
          return (
            <rect
              key={`handle-${side}`}
              x={h.x}
              y={h.y}
              width={h.w}
              height={h.h}
              fill={accentColor}
              stroke="#ffffff"
              strokeWidth={isActive ? 4 : 2}
              paintOrder="stroke"
            />
          );
        })}
      </svg>

      {/* Value badge near cursor */}
      {cursorViewport && (hoveredSide || draggingSide) && (() => {
        const side = draggingSide ?? hoveredSide!;
        const value = Math.round(padding[side]);
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
