'use client';

import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useState } from 'react';

import { computeGapZones, type GapZone } from '../utils/dom';

type GapHandlesProps = {
  element: Element;
  gap: { row: number; column: number };
  accentColor: string;
  hoveredAxis: 'row' | 'column' | null;
  draggingAxis: 'row' | 'column' | null;
  cursorViewport?: { x: number; y: number };
  isAutoGap?: boolean;
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

export function GapHandles({ element, gap, accentColor, hoveredAxis, draggingAxis, cursorViewport, isAutoGap = false, refreshKey = 0 }: GapHandlesProps) {
  const [bounds, setBounds] = useState<DOMRect | null>(null);
  const [zones, setZones] = useState<GapZone[]>([]);
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
      setZones([]);
      return;
    }

    const update = () => {
      setBounds(element.getBoundingClientRect());
      setZones(computeGapZones(element));
    };

    update();

    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });

    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [element]);

  // Re-read bounds and zones synchronously before paint when gap changes (element reflows during drag)
  useLayoutEffect(() => {
    if (element) {
      setBounds(element.getBoundingClientRect());
      setZones(computeGapZones(element));
    }
  }, [element, gap.row, gap.column, refreshKey]);

  if (!bounds || zones.length === 0) return null;

  const W = bounds.width;
  const H = bounds.height;

  const patternId = 'pm-gap-stripe-pattern';
  const stripeColor = colorWithAlpha(accentColor, 0.25);
  const bgColor = colorWithAlpha(accentColor, 0.1);
  const borderColor = colorWithAlpha(accentColor, 0.2);

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

  const activeAxis = draggingAxis ?? hoveredAxis;

  return (
    <div data-devtools="gap-handles" style={containerStyle}>
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

        {/* Gap zone rectangles: bg tint + diagonal stripes (skip fill for zero-gap zones) */}
        {zones.map((zone, i) => {
          // Convert viewport-relative zone to SVG-space (relative to bounds)
          const zx = zone.x - bounds.left;
          const zy = zone.y - bounds.top;
          const zw = zone.w;
          const zh = zone.h;

          // Highlight logic:
          // Default (no CMD): all zones highlighted (both axes change)
          // CMD held: only zones matching the hovered axis
          const isActive = cmdHeld
            ? zone.axis === activeAxis
            : true;

          // Skip stripe fill for zero-gap zones — only the handle bar renders
          const gapValue = zone.axis === 'row' ? gap.row : gap.column;
          if (gapValue === 0) return null;

          return (
            <g key={i} opacity={isActive ? 1 : 0.6}>
              <rect x={zx} y={zy} width={zw} height={zh} fill={bgColor} />
              <rect x={zx} y={zy} width={zw} height={zh} fill={`url(#${patternId})`} />
            </g>
          );
        })}

        {/* Handle indicator: small bar centered in the hovered gap zone only */}
        {activeAxis && (() => {
          // Find the zone closest to cursor, matching activeAxis
          const matchingZones = zones.filter(z => z.axis === activeAxis);
          if (matchingZones.length === 0) return null;

          let closest = matchingZones[0]!;
          if (cursorViewport && matchingZones.length > 1) {
            let minDist = Infinity;
            for (const z of matchingZones) {
              const cx = z.x + z.w / 2;
              const cy = z.y + z.h / 2;
              const dist = Math.abs(cursorViewport.x - cx) + Math.abs(cursorViewport.y - cy);
              if (dist < minDist) {
                minDist = dist;
                closest = z;
              }
            }
          }

          const zx = closest.x - bounds.left;
          const zy = closest.y - bounds.top;
          const zw = closest.w;
          const zh = closest.h;

          const cx = zx + zw / 2;
          const cy = zy + zh / 2;

          if (isAutoGap) {
            // Auto gap: small circle dot
            return (
              <circle
                cx={cx}
                cy={cy}
                r={1.5}
                fill={accentColor}
                stroke="#ffffff"
                strokeWidth={4}
                paintOrder="stroke"
              />
            );
          }

          // Fixed gap: directional bar
          const isColumn = activeAxis === 'column';
          const hw = isColumn ? HANDLE_THK : HANDLE_LEN;
          const hh = isColumn ? HANDLE_LEN : HANDLE_THK;
          const hx = cx - hw / 2;
          const hy = cy - hh / 2;

          return (
            <rect
              x={hx}
              y={hy}
              width={hw}
              height={hh}
              fill={accentColor}
              stroke="#ffffff"
              strokeWidth={4}
              paintOrder="stroke"
            />
          );
        })()}
      </svg>

      {/* Value badge near cursor */}
      {cursorViewport && activeAxis && (() => {
        const label = isAutoGap ? 'auto' : String(Math.round(activeAxis === 'row' ? gap.row : gap.column));
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
            {label}
          </div>
        );
      })()}
    </div>
  );
}
