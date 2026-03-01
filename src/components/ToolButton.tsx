'use client';

import type { CSSProperties, ReactNode } from 'react';

// Self-contained color tokens
const colors = {
  iconDefault: '#1f2937',
  iconActive: '#1f2937',
  bgActive: '#dedede',
  bgHover: '#e2e2e2',
  separator: '#e5e7eb',
};

type ToolButtonProps = {
  children: ReactNode;
  active?: boolean;
  siblingActive?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
};

export function ToolButton({ children, active, siblingActive, disabled, onClick, title }: ToolButtonProps) {
  const getOpacity = () => {
    if (disabled) return 0.4;
    if (siblingActive && !active) return 0.5;
    return 1;
  };

  const baseStyle: CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: 0,
    border: 'none',
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background-color 150ms ease, color 150ms ease, transform 100ms ease, opacity 150ms ease',
    backgroundColor: active ? colors.bgActive : 'transparent',
    color: active ? colors.iconActive : colors.iconDefault,
    opacity: getOpacity(),
  };

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      style={baseStyle}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.opacity = '1';
          if (!active) {
            e.currentTarget.style.backgroundColor = colors.bgHover;
          }
        }
      }}
      onMouseLeave={(e) => {
        if (!disabled) {
          e.currentTarget.style.opacity = String(getOpacity());
          if (!active) {
            e.currentTarget.style.backgroundColor = 'transparent';
          }
        }
      }}
      onMouseDown={(e) => {
        if (!disabled) {
          e.currentTarget.style.transform = 'scale(0.95)';
        }
      }}
      onMouseUp={(e) => {
        if (!disabled) {
          e.currentTarget.style.transform = 'scale(1)';
        }
      }}
    >
      {children}
    </button>
  );
}

export function ToolSeparator() {
  return (
    <div
      style={{
        width: 1,
        height: 20,
        backgroundColor: 'rgba(0, 0, 0, 0.05)',
        margin: '0 8px',
      }}
    />
  );
}

export { colors };
