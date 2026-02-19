'use client';

import type { CSSProperties } from 'react';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Baseline, ChevronDown, WholeWord } from 'lucide-react';

import { colorWithAlpha } from '../../utils/color';
import { resolveColorValue, findMatchingColorVariable } from '../../utils/dom';
import type { ColorVariable } from '../../utils/dom';
import { UnitInput, ColorInput, FieldWrapper, FIELD_BG, compactInputStyle } from '../StylePanel';

// Custom Typography Section Component
type TypographySectionProps = {
  element: Element;
  getValue: (property: string) => string;
  handleChange: (property: string, value: string) => void;
  isModified: (property: string) => boolean;
  onResetProperty: (property: string) => void;
  isCollapsed: boolean;
  onToggle: () => void;
  sectionHeaderStyle: CSSProperties;
  accentColor: string;
  colorVariables: ColorVariable[];
  activeColorDropdown: string | null;
  onColorDropdownChange: (property: string | null) => void;
  panelContentRef: React.RefObject<HTMLDivElement | null>;
  preferredUnit: 'rem' | 'px';
  onUnitCycle: () => void;
};

// Font weight labels
const WEIGHT_LABELS: Record<string, string> = {
  '100': 'Thin',
  '200': 'Extra Light',
  '300': 'Light',
  '400': 'Regular',
  '500': 'Medium',
  '600': 'Semi Bold',
  '700': 'Bold',
  '800': 'Extra Bold',
  '900': 'Black',
};

