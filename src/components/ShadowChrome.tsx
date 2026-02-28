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
/* Break :host font inheritance for component previews — let mirrored host
   page styles (Tailwind, globals) apply instead of Popmelt's monospace. */
[data-popmelt-panel] {
  font: 16px / 1.5 system-ui, -apple-system, sans-serif;
  color: initial;
  -webkit-font-smoothing: auto;
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
