import { useCallback, useMemo, useState, type Dispatch } from 'react';

import type { ComponentEntry, ComponentManifest } from '../scanner/types';
import { renderSlug } from '../scanner/render-slug';
import { screenToCanvas } from './canvas-store';
import type { CanvasAction, PlacedComponent, ViewportState } from './types';

type Props = {
  manifest: ComponentManifest | null;
  viewport: ViewportState;
  dispatch: Dispatch<CanvasAction>;
  devOrigin: string;
  selectedName: string | null;
  highlightedName: string | null;
};

let placeCounter = Date.now();

export function ComponentSidebar({ manifest, viewport, dispatch, devOrigin, selectedName, highlightedName }: Props) {
  const [search, setSearch] = useState('');

  const grouped = useMemo(() => {
    if (!manifest) return new Map<string, ComponentEntry[]>();
    const map = new Map<string, ComponentEntry[]>();
    const term = search.toLowerCase();

    for (const entry of manifest.components) {
      if (term && !entry.name.toLowerCase().includes(term)) continue;
      const cat = entry.category || 'root';
      const list = map.get(cat) ?? [];
      list.push(entry);
      map.set(cat, list);
    }

    return map;
  }, [manifest, search]);

  const placeComponent = useCallback((entry: ComponentEntry) => {
    const centerScreen = { x: (window.innerWidth - 260) / 2 + 260, y: window.innerHeight / 2 };
    const center = screenToCanvas(centerScreen.x, centerScreen.y, viewport);

    const width = 400;
    const height = 300;

    // Always load via the isolated render route — ssr:false prevents
    // server-side redirects, and the render layout blocks client-side navigation.
    const slug = renderSlug(entry.filePath, entry.name);
    const iframeUrl = `${devOrigin}/popmelt/render/${slug}`;

    const component: PlacedComponent = {
      id: `placed-${++placeCounter}`,
      entry,
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      iframeUrl,
    };

    dispatch({ type: 'PLACE_COMPONENT', component });
  }, [viewport, dispatch, devOrigin]);

  const onHover = useCallback((name: string | null) => {
    dispatch({ type: 'HIGHLIGHT', name });
  }, [dispatch]);

  return (
    <div style={{
      width: 260,
      height: '100%',
      background: '#ffffff',
      borderRight: '1px solid rgba(0,0,0,0.08)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#1f2937', marginBottom: 8, letterSpacing: '0.5px', textTransform: 'uppercase' }}>Components</div>
        <input
          type="text"
          placeholder="search..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%',
            padding: '5px 8px',
            fontSize: 12,
            background: '#f9fafb',
            border: '1px solid rgba(0,0,0,0.1)',
            borderRadius: 0,
            color: '#1f2937',
            outline: 'none',
            boxSizing: 'border-box',
            fontFamily: 'inherit',
          }}
        />
      </div>

      {/* Scrollable list */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '4px 0' }}>
        {!manifest && (
          <div style={{ padding: 12, fontSize: 11, color: '#9ca3af' }}>loading...</div>
        )}
        {manifest && grouped.size === 0 && (
          <div style={{ padding: 12, fontSize: 11, color: '#9ca3af' }}>no components found</div>
        )}
        {[...grouped.entries()].map(([category, entries]) => (
          <CategoryGroup
            key={category}
            category={category}
            entries={entries}
            onPlace={placeComponent}
            onHover={onHover}
            selectedName={selectedName}
            highlightedName={highlightedName}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryGroup({ category, entries, onPlace, onHover, selectedName, highlightedName }: {
  category: string;
  entries: ComponentEntry[];
  onPlace: (entry: ComponentEntry) => void;
  onHover: (name: string | null) => void;
  selectedName: string | null;
  highlightedName: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div>
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{
          padding: '6px 12px',
          fontSize: 10,
          fontWeight: 700,
          color: collapsed ? '#9ca3af' : '#1f2937',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          cursor: 'pointer',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          transition: 'color 0.15s',
        }}
      >
        <span style={{ color: '#9ca3af', fontWeight: 400 }}>{collapsed ? '[+]' : '[-]'}</span>
        {category}
        <span style={{ color: '#d1d5db', marginLeft: 'auto', fontWeight: 400 }}>{entries.length}</span>
      </div>
      {!collapsed && entries.map(entry => {
        const isSelected = entry.name === selectedName;
        const isHighlighted = entry.name === highlightedName;
        const isActive = isSelected || isHighlighted;

        return (
          <div
            key={entry.name + entry.filePath}
            onClick={() => onPlace(entry)}
            onMouseEnter={() => onHover(entry.name)}
            onMouseLeave={() => onHover(null)}
            style={{
              padding: '5px 12px 5px 24px',
              cursor: 'pointer',
              borderLeft: isActive ? '2px solid #1f2937' : '2px solid transparent',
              background: isActive ? '#f9fafb' : 'transparent',
              transition: 'background 0.1s, border-color 0.1s',
            }}
          >
            <div style={{ fontSize: 12, color: '#1f2937', fontWeight: 600 }}>{entry.name}</div>
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.filePath}
            </div>
            {entry.routes && entry.routes.length > 0 ? (
              <div style={{ display: 'flex', gap: 3, marginTop: 3, flexWrap: 'wrap' }}>
                {entry.routes.map(r => (
                  <span key={r} style={{ fontSize: 9, padding: '1px 4px', background: '#f3f4f6', color: '#6b7280', border: '1px solid rgba(0,0,0,0.06)' }}>{r}</span>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 9, color: '#d1d5db', marginTop: 3 }}>(no route)</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