export function TypographySection({
  element,
  getValue,
  handleChange,
  isModified,
  onResetProperty,
  isCollapsed,
  onToggle,
  sectionHeaderStyle,
  accentColor,
  colorVariables,
  activeColorDropdown,
  onColorDropdownChange,
  panelContentRef,
  preferredUnit,
  onUnitCycle,
}: TypographySectionProps) {
  const fontFamily = getValue('font-family');
  const fontSize = getValue('font-size');
  const fontWeight = getValue('font-weight');
  const lineHeight = getValue('line-height');
  const letterSpacing = getValue('letter-spacing');
  const textAlign = getValue('text-align');
  const color = getValue('color');



  // Normalize font weight to string
  const weightStr = String(fontWeight);
  const weightLabel = WEIGHT_LABELS[weightStr] || weightStr;

  // Color resolution for swatch
  const resolvedColor = resolveColorValue(element, color);
  const matchingColorVar = color.includes('var(') ? null : findMatchingColorVariable(resolvedColor, colorVariables);

  // Alignment button component
  const AlignButton = ({ align, icon }: { align: string; icon: React.ReactNode }) => {
    const isActive = textAlign === align;
    return (
      <button
        type="button"
        onClick={() => handleChange('text-align', align)}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '6px 8px',
          border: 'none',
          borderRadius: 2,
          backgroundColor: isActive ? colorWithAlpha(accentColor, 0.15) : 'transparent',
          color: isActive ? accentColor : '#64748b',
          cursor: 'pointer',
        }}
      >
        {icon}
      </button>
    );
  };

  // Clean font family for display (remove quotes and fallbacks)
  const displayFontFamily = fontFamily
    .split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '') || 'System';

  return (
    <div style={{ borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
      <div style={sectionHeaderStyle}>
        <span>Typography</span>
      </div>

      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* Font Family - full width */}
          <FieldWrapper>
            <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px' }}>
              <input
                type="text"
                value={fontFamily}
                onChange={(e) => handleChange('font-family', e.target.value)}
                style={{
                  ...compactInputStyle,
                  flex: 1,
                  minWidth: 0,
                  padding: 0,
                  fontWeight: isModified('font-family') ? 600 : 400,
                  color: isModified('font-family') ? accentColor : 'inherit',
                }}
                title={fontFamily}
              />
              <ChevronDown size={12} style={{ color: '#999', flexShrink: 0, marginLeft: 4 }} />
            </div>
          </FieldWrapper>

          {/* Weight + Size row */}
          <div style={{ display: 'flex', gap: 4 }}>
            {/* Weight dropdown */}
            <FieldWrapper style={{ flex: 1 }}>
              <select
                value={weightStr}
                onChange={(e) => handleChange('font-weight', e.target.value)}
                style={{
                  ...compactInputStyle,
                  padding: '6px 8px',
                  paddingLeft: 4,
                  paddingRight: 20,
                  cursor: 'pointer',
                  fontWeight: isModified('font-weight') ? 600 : 400,
                  color: isModified('font-weight') ? accentColor : 'inherit',
                }}
              >
                {Object.entries(WEIGHT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </FieldWrapper>

            {/* Size input */}
            <FieldWrapper style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
                <UnitInput
                  property="font-size"
                  value={fontSize}
                  onChange={(v) => handleChange('font-size', v)}
                  isModified={isModified('font-size')}
                  min={1}
                  max={999}
                  style={{
                    ...compactInputStyle,
                    padding: '6px 8px',
                    paddingRight: 24,
                    fontWeight: isModified('font-size') ? 600 : 400,
                    color: isModified('font-size') ? accentColor : 'inherit',
                  }}
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
                  onUnitCycle={onUnitCycle}
                />
              </div>
            </FieldWrapper>
          </div>

          {/* Line Height + Letter Spacing row */}
          <div style={{ display: 'flex', gap: 4 }}>
            {/* Line Height */}
            <FieldWrapper style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px', gap: 4 }}>
                <Baseline size={12} style={{ color: isModified('line-height') ? accentColor : '#999', flexShrink: 0 }} />
                <UnitInput
                  property="line-height"
                  value={lineHeight}
                  onChange={(v) => handleChange('line-height', v)}
                  isModified={isModified('line-height')}
                  step={0.1}
                  min={0}
                  placeholder="Auto"
                  style={{
                    ...compactInputStyle,
                    flex: 1,
                    minWidth: 0,
                    padding: 0,
                    fontWeight: isModified('line-height') ? 600 : 400,
                    color: isModified('line-height') ? accentColor : 'inherit',
                  }}
                  showUnit={false}
                />
              </div>
            </FieldWrapper>

            {/* Letter Spacing */}
            <FieldWrapper style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px', gap: 4 }}>
                <WholeWord size={12} style={{ color: isModified('letter-spacing') ? accentColor : '#999', flexShrink: 0 }} />
                <UnitInput
                  property="letter-spacing"
                  value={letterSpacing}
                  onChange={(v) => handleChange('letter-spacing', v)}
                  isModified={isModified('letter-spacing')}
                  step={0.1}
                  placeholder="—"
                  style={{
                    ...compactInputStyle,
                    flex: 1,
                    minWidth: 0,
                    padding: 0,
                    fontWeight: isModified('letter-spacing') ? 600 : 400,
                    color: isModified('letter-spacing') ? accentColor : 'inherit',
                  }}
                  showUnit={false}
                />
              </div>
            </FieldWrapper>
          </div>

          {/* Text Alignment - segmented control */}
          <div style={{ display: 'flex', gap: 2, backgroundColor: FIELD_BG, borderRadius: 2, padding: 2 }}>
            <AlignButton align="left" icon={<AlignLeft size={14} />} />
            <AlignButton align="center" icon={<AlignCenter size={14} />} />
            <AlignButton align="right" icon={<AlignRight size={14} />} />
            <AlignButton align="justify" icon={<AlignJustify size={14} />} />
          </div>

          {/* Color row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <span
              onClick={isModified('color') ? () => onResetProperty('color') : undefined}
              title={isModified('color') ? 'Click to reset' : undefined}
              style={{
                fontSize: 11,
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                color: isModified('color') ? accentColor : '#64748b',
                fontWeight: isModified('color') ? 600 : 400,
                cursor: isModified('color') ? 'pointer' : 'default',
                width: 40,
                flexShrink: 0,
              }}
            >Color</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ColorInput
                value={color}
                resolvedValue={resolvedColor}
                colorVariables={colorVariables}
                matchingVariable={matchingColorVar}
                onChange={(newValue) => handleChange('color', newValue)}
                accentColor={accentColor}
                modified={isModified('color')}
                panelContentRef={panelContentRef}
                isDropdownOpen={activeColorDropdown === 'color'}
                onDropdownChange={(open) => onColorDropdownChange(open ? 'color' : null)}
              />
            </div>
          </div>
        </div>
    </div>
  );
}
