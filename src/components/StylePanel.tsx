'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, MoveHorizontal, RotateCcw, Shrink, X } from 'lucide-react';

import { POPMELT_BORDER } from '../styles/border';
import type { AnnotationAction, ElementInfo, StyleModification } from '../tools/types';
import {
  applyInlineStyle,
  findMatchingColorVariable,
  getAuthoredStyleValue,
  getComputedStyleValue,
  getColorVariables,
  getRawStyleValue,
  resolveColorValue,
  revertElementStyles,
} from '../utils/dom';
import type { ColorVariable } from '../utils/dom';
import { colorWithAlpha, rgbToHex } from '../utils/color';
import { PROPERTY_UNITS, getDefaultUnit, resolveUnitValue, convertFromPx, parseValue } from '../utils/units';
import { BackdropFilterEditor } from './stylePanel/BackdropFilterEditor';
import { LayoutSection } from './stylePanel/LayoutSection';
import { TypographySection } from './stylePanel/TypographySection';
import { ScrubLabel } from './stylePanel/ScrubLabel';

type StylePanelProps = {
  element: Element;
  elementInfo: ElementInfo;
  selector: string;
  styleModifications: StyleModification[];
  dispatch: React.Dispatch<AnnotationAction>;
  onClose: () => void;
  /** null = mouse left panel, 'element' = general hover, 'padding' | 'gap' = field-specific */
  onHover?: (hint: string | null) => void;
  accentColor?: string;
  toolbarRef?: React.MutableRefObject<HTMLDivElement | null>;
};

type PropertyConfig = {
  property: string;
  label: string;
  type: 'color' | 'number' | 'select' | 'text' | 'spacing' | 'backdrop-filter';
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
};

type SectionConfig = {
  name: string;
  properties: PropertyConfig[];
};

// Sections that come AFTER the custom Layout and Typography sections
const SECTIONS: SectionConfig[] = [
  {
    name: 'Background',
    properties: [
      { property: 'background-color', label: 'Color', type: 'color' },
      { property: 'opacity', label: 'Opacity', type: 'number', step: 0.1, min: 0, max: 1 },
    ],
  },
  {
    name: 'Borders',
    properties: [
      { property: 'border-width', label: 'Width', type: 'number', min: 0, max: 20 },
      { property: 'border-color', label: 'Color', type: 'color' },
      { property: 'border-radius', label: 'Radius', type: 'number', min: 0, max: 100 },
      { property: 'border-style', label: 'Style', type: 'select', options: ['none', 'solid', 'dashed', 'dotted', 'double'] },
    ],
  },
  {
    name: 'Effects',
    properties: [
      { property: 'box-shadow', label: 'Box Shadow', type: 'text' },
      { property: 'backdrop-filter', label: 'Backdrop Filter', type: 'backdrop-filter' },
      { property: 'transform', label: 'Transform', type: 'text' },
    ],
  },
];

// Check if a CSS value is essentially the default/unset value for a property
function isDefaultValue(property: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  switch (property) {
    case 'opacity': return v === '1';
    case 'border-width': return v === '0px' || v === '0' || v === 'medium';
    case 'border-radius': return v === '0px' || v === '0';
    case 'border-style': return v === 'none';
    case 'box-shadow': return v === 'none';
    case 'backdrop-filter': return v === 'none' || v === '';
    case 'letter-spacing': return v === 'normal' || v === '0px' || v === '0';
    case 'background-color': return v === 'rgba(0, 0, 0, 0)' || v === 'transparent';
    default: return false;
  }
}

// Sizing mode options for width/height
export type SizingMode = 'fixed' | 'hug' | 'fill';

export function getSizingMode(value: string, authoredValue: string | null): SizingMode {
  // If no explicit width/height is set in styles, the element is using auto sizing (hug)
  if (!authoredValue) return 'hug';
  if (value === 'auto' || value === 'fit-content' || value === 'max-content' || value === 'min-content') return 'hug';
  if (value === '100%' || authoredValue === '100%') return 'fill';
  return 'fixed';
}

export function getSizingValue(mode: SizingMode, currentValue: string): string {
  switch (mode) {
    case 'hug': return 'fit-content';
    case 'fill': return '100%';
    case 'fixed': {
      const parsed = parseValue(currentValue);
      if (typeof parsed.num === 'number' && !isNaN(parsed.num)) {
        // Keep the current unit unless it's % (from fill mode), then use px
        const unit = parsed.unit === '%' ? 'px' : (parsed.unit || 'px');
        return `${parsed.num}${unit}`;
      }
      return 'auto';
    }
  }
}

// Parse padding/margin shorthand into 4 values
export function parseSpacing(value: string): { top: string; right: string; bottom: string; left: string } {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { top: parts[0]!, right: parts[0]!, bottom: parts[0]!, left: parts[0]! };
  } else if (parts.length === 2) {
    return { top: parts[0]!, right: parts[1]!, bottom: parts[0]!, left: parts[1]! };
  } else if (parts.length === 3) {
    return { top: parts[0]!, right: parts[1]!, bottom: parts[2]!, left: parts[1]! };
  } else if (parts.length >= 4) {
    return { top: parts[0]!, right: parts[1]!, bottom: parts[2]!, left: parts[3]! };
  }
  return { top: '0px', right: '0px', bottom: '0px', left: '0px' };
}

// Display mode types
export type DisplayMode = 'block' | 'flex-row' | 'flex-col' | 'grid';

export function getDisplayMode(display: string, flexDirection: string): DisplayMode {
  if (display === 'grid') return 'grid';
  if (display === 'flex' || display === 'inline-flex') {
    return flexDirection === 'column' || flexDirection === 'column-reverse' ? 'flex-col' : 'flex-row';
  }
  return 'block';
}

export function applyDisplayMode(mode: DisplayMode, handleChange: (property: string, value: string) => void) {
  switch (mode) {
    case 'block':
      handleChange('display', 'block');
      break;
    case 'flex-row':
      handleChange('display', 'flex');
      handleChange('flex-direction', 'row');
      break;
    case 'flex-col':
      handleChange('display', 'flex');
      handleChange('flex-direction', 'column');
      break;
    case 'grid':
      handleChange('display', 'grid');
      break;
  }
}

// Shared styles
export const FIELD_BG = 'rgba(0, 0, 0, 0.04)';

export const compactInputStyle: CSSProperties = {
  width: '100%',
  padding: '4px 8px',
  fontSize: 11,
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
  border: 'none',
  borderRadius: 2,
  outline: 'none',
  backgroundColor: 'transparent',
};

