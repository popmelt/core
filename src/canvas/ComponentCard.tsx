import { useCallback, useRef, useState, type Dispatch } from 'react';

import { POPMELT_BORDER } from '../styles/border';
import type { CanvasAction, DragState, PlacedComponent, ViewportState } from './types';

type Props = {
  component: PlacedComponent;
  selected: boolean;
  highlighted: boolean;
  isDragging: boolean;
  viewport: ViewportState;
  dispatch: Dispatch<CanvasAction>;
};

export function ComponentCard({ component, selected, highlighted, isDragging, viewport, dispatch }: Props) {
  const headerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [redirectedTo, setRedirectedTo] = useState<string | null>(null);
  const [buildError, setBuildError] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState(false);

  const hasRoute = component.entry.routes && component.entry.routes.length > 0;

  const onIframeLoad = useCallback(() => {
    // Reset on each load (handles HMR reloads)
    setBuildError(false);
    setShowErrorDetails(false);

    // Redirect detection
    try {
      const actual = iframeRef.current?.contentWindow?.location.pathname;
      if (!actual) return;
      const expected = new URL(component.iframeUrl).pathname;
      if (actual !== expected) {
        setRedirectedTo(actual);
      }
    } catch {
      // cross-origin — can't read, ignore
    }

    // Build error detection: check for the Next.js error overlay element.
    // The overlay is injected via client JS after the document loads,
    // so we wait a moment before checking.
    setTimeout(() => {
      try {
        const doc = iframeRef.current?.contentDocument;
        if (doc?.querySelector('nextjs-portal')) {
          setBuildError(true);
        }
      } catch {}
    }, 2000);
  }, [component.iframeUrl]);

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'SELECT', id: component.id });
    const dragState: DragState = {
      type: 'move',
      componentId: component.id,
      startX: e.clientX,
      startY: e.clientY,
      originX: component.x,
      originY: component.y,
    };
    dispatch({ type: 'START_DRAG', dragState });
  }, [component.id, component.x, component.y, dispatch]);

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dispatch({ type: 'SELECT', id: component.id });
    const dragState: DragState = {
      type: 'resize',
      componentId: component.id,
      startX: e.clientX,
      startY: e.clientY,
      originW: component.width,
      originH: component.height,
    };
    dispatch({ type: 'START_DRAG', dragState });
  }, [component.id, component.width, component.height, dispatch]);

  const onClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_COMPONENT', id: component.id });
  }, [component.id, dispatch]);

  const onCardMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'SELECT', id: component.id });
  }, [component.id, dispatch]);

  // Inverse scale so chrome stays constant size regardless of zoom
  const inv = 1 / viewport.scale;
  const emphasis = selected || highlighted;
  const bw = 3 * inv;
  const slop = 4 * inv;

  return (
    <div
      onMouseDown={onCardMouseDown}
      style={{
        position: 'absolute',
        left: component.x,
        top: component.y,
        width: component.width,
        height: component.height,
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: emphasis
          ? `0 ${2 * inv}px ${12 * inv}px rgba(0,0,0,0.12)`
          : `0 ${inv}px ${4 * inv}px rgba(0,0,0,0.06)`,
        borderWidth: bw,
        borderStyle: 'solid',
        borderImage: POPMELT_BORDER.borderImage,
        opacity: emphasis ? 1 : undefined,
      }}
    >
      {/* Invisible hit area — extends slop outside border for easier edge clicks */}
      <div
        onMouseDown={onCardMouseDown}
        style={{
          position: 'absolute',
          inset: -(bw + slop),
          pointerEvents: 'auto',
        }}
      />
      {/* Border opacity overlay — sits behind border, dims it when not emphasised */}
      {!emphasis && (
        <div style={{
          position: 'absolute',
          inset: -bw,
          pointerEvents: 'none',
          background: 'rgba(255,255,255,0.75)',
        }} />
      )}
      {/* Header bar */}
      <div
        ref={headerRef}
        onMouseDown={onHeaderMouseDown}
        style={{
          height: 28 * inv,
          background: buildError ? '#fef2f2' : '#f9fafb',
          display: 'flex',
          alignItems: 'center',
          padding: `0 ${8 * inv}px`,
          cursor: 'grab',
          userSelect: 'none',
          borderBottom: `${inv}px solid rgba(0,0,0,0.06)`,
          flexShrink: 0,
          position: 'relative',
        }}
      >
        <span style={{ flex: 1, fontSize: 11 * inv, fontWeight: 600, color: '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 * inv }}>
          {component.entry.name}
          {!hasRoute && (
            <span style={{ fontSize: 9 * inv, color: '#d1d5db', fontWeight: 400 }}>(no route)</span>
          )}
          {buildError && (
            <span style={{ fontSize: 9 * inv, color: '#ef4444', fontWeight: 600 }}>build error</span>
          )}
          {redirectedTo && (
            <span style={{ fontSize: 9 * inv, color: '#f59e0b', fontWeight: 400 }}>&rarr; {redirectedTo}</span>
          )}
        </span>
        <span style={{ fontSize: 10 * inv, color: '#9ca3af', marginRight: 6 * inv, whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
          {Math.round(component.width)}&times;{Math.round(component.height)}
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#9ca3af',
            cursor: 'pointer',
            fontSize: 12 * inv,
            lineHeight: 1,
            padding: `${2 * inv}px ${4 * inv}px`,
            fontFamily: 'inherit',
          }}
        >
          &#x2715;
        </button>
      </div>

      {/* Iframe body */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <iframe
          ref={iframeRef}
          src={component.iframeUrl}
          onLoad={onIframeLoad}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            pointerEvents: isDragging ? 'none' : 'auto',
            background: '#fff',
          }}
          title={component.entry.name}
        />
        {/* Build error overlay — covers the Turbopack error with a cleaner message */}
        {buildError && !showErrorDetails && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: '#fff',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              zIndex: 2,
            }}
          >
            <div style={{ fontSize: 13, color: '#991b1b', fontWeight: 600 }}>Build error</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6, textAlign: 'center' }}>
              This component has unresolvable imports.
              <br />
              Other components are not affected.
            </div>
            <button
              onClick={() => setShowErrorDetails(true)}
              style={{
                marginTop: 14,
                fontSize: 11,
                color: '#6b7280',
                background: 'none',
                border: '1px solid #e5e7eb',
                padding: '4px 12px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Show details
            </button>
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onResizeMouseDown}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 14 * inv,
          height: 14 * inv,
          cursor: 'nwse-resize',
          background: 'linear-gradient(135deg, transparent 50%, rgba(0,0,0,0.15) 50%)',
          zIndex: 1,
        }}
      />
    </div>
  );
}
