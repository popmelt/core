'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef } from 'react';

import { parseValue } from '../../utils/units';

/** Padding snap steps in px — matches canvas handle snap behavior */
export const PADDING_SNAP_STEPS = [0, 1, 2, 4, 8, 12, 16, 20, 24, 28, 32] as const;

/**
 * Draggable label icon — horizontal drag scrubs the associated numeric value.
 * Uses Pointer Lock for infinite cursor wrapping at viewport edges.
 * Live preview via `onPreview` during drag; `onChange` only fires on mouseup.
 */
export function ScrubLabel({
  value,
  onChange,
  onPreview,
  onScrubEnd,
  onReset,
  isModified,
  accentColor,
  defaultUnit = 'rem',
  snapSteps,
  color,
  style,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Called on every drag frame for live inline preview — should NOT record a modification */
  onPreview?: (v: string) => void;
  /** Called after mouseup to clean up any preview display state */
  onScrubEnd?: () => void;
  onReset?: () => void;
  isModified?: boolean;
  accentColor?: string;
  /** Unit to use when the parsed value has no unit or is 'px'. Defaults to 'rem'. */
  defaultUnit?: string;
  /** Snap steps in px — when shift is held, value snaps to the nearest step. Beyond last step, snaps to multiples of 8. */
  snapSteps?: readonly number[];
  color?: string;
  style?: CSSProperties;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const scrub = useRef<{ startValue: number; unit: string; accum: number; hasMoved: boolean } | null>(null);
  const resetRef = useRef(onReset);
  const modifiedRef = useRef(isModified);
  const lastShiftRef = useRef(false);
  resetRef.current = onReset;
  modifiedRef.current = isModified;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const s = scrub.current;
      if (!s) return;
      s.hasMoved = true;
      lastShiftRef.current = e.shiftKey;
      // Sensitivity: 1px/px, 0.1px/rem, 0.1px/em
      const sens = (s.unit === 'rem' || s.unit === 'em') ? 0.1 : 1;
      s.accum += e.movementX * sens;
      let newVal = Math.max(0, Math.round((s.startValue + s.accum) * 10) / 10);
      // Shift-snap to predefined steps
      if (e.shiftKey && snapSteps) {
        // Convert snap steps from px to current unit if needed
        const rootFs = (s.unit === 'rem' || s.unit === 'em')
          ? (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)
          : 1;
        const pxVal = s.unit === 'rem' || s.unit === 'em' ? newVal * rootFs : newVal;
        let snapped = snapSteps[snapSteps.length - 1]!;
        for (let i = 0; i < snapSteps.length - 1; i++) {
          const lo = snapSteps[i]!;
          const hi = snapSteps[i + 1]!;
          if (pxVal <= (lo + hi) / 2) { snapped = lo; break; }
          if (pxVal < hi) { snapped = hi; break; }
        }
        // Beyond last step: snap to nearest multiple of 8
        if (pxVal > snapSteps[snapSteps.length - 1]!) {
          snapped = Math.round(pxVal / 8) * 8;
        }
        newVal = s.unit === 'rem' || s.unit === 'em'
          ? Math.round((snapped / rootFs) * 1000) / 1000
          : snapped;
      }
      onPreview?.(`${newVal}${s.unit}`);
    };
    const onUp = () => {
      const s = scrub.current;
      if (!s) return;
      let finalVal = Math.max(0, Math.round((s.startValue + s.accum) * 10) / 10);
      // Re-apply shift-snap for the committed value
      if (lastShiftRef.current && snapSteps) {
        const rootFs = (s.unit === 'rem' || s.unit === 'em')
          ? (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)
          : 1;
        const pxVal = s.unit === 'rem' || s.unit === 'em' ? finalVal * rootFs : finalVal;
        let snapped = snapSteps[snapSteps.length - 1]!;
        for (let i = 0; i < snapSteps.length - 1; i++) {
          const lo = snapSteps[i]!;
          const hi = snapSteps[i + 1]!;
          if (pxVal <= (lo + hi) / 2) { snapped = lo; break; }
          if (pxVal < hi) { snapped = hi; break; }
        }
        if (pxVal > snapSteps[snapSteps.length - 1]!) {
          snapped = Math.round(pxVal / 8) * 8;
        }
        finalVal = s.unit === 'rem' || s.unit === 'em'
          ? Math.round((snapped / rootFs) * 1000) / 1000
          : snapped;
      }
      const changed = s.hasMoved && finalVal !== s.startValue;
      scrub.current = null;
      document.exitPointerLock();
      if (changed) {
        onChange(`${finalVal}${s.unit}`);
      } else if (s.hasMoved) {
        // Scrubbed back to original — revert preview
        onPreview?.(`${s.startValue}${s.unit}`);
      } else if (modifiedRef.current && resetRef.current) {
        // Click with no drag on a modified field → reset
        resetRef.current();
      }
      onScrubEnd?.();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [onChange, onPreview, onScrubEnd]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const parsed = parseValue(value);
    // Use defaultUnit when the value is unitless or in px (computed values are always px)
    const unit = (parsed.unit && parsed.unit !== 'px') ? parsed.unit : defaultUnit;
    scrub.current = { startValue: parsed.num, unit, accum: 0, hasMoved: false };
    ref.current?.requestPointerLock();
  }, [value, defaultUnit]);

  return (
    <span
      ref={ref}
      onMouseDown={onMouseDown}
      title={isModified ? 'Click to reset · Drag to scrub' : 'Drag to scrub'}
      style={{
        color: isModified ? (accentColor || '#3b82f6') : (color || '#999'),
        padding: '0 4px',
        display: 'flex',
        alignItems: 'center',
        cursor: 'ew-resize',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
