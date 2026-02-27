'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type ShadowHostProps = {
  children: ReactNode;
};

/**
 * Renders children inside a shadow DOM via createPortal.
 *
 * Unlike createRoot, createPortal keeps children in the same React tree —
 * context, refs, state, and event bubbling all work normally. The shadow
 * boundary provides CSS isolation without breaking React's internals.
 */
export function ShadowHost({ children }: ShadowHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || host.shadowRoot) return;

    const shadow = host.attachShadow({ mode: 'open' });
    const root = document.createElement('div');
    root.setAttribute('data-popmelt-root', '');
    shadow.appendChild(root);
    setContainer(root);
  }, []);

  return (
    <>
      <div
        ref={hostRef}
        data-popmelt-shadow-host
        style={{ position: 'absolute', width: 0, height: 0, overflow: 'visible' }}
      />
      {container && createPortal(children, container)}
    </>
  );
}