// Dimension field with dropdown for sizing mode - MUST be at module level to avoid re-creation
export function DimensionField({
  label,
  property,
  cssValue,
  mode,
  onValueChange,
  onModeChange,
  modified,
  dimmed,
  dropdownOpen,
  onDropdownChange,
  panelContentRef,
  accentColor = '#3b82f6',
  onReset,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  onMinReset,
  onMaxReset,
  minModified,
  maxModified,
}: {
  label: string;
  property: 'width' | 'height';
  cssValue: string;
  mode: SizingMode;
  onValueChange: (cssValue: string) => void;
  onModeChange: (mode: SizingMode) => void;
  modified: boolean;
  dimmed?: boolean;
  dropdownOpen?: boolean;
  onDropdownChange?: (open: boolean) => void;
  panelContentRef?: React.RefObject<HTMLDivElement | null>;
  accentColor?: string;
  onReset?: () => void;
  minValue?: string;
  maxValue?: string;
  onMinChange?: (value: string) => void;
  onMaxChange?: (value: string) => void;
  onMinReset?: () => void;
  onMaxReset?: () => void;
  minModified?: boolean;
  maxModified?: boolean;
}) {
  const parsed = parseValue(cssValue);
  const effectiveUnit = modified
    ? (parsed.unit || getDefaultUnit(property))
    : getDefaultUnit(property);
  // Convert display number when units differ (e.g. computed 1376px → 86rem)
  const displayNum = (!modified && parsed.unit && parsed.unit !== effectiveUnit)
    ? convertFromPx(parsed.num, effectiveUnit)
    : parsed.num;

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(String(displayNum));
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const isCancelingRef = useRef(false);

  // Sync edit value when external value changes and not editing
  useEffect(() => {
    if (!isEditing) {
      setEditValue(String(displayNum));
    }
  }, [displayNum, isEditing]);

  // Close dropdown when clicking outside or pressing Escape
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !e.composedPath().includes(dropdownRef.current) &&
          fieldRef.current && !e.composedPath().includes(fieldRef.current)) {
        onDropdownChange?.(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDropdownChange?.(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dropdownOpen, onDropdownChange]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const commitValue = () => {
    const resolved = resolveUnitValue(editValue, property, cssValue, modified);
    onValueChange(resolved || `${Math.max(0, parseFloat(editValue) || 0)}${effectiveUnit}`);
    setIsEditing(false);
  };

  const handleBlur = () => {
    if (isCancelingRef.current) {
      isCancelingRef.current = false;
      return;
    }
    commitValue();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitValue();
      return;
    }
    if (e.key === 'Escape') {
      isCancelingRef.current = true;
      setEditValue(String(displayNum));
      setIsEditing(false);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? 1 : -1;
      const multiplier = e.shiftKey ? 8 : e.altKey ? 0.1 : 1;
      const currentNum = parseFloat(editValue) || 0;
      const newValue = Math.round(Math.max(0, currentNum + delta * multiplier) * 1000) / 1000;
      setEditValue(String(newValue));
      onValueChange(`${newValue}${effectiveUnit}`);
    }
  };

  const modeLabels: Record<SizingMode, string> = {
    fixed: 'Fixed',
    hug: 'Hug',
    fill: 'Fill',
  };

  const modeIcons: Record<SizingMode, React.ReactNode> = {
    fixed: <MoveHorizontal size={12} />,
    hug: <Shrink size={12} />,
    fill: <MoveHorizontal size={12} />,
  };

  const toggleDropdown = () => {
    onDropdownChange?.(!dropdownOpen);
  };

  // Calculate dropdown position to span full panel width
  // Note: The panel has backdrop-filter which creates a containing block for
  // position:fixed descendants, so we need panel-relative coordinates.
  const getDropdownStyle = (): CSSProperties => {
    if (!fieldRef.current || !panelContentRef?.current) {
      // Fallback to relative positioning
      return {
        position: 'absolute',
        top: '100%',
        left: -4,
        right: -4,
        width: 'calc(100% + 8px)',
        marginTop: 4,
      };
    }

    const fieldRect = fieldRef.current.getBoundingClientRect();
    const panelRect = panelContentRef.current.getBoundingClientRect();
    const panelEl = panelContentRef.current.closest('[data-devtools="panel"]');
    const panelOffset = panelEl ? panelEl.getBoundingClientRect() : { top: 0, left: 0 };

    return {
      position: 'fixed',
      top: fieldRect.bottom + 4 - panelOffset.top,
      left: panelRect.left + 4 - panelOffset.left,
      width: panelRect.width - 8,
    };
  };

  return (
    <div
      ref={fieldRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        position: 'relative',
        borderRadius: 2,
        border: '1px solid',
        borderColor: isEditing ? accentColor : hovered ? 'rgba(0,0,0,0.15)' : 'transparent',
        backgroundColor: FIELD_BG,
        transition: 'border-color 100ms ease, opacity 150ms ease',
        opacity: dimmed ? 0.3 : 1,
      }}
    >
      {/* Label */}
      <span
        onClick={modified && onReset ? onReset : undefined}
        title={modified ? 'Click to reset' : undefined}
        style={{
          fontSize: 10,
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          color: modified ? accentColor : '#999',
          fontWeight: modified ? 600 : 400,
          padding: '0 8px',
          flexShrink: 0,
          cursor: modified ? 'pointer' : 'default',
        }}
      >{label}</span>

      {/* Value - clickable to edit */}
      {mode === 'fixed' ? (
        isEditing ? (
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            style={{
              ...compactInputStyle,
              flex: 1,
              minWidth: 0,
              padding: '4px 2px',
            }}
          />
        ) : (
          <span
            onClick={() => setIsEditing(true)}
            style={{
              flex: 1,
              padding: '4px 2px',
              fontSize: 11,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
              cursor: 'text',
            }}
          >
            {displayNum}
          </span>
        )
      ) : (
        <span style={{ flex: 1 }} />
      )}

      {/* Mode dropdown trigger */}
      <button
        type="button"
        onClick={toggleDropdown}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '4px 8px',
          border: 'none',
          outline: 'none',
          backgroundColor: 'transparent',
          color: '#999',
          fontSize: 10,
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {modeLabels[mode]}
        <ChevronDown size={12} />
      </button>

      {/* Dropdown menu - light mode, full panel width */}
      {dropdownOpen && (
        <div
          ref={dropdownRef}
          style={{
            ...getDropdownStyle(),
            backgroundColor: '#ffffff',
            border: '1px solid rgba(0,0,0,0.1)',
            borderRadius: 0,
            zIndex: 10001,
            overflow: 'hidden',
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          }}
        >
          {/* Fixed option */}
          <button
            type="button"
            onClick={() => { onModeChange('fixed'); onDropdownChange?.(false); }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              border: 'none',
              outline: 'none',
              backgroundColor: mode === 'fixed' ? '#f1f5f9' : 'transparent',
              color: '#1e293b',
              fontWeight: mode === 'fixed' ? 600 : 400,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            {modeIcons.fixed}
            <span>Fixed {property} ({cssValue})</span>
            {mode === 'fixed' && <Check size={14} style={{ marginLeft: 'auto' }} />}
          </button>

          {/* Hug option */}
          <button
            type="button"
            onClick={() => { onModeChange('hug'); onDropdownChange?.(false); }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              border: 'none',
              outline: 'none',
              backgroundColor: mode === 'hug' ? '#f1f5f9' : 'transparent',
              color: '#1e293b',
              fontWeight: mode === 'hug' ? 600 : 400,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            {modeIcons.hug}
            <span>Hug contents</span>
            {mode === 'hug' && <Check size={14} style={{ marginLeft: 'auto' }} />}
          </button>

          {/* Fill option */}
          <button
            type="button"
            onClick={() => { onModeChange('fill'); onDropdownChange?.(false); }}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              border: 'none',
              outline: 'none',
              backgroundColor: mode === 'fill' ? '#f1f5f9' : 'transparent',
              color: '#1e293b',
              fontWeight: mode === 'fill' ? 600 : 400,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            {modeIcons.fill}
            <span>Fill container</span>
            {mode === 'fill' && <Check size={14} style={{ marginLeft: 'auto' }} />}
          </button>

          <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', margin: '4px 0' }} />

          {/* Min/Max inputs */}
          <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {/* Min input */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                backgroundColor: FIELD_BG,
                borderRadius: 2,
                padding: '4px 8px',
              }}
            >
              <span
                onClick={minModified ? (e) => { e.stopPropagation(); onMinReset?.(); } : undefined}
                title={minModified ? 'Click to reset' : undefined}
                style={{
                  fontSize: 10,
                  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                  color: minModified ? accentColor : '#999',
                  fontWeight: minModified ? 600 : 400,
                  marginRight: 8,
                  flexShrink: 0,
                  cursor: minModified ? 'pointer' : 'default',
                }}
              >Min</span>
              <input
                type="text"
                value={minValue || ''}
                placeholder="—"
                onChange={(e) => onMinChange?.(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                style={{
                  ...compactInputStyle,
                  flex: 1,
                  minWidth: 0,
                  padding: 0,
                  textAlign: 'right',
                  color: minModified ? accentColor : 'inherit',
                  fontWeight: minModified ? 600 : 400,
                }}
              />
            </div>

            {/* Max input */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                backgroundColor: FIELD_BG,
                borderRadius: 2,
                padding: '4px 8px',
              }}
            >
              <span
                onClick={maxModified ? (e) => { e.stopPropagation(); onMaxReset?.(); } : undefined}
                title={maxModified ? 'Click to reset' : undefined}
                style={{
                  fontSize: 10,
                  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                  color: maxModified ? accentColor : '#999',
                  fontWeight: maxModified ? 600 : 400,
                  marginRight: 8,
                  flexShrink: 0,
                  cursor: maxModified ? 'pointer' : 'default',
                }}
              >Max</span>
              <input
                type="text"
                value={maxValue || ''}
                placeholder="—"
                onChange={(e) => onMaxChange?.(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                style={{
                  ...compactInputStyle,
                  flex: 1,
                  minWidth: 0,
                  padding: 0,
                  textAlign: 'right',
                  color: maxModified ? accentColor : 'inherit',
                  fontWeight: maxModified ? 600 : 400,
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Field wrapper with hover border - at module level
export function FieldWrapper({ children, style, dimmed }: { children: React.ReactNode; modified?: boolean; style?: CSSProperties; dimmed?: boolean; accentColor?: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        borderRadius: 2,
        border: '1px solid',
        borderColor: hovered ? 'rgba(0,0,0,0.15)' : 'transparent',
        backgroundColor: FIELD_BG,
        transition: 'border-color 100ms ease, opacity 150ms ease',
        opacity: dimmed ? 0.3 : 1,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// Input wrapper for property section inputs - at module level
export function InputWrapper({ children }: { children: React.ReactNode; modified?: boolean }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        borderRadius: 2,
        border: '1px solid',
        borderColor: hovered ? 'rgba(0,0,0,0.15)' : 'transparent',
        backgroundColor: FIELD_BG,
        transition: 'border-color 100ms ease',
      }}
    >
      {children}
    </div>
  );
}

// Unit-aware text input for CSS values - module level
export function UnitInput({
  property,
  value,
  onChange,
  isModified = false,
  step = 1,
  min,
  max,
  style: inputStyle,
  placeholder,
  showUnit = true,
  unitStyle: customUnitStyle,
  preferredUnit,
  onUnitCycle,
}: {
  property: string;
  value: string;
  onChange: (cssValue: string) => void;
  isModified?: boolean;
  step?: number;
  min?: number;
  max?: number;
  style?: CSSProperties;
  placeholder?: string;
  showUnit?: boolean;
  unitStyle?: CSSProperties;
  /** Panel-wide unit preference — overrides the default unit for properties that support it */
  preferredUnit?: 'rem' | 'px';
  /** Called when the unit label is clicked to cycle the panel-wide preference */
  onUnitCycle?: () => void;
}) {
  const parsed = parseValue(value);
  // Use panel-wide preference when the property supports it
  const propertyDefault = getDefaultUnit(property);
  const units = PROPERTY_UNITS[property];
  const canUsePreference = preferredUnit && units && units.includes(preferredUnit);
  const defaultUnit = canUsePreference ? preferredUnit : propertyDefault;
  const effectiveUnit = isModified
    ? (parsed.unit || defaultUnit)
    : defaultUnit;

  // Convert display number when the effective unit differs from the value's unit
  // e.g. computed "32px" with default "rem" → display as 2 (rem)
  const displayNum = (!isModified && parsed.unit && parsed.unit !== effectiveUnit)
    ? convertFromPx(parsed.num, effectiveUnit)
    : parsed.num;

  const [isFocused, setIsFocused] = useState(false);
  const [editText, setEditText] = useState('');

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    setEditText(String(displayNum || ''));
    requestAnimationFrame(() => e.target.select());
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (editText.trim()) {
      const resolved = resolveUnitValue(editText, property, value, isModified);
      if (resolved) onChange(resolved);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setEditText(raw);

    // Live update when input is a valid number (optionally with unit)
    const trimmed = raw.trim();
    const fullMatch = trimmed.match(/^(-?[\d.]+)\s*(rem|em|px|%)$/i);
    const bareNum = trimmed.match(/^(-?[\d.]+)$/);

    if (fullMatch) {
      const num = parseFloat(fullMatch[1]!);
      if (!isNaN(num)) {
        onChange(`${num}${fullMatch[2]!.toLowerCase()}`);
      }
    } else if (bareNum) {
      const num = parseFloat(bareNum[1]!);
      if (!isNaN(num)) {
        onChange(`${num}${effectiveUnit}`);
      }
    }
    // Partial unit (e.g. "2r") - wait for blur/enter to commit
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (editText.trim()) {
        const resolved = resolveUnitValue(editText, property, value, isModified);
        if (resolved) onChange(resolved);
      }
      (e.target as HTMLInputElement).blur();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const multiplier = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * multiplier;
      const current = parseFloat(editText) || displayNum || 0;
      let newVal = Math.round((current + delta) * 1000) / 1000;
      if (min !== undefined) newVal = Math.max(min, newVal);
      if (max !== undefined) newVal = Math.min(max, newVal);
      setEditText(String(newVal));
      onChange(`${newVal}${effectiveUnit}`);
    }
  };

  // Display: show edit text when focused, converted number when not
  const isNumericValue = /^-?[\d.]/.test(value.trim());
  const displayValue = isFocused ? editText : (isNumericValue ? String(displayNum) : '');

  // Hide unit suffix when user has typed one inline
  const hasTypedUnit = isFocused && /\s*(rem|em|px|%)\s*$/i.test(editText);
  const shownUnit = hasTypedUnit ? '' : effectiveUnit;

  const isUnitClickable = onUnitCycle && (shownUnit === 'rem' || shownUnit === 'px');

  const defaultUnitSuffix: CSSProperties = {
    fontSize: 10,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    color: '#999',
    pointerEvents: 'none',
  };

  const clickableUnitStyle: CSSProperties = {
    ...(customUnitStyle ?? defaultUnitSuffix),
    pointerEvents: 'auto',
    cursor: 'pointer',
  };

  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        value={displayValue}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        style={inputStyle}
      />
      {showUnit && shownUnit && (
        <span
          style={isUnitClickable ? clickableUnitStyle : (customUnitStyle ?? defaultUnitSuffix)}
          onClick={isUnitClickable ? onUnitCycle : undefined}
          title={isUnitClickable ? 'Click to switch units' : undefined}
        >{shownUnit}</span>
      )}
    </>
  );
}

// Color input with variable dropdown and autocomplete - module level
export function ColorInput({
  value,
  resolvedValue,
  colorVariables,
  matchingVariable,
  onChange,
  accentColor = '#3b82f6',
  modified,
  panelContentRef,
  isDropdownOpen,
  onDropdownChange,
}: {
  value: string;
  resolvedValue: string;
  colorVariables: ColorVariable[];
  matchingVariable: ColorVariable | null;
  onChange: (value: string) => void;
  accentColor?: string;
  modified?: boolean;
  panelContentRef?: React.RefObject<HTMLDivElement | null>;
  isDropdownOpen?: boolean;
  onDropdownChange?: (open: boolean) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  // If there's a matching variable and value doesn't already use var(), show the variable
  const displayValue = (!value.includes('var(') && matchingVariable) ? matchingVariable.usage : value;
  const [editValue, setEditValue] = useState(displayValue);
  const [showDropdownInternal, setShowDropdownInternal] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Use external state if provided, otherwise internal
  const showDropdown = isDropdownOpen !== undefined ? isDropdownOpen : showDropdownInternal;
  const setShowDropdown = onDropdownChange || setShowDropdownInternal;

  // Calculate dropdown position to span full panel width
  // Note: The panel has backdrop-filter which creates a containing block for
  // position:fixed descendants, so we need panel-relative coordinates.
  const getDropdownStyle = useCallback((): CSSProperties => {
    if (!containerRef.current) {
      return { position: 'fixed', top: 0, left: 0, width: 200 };
    }

    const fieldRect = containerRef.current.getBoundingClientRect();
    const panelEl = containerRef.current.closest('[data-devtools="panel"]');
    const panelOffset = panelEl ? panelEl.getBoundingClientRect() : { top: 0, left: 0 };

    // If we have panelContentRef, span full panel width
    if (panelContentRef?.current) {
      const contentRect = panelContentRef.current.getBoundingClientRect();
      return {
        position: 'fixed',
        top: fieldRect.bottom + 4 - panelOffset.top,
        left: contentRect.left + 4 - panelOffset.left,
        width: contentRect.width - 8,
      };
    }

    // Fallback to field width
    return {
      position: 'fixed',
      top: fieldRect.bottom + 4 - panelOffset.top,
      left: fieldRect.left - panelOffset.left,
      width: fieldRect.width,
    };
  }, [panelContentRef]);

  // Sync edit value when external value changes and not editing
  useEffect(() => {
    if (!isEditing) {
      const newDisplayValue = (!value.includes('var(') && matchingVariable) ? matchingVariable.usage : value;
      setEditValue(newDisplayValue);
    }
  }, [value, isEditing, matchingVariable]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showDropdown && !showSuggestions) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !e.composedPath().includes(containerRef.current)) {
        setShowDropdown(false);
        setShowSuggestions(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowDropdown(false);
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showDropdown, showSuggestions]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Filter suggestions based on input
  const suggestions = useMemo(() => {
    if (!editValue || editValue.startsWith('#') || editValue.startsWith('rgb') || editValue.startsWith('hsl') || editValue.startsWith('oklch')) {
      return [];
    }
    const search = editValue.toLowerCase();
    return colorVariables.filter(v =>
      v.name.toLowerCase().includes(search) ||
      v.usage.toLowerCase().includes(search)
    ).slice(0, 8);
  }, [editValue, colorVariables]);

  const commitValue = () => {
    onChange(editValue);
    setIsEditing(false);
    setShowSuggestions(false);
  };

  const handleInputChange = (newValue: string) => {
    setEditValue(newValue);
    // Show suggestions when typing var or --
    if (newValue.includes('var') || newValue.includes('--') || (newValue.length > 0 && !newValue.startsWith('#'))) {
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
    }
  };

  const handleSelectVariable = (variable: ColorVariable) => {
    setEditValue(variable.usage);
    onChange(variable.usage);
    setShowDropdown(false);
    setShowSuggestions(false);
    setIsEditing(false);
  };

  const handleBlur = () => {
    // Small delay to allow click on suggestion
    setTimeout(() => {
      if (!showDropdown && !showSuggestions) {
        commitValue();
      }
    }, 150);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitValue();
    } else if (e.key === 'Escape') {
      setEditValue(value);
      setIsEditing(false);
      setShowSuggestions(false);
    }
  };

  // Convert resolved color to hex for the picker
  const hexForPicker = useMemo(() => {
    const v = resolvedValue.trim().toLowerCase();
    // Already hex
    if (v.startsWith('#')) {
      return v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v.slice(0, 7);
    }
    // RGB/RGBA
    const rgbMatch = v.match(/rgba?\((\d+),?\s*(\d+),?\s*(\d+)/);
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1]!, 10).toString(16).padStart(2, '0');
      const g = parseInt(rgbMatch[2]!, 10).toString(16).padStart(2, '0');
      const b = parseInt(rgbMatch[3]!, 10).toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }
    // OKLCH - approximate conversion for the color picker
    // For oklch(L C H), L is lightness 0-1, convert to grayscale hex as approximation
    const oklchMatch = v.match(/oklch\(\s*([\d.]+)/);
    if (oklchMatch) {
      const lightness = Math.max(0, Math.min(1, parseFloat(oklchMatch[1]!)));
      const gray = Math.round(lightness * 255).toString(16).padStart(2, '0');
      return `#${gray}${gray}${gray}`;
    }
    // Fall back to black if we can't parse
    return '#000000';
  }, [resolvedValue]);

  const handleColorPickerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value;
    setEditValue(newColor);
    onChange(newColor);
  };

  // Check if value is a variable
  const isVariable = value.includes('var(');

  return (
    <div
      ref={containerRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        borderRadius: 2,
        border: '1px solid',
        borderColor: isEditing ? accentColor : hovered ? 'rgba(0,0,0,0.15)' : 'transparent',
        backgroundColor: FIELD_BG,
        transition: 'border-color 100ms ease',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        {/* Color swatch / picker */}
        <div style={{ position: 'relative', marginLeft: 8, flexShrink: 0 }}>
          <input
            type="color"
            value={hexForPicker}
            onChange={handleColorPickerChange}
            style={{
              width: 12,
              height: 12,
              padding: 0,
              border: 'none',
              cursor: 'pointer',
              opacity: 0,
              position: 'absolute',
              top: 0,
              left: 0,
            }}
          />
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 2,
              backgroundColor: resolvedValue,
              border: '1px solid rgba(0,0,0,0.1)',
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* Text input */}
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            style={{
              ...compactInputStyle,
              flex: 1,
              minWidth: 0,
            }}
          />
        ) : (
          <span
            onClick={() => setIsEditing(true)}
            style={{
              flex: 1,
              minWidth: 0,
              padding: '4px 8px',
              fontSize: 11,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
              cursor: 'text',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: modified ? accentColor : 'inherit',
            }}
            title={displayValue}
          >
            {displayValue}
          </span>
        )}

        {/* Dropdown arrow - only show if there are variables */}
        {colorVariables.length > 0 && (
          <button
            type="button"
            onClick={() => setShowDropdown(!showDropdown)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 24,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: '#999',
              flexShrink: 0,
            }}
          >
            <ChevronDown size={12} />
          </button>
        )}
      </div>

      {/* Suggestions dropdown (when typing) */}
      {showSuggestions && suggestions.length > 0 && (
        <div
          style={{
            ...getDropdownStyle(),
            backgroundColor: '#ffffff',
            border: '1px solid rgba(0,0,0,0.1)',
            borderRadius: 0,
            zIndex: 10001,
            maxHeight: 200,
            overflowY: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          }}
        >
          {suggestions.map((variable) => (
            <button
              key={variable.name}
              type="button"
              onClick={() => handleSelectVariable(variable)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                border: 'none',
                backgroundColor: 'transparent',
                color: '#1e293b',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 12,
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 2,
                  backgroundColor: variable.value,
                  border: '1px solid rgba(0,0,0,0.1)',
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {variable.name}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Variables dropdown (from arrow click) */}
      {showDropdown && (
        <div
          ref={dropdownRef}
          style={{
            ...getDropdownStyle(),
            backgroundColor: '#ffffff',
            border: '1px solid rgba(0,0,0,0.1)',
            borderRadius: 0,
            zIndex: 10001,
            maxHeight: 280,
            overflowY: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          }}
        >
          {colorVariables.map((variable) => (
            <button
              key={variable.name}
              type="button"
              onClick={() => handleSelectVariable(variable)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                border: 'none',
                backgroundColor: (displayValue === variable.usage || value === variable.usage) ? '#f1f5f9' : 'transparent',
                color: '#1e293b',
                fontWeight: (displayValue === variable.usage || value === variable.usage) ? 600 : 400,
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 12,
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 2,
                  backgroundColor: variable.value,
                  border: '1px solid rgba(0,0,0,0.1)',
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {variable.name}
              </span>
              {(displayValue === variable.usage || value === variable.usage) && (
                <Check size={14} style={{ marginLeft: 'auto', flexShrink: 0 }} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function StylePanel({
  element,
  elementInfo,
  selector,
  styleModifications,
  dispatch,
  onClose,
  onHover,
  accentColor = '#3b82f6',
  toolbarRef,
}: StylePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const panelContentRef = useRef<HTMLDivElement>(null);

  // Delayed fade-in to avoid flash at (0,0) before positioning.
  // Skip if we have a saved position — panel won't jump so no flash.
  const [visible, setVisible] = useState(() => {
    try { return !!localStorage.getItem('devtools-panel-position'); } catch { return false; }
  });
  useEffect(() => {
    if (visible) return;
    const id = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(id);
  }, [visible]);

  // Track which dropdown is open globally (for dimming sibling sections)
  const [activeDropdown, setActiveDropdown] = useState<'width' | 'height' | null>(null);
  // Track which color dropdown is open
  const [activeColorDropdown, setActiveColorDropdown] = useState<string | null>(null);
  const hasActiveDropdown = activeDropdown !== null || activeColorDropdown !== null;

  // Panel-wide unit preference — cycles between rem and px
  const [preferredUnit, setPreferredUnit] = useState<'rem' | 'px'>('rem');
  const cycleUnit = useCallback(() => {
    setPreferredUnit(u => u === 'rem' ? 'px' : 'rem');
  }, []);


  // Track original values for this element
  const originalValuesRef = useRef<Map<string, string>>(new Map());

  // Raw CSS textarea value
  const [rawCss, setRawCss] = useState('');

  // Color variables from document
  const colorVariables = useMemo(() => getColorVariables(), []);

  // Escape key closes panel when no dropdowns open and no fields focused
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      // Check if a field inside the panel is focused
      const active = document.activeElement;
      if (active && panelRef.current?.contains(active)) return;

      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Position the panel near the element - use direct DOM updates for smooth scrolling
  const positionRef = useRef({ top: 0, left: 0, maxHeight: 400 });
  const [, forceUpdate] = useState(0);

  // Draggable header — persisted to localStorage
  const PANEL_POS_KEY = 'devtools-panel-position';
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragState = useRef<{ startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(null);
  const hasSavedPosition = useRef(false);

  // On mount, check for a saved position
  useEffect(() => {
    try {
      const stored = localStorage.getItem(PANEL_POS_KEY);
      if (stored) {
        const pos = JSON.parse(stored);
        if (typeof pos.top === 'number' && typeof pos.left === 'number') {
          hasSavedPosition.current = true;
          positionRef.current = { ...positionRef.current, top: pos.top, left: pos.left };
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const ds = dragState.current;
      if (!ds) return;
      const rawX = ds.startOffsetX + (e.clientX - ds.startX);
      const rawY = ds.startOffsetY + (e.clientY - ds.startY);

      // Clamp so the panel stays within 16px of left/top/right edges
      const panelWidth = 280;
      const edgePad = 16;
      const clampedLeft = Math.max(edgePad, Math.min(window.innerWidth - panelWidth - edgePad, positionRef.current.left + rawX));
      const clampedTop = Math.max(edgePad, positionRef.current.top + rawY);

      dragOffset.current = {
        x: clampedLeft - positionRef.current.left,
        y: clampedTop - positionRef.current.top,
      };
      const panel = panelRef.current;
      const wrapper = panel?.parentElement;
      if (!wrapper) return;

      wrapper.style.top = `${clampedTop}px`;
      wrapper.style.left = `${clampedLeft}px`;

      // Recalculate max height based on dragged position vs toolbar
      const toolbarRect = toolbarRef?.current?.getBoundingClientRect();
      let bottomLimit = window.innerHeight - 16;
      if (toolbarRect && clampedLeft + panelWidth > toolbarRect.left) {
        bottomLimit = toolbarRect.top - 8;
      }
      const visibleTop = Math.max(0, clampedTop);
      const maxHeight = Math.max(200, bottomLimit - visibleTop);
      if (panel) panel.style.maxHeight = `${maxHeight}px`;
    };
    const onMouseUp = () => {
      if (!dragState.current) return;
      // Persist final absolute position
      const finalTop = positionRef.current.top + dragOffset.current.y;
      const finalLeft = positionRef.current.left + dragOffset.current.x;
      positionRef.current = { ...positionRef.current, top: finalTop, left: finalLeft };
      dragOffset.current = { x: 0, y: 0 };
      hasSavedPosition.current = true;
      try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ top: finalTop, left: finalLeft })); } catch { /* ignore */ }
      dragState.current = null;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag on left-click, ignore if clicking buttons inside header
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startOffsetX: dragOffset.current.x,
      startOffsetY: dragOffset.current.y,
    };
  }, []);

  useEffect(() => {
    // Reset drag offset when inspecting a new element
    dragOffset.current = { x: 0, y: 0 };

    const updatePosition = (isScrollEvent = false) => {
      const panel = panelRef.current;
      const panelWidth = 280;
      const gap = 8;

      let top: number;
      let left: number;

      if (hasSavedPosition.current) {
        // Use persisted position — don't follow element
        top = positionRef.current.top;
        left = positionRef.current.left;
      } else {
        // Default: position relative to element
        const rect = element.getBoundingClientRect();
        left = rect.right + gap;
        top = rect.top;

        if (left + panelWidth > window.innerWidth - gap) {
          left = rect.left - panelWidth - gap;
        }
        if (left < gap) {
          left = Math.max(gap, (window.innerWidth - panelWidth) / 2);
        }
      }

      // Measure toolbar to avoid overlapping it
      const toolbarRect = toolbarRef?.current?.getBoundingClientRect();

      let bottomLimit = window.innerHeight - 16;
      if (toolbarRect) {
        const panelRight = left + panelWidth;
        if (panelRight > toolbarRect.left) {
          bottomLimit = toolbarRect.top - gap;
        }
      }

      const visibleTop = Math.max(0, top);
      const maxHeight = Math.max(200, bottomLimit - visibleTop);

      positionRef.current = { top, left, maxHeight };

      // During scroll, update DOM directly for smoothness
      if (isScrollEvent && panel) {
        const wrapper = panel.parentElement;
        if (wrapper && !hasSavedPosition.current) {
          wrapper.style.top = `${top + dragOffset.current.y}px`;
          wrapper.style.left = `${left + dragOffset.current.x}px`;
        }
        panel.style.maxHeight = `${maxHeight}px`;
      } else {
        forceUpdate(n => n + 1);
      }
    };

    updatePosition(false);

    const onScroll = () => updatePosition(true);
    const onResize = () => updatePosition(false);

    // Recalculate on scroll and resize
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [element]);

  // Block page-level scroll when mouse is over the panel
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onWheel = (e: WheelEvent) => {
      const scrollable = panelContentRef.current;
      if (!scrollable) { e.preventDefault(); return; }
      const { scrollTop, scrollHeight, clientHeight } = scrollable;
      const atTop = scrollTop <= 0 && e.deltaY < 0;
      const atBottom = scrollTop + clientHeight >= scrollHeight && e.deltaY > 0;
      // Only prevent if scrollable content wouldn't scroll (avoid trapping)
      if (atTop || atBottom) {
        e.preventDefault();
      }
    };
    panel.addEventListener('wheel', onWheel, { passive: false });
    return () => panel.removeEventListener('wheel', onWheel);
  }, []);

  // Get current modification for this element
  const currentModification = useMemo(() => {
    return styleModifications.find(m => m.selector === selector);
  }, [styleModifications, selector]);

  // Get the current value for a property (modified or computed)
  const getValue = useCallback((property: string): string => {
    // Check if we have a modification
    const change = currentModification?.changes.find(c => c.property === property);
    if (change) {
      return change.modified;
    }
    // For color properties, try to preserve var() references from inline styles
    if (property.includes('color')) {
      const rawValue = getRawStyleValue(element, property);
      if (rawValue && rawValue.includes('var(')) {
        return rawValue;
      }
    }
    // Otherwise get computed value
    return getComputedStyleValue(element, property);
  }, [element, currentModification]);

  // Get the original value (before any modifications)
  const getOriginalValue = useCallback((property: string): string => {
    // Check cache first
    if (originalValuesRef.current.has(property)) {
      return originalValuesRef.current.get(property)!;
    }
    // Check if we have a stored original in modifications
    const change = currentModification?.changes.find(c => c.property === property);
    if (change) {
      return change.original;
    }
    // Otherwise get computed value and cache it
    const computed = getComputedStyleValue(element, property);
    originalValuesRef.current.set(property, computed);
    return computed;
  }, [element, currentModification]);

  // Handle property change
  const handleChange = useCallback((property: string, value: string) => {
    const original = getOriginalValue(property);

    // Apply immediately to DOM
    applyInlineStyle(element, property, value);

    // Also apply -webkit- prefix for backdrop-filter (Safari)
    if (property === 'backdrop-filter') {
      applyInlineStyle(element, '-webkit-backdrop-filter', value);
    }

    // Dispatch to state
    dispatch({
      type: 'MODIFY_STYLE',
      payload: {
        selector,
        element: elementInfo,
        property,
        original,
        modified: value,
      },
    });
  }, [element, selector, elementInfo, dispatch, getOriginalValue]);

  // Handle reset for this element
  const handleReset = useCallback(() => {
    revertElementStyles(selector, styleModifications);
    // Clear all changes for this selector
    const mod = styleModifications.find(m => m.selector === selector);
    if (mod) {
      for (const change of mod.changes) {
        dispatch({
          type: 'CLEAR_STYLE',
          payload: { selector, property: change.property },
        });
      }
    }
    originalValuesRef.current.clear();
  }, [selector, styleModifications, dispatch]);

  // Handle reset for a single property
  const handleResetProperty = useCallback((property: string) => {
    const mod = styleModifications.find(m => m.selector === selector);
    const change = mod?.changes.find(c => c.property === property);
    if (change && element instanceof HTMLElement) {
      // Revert the inline style
      element.style.removeProperty(property);
      // Clear from state
      dispatch({
        type: 'CLEAR_STYLE',
        payload: { selector, property },
      });
      // Clear from cache
      originalValuesRef.current.delete(property);
    }
  }, [element, selector, styleModifications, dispatch]);

  // Handle raw CSS apply
  const handleApplyRawCss = useCallback(() => {
    // Parse raw CSS (simple property: value; format)
    const lines = rawCss.split(';').map(l => l.trim()).filter(l => l);
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const property = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        if (property && value) {
          handleChange(property, value);
        }
      }
    }
    setRawCss('');
  }, [rawCss, handleChange]);

  // Toggle section collapse
  // Check if a property has been modified
  const isModified = useCallback((property: string): boolean => {
    return currentModification?.changes.some(c => c.property === property) ?? false;
  }, [currentModification]);

  // InputWrapper is defined at module level to prevent re-creation

  // Render a property input based on type
  const renderInput = (config: PropertyConfig) => {
    const value = getValue(config.property);
    const modified = isModified(config.property);
    const isDefault = !modified && isDefaultValue(config.property, value);

    const inputStyle: CSSProperties = {
      width: '100%',
      padding: '4px 8px',
      fontSize: 11,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      border: 'none',
      borderRadius: 2,
      outline: 'none',
      backgroundColor: 'transparent',
    };

    // For default values, show a gray hyphen placeholder (except backdrop-filter which has its own empty UI)
    if (isDefault && config.type !== 'backdrop-filter') {
      return (
        <InputWrapper modified={false}>
          <input
            type="text"
            value=""
            placeholder="—"
            onFocus={() => {
              // On focus, switch to the real value for editing
            }}
            onChange={(e) => handleChange(config.property, e.target.value)}
            style={{ ...inputStyle, color: '#999' }}
          />
        </InputWrapper>
      );
    }

    switch (config.type) {
      case 'color': {
        // Resolve the color for the swatch preview
        const resolvedColor = resolveColorValue(element, value);
        // Find matching variable if value is not already a var()
        const matchingVar = value.includes('var(') ? null : findMatchingColorVariable(resolvedColor, colorVariables);
        return (
          <ColorInput
            value={value}
            resolvedValue={resolvedColor}
            colorVariables={colorVariables}
            matchingVariable={matchingVar}
            onChange={(newValue) => handleChange(config.property, newValue)}
            accentColor={accentColor}
            modified={modified}
            panelContentRef={panelContentRef}
            isDropdownOpen={activeColorDropdown === config.property}
            onDropdownChange={(open) => setActiveColorDropdown(open ? config.property : null)}
          />
        );
      }

      case 'number': {
        const hasUnits = !!PROPERTY_UNITS[config.property];
        if (hasUnits) {
          return (
            <InputWrapper modified={modified}>
              <UnitInput
                property={config.property}
                value={value}
                onChange={(v) => handleChange(config.property, v)}
                isModified={modified}
                min={config.min}
                max={config.max}
                step={config.step || 1}
                style={{ ...inputStyle, paddingRight: 32 }}
                unitStyle={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontSize: 10,
                  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                  color: '#999',
                }}
                preferredUnit={preferredUnit}
                onUnitCycle={cycleUnit}
              />
            </InputWrapper>
          );
        }
        // No unit support (e.g., opacity) - plain number input
        const { num } = parseValue(value);
        return (
          <InputWrapper modified={modified}>
            <input
              type="number"
              value={num}
              min={config.min}
              max={config.max}
              step={config.step || 1}
              onChange={(e) => handleChange(config.property, e.target.value)}
              style={inputStyle}
            />
          </InputWrapper>
        );
      }

      case 'select':
        return (
          <InputWrapper modified={modified}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <select
                value={value}
                onChange={(e) => handleChange(config.property, e.target.value)}
                style={{ ...inputStyle, cursor: 'pointer', paddingLeft: 4, paddingRight: 24, appearance: 'none', WebkitAppearance: 'none' }}
              >
                {config.options?.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
              <div style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#999', display: 'flex', alignItems: 'center' }}>
                <ChevronDown size={12} />
              </div>
            </div>
          </InputWrapper>
        );

      case 'spacing': {
        // For padding/margin, show a single input that accepts CSS shorthand
        return (
          <InputWrapper modified={modified}>
            <input
              type="text"
              value={value}
              onChange={(e) => handleChange(config.property, e.target.value)}
              placeholder="e.g., 10px or 10px 20px"
              style={inputStyle}
            />
          </InputWrapper>
        );
      }

      case 'backdrop-filter':
        return (
          <BackdropFilterEditor
            value={value}
            onChange={(v) => handleChange(config.property, v)}
            accentColor={accentColor}
            modified={modified}
            panelContentRef={panelContentRef}
          />
        );

      case 'text':
      default:
        return (
          <InputWrapper modified={modified}>
            <input
              type="text"
              value={value}
              onChange={(e) => handleChange(config.property, e.target.value)}
              style={inputStyle}
            />
          </InputWrapper>
        );
    }
  };

  const modificationCount = currentModification?.changes.length ?? 0;
  const isCaptured = currentModification?.captured ?? false;

  const panelStyle: CSSProperties = {
    position: 'fixed',
    top: positionRef.current.top,
    left: positionRef.current.left,
    width: 280,
    maxHeight: positionRef.current.maxHeight,
    backgroundColor: 'rgba(255, 255, 255, 0.85)',
    backdropFilter: 'blur(32px)',
    WebkitBackdropFilter: 'blur(32px)',
    ...POPMELT_BORDER,
    zIndex: 10000,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: 12,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    opacity: visible ? 1 : 0,
    transition: 'opacity 150ms ease',
  };


  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    margin: '3px 3px 0',
    padding: '8px 7px 8px 12px',
    borderBottom: '1px solid rgba(0,0,0,0.1)',
    backgroundColor: '#f8fafc',
    cursor: dragState.current ? 'grabbing' : 'grab',
  };

  const sectionHeaderStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 12px 6px',
    userSelect: 'none',
    fontSize: 11,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontWeight: 600,
    color: '#475569',
  };

  const propertyRowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 12px',
    gap: 8,
  };

  const labelStyle: CSSProperties = {
    width: 80,
    fontSize: 11,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    color: '#64748b',
    flexShrink: 0,
  };

  return (
    <div data-devtools="panel-wrapper" style={{
      position: 'fixed',
      top: positionRef.current.top + dragOffset.current.y,
      left: positionRef.current.left + dragOffset.current.x,
      zIndex: 10000,
      pointerEvents: 'none',
    }}>
    <div ref={panelRef} data-devtools="panel" style={{ ...panelStyle, position: 'relative', top: 0, left: 0, zIndex: 0, pointerEvents: 'auto' }} onMouseEnter={() => onHover?.('element')} onMouseLeave={() => onHover?.(null)}>
      {/* Header */}
      <div style={headerStyle} onMouseDown={handleHeaderMouseDown}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          <span style={{
            fontWeight: 600,
            fontSize: 11,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {elementInfo.tagName}
          </span>
          {modificationCount > 0 && (
            <span style={{
              backgroundColor: isCaptured ? '#999999' : accentColor,
              color: '#fff',
              fontSize: 9,
              padding: '1px 4px',
              borderRadius: 2,
            }}>
              {modificationCount}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {modificationCount > 0 && (
            <button
              type="button"
              onClick={handleReset}
              title="Reset all changes"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                color: '#64748b',
                borderRadius: 2,
              }}
            >
              <RotateCcw size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: '#64748b',
              borderRadius: 2,
            }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div ref={panelContentRef} style={{ flex: 1, overflowY: 'auto', margin: '0 3px 3px' }}>
        {/* Layout Section - Custom Figma-style controls */}
        <div style={{ opacity: activeColorDropdown ? 0.3 : 1, transition: 'opacity 150ms ease' }}>
          <LayoutSection
            element={element}
            getValue={getValue}
            getOriginalValue={getOriginalValue}
            handleChange={handleChange}
            isModified={isModified}
            onResetProperty={handleResetProperty}
            isCollapsed={false}
            onToggle={() => {}}
            sectionHeaderStyle={sectionHeaderStyle}
            activeDropdown={activeDropdown}
            onDropdownChange={setActiveDropdown}
            panelContentRef={panelContentRef}
            accentColor={accentColor}
            onFieldHover={onHover}
            preferredUnit={preferredUnit}
            onUnitCycle={cycleUnit}
          />
        </div>

        {/* Typography Section - Custom Figma-style controls */}
        <div style={{ opacity: activeDropdown ? 0.3 : 1, transition: 'opacity 150ms ease' }}>
          <TypographySection
            element={element}
            getValue={getValue}
            handleChange={handleChange}
            isModified={isModified}
            onResetProperty={handleResetProperty}
            isCollapsed={false}
            onToggle={() => {}}
            sectionHeaderStyle={sectionHeaderStyle}
            accentColor={accentColor}
            colorVariables={colorVariables}
            activeColorDropdown={activeColorDropdown}
            onColorDropdownChange={setActiveColorDropdown}
            panelContentRef={panelContentRef}
            preferredUnit={preferredUnit}
            onUnitCycle={cycleUnit}
          />
        </div>

        {/* Property sections */}
        {SECTIONS.map((section, index) => {
          const isLast = index === SECTIONS.length - 1;
          // Check if this section contains the active color dropdown
          const sectionHasActiveColorDropdown = activeColorDropdown && section.properties.some(p => p.property === activeColorDropdown);
          // Only fade if there's an active dropdown and this section doesn't have it
          const shouldFadeSection = hasActiveDropdown && !sectionHasActiveColorDropdown;
          return (
            <div key={section.name} style={{ borderBottom: isLast ? 'none' : '1px solid rgba(0,0,0,0.08)', opacity: shouldFadeSection ? 0.3 : 1, transition: 'opacity 150ms ease' }}>
              <div style={sectionHeaderStyle}>
                <span>{section.name}</span>
              </div>
              <div style={{ padding: '4px 0' }}>
                {section.properties.map(prop => {
                  const modified = isModified(prop.property);
                  // Fade individual rows if there's an active dropdown in this section but not this row
                  const shouldFadeRow = sectionHasActiveColorDropdown && prop.property !== activeColorDropdown;
                  return (
                    <div key={prop.property} style={{ ...propertyRowStyle, opacity: shouldFadeRow ? 0.3 : 1, transition: 'opacity 150ms ease' }}>
                      <span
                        onClick={modified ? () => handleResetProperty(prop.property) : undefined}
                        title={modified ? 'Click to reset' : undefined}
                        style={{
                          ...labelStyle,
                          color: modified ? accentColor : '#64748b',
                          fontWeight: modified ? 600 : 400,
                          cursor: modified ? 'pointer' : 'default',
                        }}
                      >{prop.label}</span>
                      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                        {renderInput(prop)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Raw CSS section */}
        <div style={{ opacity: hasActiveDropdown ? 0.3 : 1, transition: 'opacity 150ms ease' }}>
          <div style={sectionHeaderStyle}>
            <span>Raw CSS</span>
          </div>
          <div style={{ padding: '8px 12px' }}>
            <textarea
                value={rawCss}
                onChange={(e) => setRawCss(e.target.value)}
                placeholder="property: value; ..."
                style={{
                  width: '100%',
                  height: 60,
                  padding: 8,
                  fontSize: 11,
                  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                  border: '1px solid rgba(0,0,0,0.1)',
                  borderRadius: 2,
                  resize: 'vertical',
                  outline: 'none',
                }}
              />
              {rawCss.trim() && (
              <button
                type="button"
                onClick={handleApplyRawCss}
                style={{
                  marginTop: 4,
                  padding: '4px 8px',
                  width: '100%',
                  fontSize: 11,
                  border: 'none',
                  borderRadius: 2,
                  backgroundColor: accentColor,
                  color: '#fff',
                  cursor: 'pointer',
                  opacity: rawCss.trim() ? 1 : 0.5,
                }}
              >
                Apply
              </button>
              )}
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}
