import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { ComponentManifest } from '../scanner/types';
import { canvasReducer, initialCanvasState, loadPersistedState, saveCanvasState } from './canvas-store';
import { CanvasViewport } from './CanvasViewport';
import { ComponentSidebar } from './ComponentSidebar';

export const CANVAS_FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

type Props = {
  devOrigin: string;
  bridgeOrigin: string;
};

export function CanvasApp({ devOrigin, bridgeOrigin }: Props) {
  const [state, dispatch] = useReducer(canvasReducer, initialCanvasState, (init) => ({
    ...init,
    ...loadPersistedState(),
  }));
  const [manifest, setManifest] = useState<ComponentManifest | null>(null);

  // Persist components + viewport on change (debounced)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveCanvasState(state), 300);
    return () => clearTimeout(saveTimer.current);
  }, [state.components, state.viewport]);

  const selectedName = useMemo(() => {
    if (!state.selectedId) return null;
    return state.components.find(c => c.id === state.selectedId)?.entry.name ?? null;
  }, [state.selectedId, state.components]);

  useEffect(() => {
    let cancelled = false;

    async function loadManifest() {
      try {
        const res = await fetch(`${bridgeOrigin}/canvas/manifest`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setManifest(data);
      } catch (err) {
        console.error('[Popmelt Canvas] Failed to load manifest:', err);
      }
    }

    loadManifest();
    return () => { cancelled = true; };
  }, [bridgeOrigin]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      width: '100vw',
      height: '100vh',
      fontFamily: CANVAS_FONT,
      color: '#1f2937',
      background: '#ffffff',
    }}>
      <ComponentSidebar
        manifest={manifest}
        viewport={state.viewport}
        dispatch={dispatch}
        devOrigin={devOrigin}
        selectedName={selectedName}
        highlightedName={state.highlightedName}
      />
      <CanvasViewport state={state} dispatch={dispatch} />
    </div>
  );
}
