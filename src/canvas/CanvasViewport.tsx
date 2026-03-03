import { useCallback, useEffect, useRef, type Dispatch } from 'react';

import type { CanvasAction, CanvasState } from './types';
import { ComponentCard } from './ComponentCard';

type Props = {
  state: CanvasState;
  dispatch: Dispatch<CanvasAction>;
};

const MIN_SCALE = 0.1;
const MAX_SCALE = 3.0;
const ZOOM_SENSITIVITY = 0.004;

export function CanvasViewport({ state, dispatch }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { viewport, components, selectedId, highlightedName, dragState } = state;

  const mouseRef = useRef({ x: 0, y: 0 });

  // Use a ref to always have current viewport/dispatch without re-attaching the listener
  const stateRef = useRef({ viewport, dispatch });
  stateRef.current = { viewport, dispatch };

  /** Zoom toward a focal point (screen coords relative to container). */
  function zoomTo(el: HTMLElement, vp: ViewportState, d: Dispatch<CanvasAction>, newScale: number, focalX: number, focalY: number) {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
    const scaleRatio = clamped / vp.scale;
    d({
      type: 'SET_VIEWPORT',
      viewport: {
        scale: clamped,
        offsetX: focalX - (focalX - vp.offsetX) * scaleRatio,
        offsetY: focalY - (focalY - vp.offsetY) * scaleRatio,
      },
    });
  }

  // Attach wheel handler with { passive: false } so preventDefault works
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { viewport: vp, dispatch: d } = stateRef.current;
      const rect = el.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      if (e.ctrlKey || e.metaKey) {
        const zoomFactor = 1 - e.deltaY * ZOOM_SENSITIVITY;
        zoomTo(el, vp, d, vp.scale * zoomFactor, mouseRef.current.x, mouseRef.current.y);
      } else {
        d({ type: 'PAN', deltaX: -e.deltaX, deltaY: -e.deltaY });
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousemove', onMouseMove);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousemove', onMouseMove);
    };
  }, []);

  // Keyboard shortcuts: Cmd+0 = reset 100%, Cmd+=/- = zoom in/out 25%
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const { viewport: vp, dispatch: d } = stateRef.current;
      const { x: fx, y: fy } = mouseRef.current;

      if (e.key === '0') {
        e.preventDefault();
        zoomTo(el, vp, d, 1.0, fx, fy);
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomTo(el, vp, d, vp.scale + 0.25, fx, fy);
      } else if (e.key === '-') {
        e.preventDefault();
        zoomTo(el, vp, d, vp.scale - 0.25, fx, fy);
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  const onBackgroundMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start pan on direct background click
    if (e.target !== e.currentTarget && e.target !== containerRef.current?.firstChild) return;
    dispatch({ type: 'SELECT', id: null });
    dispatch({
      type: 'START_DRAG',
      dragState: {
        type: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        originOffsetX: viewport.offsetX,
        originOffsetY: viewport.offsetY,
      },
    });
  }, [viewport.offsetX, viewport.offsetY, dispatch]);

  // Global mouse move/up handlers for drag operations
  useEffect(() => {
    if (!dragState) return;

    const onMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;

      switch (dragState.type) {
        case 'pan':
          dispatch({
            type: 'SET_VIEWPORT',
            viewport: {
              ...viewport,
              offsetX: dragState.originOffsetX + dx,
              offsetY: dragState.originOffsetY + dy,
            },
          });
          break;
        case 'move':
          dispatch({
            type: 'MOVE_COMPONENT',
            id: dragState.componentId,
            x: dragState.originX + dx / viewport.scale,
            y: dragState.originY + dy / viewport.scale,
          });
          break;
        case 'resize': {
          let rdx = dx / viewport.scale;
          let rdy = dy / viewport.scale;
          if (e.shiftKey) {
            // Constrain to single axis — whichever has more movement
            if (Math.abs(rdx) > Math.abs(rdy)) rdy = 0;
            else rdx = 0;
          }
          dispatch({
            type: 'RESIZE_COMPONENT',
            id: dragState.componentId,
            width: dragState.originW + rdx,
            height: dragState.originH + rdy,
          });
          break;
        }
      }
    };

    const onMouseUp = () => {
      dispatch({ type: 'END_DRAG' });
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragState, viewport, dispatch]);

  return (
    <div
      ref={containerRef}
      onMouseDown={onBackgroundMouseDown}
      style={{
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        background: '#f9fafb',
        cursor: dragState?.type === 'pan' ? 'grabbing' : 'default',
      }}
    >
      {/* Canvas transform layer */}
      <div
        style={{
          transform: `translate(${viewport.offsetX}px, ${viewport.offsetY}px) scale(${viewport.scale})`,
          transformOrigin: '0 0',
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      >
        {/* Cross dot grid */}
        <div
          onMouseDown={onBackgroundMouseDown}
          style={{
            position: 'fixed',
            top: -10000,
            left: -10000,
            width: 20000,
            height: 20000,
            backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.1) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
            pointerEvents: 'auto',
          }}
        />
        {components.map(comp => (
          <ComponentCard
            key={comp.id}
            component={comp}
            selected={comp.id === selectedId}
            highlighted={comp.entry.name === highlightedName}
            isDragging={!!dragState}
            viewport={viewport}
            dispatch={dispatch}
          />
        ))}
      </div>

      {/* Zoom indicator */}
      <div style={{
        position: 'absolute',
        bottom: 12,
        right: 12,
        fontSize: 10,
        color: '#6b7280',
        background: '#ffffff',
        padding: '3px 8px',
        border: '1px solid rgba(0,0,0,0.08)',
        userSelect: 'none',
        fontFamily: 'inherit',
      }}>
        {Math.round(viewport.scale * 100)}%
      </div>
    </div>
  );
}
