'use client';

import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useState } from 'react';

import { getTextBoundingRect } from '../utils/dom';

export type TextHandleProperty = 'font-size' | 'line-height';

type TextHandlesProps = {
  element: Element;
  fontSize: number;
  lineHeight: number;
  accentColor: string;
  hoveredProperty: TextHandleProperty | null;
  draggingProperty: TextHandleProperty | null;
  cursorViewport?: { x: number; y: number };
};

function colorWithAlpha(color: string, alpha: number): string {
  const oklchMatch = color.match(/^oklch\(([^)]+)\)$/i);
  if (oklchMatch) {
    return `oklch(${oklchMatch[1]} / ${alpha})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

export function TextHandles({ element, fontSize, lineHeight, accentColor, hoveredProperty, draggingProperty, cursorViewport }: TextHandlesProps) {
  const [textBounds, setTextBounds] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!element) {
      setTextBounds(null);
      return;
    }

    const updateBounds = () => {
      setTextBounds(getTextBoundingRect(element));
    };

    updateBounds();

    window.addEventListener('scroll', updateBounds, { passive: true });
    window.addEventListener('resize', updateBounds, { passive: true });

    return () => {
      window.removeEventListener('scroll', updateBounds);
      window.removeEventListener('resize', updateBounds);
    };
  }, [element]);

  // Re-read bounds synchronously before paint when text properties change (element reflows during drag)
  useLayoutEffect(() => {
    if (element) {
      setTextBounds(getTextBoundingRect(element));
    }
  }, [element, fontSize, lineHeight]);

  if (!textBounds) return null;

  const W = textBounds.width;
  const H = textBounds.height;

  const borderColor = colorWithAlpha(accentColor, 0.2);
  const activeProperty = draggingProperty ?? hoveredProperty;

  // Handle bar dimensions
  const BAR_LONG = 8;
  const BAR_SHORT = 2;

  const containerStyle: CSSProperties = {
    position: 'fixed',
    top: textBounds.top,
    left: textBounds.left,
    width: W,
    height: H,
    pointerEvents: 'none',
    zIndex: 9996,
    overflow: 'visible',
  };

  // Format badge values
  const formatValue = (prop: TextHandleProperty): string => {
    if (prop === 'font-size') {
      return `${Math.round(fontSize)}`;
    }
    // line-height: show unitless ratio, trim trailing zeros
    const ratio = fontSize > 0 ? lineHeight / fontSize : 1.2;
    return ratio.toFixed(2).replace(/\.?0+$/, '');
  };

  return (
    <div data-devtools="text-handles" style={containerStyle}>
      <svg
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}
        viewBox={`0 0 ${W} ${H}`}
      >
        {/* Text outline */}
        <rect
          x="0.5"
          y="0.5"
          width={Math.max(0, W - 1)}
          height={Math.max(0, H - 1)}
          fill="none"
          stroke={borderColor}
          strokeWidth="1"
        />

        {/* Right handle — font-size */}
        {(activeProperty === 'font-size' || !activeProperty) && (
          <rect
            x={W - BAR_SHORT / 2}
            y={H / 2 - BAR_LONG / 2}
            width={BAR_SHORT}
            height={BAR_LONG}
            fill={accentColor}
            stroke="#ffffff"
            strokeWidth={activeProperty === 'font-size' ? 4 : 2}
            paintOrder="stroke"
          />
        )}

        {/* Bottom handle — line-height */}
        {(activeProperty === 'line-height' || !activeProperty) && (
          <rect
            x={W / 2 - BAR_LONG / 2}
            y={H - BAR_SHORT / 2}
            width={BAR_LONG}
            height={BAR_SHORT}
            fill={accentColor}
            stroke="#ffffff"
            strokeWidth={activeProperty === 'line-height' ? 4 : 2}
            paintOrder="stroke"
          />
        )}
      </svg>

      {/* Value badge near cursor */}
      {cursorViewport && activeProperty && (() => {
        const label = activeProperty === 'font-size' ? 'Aa' : 'Lh';
        const value = formatValue(activeProperty);
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
            {label} {value}
          </div>
        );
      })()}
    </div>
  );
}
