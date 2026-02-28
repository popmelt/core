'use client';

import React, { Component, createElement, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { Link2 } from 'lucide-react';
import { POPMELT_BORDER } from '../styles/border';
import type { SpacingTokenChange, SpacingTokenMod } from '../tools/types';
import { fetchModel, type DesignModel } from '../utils/bridge-client';
import { findAllComponentBoundariesByName, getComponentPositions } from '../utils/dom';
import { buildSpacingChangeContext, captureBindingsFromTargets, findElementsByTokenBinding, inferPropertyScope, resolveSpacingToken, updateBindingClasses, type SpacingElement, type TokenBinding } from '../utils/spacingAnalysis';
import { getUniqueSelector } from '../utils/cssSelector';
import { scanRootTokens, groupColorsByNamespace, type ScannedTokens } from '../utils/cssTokenScanner';

export type ComponentHoverInfo = { name: string; instanceIndex: number } | null;
export type SpacingTokenHover = { name: string; px: number; token?: TokenBinding } | null;

type LibraryPanelProps = {
  bridgeUrl?: string;
  modelRefreshKey?: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  selectedComponent?: string | null;
  hoveredComponent?: string | null;
  onComponentHover?: (info: ComponentHoverInfo) => void;
  onSpacingTokenHover?: (info: SpacingTokenHover) => void;
  onModifySpacingToken?: (mod: SpacingTokenMod, change: SpacingTokenChange) => void;
  onDeleteSpacingToken?: (tokenPath: string, originalValue: string) => void;
  onComponentAdded?: () => void;
  onComponentRemoved?: (name: string) => void;
};

type Tab = 'patterns' | 'principles' | 'rules';

const TAB_STORAGE_KEY = 'popmelt-library-tab';

// --- Detection helpers ---

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const FN_COLOR_RE = /^(?:rgba?|hsla?|oklch)\([^)]+\)$/;
const NAMED_COLORS = new Set([
  'black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple',
  'pink', 'gray', 'grey', 'cyan', 'magenta', 'brown', 'navy', 'teal',
  'maroon', 'olive', 'silver', 'aqua', 'fuchsia', 'lime',
]);
const CSS_LENGTH_RE = /^-?\d+(\.\d+)?(px|rem|em|%)$/;

function isColor(s: string): boolean {
  const t = s.trim();
  return HEX_RE.test(t) || FN_COLOR_RE.test(t) || NAMED_COLORS.has(t.toLowerCase());
}

function isCssLength(s: string): boolean {
  return CSS_LENGTH_RE.test(s.trim());
}

function parsePx(s: string): number | null {
  const m = s.trim().match(/^(-?\d+(?:\.\d+)?)px$/);
  return m ? parseFloat(m[1]!) : null;
}

// --- Flatten ---

function flattenEntries(obj: unknown, prefix = ''): [string, string][] {
  if (obj === null || obj === undefined) return [];
  if (typeof obj !== 'object') return [[prefix, String(obj)]];
  if (Array.isArray(obj)) return [[prefix, obj.map(String).join(', ')]];
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Token object detection: if it has a `value` key (string), treat as leaf
      const rec = v as Record<string, unknown>;
      if (typeof rec.value === 'string') {
        entries.push([key, rec.value]);
      } else {
        entries.push(...flattenEntries(v, key));
      }
    } else {
      entries.push([key, Array.isArray(v) ? v.map(String).join(', ') : String(v ?? '')]);
    }
  }
  return entries;
}

/** Classify a set of flattened entries by the dominant value type */
function classifyEntries(entries: [string, string][]): 'colors' | 'spacing' | 'generic' {
  if (entries.length === 0) return 'generic';
  const colorCount = entries.filter(([, v]) => isColor(v)).length;
  if (colorCount > entries.length / 2) return 'colors';
  const spacingCount = entries.filter(([, v]) => isCssLength(v)).length;
  if (spacingCount > entries.length / 2) return 'spacing';
  return 'generic';
}

// --- Styles ---

