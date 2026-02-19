'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';

import { InputWrapper } from '../StylePanel';

// Backdrop filter definitions
export type FilterDef = {
  name: string;
  label: string;
  unit: string;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
};

export const BACKDROP_FILTERS: FilterDef[] = [
  { name: 'blur', label: 'Blur', unit: 'px', defaultValue: 10, min: 0, max: 100, step: 1 },
  { name: 'brightness', label: 'Brightness', unit: '', defaultValue: 1, min: 0, max: 3, step: 0.05 },
  { name: 'contrast', label: 'Contrast', unit: '', defaultValue: 1, min: 0, max: 3, step: 0.05 },
  { name: 'saturate', label: 'Saturate', unit: '', defaultValue: 1, min: 0, max: 3, step: 0.05 },
  { name: 'grayscale', label: 'Grayscale', unit: '', defaultValue: 0, min: 0, max: 1, step: 0.05 },
  { name: 'sepia', label: 'Sepia', unit: '', defaultValue: 0, min: 0, max: 1, step: 0.05 },
  { name: 'invert', label: 'Invert', unit: '', defaultValue: 0, min: 0, max: 1, step: 0.05 },
  { name: 'hue-rotate', label: 'Hue Rotate', unit: 'deg', defaultValue: 0, min: 0, max: 360, step: 1 },
  { name: 'opacity', label: 'Opacity', unit: '', defaultValue: 1, min: 0, max: 1, step: 0.05 },
];

export type ActiveFilter = { name: string; value: number };

export function parseBackdropFilter(raw: string): ActiveFilter[] {
  if (!raw || raw === 'none') return [];
  const filters: ActiveFilter[] = [];
  // Match patterns like blur(10px), saturate(1.5), hue-rotate(90deg)
  const regex = /([\w-]+)\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const name = match[1]!;
    const valStr = match[2]!;
    const num = parseFloat(valStr);
    if (!isNaN(num)) {
      filters.push({ name, value: num });
    }
  }
  return filters;
}

export function serializeBackdropFilter(filters: ActiveFilter[]): string {
  if (filters.length === 0) return 'none';
  return filters.map(f => {
    const def = BACKDROP_FILTERS.find(d => d.name === f.name);
    const unit = def?.unit ?? '';
    return `${f.name}(${f.value}${unit})`;
  }).join(' ');
}

