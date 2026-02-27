'use client';

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type ShadowHostProps = {
  children: ReactNode;
};

/**
 * Renders children inside a shadow DOM with a separate React root.
 *
 * Using a separate `createRoot` inside the shadow root ensures React's event
 * listeners attach *inside* the shadow boundary. This avoids the event.target
 * retargeting problem that occurs with `createPortal` across shadow boundaries.
 */
export function ShadowHost({ children }: ShadowHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<Root | null>(null);

  // Create shadow root + React root once
  useEffect(() => {
    const host = hostRef.current;
    if (!host || host.shadowRoot) return;

    const shadow = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    container.setAttribute('data-popmelt-root', '');
    shadow.appendChild(container);
    rootRef.current = createRoot(container);

    return () => {
      const root = rootRef.current;
      rootRef.current = null;
      // Defer unmount so it doesn't fire while React is still rendering,
      // which triggers "synchronously unmount a root while already rendering".
      setTimeout(() => root?.unmount(), 0);
    };
  }, []);

  // Re-render shadow tree on every parent render.
  // useLayoutEffect minimizes frame delay between main tree state changes
  // and shadow tree updates.
  useLayoutEffect(() => {
    rootRef.current?.render(<>{children}</>);
  });

  return (
    <div
      ref={hostRef}
      data-popmelt-shadow-host
      style={{ display: 'contents' }}
    />
  );
}