const panelStyle: CSSProperties = {
  position: 'fixed',
  top: 16,
  right: 16,
  bottom: 80,
  width: 300,
  backgroundColor: '#ffffff',
  ...POPMELT_BORDER,
  boxSizing: 'content-box',
  zIndex: 10001,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  color: '#1f2937',
  padding: 12,
  pointerEvents: 'auto',
};

const tabStyle: CSSProperties = {
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11,
  fontWeight: 600,
  padding: '2px 0',
  color: '#9ca3af',
};

const activeTabStyle: CSSProperties = {
  ...tabStyle,
  color: '#1f2937',
  borderBottom: '1.5px solid #1f2937',
};

// --- Renderers ---

function ColorSwatch({ varName, value, reference }: { varName: string; value: string; reference?: string }) {
  return (
    <div
      title={reference ? `${varName} \u2192 ${reference}\n${value}` : `${varName}: ${value}`}
      style={{
        width: 28,
        height: 28,
        backgroundColor: value,
        outline: '1px solid rgba(0,0,0,0.08)',
        outlineOffset: -1,
        position: 'relative',
      }}
    >
      {reference && (
        <Link2 size={10} strokeWidth={2.5} style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'white', filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.5))' }} />
      )}
    </div>
  );
}

function ColorGrid({ entries, references }: { entries: [string, string][]; references: Record<string, string> }) {
  const colors: [string, string][] = [];
  const other: [string, string][] = [];
  for (const e of entries) {
    if (isColor(e[1])) colors.push(e);
    else other.push(e);
  }

  const groups = groupColorsByNamespace(colors);

  return (
    <>
      {groups.map(([ns, items]) => (
        <div key={ns} style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>{ns}{items.length > 1 ? ` (${items.length})` : ''}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
            {items.map(([key, value]) => (
              <ColorSwatch key={key} varName={key} value={value} reference={references[key]} />
            ))}
          </div>
        </div>
      ))}
      {other.length > 0 && <GenericList entries={other} />}
    </>
  );
}

const SNAP_STEPS = [0, 1, 2, 4, 8, 12, 16, 20, 24, 28, 32] as const;

function snapToStep(raw: number): number {
  if (raw <= 32) {
    let best: number = SNAP_STEPS[0];
    let bestDist = Math.abs(raw - best);
    for (let i = 1; i < SNAP_STEPS.length; i++) {
      const d = Math.abs(raw - SNAP_STEPS[i]!);
      if (d < bestDist) { best = SNAP_STEPS[i]!; bestDist = d; }
    }
    return best;
  }
  return Math.round(raw / 8) * 8;
}