export function BackdropFilterEditor({
  value,
  onChange,
  accentColor,
  modified,
  panelContentRef,
}: {
  value: string;
  onChange: (value: string) => void;
  accentColor: string;
  modified: boolean;
  panelContentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const filters = parseBackdropFilter(value);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!showAddMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [showAddMenu]);

  const availableFilters = BACKDROP_FILTERS.filter(
    def => !filters.some(f => f.name === def.name)
  );

  const handleAdd = (def: FilterDef) => {
    const next = [...filters, { name: def.name, value: def.defaultValue }];
    onChange(serializeBackdropFilter(next));
    setShowAddMenu(false);
  };

  const handleRemove = (index: number) => {
    const next = filters.filter((_, i) => i !== index);
    onChange(serializeBackdropFilter(next));
  };

  const handleFilterChange = (index: number, newValue: number) => {
    const next = filters.map((f, i) => i === index ? { ...f, value: newValue } : f);
    onChange(serializeBackdropFilter(next));
  };

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

  // Get fixed-position dropdown style (panel-relative due to backdrop-filter containing block).
  // Opens upward if there isn't enough room below.
  const getMenuStyle = useCallback((itemCount: number): CSSProperties => {
    if (!addBtnRef.current) return { position: 'fixed', top: 0, left: 0 };
    const btnRect = addBtnRef.current.getBoundingClientRect();
    const panelEl = addBtnRef.current.closest('[data-devtools="panel"]');
    const panelBounds = panelEl ? panelEl.getBoundingClientRect() : { top: 0, left: 0, bottom: 9999 };
    const contentRect = panelContentRef?.current?.getBoundingClientRect();
    // Estimate menu height: ~24px per item + 8px padding
    const estimatedHeight = itemCount * 24 + 8;
    const spaceBelow = panelBounds.bottom - btnRect.bottom;
    const openUpward = spaceBelow < estimatedHeight;
    return {
      position: 'fixed',
      ...(openUpward
        ? { bottom: panelBounds.bottom - btnRect.top + 2 - panelBounds.top }
        : { top: btnRect.bottom + 2 - panelBounds.top }),
      left: contentRect ? contentRect.left + 4 - panelBounds.left : btnRect.left - panelBounds.left,
      width: contentRect ? contentRect.width - 8 : 140,
      zIndex: 10001,
    };
  }, [panelContentRef]);

  const menuStyle: CSSProperties = {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    border: '1px solid rgba(0,0,0,0.1)',
    borderRadius: 4,
    padding: '4px 0',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  };

  const menuItemStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '4px 10px',
    border: 'none',
    backgroundColor: 'transparent',
    fontSize: 11,
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    color: '#334155',
    cursor: 'pointer',
    textAlign: 'left',
  };

  // Render the filter menu items
  const renderMenu = (items: FilterDef[]) => (
    <div ref={menuRef} style={{ ...getMenuStyle(items.length), ...menuStyle }}>
      {items.map(def => (
        <button
          key={def.name}
          type="button"
          onClick={() => handleAdd(def)}
          style={menuItemStyle}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.05)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          {def.label}
        </button>
      ))}
    </div>
  );

  // No active filters - show placeholder with add button
  if (filters.length === 0) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <InputWrapper modified={false}>
            <input
              type="text"
              value=""
              placeholder="—"
              readOnly
              style={{ ...inputStyle, color: '#999', cursor: 'default' }}
            />
          </InputWrapper>
          <button
            ref={addBtnRef}
            type="button"
            onClick={() => setShowAddMenu(!showAddMenu)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 20,
              padding: 0,
              border: 'none',
              borderRadius: 2,
              backgroundColor: 'transparent',
              color: '#94a3b8',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Plus size={12} />
          </button>
        </div>
        {showAddMenu && renderMenu(BACKDROP_FILTERS)}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, position: 'relative' }}>
      {filters.map((f, index) => {
        const def = BACKDROP_FILTERS.find(d => d.name === f.name);
        if (!def) return null;
        return (
          <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              fontSize: 10,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
              color: modified ? accentColor : '#94a3b8',
              fontWeight: modified ? 600 : 400,
              width: 56,
              flexShrink: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {def.label}
            </span>
            <InputWrapper modified={modified}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px' }}>
                <input
                  type="range"
                  min={def.min}
                  max={def.max}
                  step={def.step}
                  value={f.value}
                  onChange={(e) => handleFilterChange(index, parseFloat(e.target.value))}
                  style={{
                    flex: 1,
                    height: 2,
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    background: `linear-gradient(to right, ${accentColor} ${((f.value - def.min) / (def.max - def.min)) * 100}%, rgba(0,0,0,0.1) ${((f.value - def.min) / (def.max - def.min)) * 100}%)`,
                    borderRadius: 1,
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                />
                <input
                  type="number"
                  min={def.min}
                  max={def.max}
                  step={def.step}
                  value={def.unit === 'px' || def.unit === 'deg' ? Math.round(f.value) : Math.round(f.value * 100) / 100}
                  onChange={(e) => handleFilterChange(index, parseFloat(e.target.value) || 0)}
                  style={{
                    ...inputStyle,
                    width: 44,
                    padding: '2px 4px',
                    textAlign: 'right',
                    flexShrink: 0,
                  }}
                />
                {def.unit && (
                  <span style={{
                    fontSize: 9,
                    color: '#94a3b8',
                    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                    flexShrink: 0,
                    width: 16,
                  }}>
                    {def.unit}
                  </span>
                )}
              </div>
            </InputWrapper>
            <button
              type="button"
              onClick={() => handleRemove(index)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 16,
                height: 16,
                padding: 0,
                border: 'none',
                borderRadius: 2,
                backgroundColor: 'transparent',
                color: '#94a3b8',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
      {availableFilters.length > 0 && (
        <div>
          <button
            ref={addBtnRef}
            type="button"
            onClick={() => setShowAddMenu(!showAddMenu)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 4px',
              border: 'none',
              borderRadius: 2,
              backgroundColor: 'transparent',
              fontSize: 10,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
              color: '#94a3b8',
              cursor: 'pointer',
            }}
          >
            <Plus size={10} />
            Add filter
          </button>
          {showAddMenu && renderMenu(availableFilters)}
        </div>
      )}
    </div>
  );
}
