'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlignHorizontalSpaceAround, AlignVerticalSpaceAround, Columns3, Grid2x2, RectangleHorizontal, Rows3, UnfoldHorizontal, UnfoldVertical } from 'lucide-react';

import { colorWithAlpha } from '../../utils/color';
import { getAuthoredStyleValue, applyInlineStyle } from '../../utils/dom';
import {
  UnitInput,
  DimensionField,
  FieldWrapper,
  FIELD_BG,
  compactInputStyle,
  parseSpacing,
  SizingMode,
  getSizingMode,
  getSizingValue,
  DisplayMode,
  getDisplayMode,
  applyDisplayMode,
} from '../StylePanel';
import { ScrubLabel, PADDING_SNAP_STEPS } from './ScrubLabel';

// Grid dimensions control - at module level to prevent defocusing
function GridDimensions({
  gridCols,
  gridRows,
  gridModified,
  accentColor,
  onColsChange,
  onRowsChange,
}: {
  gridCols: number;
  gridRows: number;
  gridModified: boolean;
  accentColor: string;
  onColsChange: (cols: number) => void;
  onRowsChange: (rows: number) => void;
}) {
  return (
    <FieldWrapper style={{ width: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 4px' }}>
        <input
          type="number"
          min={1}
          max={12}
          value={gridCols}
          onChange={(e) => onColsChange(parseInt(e.target.value) || 1)}
          style={{ ...compactInputStyle, width: 32, textAlign: 'center', padding: 2 }}
        />
        <span style={{
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          color: gridModified ? accentColor : '#999',
          fontWeight: gridModified ? 600 : 400,
          fontSize: 11,
          margin: '0 4px',
        }}>{'\u00d7'}</span>
        <input
          type="number"
          min={1}
          max={12}
          value={gridRows}
          onChange={(e) => onRowsChange(parseInt(e.target.value) || 1)}
          style={{ ...compactInputStyle, width: 32, textAlign: 'center', padding: 2 }}
        />
      </div>
    </FieldWrapper>
  );
}

// Custom Layout Section Component
export type LayoutSectionProps = {
  element: Element;
  getValue: (property: string) => string;
  getOriginalValue: (property: string) => string;
  handleChange: (property: string, value: string) => void;
  isModified: (property: string) => boolean;
  onResetProperty: (property: string) => void;
  isCollapsed: boolean;
  onToggle: () => void;
  sectionHeaderStyle: CSSProperties;
  activeDropdown: 'width' | 'height' | null;
  onDropdownChange: (dropdown: 'width' | 'height' | null) => void;
  panelContentRef: React.RefObject<HTMLDivElement | null>;
  accentColor: string;
  onFieldHover?: (hint: string | null) => void;
  preferredUnit: 'rem' | 'px';
  onUnitCycle: () => void;
};

export function LayoutSection({
  element,
  getValue,
  getOriginalValue,
  handleChange,
  isModified,
  onResetProperty,
  isCollapsed,
  onToggle,
  sectionHeaderStyle,
  activeDropdown,
  onDropdownChange,
  panelContentRef,
  accentColor,
  onFieldHover,
  preferredUnit,
  onUnitCycle,
}: LayoutSectionProps) {
  const setActiveDropdown = onDropdownChange;

  const display = getValue('display');
  const flexDirection = getValue('flex-direction');
  const displayMode = getDisplayMode(display, flexDirection);
  const isFlex = display === 'flex' || display === 'inline-flex';
  const isGrid = display === 'grid';
  const isFlexOrGrid = isFlex || isGrid;

  const width = getValue('width');
  const height = getValue('height');
  // Use authored value to detect if width/height is explicitly set, but
  // if the user has modified it in the panel, treat the modified value as authored
  const authoredWidth = isModified('width') ? width : getAuthoredStyleValue(element, 'width');
  const authoredHeight = isModified('height') ? height : getAuthoredStyleValue(element, 'height');
  const widthMode = getSizingMode(width, authoredWidth);
  const heightMode = getSizingMode(height, authoredHeight);

  const minWidth = getValue('min-width');
  const maxWidth = getValue('max-width');
  const minHeight = getValue('min-height');
  const maxHeight = getValue('max-height');

  const padding = parseSpacing(getValue('padding'));
  const gap = getValue('gap');
  const rowGap = getValue('row-gap');
  const columnGap = getValue('column-gap');
  const gridTemplateCols = getValue('grid-template-columns');
  const gridTemplateRows = getValue('grid-template-rows');
  const overflow = getValue('overflow');

  // Parse grid template to count columns/rows
  const gridCols = gridTemplateCols.split(/\s+/).filter(v => v && v !== 'none').length || 1;
  const gridRows = gridTemplateRows.split(/\s+/).filter(v => v && v !== 'none').length || 1;

  // Dimming logic
  const [gridHovered, setGridHovered] = useState(false);
  const hasActiveDropdown = activeDropdown !== null;
  const dimSiblings = hasActiveDropdown || gridHovered;
  const siblingOpacity = hasActiveDropdown ? 0.3 : gridHovered ? 0.65 : 1;

  // Display mode button
  const DisplayModeButton = ({ mode, icon, active }: { mode: DisplayMode; icon: React.ReactNode; active: boolean }) => (
    <button
      type="button"
      onClick={() => applyDisplayMode(mode, handleChange)}
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '6px 8px',
        border: 'none',
        borderRadius: 2,
        backgroundColor: active ? colorWithAlpha(accentColor, 0.15) : 'transparent',
        color: active ? accentColor : '#64748b',
        cursor: 'pointer',
        fontSize: 14,
      }}
    >
      {icon}
    </button>
  );

  // Handle dimension change with mode
  const handleDimensionChange = (prop: 'width' | 'height', value: string, mode: SizingMode) => {
    if (mode === 'fixed') {
      handleChange(prop, value);
    } else {
      handleChange(prop, getSizingValue(mode, value));
    }
  };

  // Handle padding change for horizontal (left+right) or vertical (top+bottom)
  const handlePaddingHorizontal = (value: string) => {
    const current = parseSpacing(getValue('padding'));
    const v = value || '0';
    handleChange('padding', `${current.top} ${v} ${current.bottom} ${v}`);
  };

  const handlePaddingVertical = (value: string) => {
    const current = parseSpacing(getValue('padding'));
    const v = value || '0';
    handleChange('padding', `${v} ${current.right} ${v} ${current.left}`);
  };

  // Scrub display overrides — tracks live preview values so UnitInput shows them during drag
  const [scrubDisplay, setScrubDisplay] = useState<Record<string, string>>({});

  const scrubPreview = useCallback((key: string, domUpdate: (v: string) => void) => (v: string) => {
    domUpdate(v);
    setScrubDisplay(prev => ({ ...prev, [key]: v }));
  }, []);

  const clearScrub = useCallback((key: string) => {
    setScrubDisplay(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Live preview via inline style (no modification tracking)
  const previewPaddingHorizontal = useCallback((v: string) => {
    const current = parseSpacing(getValue('padding'));
    applyInlineStyle(element, 'padding', `${current.top} ${v} ${current.bottom} ${v}`);
  }, [element, getValue]);

  const previewPaddingVertical = useCallback((v: string) => {
    const current = parseSpacing(getValue('padding'));
    applyInlineStyle(element, 'padding', `${v} ${current.right} ${v} ${current.left}`);
  }, [element, getValue]);

  const previewProperty = useCallback((property: string) => (v: string) => {
    applyInlineStyle(element, property, v);
  }, [element]);

  // 9-dot alignment grid for flex
  // --- Alignment grid: swipe + click to set justify/align ---
  const isColumn = flexDirection === 'column' || flexDirection === 'column-reverse';

  const getAxisIndex = (val: string): number => {
    if (val === 'center') return 1;
    if (val === 'flex-end' || val === 'end') return 2;
    return 0;
  };

  const justifyIdx = getAxisIndex(getValue('justify-content'));
  const alignIdx = getAxisIndex(getValue('align-items'));
  const gridActiveCol = isColumn ? alignIdx : justifyIdx;
  const gridActiveRow = isColumn ? justifyIdx : alignIdx;

  const gridRef = useRef<HTMLDivElement>(null);
  const gridSwipeAccum = useRef({ x: 0, y: 0 });
  const gridPosRef = useRef({ col: gridActiveCol, row: gridActiveRow });
  gridPosRef.current = { col: gridActiveCol, row: gridActiveRow };

  const applyGridPosition = useCallback((col: number, row: number) => {
    const vals = ['flex-start', 'center', 'flex-end'];
    if (isColumn) {
      handleChange('justify-content', vals[row]!);
      handleChange('align-items', vals[col]!);
    } else {
      handleChange('justify-content', vals[col]!);
      handleChange('align-items', vals[row]!);
    }
  }, [isColumn, handleChange]);
  const applyGridRef = useRef(applyGridPosition);
  applyGridRef.current = applyGridPosition;

  // Document-level capture listener — lives at LayoutSection level so it's never torn down mid-interaction.
  useEffect(() => {
    const THRESHOLD = 30;
    const onWheel = (e: WheelEvent) => {
      const grid = gridRef.current;
      if (!grid || !grid.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      gridSwipeAccum.current.x += e.deltaX;
      gridSwipeAccum.current.y += e.deltaY;

      let { col, row } = gridPosRef.current;
      let moved = false;

      if (Math.abs(gridSwipeAccum.current.x) >= THRESHOLD) {
        col = Math.max(0, Math.min(2, col + (gridSwipeAccum.current.x > 0 ? 1 : -1)));
        gridSwipeAccum.current.x = 0;
        gridSwipeAccum.current.y = 0;
        moved = true;
      }
      if (!moved && Math.abs(gridSwipeAccum.current.y) >= THRESHOLD) {
        row = Math.max(0, Math.min(2, row + (gridSwipeAccum.current.y > 0 ? 1 : -1)));
        gridSwipeAccum.current.x = 0;
        gridSwipeAccum.current.y = 0;
        moved = true;
      }

      if (moved && (col !== gridPosRef.current.col || row !== gridPosRef.current.row)) {
        applyGridRef.current(col, row);
      }
    };
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  const renderAlignmentGrid = () => (
    <div
      ref={gridRef}
      onMouseEnter={() => { setGridHovered(true); if (panelContentRef.current) panelContentRef.current.style.overflowY = 'hidden'; }}
      onMouseLeave={() => { setGridHovered(false); if (panelContentRef.current) panelContentRef.current.style.overflowY = 'auto'; }}
      style={{
        width: 56,
        height: 56,
        backgroundColor: FIELD_BG,
        borderRadius: 2,
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gridTemplateRows: 'repeat(3, 1fr)',
        padding: 6,
        gap: 2,
        touchAction: 'none',
      }}
    >
      {[0, 1, 2].map(row =>
        [0, 1, 2].map(col => {
          const isActive = col === gridActiveCol && row === gridActiveRow;
          return (
            <button
              key={`${row}-${col}`}
              type="button"
              onClick={() => applyGridPosition(col, row)}
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                backgroundColor: 'transparent',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {isActive ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
                  {/* 3 horizontal lines: widths 8/5/7, aligned by column */}
                  {col === 0 ? (
                    <>
                      <rect x="1" y="1.5" width="8" height="1.2" rx="0.5" fill={accentColor} />
                      <rect x="1" y="4.4" width="5" height="1.2" rx="0.5" fill={accentColor} />
                      <rect x="1" y="7.3" width="7" height="1.2" rx="0.5" fill={accentColor} />
                    </>
                  ) : col === 1 ? (
                    <>
                      <rect x="1" y="1.5" width="8" height="1.2" rx="0.5" fill={accentColor} />
                      <rect x="2.5" y="4.4" width="5" height="1.2" rx="0.5" fill={accentColor} />
                      <rect x="1.5" y="7.3" width="7" height="1.2" rx="0.5" fill={accentColor} />
                    </>
                  ) : (
                    <>
                      <rect x="1" y="1.5" width="8" height="1.2" rx="0.5" fill={accentColor} />
                      <rect x="4" y="4.4" width="5" height="1.2" rx="0.5" fill={accentColor} />
                      <rect x="2" y="7.3" width="7" height="1.2" rx="0.5" fill={accentColor} />
                    </>
                  )}
                </svg>
              ) : (
                <div style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  backgroundColor: '#aaa',
                }} />
              )}
            </button>
          );
        })
      )}
    </div>
  );

  // GridDimensions moved to module level
  const gridModified = isModified('grid-template-columns') || isModified('grid-template-rows');


  const sectionTitle = isFlexOrGrid ? 'Auto layout' : 'Layout';

  return (
    <div style={{ borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
      <div style={sectionHeaderStyle}>
        <span>{sectionTitle}</span>
      </div>

      <div style={{ padding: '8px 12px' }}>
          {/* Display Mode - 4 button segmented control */}
          <div style={{ display: 'flex', gap: 2, marginBottom: 8, backgroundColor: FIELD_BG, borderRadius: 2, padding: 2, opacity: siblingOpacity, transition: 'opacity 150ms ease' }}>
            <DisplayModeButton mode="block" icon={<RectangleHorizontal size={16} />} active={displayMode === 'block'} />
            <DisplayModeButton mode="flex-col" icon={<Rows3 size={16} />} active={displayMode === 'flex-col'} />
            <DisplayModeButton mode="flex-row" icon={<Columns3 size={16} />} active={displayMode === 'flex-row'} />
            <DisplayModeButton mode="grid" icon={<Grid2x2 size={16} />} active={displayMode === 'grid'} />
          </div>

          {/* Width & Height */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            <DimensionField
              label="W"
              property="width"
              cssValue={widthMode === 'fixed' ? width : `${Math.round(element.getBoundingClientRect().width)}px`}
              mode={widthMode}
              onValueChange={(v) => handleChange('width', v)}
              onModeChange={(mode) => {
                if (mode === 'fixed') {
                  const rect = element.getBoundingClientRect();
                  handleChange('width', `${Math.round(rect.width)}px`);
                } else {
                  handleChange('width', getSizingValue(mode, width));
                }
              }}
              modified={isModified('width')}
              dimmed={hasActiveDropdown && activeDropdown !== 'width'}
              dropdownOpen={activeDropdown === 'width'}
              onDropdownChange={(open) => setActiveDropdown(open ? 'width' : null)}
              panelContentRef={panelContentRef}
              accentColor={accentColor}
              onReset={() => onResetProperty('width')}
              minValue={minWidth !== 'none' && minWidth !== '0px' && minWidth !== 'auto' ? minWidth : ''}
              maxValue={maxWidth !== 'none' && maxWidth !== 'auto' ? maxWidth : ''}
              onMinChange={(v) => handleChange('min-width', v || '0')}
              onMaxChange={(v) => handleChange('max-width', v || 'none')}
              onMinReset={() => onResetProperty('min-width')}
              onMaxReset={() => onResetProperty('max-width')}
              minModified={isModified('min-width')}
              maxModified={isModified('max-width')}
            />
            <DimensionField
              label="H"
              property="height"
              cssValue={heightMode === 'fixed' ? height : `${Math.round(element.getBoundingClientRect().height)}px`}
              mode={heightMode}
              onValueChange={(v) => handleChange('height', v)}
              onModeChange={(mode) => {
                if (mode === 'fixed') {
                  const rect = element.getBoundingClientRect();
                  handleChange('height', `${Math.round(rect.height)}px`);
                } else {
                  handleChange('height', getSizingValue(mode, height));
                }
              }}
              modified={isModified('height')}
              dimmed={hasActiveDropdown && activeDropdown !== 'height'}
              dropdownOpen={activeDropdown === 'height'}
              onDropdownChange={(open) => setActiveDropdown(open ? 'height' : null)}
              panelContentRef={panelContentRef}
              minValue={minHeight !== 'none' && minHeight !== '0px' && minHeight !== 'auto' ? minHeight : ''}
              maxValue={maxHeight !== 'none' && maxHeight !== 'auto' ? maxHeight : ''}
              onMinChange={(v) => handleChange('min-height', v || '0')}
              onMaxChange={(v) => handleChange('max-height', v || 'none')}
              onMinReset={() => onResetProperty('min-height')}
              onMaxReset={() => onResetProperty('max-height')}
              minModified={isModified('min-height')}
              maxModified={isModified('max-height')}
              accentColor={accentColor}
              onReset={() => onResetProperty('height')}
            />
          </div>

          {/* Flex: Alignment grid + Gap */}
          {isFlex && (
            <div onMouseEnter={() => onFieldHover?.('gap')} onMouseLeave={() => onFieldHover?.('element')} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <div style={{ opacity: hasActiveDropdown ? 0.3 : 1, transition: 'opacity 150ms ease' }}>{renderAlignmentGrid()}</div>
              <div style={{ flex: 1, opacity: siblingOpacity, transition: 'opacity 150ms ease' }}>
                <div
                  onClick={isModified('gap') ? () => onResetProperty('gap') : undefined}
                  title={isModified('gap') ? 'Click to reset' : undefined}
                  style={{
                    fontSize: 9,
                    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                    color: isModified('gap') ? accentColor : '#999',
                    fontWeight: isModified('gap') ? 600 : 400,
                    marginBottom: 2,
                    cursor: isModified('gap') ? 'pointer' : 'default',
                  }}
                >Gap</div>
                <FieldWrapper dimmed={hasActiveDropdown}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <ScrubLabel
                      value={gap}
                      onChange={(v) => { clearScrub('gap'); handleChange('gap', v); }}
                      onPreview={scrubPreview('gap', previewProperty('gap'))}
                      onScrubEnd={() => clearScrub('gap')}
                      onReset={() => onResetProperty('gap')}
                      isModified={isModified('gap')}
                      accentColor={accentColor}
                      defaultUnit={preferredUnit}
                    >
                      {flexDirection === 'column' || flexDirection === 'column-reverse'
                        ? <UnfoldVertical size={12} strokeWidth={isModified('gap') ? 2.5 : 1.5} />
                        : <UnfoldHorizontal size={12} strokeWidth={isModified('gap') ? 2.5 : 1.5} />}
                    </ScrubLabel>
                    <UnitInput
                      property="gap"
                      value={scrubDisplay['gap'] || gap}
                      onChange={(v) => handleChange('gap', v)}
                      isModified={isModified('gap') || 'gap' in scrubDisplay}
                      style={{ ...compactInputStyle, flex: 1, minWidth: 0 }}
                      unitStyle={{ fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace', color: '#999', padding: '0 8px' }}
                      preferredUnit={preferredUnit}
                      onUnitCycle={onUnitCycle}
                    />
                  </div>
                </FieldWrapper>
              </div>
            </div>
          )}

          {/* Grid: Dimensions + Row/Column gaps */}
          {isGrid && (
            <div onMouseEnter={() => onFieldHover?.('gap')} onMouseLeave={() => onFieldHover?.('element')} style={{ display: 'flex', gap: 8, marginBottom: 8, opacity: siblingOpacity, transition: 'opacity 150ms ease' }}>
              <GridDimensions
                gridCols={gridCols}
                gridRows={gridRows}
                gridModified={gridModified}
                accentColor={accentColor}
                onColsChange={(cols) => handleChange('grid-template-columns', `repeat(${cols}, 1fr)`)}
                onRowsChange={(rows) => handleChange('grid-template-rows', `repeat(${rows}, 1fr)`)}
              />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <FieldWrapper dimmed={hasActiveDropdown}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <ScrubLabel
                      value={columnGap || gap}
                      onChange={(v) => { clearScrub('column-gap'); handleChange('column-gap', v); }}
                      onPreview={scrubPreview('column-gap', previewProperty('column-gap'))}
                      onScrubEnd={() => clearScrub('column-gap')}
                      onReset={() => onResetProperty('column-gap')}
                      isModified={isModified('column-gap')}
                      accentColor={accentColor}
                      defaultUnit={preferredUnit}
                    >
                      <UnfoldHorizontal size={12} strokeWidth={isModified('column-gap') ? 2.5 : 1.5} />
                    </ScrubLabel>
                    <UnitInput
                      property="column-gap"
                      value={scrubDisplay['column-gap'] || columnGap || gap}
                      onChange={(v) => handleChange('column-gap', v)}
                      isModified={isModified('column-gap') || 'column-gap' in scrubDisplay}
                      placeholder="col"
                      style={{ ...compactInputStyle, flex: 1, minWidth: 0 }}
                      unitStyle={{ fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace', color: '#999', padding: '0 8px' }}
                      preferredUnit={preferredUnit}
                      onUnitCycle={onUnitCycle}
                    />
                  </div>
                </FieldWrapper>
                <FieldWrapper dimmed={hasActiveDropdown}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <ScrubLabel
                      value={rowGap || gap}
                      onChange={(v) => { clearScrub('row-gap'); handleChange('row-gap', v); }}
                      onPreview={scrubPreview('row-gap', previewProperty('row-gap'))}
                      onScrubEnd={() => clearScrub('row-gap')}
                      onReset={() => onResetProperty('row-gap')}
                      isModified={isModified('row-gap')}
                      accentColor={accentColor}
                      defaultUnit={preferredUnit}
                    >
                      <UnfoldVertical size={12} strokeWidth={isModified('row-gap') ? 2.5 : 1.5} />
                    </ScrubLabel>
                    <UnitInput
                      property="row-gap"
                      value={scrubDisplay['row-gap'] || rowGap || gap}
                      onChange={(v) => handleChange('row-gap', v)}
                      isModified={isModified('row-gap') || 'row-gap' in scrubDisplay}
                      placeholder="row"
                      style={{ ...compactInputStyle, flex: 1, minWidth: 0 }}
                      unitStyle={{ fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace', color: '#999', padding: '0 8px' }}
                      preferredUnit={preferredUnit}
                      onUnitCycle={onUnitCycle}
                    />
                  </div>
                </FieldWrapper>
              </div>
            </div>
          )}

          {/* Padding - horizontal + vertical fields (for flex/grid) */}
          {isFlexOrGrid && (
            <div onMouseEnter={() => onFieldHover?.('padding')} onMouseLeave={() => onFieldHover?.('element')} style={{ display: 'flex', gap: 4, marginBottom: 8, opacity: siblingOpacity, transition: 'opacity 150ms ease' }}>
              <FieldWrapper style={{ flex: 1 }} dimmed={hasActiveDropdown}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <ScrubLabel
                    value={padding.left}
                    onChange={(v) => { clearScrub('padding-h'); handlePaddingHorizontal(v); }}
                    onPreview={scrubPreview('padding-h', previewPaddingHorizontal)}
                    onScrubEnd={() => clearScrub('padding-h')}
                    onReset={() => onResetProperty('padding')}
                    isModified={isModified('padding')}
                    accentColor={accentColor}
                    defaultUnit={preferredUnit}
                    snapSteps={PADDING_SNAP_STEPS}
                  >
                    <AlignHorizontalSpaceAround size={12} strokeWidth={isModified('padding') ? 2.5 : 1.5} />
                  </ScrubLabel>
                  <UnitInput
                    property="padding"
                    value={scrubDisplay['padding-h'] || padding.left}
                    onChange={(v) => handlePaddingHorizontal(v)}
                    isModified={isModified('padding') || 'padding-h' in scrubDisplay}
                    placeholder="H pad"
                    style={{ ...compactInputStyle, flex: 1, minWidth: 0 }}
                    unitStyle={{ fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace', color: '#999', padding: '0 8px' }}
                    preferredUnit={preferredUnit}
                    onUnitCycle={onUnitCycle}
                  />
                </div>
              </FieldWrapper>
              <FieldWrapper style={{ flex: 1 }} dimmed={hasActiveDropdown}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <ScrubLabel
                    value={padding.top}
                    onChange={(v) => { clearScrub('padding-v'); handlePaddingVertical(v); }}
                    onPreview={scrubPreview('padding-v', previewPaddingVertical)}
                    onScrubEnd={() => clearScrub('padding-v')}
                    onReset={() => onResetProperty('padding')}
                    isModified={isModified('padding')}
                    accentColor={accentColor}
                    defaultUnit={preferredUnit}
                    snapSteps={PADDING_SNAP_STEPS}
                  >
                    <AlignVerticalSpaceAround size={12} strokeWidth={isModified('padding') ? 2.5 : 1.5} />
                  </ScrubLabel>
                  <UnitInput
                    property="padding"
                    value={scrubDisplay['padding-v'] || padding.top}
                    onChange={(v) => handlePaddingVertical(v)}
                    isModified={isModified('padding') || 'padding-v' in scrubDisplay}
                    placeholder="V pad"
                    style={{ ...compactInputStyle, flex: 1, minWidth: 0 }}
                    unitStyle={{ fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace', color: '#999', padding: '0 8px' }}
                    preferredUnit={preferredUnit}
                    onUnitCycle={onUnitCycle}
                  />
                </div>
              </FieldWrapper>
            </div>
          )}

          {/* Clip content checkbox */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace', color: '#64748b', opacity: siblingOpacity, transition: 'opacity 150ms ease' }}>
            <input
              type="checkbox"
              checked={overflow === 'hidden'}
              onChange={(e) => handleChange('overflow', e.target.checked ? 'hidden' : 'visible')}
              style={{ margin: 0, accentColor: accentColor }}
            />
            Clip content
          </label>
        </div>
    </div>
  );
}
