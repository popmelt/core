'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';

import type { ElementInfo } from '../tools/types';

type ElementHighlightProps = {
  element: Element | null;
  isSelected?: boolean;
  elementInfo?: ElementInfo | null;
  color?: string;
  annotationNumber?: number;
  changeCount?: number;
  hideTooltip?: boolean;
};

// Convert color to rgba/oklch with alpha
function colorWithAlpha(color: string, alpha: number): string {
  // Handle OKLCH colors: oklch(L C H) -> oklch(L C H / alpha)
  const oklchMatch = color.match(/^oklch\(([^)]+)\)$/i);
  if (oklchMatch) {
    return `oklch(${oklchMatch[1]} / ${alpha})`;
  }

  // Handle hex colors
  const hexResult = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
  if (hexResult) {
    const r = parseInt(hexResult[1]!, 16);
    const g = parseInt(hexResult[2]!, 16);
    const b = parseInt(hexResult[3]!, 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Handle rgb/rgba - just use color-mix
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

export function ElementHighlight({ element, isSelected = false, elementInfo, color = '#3b82f6', annotationNumber, changeCount, hideTooltip = false }: ElementHighlightProps) {
  const [bounds, setBounds] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!element) {
      setBounds(null);
      return;
    }

    const updateBounds = () => {
      const rect = element.getBoundingClientRect();
      setBounds(rect);
    };

    updateBounds();

    // Update on scroll/resize
    window.addEventListener('scroll', updateBounds, { passive: true });
    window.addEventListener('resize', updateBounds, { passive: true });

    return () => {
      window.removeEventListener('scroll', updateBounds);
      window.removeEventListener('resize', updateBounds);
    };
  }, [element]);

  if (!bounds || !element) {
    return null;
  }

  const highlightStyle: CSSProperties = {
    position: 'fixed',
    top: bounds.top,
    left: bounds.left,
    width: bounds.width,
    height: bounds.height,
    pointerEvents: 'none',
    zIndex: 9996,
    backgroundColor: isSelected ? colorWithAlpha(color, 0.1) : colorWithAlpha(color, 0.05),
    overflow: 'visible',
  };

  const cornerDotStyle: CSSProperties = {
    position: 'absolute',
    width: 2,
    height: 2,
    backgroundColor: color,
    pointerEvents: 'none',
  };

  // Build tooltip label
  const tagName = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const classes = element.classList.length > 0
    ? '.' + Array.from(element.classList).slice(0, 2).join('.')
    : '';
  const reactComponent = elementInfo?.reactComponent;

  const elementLabel = reactComponent
    ? `<${reactComponent}> ${tagName}${id}${classes}`
    : `${tagName}${id}${classes}`;

  const tooltipHeight = 22;
  // If the element fills the viewport (body, html, full-height wrappers),
  // render the tooltip inside the overlay instead of outside it.
  const isFullHeight = bounds.height >= window.innerHeight;
  const tooltipTop = isFullHeight
    ? 0 // rendered inside the overlay via absolute positioning
    : bounds.top >= tooltipHeight
      ? bounds.top - tooltipHeight
      : bounds.bottom;
  const tooltipStyle: CSSProperties = isFullHeight
    ? {
        position: 'absolute' as const,
        top: 8,
        left: 8,
        zIndex: 9997,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        backgroundColor: color,
        color: '#fff',
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        padding: '4px 8px',
        borderRadius: 0,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        maxWidth: 400,
      }
    : {
        position: 'fixed' as const,
        top: tooltipTop,
        left: bounds.left,
        zIndex: 9997,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        backgroundColor: color,
        color: '#fff',
        fontSize: 11,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        padding: '4px 8px',
        borderRadius: 0,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        maxWidth: 400,
      };

  const labelStyle: CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flex: 1,
    minWidth: 0,
  };

  const tooltipJsx = !hideTooltip && (
    <div data-devtools="tooltip" style={tooltipStyle}>
      {annotationNumber !== undefined && (
        <span>{annotationNumber}.</span>
      )}
      <span style={labelStyle}>{elementLabel}</span>
      {changeCount !== undefined && changeCount > 0 && (
        <span style={{ opacity: 0.8 }}>({changeCount} {changeCount === 1 ? 'change' : 'changes'})</span>
      )}
    </div>
  );

  return (
    <>
      <div data-devtools="highlight" style={highlightStyle}>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}>
          <rect
            x="0.5"
            y="0.5"
            width={Math.max(0, bounds.width - 1)}
            height={Math.max(0, bounds.height - 1)}
            fill="none"
            stroke={color}
            strokeWidth="1"
            {...(!isSelected && { strokeDasharray: '2 4' })}
          />
        </svg>
        <div style={{ ...cornerDotStyle, top: -1, left: -1 }} />
        <div style={{ ...cornerDotStyle, top: -1, right: -1 }} />
        <div style={{ ...cornerDotStyle, bottom: -1, left: -1 }} />
        <div style={{ ...cornerDotStyle, bottom: -1, right: -1 }} />
        {isFullHeight && tooltipJsx}
      </div>
      {!isFullHeight && tooltipJsx}
    </>
  );
}