function SpacingTokenRow({ label, value, px, tokenPath, rawToken, onHover, onModify, onDelete }: {
  label: string; value: string; px: number; tokenPath: string;
  rawToken: string | TokenBinding;
  onHover?: (info: SpacingTokenHover) => void;
  onModify?: (mod: SpacingTokenMod, change: SpacingTokenChange) => void;
  onDelete?: (path: string, originalValue: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [dragPx, setDragPx] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const originalPxRef = useRef(0);
  const targetsRef = useRef<SpacingElement[]>([]);

  const displayPx = dragPx !== null ? dragPx : px;
  const displayValue = dragPx !== null ? `${dragPx}px` : value;
  const isDragging = dragPx !== null;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    originalPxRef.current = px;
    const token = resolveSpacingToken(rawToken);
    targetsRef.current = findElementsByTokenBinding(token);

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startXRef.current;
      let raw = Math.max(0, Math.round(originalPxRef.current + delta));
      if (ev.shiftKey) raw = snapToStep(raw);
      // Apply inline styles to page elements for live preview
      for (const t of targetsRef.current) {
        t.element.style.setProperty(t.property, raw + 'px', 'important');
      }
      setDragPx(raw);
      onHover?.({ name: label, px: raw, token });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      draggingRef.current = false;

      setDragPx(current => {
        if (current !== null && current !== px && onModify) {
          const token = resolveSpacingToken(rawToken);
          const hadBindings = token.bindings && token.bindings.length > 0;

          // Compute the serialized new value for model.json
          let newValue: string;
          if (hadBindings) {
            const newBindings = updateBindingClasses(token.bindings!, originalPxRef.current, current);
            newValue = JSON.stringify({ ...token, value: `${current}px`, bindings: newBindings });
          } else {
            const bindings = captureBindingsFromTargets(targetsRef.current, originalPxRef.current);
            const property = inferPropertyScope(targetsRef.current);
            if (bindings.length > 0) {
              const newBindings = updateBindingClasses(bindings, originalPxRef.current, current);
              newValue = JSON.stringify({ value: `${current}px`, property, bindings: newBindings });
            } else {
              newValue = `${current}px`;
            }
          }

          // Serialize original value for undo
          const originalValue = typeof rawToken === 'string' ? rawToken : JSON.stringify(rawToken);

          // Capture target selectors for inline style undo
          const targets = targetsRef.current.map(t => ({
            selector: getUniqueSelector(t.element),
            property: t.property,
          }));

          // Build code-grounded context for AI
          const evidence = buildSpacingChangeContext(targetsRef.current, originalPxRef.current, current);

          onModify(
            { tokenPath, originalValue, currentValue: newValue, targets, originalPx: originalPxRef.current, currentPx: current },
            { id: Math.random().toString(36).substring(2, 9), tokenPath, tokenName: label, originalPx: originalPxRef.current, newPx: current, affectedElements: evidence },
          );
        }
        return current; // keep displaying the dragged value
      });
    };

    document.body.style.cursor = 'ew-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [px, label, tokenPath, rawToken, onHover, onModify]);

  const token = resolveSpacingToken(rawToken);

  return (
    <div
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, padding: '1px 0', cursor: 'ew-resize', userSelect: 'none' }}
      onMouseEnter={() => { if (!draggingRef.current) { setHovered(true); onHover?.({ name: label, px: displayPx, token }); } }}
      onMouseLeave={() => { if (!draggingRef.current) { setHovered(false); onHover?.(null); } }}
      onMouseDown={handleMouseDown}
    >
      <span style={{ color: (hovered || isDragging) ? '#FF0000' : '#9ca3af' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: (hovered || isDragging) ? '#FF0000' : '#6b7280', fontWeight: 600 }}>{displayValue}</span>
        {onDelete && hovered && !isDragging && (
          <button
            type="button"
            title="Remove token"
            onMouseDown={(e) => {
              e.stopPropagation();
              const originalValue = typeof rawToken === 'string' ? rawToken : JSON.stringify(rawToken);
              onDelete(tokenPath, originalValue);
            }}
            style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, fontSize: 10, lineHeight: 1, color: '#9ca3af' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#FF0000'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#9ca3af'; }}
          >&#x2715;</button>
        )}
      </span>
    </div>
  );
}

function SpacingTokenList({ entries, categoryKey, rawTokens, onHover, onModify, onDelete }: {
  entries: [string, string][]; categoryKey: string;
  rawTokens?: Record<string, unknown>;
  onHover?: (info: SpacingTokenHover) => void;
  onModify?: (mod: SpacingTokenMod, change: SpacingTokenChange) => void;
  onDelete?: (path: string, originalValue: string) => void;
}) {
  const spacing: [string, string, number][] = [];
  const other: [string, string][] = [];
  for (const e of entries) {
    const px = parsePx(e[1]);
    if (px !== null) spacing.push([e[0], e[1], px]);
    else other.push(e);
  }

  return (
    <>
      {spacing.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {spacing.map(([key, value, px]) => {
            // Resolve the raw token value (may be enriched object or plain string)
            const leafKey = key.split('.').pop()!;
            const rawValue = rawTokens ? resolveNestedValue(rawTokens, key) : value;
            const rawToken: string | TokenBinding = rawValue && typeof rawValue === 'object' && 'value' in (rawValue as Record<string, unknown>)
              ? rawValue as TokenBinding
              : value;

            return (
              <SpacingTokenRow
                key={key}
                label={leafKey}
                value={value}
                px={px}
                tokenPath={`tokens.${categoryKey}.${key}`}
                rawToken={rawToken}
                onHover={onHover}
                onModify={onModify}
                onDelete={onDelete}
              />
            );
          })}
        </div>
      )}
      {other.length > 0 && <GenericList entries={other} />}
    </>
  );
}

