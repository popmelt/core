'use client';

import type { ReactNode } from 'react';

const BASE_RESET = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:host {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #1f2937;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
`;

type ShadowChromeProps = {
  children: ReactNode;
};

/**
 * Provides base CSS reset styles inside the shadow root.
 * Wraps the Popmelt chrome (canvas, toolbar, panels) with sane
 * inherited defaults that are isolated from host page styles.
 */
export function ShadowChrome({ children }: ShadowChromeProps) {
  return (
    <>
      <style>{BASE_RESET}</style>
      {children}
    </>
  );
}