/** Resolve a dot-path to a value in a nested object. */
function resolveNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function GenericList({ entries }: { entries: [string, string][] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {entries.map(([key, value]) => (
        <div key={key} style={{ fontSize: 11 }}>
          <div style={{ color: '#9ca3af', fontSize: 10, marginBottom: 1 }}>{key}</div>
          <div style={{ color: '#1f2937', lineHeight: 1.4, paddingLeft: 8 }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

/** Pick the right renderer based on entry classification */
function SmartEntries({ entries, categoryKey, rawTokens, onSpacingHover, onModifyToken, onDeleteToken }: {
  entries: [string, string][]; categoryKey: string;
  rawTokens?: Record<string, unknown>;
  onSpacingHover?: (info: SpacingTokenHover) => void;
  onModifyToken?: (mod: SpacingTokenMod, change: SpacingTokenChange) => void;
  onDeleteToken?: (path: string, originalValue: string) => void;
}) {
  const kind = classifyEntries(entries);
  if (kind === 'colors') return <ColorGrid entries={entries} />;
  if (kind === 'spacing') return <SpacingTokenList entries={entries} categoryKey={categoryKey} rawTokens={rawTokens} onHover={onSpacingHover} onModify={onModifyToken} onDelete={onDeleteToken} />;
  return <GenericList entries={entries} />;
}

// --- Dynamic component preview via React fiber ---

type FiberMatch = { type: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };

/** Walk the page DOM and find the React fiber for `componentName`, returning its type + props.
 *  Exact name match is preferred; falls back to substring match (e.g. "MonoAccordion" matches
 *  a fiber named "Accordion" since one contains the other). */
function findComponentFiber(componentName: string): FiberMatch | null {
  const normalized = componentName.toLowerCase();
  let fuzzyMatch: FiberMatch | null = null;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as HTMLElement;
      if (el.closest('#devtools-toolbar, #devtools-canvas, #devtools-scrim, [data-popmelt-panel]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null = walker.currentNode;
  while ((node = walker.nextNode())) {
    const el = node as HTMLElement & Record<string, unknown>;
    const fiberKey = Object.keys(el).find(
      k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (!fiberKey) continue;

    let fiber = el[fiberKey] as Record<string, unknown> | null;
    while (fiber) {
      const type = fiber.type;
      const name = typeof type === 'function' || typeof type === 'object'
        ? (type as Record<string, unknown>)?.displayName || (type as Record<string, unknown>)?.name
        : null;
      if (typeof name === 'string') {
        const fiberNorm = name.toLowerCase();
        if (fiberNorm === normalized) {
          // Exact match — return immediately
          const rawProps = { ...(fiber.memoizedProps as Record<string, unknown>) };
          delete rawProps.ref;
          return { type: type as React.ComponentType<Record<string, unknown>>, props: rawProps };
        }
        // Fuzzy: one name contains the other (min 4 chars for the contained part to avoid "Root", "Box", etc.)
        if (!fuzzyMatch) {
          if (fiberNorm.length >= 4 && normalized.includes(fiberNorm)) {
            const rawProps = { ...(fiber.memoizedProps as Record<string, unknown>) };
            delete rawProps.ref;
            fuzzyMatch = { type: type as React.ComponentType<Record<string, unknown>>, props: rawProps };
          } else if (normalized.length >= 4 && fiberNorm.includes(normalized)) {
            const rawProps = { ...(fiber.memoizedProps as Record<string, unknown>) };
            delete rawProps.ref;
            fuzzyMatch = { type: type as React.ComponentType<Record<string, unknown>>, props: rawProps };
          }
        }
      }
      fiber = fiber.return as Record<string, unknown> | null;
    }
  }
  return fuzzyMatch;
}

/** Error boundary to gracefully handle preview render failures */
class PreviewErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

// --- Tabs ---

const COLLAPSED_STORAGE_KEY = 'popmelt-principles-collapsed';

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {}
  return new Set();
}

function writeCollapsed(set: Set<string>) {
  try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...set])); } catch {}
}

function CategoryHeader({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontWeight: 700, fontSize: 11, color: '#6b7280', letterSpacing: '0.05em', marginBottom: 6 }}>
      {children}
    </div>
  );
}

function CollapsibleCategory({ id, label, count, children, collapsed, onToggle }: {
  id: string; label: string; count: number; children: ReactNode;
  collapsed: boolean; onToggle: (id: string) => void;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        onClick={() => onToggle(id)}
        style={{ fontWeight: 700, fontSize: 11, color: '#6b7280', letterSpacing: '0.05em', marginBottom: collapsed ? 0 : 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none' }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 10, fontSize: 9, color: '#9ca3af', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>&#9660;</span>
        {label}
        <span style={{ fontWeight: 400, color: '#9ca3af' }}>{count}</span>
      </div>
      {!collapsed && children}
    </div>
  );
}

const CATEGORY_LABELS: Record<keyof ScannedTokens, string> = {
  colors: 'Colors',
  fonts: 'Fonts',
  typeScale: 'Type Scale',
  spacing: 'Spacing',
  radii: 'Radii',
  shadows: 'Shadows',
  other: 'Other',
};

const CATEGORY_ORDER: (keyof ScannedTokens)[] = ['colors', 'fonts', 'typeScale', 'spacing', 'radii', 'shadows', 'other'];

function PrinciplesTab() {
  const [tokens, setTokens] = useState<ScannedTokens | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

  useEffect(() => {
    setTokens(scanRootTokens());
  }, []);

  const handleToggle = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      writeCollapsed(next);
      return next;
    });
  }, []);

  if (!tokens) return null;

  const hasAny = CATEGORY_ORDER.some(cat => tokens[cat].length > 0);
  if (!hasAny) {
    return <div style={{ color: '#9ca3af', fontSize: 11 }}>No :root tokens found.</div>;
  }

  return (
    <>
      {CATEGORY_ORDER.map(cat => {
        const entries = tokens[cat];
        if (entries.length === 0) return null;
        return (
          <CollapsibleCategory key={cat} id={cat} label={CATEGORY_LABELS[cat]} count={entries.length} collapsed={collapsed.has(cat)} onToggle={handleToggle}>
            {cat === 'colors' ? <ColorGrid entries={entries} references={tokens.references} /> : <GenericList entries={entries} />}
          </CollapsibleCategory>
        );
      })}
    </>
  );
}

function RulesTab({ rules }: { rules?: string[] }) {
  if (!rules || rules.length === 0) {
    return <div style={{ color: '#9ca3af', fontSize: 11 }}>No rules defined yet.</div>;
  }
  return (
    <>
      {rules.map((rule, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, lineHeight: 1.4, fontSize: 11 }}>
          <span style={{ color: '#9ca3af', flexShrink: 0 }}>{i + 1}.</span>
          <span>{rule}</span>
        </div>
      ))}
    </>
  );
}

function ComponentEntry({ name, value, selected, highlighted, onRemove, onHover }: { name: string; value: unknown; selected?: boolean; highlighted?: boolean; onRemove?: (name: string) => void; onHover?: (info: ComponentHoverInfo) => void }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const entryRef = useRef<HTMLDivElement>(null);
  const instanceIndexRef = useRef(0);
  const [instanceCount, setInstanceCount] = useState(0);
  const [currentInstance, setCurrentInstance] = useState(0);
  const entries = flattenEntries(value);
  const description = entries.find(([k]) => k === 'description')?.[1];

  // Count instances on hover
  useEffect(() => {
    if (!hovered && !highlighted) {
      setInstanceCount(0);
      setCurrentInstance(0);
      instanceIndexRef.current = 0;
      return;
    }
    const boundaries = findAllComponentBoundariesByName(name);
    setInstanceCount(boundaries.length);
  }, [hovered, highlighted, name]);

  // Scroll into view and pulse when selected
  useEffect(() => {
    if (selected && entryRef.current) {
      entryRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selected]);

  const isActive = selected || highlighted || hovered;
  // Green for hover (mirrors canvas green highlight), purple for selected (just-added confirmation)
  const accent = selected ? '139,92,246' : '34,197,94';
  const accentSolid = selected ? '#8b5cf6' : '#22c55e';
  const bg = isActive ? `rgba(${accent},0.06)` : undefined;
  const shadow = isActive ? `inset 0 0 0 1.5px rgba(${accent},0.35)` : undefined;
  const showBadge = highlighted || hovered;

  const handleClick = useCallback(() => {
    const boundaries = findAllComponentBoundariesByName(name);
    if (boundaries.length === 0) return;
    const idx = instanceIndexRef.current % boundaries.length;
    boundaries[idx]!.rootElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setCurrentInstance(idx);
    instanceIndexRef.current = idx + 1;
    onHover?.({ name, instanceIndex: idx });
  }, [name, onHover]);

  return (
    <div
      ref={entryRef}
      onClick={handleClick}
      onMouseEnter={() => { setHovered(true); onHover?.({ name, instanceIndex: 0 }); }}
      onMouseLeave={() => { setHovered(false); onHover?.(null); }}
      style={{ marginBottom: 8, background: bg, padding: 6, boxShadow: shadow, cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <div style={{
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: '0.05em',
            padding: '2px 6px',
            backgroundColor: showBadge ? accentSolid : 'transparent',
            color: showBadge ? '#fff' : '#6b7280',
          }}>{name}</div>
          {showBadge && instanceCount > 1 && (
            <span style={{
              fontSize: 10,
              fontWeight: 600,
              color: '#9ca3af',
            }}>{currentInstance + 1}/{instanceCount}</span>
          )}
        </div>
        {onRemove && hovered && (
          <button
            type="button"
            title="Remove from model"
            onClick={(e) => { e.stopPropagation(); onRemove(name); }}
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              padding: '0 2px',
              fontSize: 14,
              lineHeight: 1,
              color: '#9ca3af',
              marginTop: -4,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#FF0000'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#9ca3af'; }}
          >
            &#x2715;
          </button>
        )}
      </div>
      {description && (
        <div style={{ fontSize: 11, color: showBadge ? '#1f2937' : '#9ca3af', marginBottom: 6, lineHeight: 1.4 }}>{description}</div>
      )}
      {!previewFailed ? (
        <ComponentPreviewWithFallback name={name} onNotFound={() => setPreviewFailed(true)} entries={entries} />
      ) : (
        <SmartEntries entries={entries.filter(([k]) => k !== 'description')} categoryKey="" />
      )}
    </div>
  );
}

function ComponentPreviewWithFallback({ name, onNotFound }: { name: string; onNotFound: () => void; entries: [string, string][] }) {
  const [fiber, setFiber] = useState<FiberMatch | null>(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const result = findComponentFiber(name);
    if (!result) {
      onNotFound();
    }
    setFiber(result);
    setSearched(true);
  }, [name, onNotFound]);

  if (!searched || !fiber) return null;

  return (
    <PreviewErrorBoundary onError={onNotFound}>
      <div
        data-popmelt-panel
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
        style={{
          width: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          maxHeight: 150,
          padding: '1rem',
          outline: '1px solid rgba(0,0,0,0.06)',
          backgroundColor: 'rgb(250,250,250)',
          boxSizing: 'border-box',
          marginBottom: 4,
          display: 'flex',
          flexDirection: 'column' as const,
          justifyContent: 'stretch',
          alignItems: 'center',
          contain: 'layout paint',
          position: 'relative' as const,
          isolation: 'isolate' as const,
        }}
      >
        <div style={{ zoom: 0.5, pointerEvents: 'none' }}>
          {createElement(fiber.type, fiber.props)}
        </div>
      </div>
    </PreviewErrorBoundary>
  );
}

function ComponentsTab({ components, selectedComponent, hoveredComponent, onRemove, onHover }: { components?: Record<string, unknown>; selectedComponent?: string | null; hoveredComponent?: string | null; onRemove?: (name: string) => void; onHover?: (info: ComponentHoverInfo) => void }) {
  if (!components || Object.keys(components).length === 0) {
    return <div style={{ color: '#9ca3af', fontSize: 11 }}>No component patterns defined yet.</div>;
  }

  const names = new Set(Object.keys(components));
  const positions = getComponentPositions(names);
  const sorted = Object.entries(components).sort(([a], [b]) =>
    (positions.get(a) ?? Infinity) - (positions.get(b) ?? Infinity)
  );

  return (
    <>
      {sorted.map(([name, value]) => (
        <ComponentEntry
          key={name}
          name={name}
          value={value}
          selected={selectedComponent === name}
          highlighted={hoveredComponent === name}
          onRemove={onRemove}
          onHover={onHover}
        />
      ))}
    </>
  );
}

// --- Main ---

export function LibraryPanel({ bridgeUrl, modelRefreshKey, onMouseEnter, onMouseLeave, selectedComponent, hoveredComponent, onComponentHover, onSpacingTokenHover, onModifySpacingToken, onDeleteSpacingToken, onComponentAdded, onComponentRemoved }: LibraryPanelProps) {
  const [model, setModel] = useState<DesignModel>(undefined as unknown as DesignModel);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    try {
      const stored = localStorage.getItem(TAB_STORAGE_KEY);
      if (stored === 'patterns' || stored === 'principles' || stored === 'rules') return stored;
    } catch {}
    return 'patterns';
  });

  useEffect(() => {
    fetchModel(bridgeUrl).then(m => {
      setModel(m);
      setLoading(false);
    });
  }, [bridgeUrl, modelRefreshKey]);

  // Persist active tab
  useEffect(() => {
    try { localStorage.setItem(TAB_STORAGE_KEY, activeTab); } catch {}
  }, [activeTab]);

  // Auto-switch to components tab and re-fetch when a component is selected
  useEffect(() => {
    if (!selectedComponent) return;
    setActiveTab('patterns');
    // Re-fetch model to pick up newly added components
    fetchModel(bridgeUrl).then(m => {
      if (m) setModel(m);
    });
  }, [selectedComponent, bridgeUrl]);

  const handleRemove = useCallback((name: string) => {
    // Optimistically remove from local state
    setModel(prev => {
      if (!prev?.components) return prev;
      const { [name]: _, ...rest } = prev.components as Record<string, Record<string, string>>;
      return { ...prev, components: rest };
    });
    // Fire upstream callback (bridge call + modelComponentNames update)
    onComponentRemoved?.(name);
  }, [onComponentRemoved]);

  const components = model?.components as Record<string, unknown> | undefined;
  const rules = model?.rules as string[] | undefined;

  const hasComponents = components && Object.keys(components).length > 0;
  const hasRules = rules && rules.length > 0;

  return (
    <div style={panelStyle} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {/* Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
        <span>Model</span>
        <code style={{
          fontSize: 10,
          fontWeight: 500,
          backgroundColor: 'rgba(0,0,0,0.06)',
          padding: '1px 4px',
          color: '#6b7280',
        }}>M</code>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 10, borderBottom: '1px solid rgba(0,0,0,0.08)', paddingBottom: 6 }}>
        {(['patterns', 'principles', 'rules'] as const).map(tab => (
          <button
            key={tab}
            type="button"
            style={activeTab === tab ? activeTabStyle : tabStyle}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {activeTab === 'principles' ? (
          <PrinciplesTab />
        ) : loading ? (
          <div style={{ color: '#9ca3af', fontSize: 11 }}>Loading...</div>
        ) : !model || (!hasComponents && !hasRules) ? (
          <div style={{ color: '#9ca3af', lineHeight: 1.5 }}>
            No design model yet. Pattern-scoped annotations will build one automatically.
          </div>
        ) : (
          <>
            {activeTab === 'patterns' && <ComponentsTab components={components} selectedComponent={selectedComponent} hoveredComponent={hoveredComponent} onRemove={handleRemove} onHover={onComponentHover} />}
            {activeTab === 'rules' && <RulesTab rules={rules} />}
          </>
        )}
      </div>
    </div>
  );
}
