'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle,
  Component,
  Hand,
  MessageCircle,
  Pen,
  Slash,
  Square,
  Trash2,
  Type,
} from 'lucide-react';

import { useLocalStorageBatch } from '../hooks/useLocalStorageBatch';
import type { StorageKeys } from '../hooks/useLocalStorageBatch';
import { usePathname } from '../hooks/usePathname';
import type { ToolbarSnapPosition } from '../hooks/useToolbarLayout';
import { getToolbarStyle as getSnapToolbarStyle, getGuidanceStyle, getPanelEdge, SNAP_POSITIONS } from '../hooks/useToolbarLayout';

import { POPMELT_BORDER } from '../styles/border';
import type { Annotation, AnnotationAction, AnnotationState, SpacingTokenChange, ToolType } from '../tools/types';
import { restartBridge } from '../utils/bridge-client';
import { computeSupersededAnnotations } from '../utils/superseded';
import { applyStyleModifications, extractElementInfo, findElementBySelector, revertAllStyles } from '../utils/dom';
import { LibraryPanel, type ComponentHoverInfo, type SpacingTokenHover } from './LibraryPanel';
import { ClaudeIcon, CodexIcon } from './providers';
import { colors, ToolButton, ToolSeparator } from './ToolButton';

type McpStatus = {
  found: boolean;
  name: string | null;
  scope: 'user' | 'project' | 'mcp.json' | null;
  disabled: boolean;
};

type AnnotationToolbarProps = {
  state: AnnotationState;
  dispatch: React.Dispatch<AnnotationAction>;
  onScreenshot: () => Promise<boolean>;
  onSendToClaude?: () => Promise<boolean>;
  hasActiveJobs?: boolean;
  activeJobColor?: string;
  onCrosshairHover?: (hovering: boolean) => void;
  onClear?: () => void;
  provider?: string;
  onProviderChange?: (provider: string) => void;
  availableProviders?: string[];
  modelIndex?: number;
  modelCount?: number;
  modelLabel?: string;
  onModelChange?: (index: number) => void;
  onViewThread?: (threadId: string) => void;
  isThreadPanelOpen?: boolean;
  mcpStatus?: Record<string, McpStatus>;
  onInstallMcp?: () => Promise<void>;
  mcpJustInstalled?: boolean;
  bridgeUrl?: string;
  isBridgeConnected?: boolean;
  modelSelectedComponent?: string | null;
  modelCanvasHoveredComponent?: string | null;
  onModelComponentHover?: (info: ComponentHoverInfo) => void;
  onSpacingTokenHover?: (info: SpacingTokenHover) => void;
  onModifySpacingToken?: (mod: import('../tools/types').SpacingTokenMod, change: SpacingTokenChange) => void;
  onDeleteSpacingToken?: (tokenPath: string, originalValue: string) => void;
  modelRefreshKey?: number;
  onModelComponentAdded?: () => void;
  onModelComponentRemoved?: (name: string) => void;
  onSynthesizeRules?: () => void;
  isSynthesizing?: boolean;
  onMouseEnter?: () => void;
  toolbarRef?: React.MutableRefObject<HTMLDivElement | null>;
  snapPosition?: ToolbarSnapPosition;
  onSnapPositionChange?: (pos: ToolbarSnapPosition) => void;
};

type ToolDef = { type: ToolType; icon: typeof Pen; label: string; shortcut: string };

const shapeTools: ToolDef[] = [
  { type: 'rectangle', icon: Square, label: 'Rectangle', shortcut: 'R' },
  { type: 'circle', icon: Circle, label: 'Oval', shortcut: 'O' },
  { type: 'line', icon: Slash, label: 'Line', shortcut: 'L' },
  { type: 'freehand', icon: Pen, label: 'Pen', shortcut: 'P' },
];

const shapeToolTypes = new Set(shapeTools.map(t => t.type));

function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

function getPanelBottomEdge(snapPos: ToolbarSnapPosition = 'bottom-right'): { left: number; right: number; y: number } {
  return getPanelEdge(snapPos, window.innerWidth, window.innerHeight);
}

const standaloneTools: ToolDef[] = [
  { type: 'text', icon: Type, label: 'Text', shortcut: 'T' },
];

type GuidanceEntry = {
  name: string;
  desc: string;
  usage: string[];
  keys: { key: string; desc: string; accent?: boolean }[];
};

const TOOL_GUIDANCE: Record<string, GuidanceEntry> = {
  inspector: {
    name: 'Comment',
    desc: 'Pin feedback to specific elements on the page.',
    usage: [
      'Click any element to attach a comment',
      'Type your note, then hand off to your AI',
      'Your AI may ask clarifying questions',
      'Replies get threaded',
    ],
    keys: [
      { key: 'C', desc: 'Select tool' },
      { key: 'Click', desc: 'Pin comment to element' },
      { key: 'Esc', desc: 'Deselect' },
      { key: '⌘ Enter', desc: 'Hand off to your AI', accent: true },
    ],
  },
  hand: {
    name: 'Handle',
    desc: 'Quickly finetune layout and typescale.',
    usage: [
      'Edges → padding',
      'Between items → spacing',
      'Corners → rounding',
      'Right of text → font size',
      'Below text → line height',
      'Click a spacing handle to cycle distribution',
      'Right-click → inspect element styles',
    ],
    keys: [
      { key: 'H', desc: 'Select tool' },
      { key: 'Shift', desc: 'Snap to scale' },
      { key: '⌥ + swipe', desc: 'Cycle justify / flip direction' },
      { key: '⇧ + swipe', desc: 'Cycle align-items' },
      { key: 'Right-click', desc: 'Inspect styles' },
      { key: 'Esc', desc: 'Deselect' },
      { key: '⌘ Enter', desc: 'Hand off to your AI', accent: true },
    ],
  },
  rectangle: {
    name: 'Rectangle',
    desc: 'Draw rectangular highlights to mark areas of interest.',
    usage: [
      'Click and drag to draw',
      'Cycle between shapes with the dot selector',
    ],
    keys: [
      { key: 'R', desc: 'Rectangle' },
      { key: 'O', desc: 'Oval' },
      { key: 'L', desc: 'Line' },
      { key: 'P', desc: 'Pen' },
      { key: 'Esc', desc: 'Cancel or deselect' },
      { key: '⌘ Enter', desc: 'Hand off to your AI', accent: true },
    ],
  },
  circle: {
    name: 'Oval',
    desc: 'Draw oval highlights to mark areas of interest.',
    usage: [
      'Click and drag to draw',
      'Cycle between shapes with the dot selector',
    ],
    keys: [
      { key: 'O', desc: 'Oval' },
      { key: 'R', desc: 'Rectangle' },
      { key: 'L', desc: 'Line' },
      { key: 'P', desc: 'Pen' },
      { key: 'Esc', desc: 'Cancel or deselect' },
      { key: '⌘ Enter', desc: 'Hand off to your AI', accent: true },
    ],
  },
  line: {
    name: 'Line',
    desc: 'Draw line annotations to point at or connect elements.',
    usage: [
      'Click and drag to draw',
      'Cycle between shapes with the dot selector',
    ],
    keys: [
      { key: 'L', desc: 'Line' },
      { key: 'R', desc: 'Rectangle' },
      { key: 'O', desc: 'Oval' },
      { key: 'P', desc: 'Pen' },
      { key: 'Esc', desc: 'Cancel or deselect' },
      { key: '⌘ Enter', desc: 'Hand off to your AI', accent: true },
    ],
  },
  freehand: {
    name: 'Pen',
    desc: 'Draw freehand paths to annotate freely.',
    usage: [
      'Click and drag to draw',
      'Cycle between shapes with the dot selector',
    ],
    keys: [
      { key: 'P', desc: 'Pen' },
      { key: 'R', desc: 'Rectangle' },
      { key: 'O', desc: 'Oval' },
      { key: 'L', desc: 'Line' },
      { key: 'Esc', desc: 'Cancel or deselect' },
      { key: '⌘ Enter', desc: 'Hand off to your AI', accent: true },
    ],
  },
  text: {
    name: 'Text',
    desc: 'Place text labels anywhere on the page.',
    usage: [
      'Click to place, then start typing',
      'Click away or press Enter to finish',
      'Scroll while hovering a label to resize it',
    ],
    keys: [
      { key: 'T', desc: 'Select tool' },
      { key: 'Esc', desc: 'Cancel text or deselect' },
      { key: '⌘ Enter', desc: 'Hand off to your AI', accent: true },
    ],
  },
  model: {
    name: 'Model',
    desc: 'Promote components into the local design model.',
    usage: [
      'Hover to highlight component boundaries',
      'Scroll to walk up/down the component tree',
      'Click to add to model.json',
      'Green = already in model',
    ],
    keys: [
      { key: 'M', desc: 'Select tool' },
      { key: 'Scroll', desc: 'Walk tree depth' },
      { key: 'Click', desc: 'Promote component' },
      { key: 'Esc', desc: 'Deselect' },
    ],
  },
  counter: {
    name: 'Annotations',
    desc: 'Click to cycle, scroll to change color, long press to reset.',
    usage: [],
    keys: [
      { key: 'Click', desc: 'Cycle annotations' },
      { key: 'Scroll', desc: 'Change color' },
      { key: 'Hold', desc: 'Reset to red' },
    ],
  },
  clear: {
    name: 'Clear',
    desc: 'Remove all annotations and style changes.',
    usage: [],
    keys: [
      { key: '⌘ ⌫', desc: 'Clear all' },
      { key: '⌫', desc: 'Delete selected annotation' },
      { key: '⌘ Z', desc: 'Undo' },
      { key: '⌘ ⇧ Z', desc: 'Redo' },
    ],
  },
  collapse: {
    name: 'Popmelt',
    desc: 'Comment and zhuzh, then hand off.\n\nYour AI gets the visual and technical context it needs to act.',
    usage: [],
    keys: [
      { key: '⌘⌘', desc: 'Toggle toolbar' },
    ],
  },
};

const baseToolbarStyle: CSSProperties = {
  zIndex: 9999,
  display: 'flex',
  alignItems: 'center',
  backgroundColor: '#eaeaea',
  borderWidth: 3,
  borderStyle: 'solid',
  borderColor: 'transparent',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  cursor: 'pointer',
  overflow: 'visible',
  boxSizing: 'content-box',
  transition: 'none',
};

const STORAGE_KEY = 'devtools-toolbar-expanded';
const ANNOTATIONS_STORAGE_KEY = 'devtools-annotations';
const STYLE_MODS_STORAGE_KEY = 'devtools-style-modifications';
const TOOL_STORAGE_KEY = 'devtools-active-tool';
const COLOR_STORAGE_KEY = 'devtools-active-color';
const STROKE_STORAGE_KEY = 'devtools-stroke-width';
const INSPECTED_STORAGE_KEY = 'devtools-inspected-element';
const SPACING_CHANGES_STORAGE_KEY = 'devtools-spacing-changes';

const STORAGE_KEYS: StorageKeys = {
  expanded: STORAGE_KEY,
  annotations: ANNOTATIONS_STORAGE_KEY,
  styleMods: STYLE_MODS_STORAGE_KEY,
  spacingChanges: SPACING_CHANGES_STORAGE_KEY,
  tool: TOOL_STORAGE_KEY,
  color: COLOR_STORAGE_KEY,
  stroke: STROKE_STORAGE_KEY,
  inspected: INSPECTED_STORAGE_KEY,
};

// ClaudeIcon and CodexIcon imported from './providers'

export function AnnotationToolbar({
  state,
  dispatch,
  onScreenshot,
  onSendToClaude,
  hasActiveJobs,
  activeJobColor,
  onCrosshairHover,
  onClear,
  provider = 'claude',
  onProviderChange,
  availableProviders,
  modelIndex = 0,
  modelCount = 2,
  modelLabel = 'Opus 4.6',
  onModelChange,
  onViewThread,
  isThreadPanelOpen,
  mcpStatus,
  onInstallMcp,
  mcpJustInstalled,
  bridgeUrl,
  isBridgeConnected,
  modelSelectedComponent,
  modelCanvasHoveredComponent,
  onModelComponentHover,
  onSpacingTokenHover,
  onModifySpacingToken,
  onDeleteSpacingToken,
  modelRefreshKey,
  onModelComponentAdded,
  onModelComponentRemoved,
  onSynthesizeRules,
  isSynthesizing,
  onMouseEnter: onToolbarMouseEnter,
  toolbarRef: externalToolbarRef,
  snapPosition: snapPos = 'bottom-right',
  onSnapPositionChange,
}: AnnotationToolbarProps) {
  // Viewport size for layout calculations
  const [viewport, setViewport] = useState(() =>
    typeof window !== 'undefined' ? { w: window.innerWidth, h: window.innerHeight } : { w: 1920, h: 1080 },
  );
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });
  const [activeShapeIndex, setActiveShapeIndex] = useState(0);
  const lastCmdTapTime = useRef<number>(0);
  const cmdTapCount = useRef<number>(0);
  const prevIsAnnotatingRef = useRef(state.isAnnotating);
  const hasRestoredAnnotations = useRef(false);

  // Capture localStorage values at initialization time, before any effects can clobber them.
  // This protects against React strict mode re-mount writing stale values to localStorage
  // (persist effects see hasRestoredAnnotations=true from the first mount but state is still initial).
  const savedToolAtInit = useRef<ToolType | null>(
    typeof window !== 'undefined' ? localStorage.getItem(TOOL_STORAGE_KEY) as ToolType | null : null
  );
  const savedColorAtInit = useRef<string | null>(
    typeof window !== 'undefined' ? localStorage.getItem(COLOR_STORAGE_KEY) : null
  );
  const savedStrokeAtInit = useRef<string | null>(
    typeof window !== 'undefined' ? localStorage.getItem(STROKE_STORAGE_KEY) : null
  );

  // Spinner animation for crosshair when jobs are active

  // Tool guidance hover state
  const [guidanceTool, setGuidanceTool] = useState<string | null>(null);
  const guidanceVisibleRef = useRef(false);
  const guidanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const guidanceHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const guidancePanelRef = useRef<HTMLDivElement | null>(null);

  // Recent threads (shown in counter guidance)
  const [recentThreads, setRecentThreads] = useState<Array<{ id: string; createdAt: number; updatedAt: number; preview: string; messageCount: number; elementIdentifiers: string[] }>>([]);

  // Mouse-position prediction cone refs (Amazon mega-menu pattern)
  const lastMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pendingToolRef = useRef<string | null>(null);
  const decisionPointRef = useRef<{ x: number; y: number } | null>(null);
  const predictionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPrediction = useCallback(() => {
    pendingToolRef.current = null;
    decisionPointRef.current = null;
    if (predictionTimerRef.current) {
      clearTimeout(predictionTimerRef.current);
      predictionTimerRef.current = null;
    }
  }, []);

  const handleToolHoverStart = useCallback((tool: string) => {
    if (guidanceHideTimerRef.current) {
      clearTimeout(guidanceHideTimerRef.current);
      guidanceHideTimerRef.current = null;
    }
    if (guidanceVisibleRef.current) {
      // Panel already visible — use prediction cone instead of immediate switch
      pendingToolRef.current = tool;
      decisionPointRef.current = { ...lastMouseRef.current };
      if (predictionTimerRef.current) clearTimeout(predictionTimerRef.current);
      predictionTimerRef.current = setTimeout(() => {
        if (pendingToolRef.current) {
          setGuidanceTool(pendingToolRef.current);
          clearPrediction();
        }
      }, 300);
    } else {
      // Start 500ms show delay
      if (guidanceTimerRef.current) clearTimeout(guidanceTimerRef.current);
      guidanceTimerRef.current = setTimeout(() => {
        guidanceVisibleRef.current = true;
        setGuidanceTool(tool);
        guidanceTimerRef.current = null;
      }, 500);
    }
  }, [clearPrediction]);

  const handleToolHoverEnd = useCallback(() => {
    clearPrediction();
    if (guidanceTimerRef.current) {
      clearTimeout(guidanceTimerRef.current);
      guidanceTimerRef.current = null;
    }
    guidanceHideTimerRef.current = setTimeout(() => {
      guidanceVisibleRef.current = false;
      setGuidanceTool(null);
    }, 150);
  }, [clearPrediction]);

  // Native mouseenter/mouseleave on guidance panel — React synthetic events
  // don't fire reliably inside Shadow DOM (event retargeting at shadow boundary).
  useEffect(() => {
    const el = guidancePanelRef.current;
    if (!el) return;
    const onEnter = () => {
      clearPrediction();
      if (guidanceHideTimerRef.current) {
        clearTimeout(guidanceHideTimerRef.current);
        guidanceHideTimerRef.current = null;
      }
    };
    const onLeave = () => {
      guidanceHideTimerRef.current = setTimeout(() => {
        guidanceVisibleRef.current = false;
        setGuidanceTool(null);
      }, 150);
    };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [guidanceTool, clearPrediction]);

  // Fetch recent threads when counter guidance opens
  useEffect(() => {
    if (guidanceTool !== 'counter' || !bridgeUrl) return;
    let cancelled = false;
    fetch(`${bridgeUrl}/threads/recent?limit=5`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { if (!cancelled) setRecentThreads(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [guidanceTool, bridgeUrl]);

  const handleToolbarMouseMove = useCallback((e: React.MouseEvent) => {
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
    if (pendingToolRef.current && decisionPointRef.current) {
      const apex = decisionPointRef.current;
      const edge = getPanelBottomEdge(snapPos);
      if (!pointInTriangle(e.clientX, e.clientY, apex.x, apex.y, edge.left, edge.y, edge.right, edge.y)) {
        setGuidanceTool(pendingToolRef.current);
        clearPrediction();
      }
    }
  }, [clearPrediction, snapPos]);

  // Dynamic provider guidance (computed from availableProviders instead of static TOOL_GUIDANCE)
  const providerGuidance = useMemo((): GuidanceEntry => {
    const providerNames = (availableProviders ?? []).map(p =>
      p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : p
    );
    return {
      name: 'AI Model',
      desc: providerNames.length > 1
        ? `${providerNames.join(' and ')} are available.`
        : providerNames.length === 1
          ? `Connected to ${providerNames[0]}.`
          : 'No AI providers detected.',
      usage: providerNames.length > 1
        ? [
            'Click the logo to switch between providers',
            'Click the model name to switch tiers',
          ]
        : [
            'Click the model name to switch tiers',
          ],
      keys: providerNames.length > 1
        ? [{ key: 'Click', desc: 'Switch' }, { key: '⌘ Enter', desc: 'Hand off to your AI', accent: true }]
        : [{ key: '⌘ Enter', desc: 'Hand off to your AI', accent: true }],
    };
  }, [availableProviders]);

  // Batch-persist all toolbar state to localStorage in a single effect
  useLocalStorageBatch(isExpanded, state, hasRestoredAnnotations, !!hasActiveJobs, STORAGE_KEYS);

  // Auto-open toolbar when ?popmelt is present (for automated recording tools).
  // Optional delay value: ?popmelt=1000 opens after 1000ms (shows collapsed → expanded).
  // Also hides framework dev overlays (Turbopack, Vite error toast, etc.).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('popmelt')) return;

    // Hide dev overlays
    const style = document.createElement('style');
    style.textContent = 'nextjs-portal, vite-error-overlay { display: none !important; }';
    document.head.appendChild(style);

    const delayMs = parseInt(params.get('popmelt') || '0', 10) || 0;
    const open = () => {
      setIsExpanded(true);
      dispatch({ type: 'SET_TOOL', payload: 'inspector' });
      dispatch({ type: 'SET_ANNOTATING', payload: true });
    };

    if (delayMs > 0) {
      const timer = setTimeout(open, delayMs);
      return () => clearTimeout(timer);
    }
    open();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize annotation mode and restore annotations if restored as expanded.
  // Uses refs captured at init time (savedToolAtInit, etc.) to avoid reading from
  // localStorage after persist effects may have clobbered it (React strict mode).
  useEffect(() => {
    const wasExpanded = localStorage.getItem(STORAGE_KEY) === 'true';
    if (wasExpanded && !state.isAnnotating) {
      if (!isExpanded) setIsExpanded(true);
      // Use init-captured ref — immune to strict mode persist effect clobbering
      dispatch({ type: 'SET_TOOL', payload: savedToolAtInit.current || 'inspector' });
      dispatch({ type: 'SET_ANNOTATING', payload: true });

      if (savedColorAtInit.current) {
        dispatch({ type: 'SET_COLOR', payload: savedColorAtInit.current });
      }

      if (savedStrokeAtInit.current) {
        const width = parseFloat(savedStrokeAtInit.current);
        if (!isNaN(width)) {
          dispatch({ type: 'SET_STROKE_WIDTH', payload: width });
        }
      }

      // Restore annotations from localStorage
      const stored = localStorage.getItem(ANNOTATIONS_STORAGE_KEY);
      if (stored) {
        try {
          const annotations = JSON.parse(stored);
          if (Array.isArray(annotations) && annotations.length > 0) {
            // Clear transient statuses that don't survive a page refresh —
            // the agent session that set waiting_input/in_flight is gone.
            for (const a of annotations) {
              if (a.status === 'waiting_input' || a.status === 'in_flight') {
                a.status = a.threadId ? 'resolved' : 'pending';
              }
            }
            dispatch({ type: 'RESTORE_ANNOTATIONS', payload: { annotations } });
          }
        } catch {
          // Invalid JSON, ignore
        }
      }

      // Restore style modifications from localStorage
      const storedStyles = localStorage.getItem(STYLE_MODS_STORAGE_KEY);
      if (storedStyles) {
        try {
          const styleModifications = JSON.parse(storedStyles);
          if (Array.isArray(styleModifications) && styleModifications.length > 0) {
            dispatch({ type: 'RESTORE_STYLE_MODIFICATIONS', payload: styleModifications });
            // Apply styles to DOM
            applyStyleModifications(styleModifications);
          }
        } catch {
          // Invalid JSON, ignore
        }
      }

      // Restore spacing token changes from localStorage
      const storedSpacingChanges = localStorage.getItem(SPACING_CHANGES_STORAGE_KEY);
      if (storedSpacingChanges) {
        try {
          const spacingChanges = JSON.parse(storedSpacingChanges);
          if (Array.isArray(spacingChanges) && spacingChanges.length > 0) {
            dispatch({ type: 'RESTORE_SPACING_TOKEN_CHANGES', payload: spacingChanges });
          }
        } catch {
          // Invalid JSON, ignore
        }
      }

      // Restore inspected element (style panel visibility)
      const savedInspected = localStorage.getItem(INSPECTED_STORAGE_KEY);
      if (savedInspected) {
        try {
          const { selector, info } = JSON.parse(savedInspected);
          if (selector) {
            const el = findElementBySelector(selector);
            if (el) {
              const restoredInfo = info || { ...extractElementInfo(el), selector };
              dispatch({ type: 'SELECT_ELEMENT', payload: { el, info: restoredInfo } });
            }
          }
        } catch {
          // Invalid JSON, ignore
        }
      }

      // Check for cross-page pending focus (set by off-page cycle navigation)
      const pendingFocus = sessionStorage.getItem('popmelt-pending-focus');
      if (pendingFocus) {
        sessionStorage.removeItem('popmelt-pending-focus');
        try {
          const { annotationId } = JSON.parse(pendingFocus);
          if (annotationId) {
            // Read restored annotations from localStorage directly since state
            // hasn't been updated yet (RESTORE_ANNOTATIONS dispatch is batched)
            const restoredAnns: Annotation[] = stored ? (JSON.parse(stored) ?? []) : [];
            // Defer to allow DOM to settle after restore
            requestAnimationFrame(() => {
              dispatch({ type: 'SELECT_ANNOTATION', payload: { id: annotationId } });

              const target = restoredAnns.find((a: Annotation) => a.id === annotationId);
              if (target) {
                const groupAnns = target.groupId
                  ? restoredAnns.filter((a: Annotation) => a.groupId === target.groupId)
                  : [target];
                const allPoints = groupAnns.flatMap((a: Annotation) => a.points);
                if (allPoints.length > 0) {
                  const minX = Math.min(...allPoints.map(p => p.x));
                  const maxX = Math.max(...allPoints.map(p => p.x));
                  const minY = Math.min(...allPoints.map(p => p.y));
                  const maxY = Math.max(...allPoints.map(p => p.y));
                  window.scrollTo({
                    left: (minX + maxX) / 2 - window.innerWidth / 2,
                    top: (minY + maxY) / 2 - window.innerHeight / 2,
                    behavior: 'smooth',
                  });
                }
              }
            });
          }
        } catch {
          // Invalid JSON, ignore
        }
      }
    }

    // Check for cross-page pending thread reopen (set by recent thread click on different page)
    const pendingThread = sessionStorage.getItem('popmelt-pending-thread');
    if (pendingThread) {
      sessionStorage.removeItem('popmelt-pending-thread');
      try {
        const { threadId, selector, preview } = JSON.parse(pendingThread);
        if (threadId) {
          requestAnimationFrame(() => {
            // Re-tag the element with an annotation
            if (selector) {
              try {
                const el = document.querySelector(selector);
                if (el) {
                  const rect = el.getBoundingClientRect();
                  const annId = Math.random().toString(36).slice(2, 9);
                  dispatch({
                    type: 'ADD_TEXT',
                    payload: {
                      id: annId,
                      point: { x: rect.left + rect.width, y: rect.top },
                      text: preview || '[thread]',
                      linkedSelector: selector,
                      linkedAnchor: 'top-left',
                    },
                  });
                  dispatch({ type: 'SET_ANNOTATION_THREAD', payload: { ids: [annId], threadId } });
                  dispatch({ type: 'SET_ANNOTATION_STATUS', payload: { ids: [annId], status: 'resolved' } });
                }
              } catch { /* invalid selector */ }
            }
            if (onViewThread) onViewThread(threadId);
          });
        }
      } catch { /* invalid JSON */ }
    }

    hasRestoredAnnotations.current = true;
    // Cleanup: reset flag so strict mode re-mount doesn't let persist effects
    // write stale initial state (e.g. 'inspector') to localStorage
    return () => { hasRestoredAnnotations.current = false; };
  }, []); // Only on mount

  // Track previous styleModifications for undo/redo DOM sync
  const prevStyleModsRef = useRef(state.styleModifications);

  // Sync DOM with styleModifications on undo/redo
  useEffect(() => {
    const prevMods = prevStyleModsRef.current;
    const currentMods = state.styleModifications;

    // Skip if same reference (no change)
    if (prevMods === currentMods) return;

    // Revert all previous styles, then apply current ones
    // This handles undo/redo where the entire styleModifications array changes
    revertAllStyles(prevMods);
    applyStyleModifications(currentMods);

    prevStyleModsRef.current = currentMods;
  }, [state.styleModifications]);

  // Sync isExpanded when isAnnotating is turned OFF externally (e.g., from canvas escape handler)
  useEffect(() => {
    const wasAnnotating = prevIsAnnotatingRef.current;
    prevIsAnnotatingRef.current = state.isAnnotating;

    // Only collapse if annotation mode was just turned OFF (not when turning on)
    if (wasAnnotating && !state.isAnnotating && isExpanded) {
      setIsExpanded(false);
    }
  }, [state.isAnnotating, isExpanded]);

  // Track expanded state in ref for use in event handlers
  const isExpandedRef = useRef(isExpanded);
  isExpandedRef.current = isExpanded;

  // Double-tap cmd/ctrl to toggle toolbar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only respond to cmd/ctrl key itself (not when used with other keys)
      if (e.key === 'Meta' || e.key === 'Control') {
        const now = Date.now();
        const timeSinceLastTap = now - lastCmdTapTime.current;

        if (timeSinceLastTap < 300) {
          cmdTapCount.current++;
          if (cmdTapCount.current >= 2) {
            // Double-tap detected - toggle toolbar
            const wasExpanded = isExpandedRef.current;
            if (wasExpanded) {
              // Collapsing - keep annotations
              dispatch({ type: 'SET_ANNOTATING', payload: false });
              setIsExpanded(false);
            } else {
              // Expanding - restore persisted tool or default to inspector
              const savedTool = localStorage.getItem(TOOL_STORAGE_KEY) as ToolType | null;
              dispatch({ type: 'SET_TOOL', payload: savedTool || 'inspector' });
              dispatch({ type: 'SET_ANNOTATING', payload: true });
              setIsExpanded(true);
            }
            cmdTapCount.current = 0;
          }
        } else {
          cmdTapCount.current = 1;
        }
        lastCmdTapTime.current = now;
      } else {
        // Any non-modifier key pressed while Cmd is held = not a clean double-tap
        // Reset to prevent Cmd+Backspace from counting as a Cmd tap
        cmdTapCount.current = 0;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Reset if another key is released (not cmd/ctrl itself)
      if (e.key !== 'Meta' && e.key !== 'Control') {
        cmdTapCount.current = 0;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [dispatch]);

  const handleToolSelect = useCallback((tool: ToolType) => {
    clearPrediction();
    dispatch({ type: 'SET_TOOL', payload: tool });
    if (!state.isAnnotating) {
      dispatch({ type: 'SET_ANNOTATING', payload: true });
    }
    // Dismiss guidance on tool select
    guidanceVisibleRef.current = false;
    setGuidanceTool(null);
    if (guidanceTimerRef.current) { clearTimeout(guidanceTimerRef.current); guidanceTimerRef.current = null; }
    if (guidanceHideTimerRef.current) { clearTimeout(guidanceHideTimerRef.current); guidanceHideTimerRef.current = null; }
  }, [dispatch, state.isAnnotating, clearPrediction]);

  const handleScreenshot = useCallback(async () => {
    window.focus();
    await onScreenshot();
  }, [onScreenshot]);

  const handleSendToClaude = useCallback(async () => {
    if (!onSendToClaude) return;
    await onSendToClaude();
  }, [onSendToClaude]);

  const handleCollapse = useCallback(() => {
    dispatch({ type: 'SET_ANNOTATING', payload: false });
    setIsExpanded(false);
  }, [dispatch]);

  const handleClear = useCallback(() => {
    // Revert all style modifications in DOM before clearing
    revertAllStyles(state.styleModifications);
    // Remove data-pm tracking attributes from DOM
    document.querySelectorAll('[data-pm]').forEach(el => el.removeAttribute('data-pm'));
    dispatch({ type: 'CLEAR' });
    dispatch({ type: 'CLEAR_ALL_STYLES' });
    localStorage.removeItem(ANNOTATIONS_STORAGE_KEY);
    localStorage.removeItem(STYLE_MODS_STORAGE_KEY);
    localStorage.removeItem(SPACING_CHANGES_STORAGE_KEY);
    setFocusedGroupIndex(null);
    onClear?.();
  }, [dispatch, state.styleModifications, onClear]);

  // Color hue state (OKLCH hue, 0-360, red ≈ 29)
  const [hue, setHue] = useState(() => {
    if (savedColorAtInit.current) {
      const match = savedColorAtInit.current.match(/oklch\([^)]*\s+([\d.]+)\s*\)/);
      if (match?.[1]) return parseFloat(match[1]);
    }
    return 29;
  });
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const counterRef = useRef<HTMLButtonElement>(null);
  const isInternalColorChange = useRef(false);

  // Parse hue from OKLCH color string (defined early for use in effects)
  const parseHueFromColor = useCallback((color: string): number | null => {
    const match = color.match(/oklch\([^)]*\s+([\d.]+)\s*\)/);
    if (match && match[1]) {
      return parseFloat(match[1]);
    }
    return null;
  }, []);

  // Update activeColor when hue changes (mark as internal to avoid feedback loop)
  useEffect(() => {
    isInternalColorChange.current = true;
    const color = `oklch(0.628 0.258 ${hue})`;
    dispatch({ type: 'SET_COLOR', payload: color });
    // Reset flag after a tick
    requestAnimationFrame(() => {
      isInternalColorChange.current = false;
    });
  }, [hue, dispatch]);

  // Sync hue from activeColor when it changes externally (e.g., from canvas selection)
  useEffect(() => {
    if (isInternalColorChange.current) return;
    const parsedHue = parseHueFromColor(state.activeColor);
    if (parsedHue !== null && Math.abs(parsedHue - hue) > 0.5) {
      setHue(parsedHue);
    }
  }, [state.activeColor, parseHueFromColor, hue]);

  // Sync hue to the actively-processing job's color so the toolbar matches
  // the annotation being worked on. Stash the auto-advanced hue so it can be
  // restored when all jobs finish.
  const preJobHueRef = useRef<number | null>(null);
  useEffect(() => {
    if (hasActiveJobs && activeJobColor) {
      const jobHue = parseHueFromColor(activeJobColor);
      if (jobHue !== null && Math.abs(jobHue - hue) > 0.5) {
        // Stash current hue only on the first sync (not every active-job color change)
        if (preJobHueRef.current === null) {
          preJobHueRef.current = hue;
        }
        setHue(jobHue);
      }
    } else if (preJobHueRef.current !== null) {
      // Jobs finished — restore the auto-advanced hue
      setHue(preJobHueRef.current);
      preJobHueRef.current = null;
    }
  }, [hasActiveJobs, activeJobColor, parseHueFromColor]);

  // Handle wheel on counter to change hue (native listener for passive: false)
  const hasAnnotations = state.annotations.length > 0;
  useEffect(() => {
    const counter = counterRef.current;
    if (!counter || !hasAnnotations) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const delta = e.deltaY > 0 ? -1 : 1;
      const newHue = ((hue + delta) % 360 + 360) % 360;
      const newColor = `oklch(0.628 0.258 ${newHue})`;

      setHue(newHue);

      // If annotations are selected, update their colors (uses lastSelectedId internally)
      if (state.selectedAnnotationIds.length > 0) {
        dispatch({ type: 'UPDATE_ANNOTATION_COLOR', payload: { id: state.lastSelectedId || state.selectedAnnotationIds[0]!, color: newColor } });
      }
    };

    counter.addEventListener('wheel', handleWheel, { passive: false });
    return () => counter.removeEventListener('wheel', handleWheel);
  }, [hasAnnotations, state.selectedAnnotationIds, state.lastSelectedId, hue, dispatch]);

  // Auto-advance hue after send: pick the hue farthest from all existing annotation hues
  const prevHadPendingRef = useRef(false);
  const prevAnnotationCountRef = useRef(0);
  useEffect(() => {
    const hasPending = state.annotations.some(a => !a.status || a.status === 'pending');
    const hadPending = prevHadPendingRef.current;
    prevHadPendingRef.current = hasPending;

    // Detect restore: went from 0 → N annotations (page reload with persisted annotations)
    const justRestored = prevAnnotationCountRef.current === 0 && state.annotations.length > 0;
    prevAnnotationCountRef.current = state.annotations.length;

    // Trigger on: (1) just sent (pending → non-pending), or (2) restored non-pending annotations on load
    if (((hadPending && !hasPending) || (justRestored && !hasPending)) && state.annotations.length > 0) {
      const usedHues = state.annotations
        .map(a => parseHueFromColor(a.color))
        .filter((h): h is number => h !== null);

      if (usedHues.length > 0) {
        // Find the hue (0-359, stepping by 1) that maximizes minimum distance to all used hues
        let bestHue = 0;
        let bestDist = -1;
        for (let candidate = 0; candidate < 360; candidate++) {
          const minDist = Math.min(...usedHues.map(h => {
            const d = Math.abs(candidate - h);
            return Math.min(d, 360 - d);
          }));
          if (minDist > bestDist) {
            bestDist = minDist;
            bestHue = candidate;
          }
        }
        setHue(bestHue);
      }
    }
  }, [state.annotations, parseHueFromColor]);

  // Long press to reset to red
  const longPressTriggeredRef = useRef(false);

  const handleCounterMouseDown = useCallback(() => {
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      setHue(29); // Reset to red
    }, 500);
  }, []);

  const handleCounterMouseUp = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // Cleanup long press timer and prediction timer
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
      if (predictionTimerRef.current) {
        clearTimeout(predictionTimerRef.current);
      }
    };
  }, []);

  // Filter annotations to current page (annotations without pathname are visible everywhere for backward compat)
  const currentPathname = usePathname();
  const pageAnnotations = useMemo(
    () => state.annotations.filter(a => !a.pathname || a.pathname === currentPathname),
    [state.annotations, currentPathname],
  );

  // Compute superseded annotations (older rounds on the same element)
  // Uses all annotations (not just page) so off-page superseded are correctly excluded
  const supersededAnnotations = useMemo(
    () => computeSupersededAnnotations(state.annotations),
    [state.annotations],
  );

  // Global annotation groups sorted by creation time (timestamp).
  // Each group knows its pathname so cycling can navigate cross-page.
  type AnnotationGroup = { id: string; pathname: string | undefined; annotations: Annotation[]; timestamp: number };
  const allAnnotationGroups = useMemo(() => {
    const groups: AnnotationGroup[] = [];
    const seenGroupIds = new Set<string>();
    const sorted = [...state.annotations].sort((a, b) => a.timestamp - b.timestamp);

    for (const annotation of sorted) {
      if (supersededAnnotations.has(annotation)) continue;
      if (annotation.groupId) {
        if (!seenGroupIds.has(annotation.groupId)) {
          seenGroupIds.add(annotation.groupId);
          const groupAnnotations = state.annotations.filter(
            a => a.groupId === annotation.groupId && !supersededAnnotations.has(a),
          );
          const primary = groupAnnotations.find(a => a.type !== 'text') || groupAnnotations[0]!;
          const earliest = Math.min(...groupAnnotations.map(a => a.timestamp));
          groups.push({ id: primary.id, pathname: annotation.pathname, annotations: groupAnnotations, timestamp: earliest });
        }
      } else {
        groups.push({ id: annotation.id, pathname: annotation.pathname, annotations: [annotation], timestamp: annotation.timestamp });
      }
    }
    // Already in timestamp order since we iterated sorted annotations
    return groups;
  }, [state.annotations, supersededAnnotations]);

  // On-page subset (for badge display count and on-page focusing)
  const annotationGroups = useMemo(
    () => allAnnotationGroups.filter(g => !g.pathname || g.pathname === currentPathname),
    [allAnnotationGroups, currentPathname],
  );

  // Track focused item index (null = showing total, 0+ = focused on that item)
  // Cycle order: all annotation groups (global, by timestamp) then style modifications
  const [focusedGroupIndex, setFocusedGroupIndex] = useState<number | null>(null);

  // Total focusable items count (global annotations + style modifications)
  const totalFocusableItems = allAnnotationGroups.length + state.styleModifications.length;

  // Reset focused index when items change significantly or selection is cleared
  useEffect(() => {
    if (totalFocusableItems === 0) {
      setFocusedGroupIndex(null);
    } else if (focusedGroupIndex !== null && focusedGroupIndex >= totalFocusableItems) {
      setFocusedGroupIndex(null);
    }
  }, [totalFocusableItems, focusedGroupIndex]);

  // Sync focused index from external selection changes (e.g. badge clicks)
  // Reset to null when selection is cleared and no element is inspected
  useEffect(() => {
    if (state.selectedAnnotationIds.length === 0 && !state.inspectedElement) {
      setFocusedGroupIndex(null);
      return;
    }
    if (state.selectedAnnotationIds.length > 0) {
      const selectedId = state.selectedAnnotationIds[0];
      const groupIdx = allAnnotationGroups.findIndex(g =>
        g.id === selectedId || g.annotations.some(a => a.id === selectedId)
      );
      if (groupIdx >= 0 && groupIdx !== focusedGroupIndex) {
        setFocusedGroupIndex(groupIdx);
      }
    }
  }, [state.selectedAnnotationIds, state.inspectedElement, allAnnotationGroups]);

  // Cycle through annotations and style modifications
  const handleCycleAnnotation = useCallback(() => {
    if (totalFocusableItems === 0) return;

    let nextIndex: number | null;
    if (focusedGroupIndex === null) {
      // Currently showing total, go to first global item
      nextIndex = 0;
    } else if (focusedGroupIndex + 1 >= totalFocusableItems) {
      // Past the last item — wrap to null (total display)
      nextIndex = null;
    } else {
      nextIndex = focusedGroupIndex + 1;
    }

    setFocusedGroupIndex(nextIndex);

    if (nextIndex === null) {
      // Wrapped back to total display — clear selection
      dispatch({ type: 'SELECT_ANNOTATION', payload: { id: null } });
      dispatch({ type: 'SELECT_ELEMENT', payload: null });
      return;
    }

    // Check if this is an annotation group or a style modification
    if (nextIndex < allAnnotationGroups.length) {
      const group = allAnnotationGroups[nextIndex]!;
      const isOnPage = !group.pathname || group.pathname === currentPathname;

      if (!isOnPage) {
        // Off-page — navigate to the target page
        sessionStorage.setItem('popmelt-pending-focus', JSON.stringify({
          annotationId: group.id,
          pathname: group.pathname,
        }));
        window.location.href = group.pathname!;
        return;
      }

      // On-page annotation group
      // Clear inspected element when switching to annotation
      dispatch({ type: 'SELECT_ELEMENT', payload: null });

      // Select the primary annotation
      dispatch({ type: 'SELECT_ANNOTATION', payload: { id: group.id } });

      // Get the primary (non-text) annotation for tool and color
      const primaryAnnotation = group.annotations.find(a => a.type !== 'text') || group.annotations[0];
      const isLinkedAnnotation = group.annotations.some(a => a.linkedSelector);

      // Switch to the annotation's tool type
      if (isLinkedAnnotation) {
        dispatch({ type: 'SET_TOOL', payload: 'inspector' });
      } else if (primaryAnnotation?.type && primaryAnnotation.type !== 'text' && primaryAnnotation.type !== 'inspector') {
        dispatch({ type: 'SET_TOOL', payload: primaryAnnotation.type });
        const shapeIdx = shapeTools.findIndex(s => s.type === primaryAnnotation.type);
        if (shapeIdx >= 0) setActiveShapeIndex(shapeIdx);
      }

      // Set active color to match the selected annotation's color
      if (primaryAnnotation?.color) {
        dispatch({ type: 'SET_COLOR', payload: primaryAnnotation.color });
        const parsedHue = parseHueFromColor(primaryAnnotation.color);
        if (parsedHue !== null) {
          setHue(parsedHue);
        }
      }

      // Calculate center point of all annotations in group
      const allPoints = group.annotations.flatMap(a => a.points);
      if (allPoints.length === 0) return;

      const minX = Math.min(...allPoints.map(p => p.x));
      const maxX = Math.max(...allPoints.map(p => p.x));
      const minY = Math.min(...allPoints.map(p => p.y));
      const maxY = Math.max(...allPoints.map(p => p.y));
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      window.scrollTo({
        left: centerX - window.innerWidth / 2,
        top: centerY - window.innerHeight / 2,
        behavior: 'smooth',
      });

      // Switch the thread panel to this group's thread if open
      if (isThreadPanelOpen && onViewThread) {
        const threadId = group.annotations.find(a => a.threadId)?.threadId;
        if (threadId) onViewThread(threadId);
      }
    } else {
      // Style modification (always on-page)
      const modIndex = nextIndex - allAnnotationGroups.length;
      const modification = state.styleModifications[modIndex];
      if (!modification) return;

      const el = findElementBySelector(modification.selector);
      if (!el) return;

      dispatch({ type: 'SELECT_ANNOTATION', payload: { id: null } });
      dispatch({ type: 'SET_TOOL', payload: 'inspector' });
      dispatch({
        type: 'SELECT_ELEMENT',
        payload: { el, info: modification.element },
      });

      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2 + window.scrollX;
      const centerY = rect.top + rect.height / 2 + window.scrollY;

      window.scrollTo({
        left: centerX - window.innerWidth / 2,
        top: centerY - window.innerHeight / 2,
        behavior: 'smooth',
      });
    }
  }, [allAnnotationGroups, currentPathname, state.styleModifications, totalFocusableItems, focusedGroupIndex, dispatch, parseHueFromColor, isThreadPanelOpen, onViewThread]);

  // Keyboard shortcuts for tools (only when expanded and not editing text)
  useEffect(() => {
    if (!isExpanded) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if editing text (input/textarea focused)
      // Walk into shadow roots to find the real focused element
      let activeEl: Element | null = document.activeElement;
      while (activeEl?.shadowRoot?.activeElement) {
        activeEl = activeEl.shadowRoot.activeElement;
      }
      if (activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA' || (activeEl as HTMLElement)?.isContentEditable) {
        return;
      }

      // Cmd/Ctrl+Enter to send to Claude (when bridge connected and annotations exist)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (onSendToClaude && (state.annotations.length > 0 || state.styleModifications.length > 0 || state.spacingTokenChanges.filter(c => !c.captured).length > 0)) {
          e.preventDefault();
          handleSendToClaude();
        }
        return;
      }

      // Cmd/Ctrl+C for screenshot (when annotations or style modifications exist)
      // Skip if user has a text selection — let native copy work
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return; // allow native copy
        if (state.annotations.length > 0 || state.styleModifications.length > 0) {
          e.preventDefault();
          window.focus();
          handleScreenshot();
        }
        return;
      }

      // Cmd/Ctrl+Backspace/Delete to clear all annotations
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault();
        handleClear();
        return;
      }

      // Tool shortcuts (no modifiers)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const toolMap: Record<string, ToolType> = {
        p: 'freehand',
        l: 'line',
        r: 'rectangle',
        o: 'circle',
        t: 'text',
        c: 'inspector',
        h: 'hand',
      };

      // M key selects the Model tool
      if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        handleToolSelect('model');
        return;
      }

      const tool = toolMap[e.key.toLowerCase()];
      if (tool) {
        e.preventDefault();
        // If it's a shape tool, also update the active shape index
        const shapeIdx = shapeTools.findIndex(s => s.type === tool);
        if (shapeIdx >= 0) {
          setActiveShapeIndex(shapeIdx);
        }
        handleToolSelect(tool);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExpanded, handleToolSelect, handleScreenshot, handleSendToClaude, onSendToClaude, handleClear, state.annotations.length, state.styleModifications.length, state.spacingTokenChanges, guidanceTool]);



  // Dynamic styles based on expanded state + snap position
  const snapStyles = getSnapToolbarStyle(snapPos, viewport.w, viewport.h);
  const toolbarStyle: CSSProperties = {
    ...baseToolbarStyle,
    ...snapStyles,
    borderRadius: 0,
    padding: isExpanded ? '0 8px' : '0',
    width: isExpanded ? 'auto' : 48,
    height: 48,
    gap: 0,
    justifyContent: isExpanded ? 'flex-start' : 'center',
  };

  const borderTileColor = hasActiveJobs && activeJobColor ? activeJobColor : 'rgb(0,0,0)';
  const borderSvgTile = `<svg xmlns='http://www.w3.org/2000/svg' width='5' height='5'><path d='M-1,1 l2,-2 M0,5 l5,-5 M4,6 l2,-2' stroke='${borderTileColor}' stroke-width='.75'/></svg>`;
  const borderOverlay = (
    <div style={{
      position: 'absolute',
      inset: -3,
      padding: 5,
      backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(borderSvgTile)}")`,
      backgroundSize: '5px 5px',
      WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) border-box',
      WebkitMaskComposite: 'xor',
      mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) border-box',
      maskComposite: 'exclude' as string,
      pointerEvents: 'none' as const,
      ...(hasActiveJobs && { animation: 'popmelt-border-march 0.8s linear infinite' }),
    }} />
  );

  // Crosshair icon color based on job state
  const crosshairColor = isBridgeConnected === false
    ? 'rgba(239, 68, 68, 0.4)'
    : hasActiveJobs && activeJobColor ? activeJobColor : colors.iconActive;

  // Expanded collapse button — native listeners (shadow DOM compat)
  const expandedCollapseRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isExpanded) return;
    const el = expandedCollapseRef.current;
    if (!el) return;
    const onEnter = () => {
      onCrosshairHover?.(true);
      handleToolHoverStart('collapse');
    };
    const onLeave = () => {
      onCrosshairHover?.(false);
      handleToolHoverEnd();
    };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    return () => { el.removeEventListener('mouseenter', onEnter); el.removeEventListener('mouseleave', onLeave); };
  }, [isExpanded, hasActiveJobs, onCrosshairHover, handleToolHoverStart, handleToolHoverEnd]);

  // Collapsed state content
  const collapsedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isExpanded) return;
    const el = collapsedRef.current;
    if (!el) return;
    const logo = el.querySelector('[data-popmelt-logo]') as SVGElement | null;
    const onEnter = () => { el.style.opacity = '1'; if (!hasActiveJobs && logo) logo.style.fill = '#000'; onToolbarMouseEnter?.(); };
    const onLeave = () => { el.style.opacity = hasActiveJobs ? '1' : '0.5'; if (!hasActiveJobs && logo) logo.style.fill = 'none'; };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    return () => { el.removeEventListener('mouseenter', onEnter); el.removeEventListener('mouseleave', onLeave); };
  }, [isExpanded, hasActiveJobs, onToolbarMouseEnter]);
  if (!isExpanded) {
    return (
      <>
        <style>{`
          @keyframes popmelt-border-march { to { background-position: 0 -5px; } }
        `}</style>
        <div
          ref={(el) => { collapsedRef.current = el; if (externalToolbarRef) externalToolbarRef.current = el; }}
          id="devtools-toolbar"
          style={{ ...toolbarStyle, overflow: 'visible', opacity: hasActiveJobs ? 1 : 0.5 }}
        >
          {borderOverlay}
          <button
            type="button"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 48,
              height: 48,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
            onClick={() => {
              setIsExpanded(true);
              dispatch({ type: 'SET_TOOL', payload: 'inspector' });
              dispatch({ type: 'SET_ANNOTATING', payload: true });
            }}
            onMouseEnter={() => onCrosshairHover?.(true)}
            onMouseLeave={() => onCrosshairHover?.(false)}
            title="Open annotation toolbar (⌘⌘)"
          >
            <svg data-popmelt-logo width="30" height="30" viewBox="0 0 40 40" fill="none" stroke={crosshairColor} strokeWidth="1" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
                <path d="M20.25 8.00293H20.249C21.5098 8.0286 22.7219 8.25094 23.8584 8.63672L23.8604 8.63574C23.8961 8.64787 23.9312 8.66145 23.9668 8.67383C24.0611 8.70686 24.1548 8.74106 24.248 8.77637C24.2915 8.79273 24.3357 8.80727 24.3789 8.82422L24.376 8.82617C27.6145 10.0955 30.1646 12.7301 31.3213 16.0234L31.3232 16.0225C31.3327 16.0493 31.3404 16.0766 31.3496 16.1035C31.7691 17.3256 32 18.6356 32 20C32 20.8726 31.9366 21.6706 31.7598 22.4902L31.7197 22.6328C31.6412 23.0066 31.5136 23.6108 31.3408 24.2217L31.3398 24.2246C31.2967 24.377 31.251 24.5299 31.2021 24.6797C30.9215 25.5403 30.5473 26.2998 30.0879 26.2998C29.7613 26.2996 29.5995 25.9674 29.4316 25.6221C29.2501 25.2487 29.0614 24.8605 28.6484 24.8604C27.8532 24.8604 27.2081 25.5046 27.208 26.2998V27.0771C27.2079 27.6079 26.9661 28.112 26.5205 28.4004C25.9146 28.7925 25.2357 28.6462 24.7959 28.2061L24.7949 28.208C24.7897 28.2028 24.7854 28.1967 24.7803 28.1914C24.7654 28.1761 24.7507 28.1606 24.7363 28.1445C24.7105 28.1156 24.6858 28.0857 24.6621 28.0547C24.6461 28.0339 24.6302 28.013 24.6152 27.9912C24.5931 27.9591 24.5726 27.9257 24.5527 27.8916C24.5392 27.8685 24.5261 27.8452 24.5137 27.8213C24.5093 27.8128 24.5043 27.8045 24.5 27.7959L24.501 27.7939C24.3932 27.5763 24.3282 27.3276 24.3281 27.0576V26.2998C24.328 25.5993 23.8278 25.0158 23.165 24.8867V24.8877C23.0752 24.8702 22.9826 24.8604 22.8877 24.8604C22.8446 24.8604 22.8019 24.8624 22.7598 24.8662C22.0247 24.9312 21.4483 25.5479 21.4482 26.2998C21.4482 26.9127 21.4608 27.5305 21.4736 28.1494L21.4951 29.3135C21.5 29.7013 21.5015 30.089 21.4971 30.4756C21.4874 31.3103 20.8426 32 20.0078 32C19.1732 31.9998 18.5292 31.3102 18.5195 30.4756C18.5159 30.1613 18.5176 29.8464 18.5205 29.5312V29.5322C18.5212 29.4593 18.5206 29.3864 18.5215 29.3135L18.5303 28.8154V28.8145C18.5343 28.5927 18.5384 28.371 18.543 28.1494C18.5558 27.5305 18.5684 28.1129 18.5684 27.5C18.5684 26.7047 17.9232 26.0596 17.1279 26.0596C16.907 26.0596 16.6978 26.1103 16.5107 26.1992C16.2161 26.3393 15.9767 26.5769 15.834 26.8701C15.8269 26.8846 15.8201 26.8993 15.8135 26.9141C15.7821 26.9845 15.7562 27.0579 15.7363 27.1338C15.7243 27.1798 15.7155 27.2267 15.708 27.2744C15.7012 27.3175 15.6953 27.361 15.6924 27.4053C15.6903 27.4366 15.6885 27.4681 15.6885 27.5V28.7383C15.6883 29.9234 14.4911 30.7248 13.4961 30.0811C13.0505 29.7926 12.8086 29.2886 12.8086 28.7578V26.2998C12.8086 25.9737 12.6984 25.674 12.5156 25.4326C12.4437 25.3381 12.3612 25.2521 12.2686 25.1777V25.1768C12.0219 24.9788 11.709 24.8604 11.3682 24.8604C10.9892 24.8604 10.8622 24.8872 10.7295 25.2295C10.5837 25.6055 10.4302 26 9.92773 26C9.33081 25.9996 8.95963 25.2403 8.71484 24.3799C8.5591 23.8325 8.45907 23.571 8.3623 23.0107C8.3501 22.9401 8.33284 22.8403 8.31738 22.7529C8.12812 21.9466 8.02043 21.1089 8.00293 20.249V20.25L8 20C8 19.8617 8.00317 19.724 8.00781 19.5869C8.00837 19.5703 8.00816 19.5537 8.00879 19.5371L8.00977 19.5352C8.0998 17.1716 8.87444 14.9844 10.1396 13.1631C10.1488 13.1499 10.1587 13.1372 10.168 13.124C12.255 10.1453 15.6582 8.15745 19.5352 8.00977L19.5371 8.00879C19.5537 8.00816 19.5703 8.00837 19.5869 8.00781C19.724 8.00317 19.8617 8 20 8L20.25 8.00293Z" />
              </svg>
          </button>
        </div>
      </>
    );
  }

  // Expanded state content
  return (
    <>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes popmelt-border-march { to { background-position: 0 -5px; } }
      `}</style>
      {/* Scrim overlay */}
      <div
        id="devtools-scrim"
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.06)',
          zIndex: 9997,
          pointerEvents: 'none',
        }}
      />
      {/* Model panel (active tool or hover-triggered) — hidden when thread panel is open */}
      {!isThreadPanelOpen && (guidanceTool === 'model' || state.activeTool === 'model') && (
        <LibraryPanel
          bridgeUrl={bridgeUrl}
          selectedComponent={modelSelectedComponent}
          hoveredComponent={modelCanvasHoveredComponent}
          onComponentHover={onModelComponentHover}
          onSpacingTokenHover={onSpacingTokenHover}
          onModifySpacingToken={onModifySpacingToken}
          onDeleteSpacingToken={onDeleteSpacingToken}
          modelRefreshKey={modelRefreshKey}
          onComponentAdded={onModelComponentAdded}
          onComponentRemoved={onModelComponentRemoved}
          onSynthesizeRules={onSynthesizeRules}
          isSynthesizing={isSynthesizing}
          snapPosition={snapPos}
          onMouseEnter={() => {
            clearPrediction();
            if (guidanceHideTimerRef.current) {
              clearTimeout(guidanceHideTimerRef.current);
              guidanceHideTimerRef.current = null;
            }
          }}
          onMouseLeave={state.activeTool === 'model' ? undefined : handleToolHoverEnd}
        />
      )}
      {/* Tool guidance panel (model has its own LibraryPanel, skip here) */}
      {guidanceTool && guidanceTool !== 'model' && (guidanceTool === 'provider' || TOOL_GUIDANCE[guidanceTool]) && (() => {
        const g = guidanceTool === 'provider' ? providerGuidance : TOOL_GUIDANCE[guidanceTool]!;
        return (
          <div
            ref={guidancePanelRef}
            style={{
            ...getGuidanceStyle(snapPos, viewport.w, viewport.h),
            width: 300,
            backgroundColor: '#eaeaea',
            ...POPMELT_BORDER,
            boxSizing: 'content-box',
            zIndex: 10001,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 12,
            color: '#1f2937',
            padding: 12,
            ...(guidanceTool !== 'collapse' && guidanceTool !== 'counter' ? { pointerEvents: 'none' as const } : {}),
          }}>
            {guidanceTool === 'collapse' && (
              <div
                title="Restart bridge"
                onClick={() => { restartBridge(bridgeUrl); }}
                style={{ marginBottom: 10, cursor: 'pointer', width: 'fit-content' }}
              >
                <svg width="48" height="48" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M11.1406 31.2559C11.2407 31.3875 11.351 31.5132 11.4697 31.6338L3.10449 40H2.39746L11.1406 31.2559ZM8.05371 40H7.34668L14.5498 32.7959C14.8554 32.7706 15.1541 32.7063 15.4414 32.6113L8.05371 40ZM18.2197 34.0762C18.3788 34.1569 18.5445 34.2272 18.7168 34.2861L13.0039 40H12.2969L18.2197 34.0762ZM17.9531 40H17.2461L26.1338 31.1113C26.438 31.0829 26.7427 31.0148 27.0439 30.9082L17.9531 40ZM40 22.9023L22.9033 40H22.1963L40 22.1953V22.9023ZM40 27.8525L27.8525 40H27.1455L40 27.1455V27.8525ZM40 32.8027L32.8027 40H32.0957L40 32.0957V32.8027ZM40 37.752L37.752 40H37.0449L40 37.0449V37.752ZM9.06543 28.3809C9.25255 28.4332 9.45183 28.4715 9.66504 28.4883L0 38.1543V37.4473L9.06543 28.3809ZM6.59375 25.9023C6.65822 26.0626 6.73171 26.2263 6.81445 26.3896L0 33.2041V32.4971L6.59375 25.9023ZM20.25 8.00293H20.249C21.5098 8.0286 22.7219 8.25094 23.8584 8.63672L23.8604 8.63574C23.8961 8.64787 23.9312 8.66145 23.9668 8.67383C24.0611 8.70686 24.1548 8.74106 24.248 8.77637C24.2915 8.79273 24.3357 8.80727 24.3789 8.82422L24.376 8.82617C27.6145 10.0955 30.1646 12.7301 31.3213 16.0234L31.3232 16.0225C31.3327 16.0493 31.3404 16.0766 31.3496 16.1035C31.7691 17.3256 32 18.6356 32 20C32 20.8726 31.9366 21.6706 31.7598 22.4902L31.7197 22.6328C31.6412 23.0066 31.5136 23.6108 31.3408 24.2217L31.3398 24.2246C31.2967 24.377 31.251 24.5299 31.2021 24.6797C30.9215 25.5403 30.5473 26.2998 30.0879 26.2998C29.7613 26.2996 29.5995 25.9674 29.4316 25.6221C29.2501 25.2487 29.0614 24.8605 28.6484 24.8604C27.8532 24.8604 27.2081 25.5046 27.208 26.2998V27.0771C27.2079 27.6079 26.9661 28.112 26.5205 28.4004C25.9146 28.7925 25.2357 28.6462 24.7959 28.2061L24.7949 28.208C24.7897 28.2028 24.7854 28.1967 24.7803 28.1914C24.7654 28.1761 24.7507 28.1606 24.7363 28.1445C24.7105 28.1156 24.6858 28.0857 24.6621 28.0547C24.6461 28.0339 24.6302 28.013 24.6152 27.9912C24.5931 27.9591 24.5726 27.9257 24.5527 27.8916C24.5392 27.8685 24.5261 27.8452 24.5137 27.8213C24.5093 27.8128 24.5043 27.8045 24.5 27.7959L24.501 27.7939C24.3932 27.5763 24.3282 27.3276 24.3281 27.0576V26.2998C24.328 25.5993 23.8278 25.0158 23.165 24.8867V24.8877C23.0752 24.8702 22.9826 24.8604 22.8877 24.8604C22.8446 24.8604 22.8019 24.8624 22.7598 24.8662C22.0247 24.9312 21.4483 25.5479 21.4482 26.2998C21.4482 26.9127 21.4608 27.5305 21.4736 28.1494L21.4951 29.3135C21.5 29.7013 21.5015 30.089 21.4971 30.4756C21.4874 31.3103 20.8426 32 20.0078 32C19.1732 31.9998 18.5292 31.3102 18.5195 30.4756C18.5159 30.1613 18.5176 29.8464 18.5205 29.5312V29.5322C18.5212 29.4593 18.5206 29.3864 18.5215 29.3135L18.5303 28.8154V28.8145C18.5343 28.5927 18.5384 28.371 18.543 28.1494C18.5558 27.5305 18.5684 28.1129 18.5684 27.5C18.5684 26.7047 17.9232 26.0596 17.1279 26.0596C16.907 26.0596 16.6978 26.1103 16.5107 26.1992C16.2161 26.3393 15.9767 26.5769 15.834 26.8701C15.8269 26.8846 15.8201 26.8993 15.8135 26.9141C15.7821 26.9845 15.7562 27.0579 15.7363 27.1338C15.7243 27.1798 15.7155 27.2267 15.708 27.2744C15.7012 27.3175 15.6953 27.361 15.6924 27.4053C15.6903 27.4366 15.6885 27.4681 15.6885 27.5V28.7383C15.6883 29.9234 14.4911 30.7248 13.4961 30.0811C13.0505 29.7926 12.8086 29.2886 12.8086 28.7578V26.2998C12.8086 25.9737 12.6984 25.674 12.5156 25.4326C12.4437 25.3381 12.3612 25.2521 12.2686 25.1777V25.1768C12.0219 24.9788 11.709 24.8604 11.3682 24.8604C10.9892 24.8604 10.8622 24.8872 10.7295 25.2295C10.5837 25.6055 10.4302 26 9.92773 26C9.33081 25.9996 8.95963 25.2403 8.71484 24.3799C8.5591 23.8325 8.45907 23.571 8.3623 23.0107C8.3501 22.9401 8.33284 22.8403 8.31738 22.7529C8.12812 21.9466 8.02043 21.1089 8.00293 20.249V20.25L8 20C8 19.8617 8.00317 19.724 8.00781 19.5869C8.00837 19.5703 8.00816 19.5537 8.00879 19.5371L8.00977 19.5352C8.0998 17.1716 8.87444 14.9844 10.1396 13.1631C10.1488 13.1499 10.1587 13.1372 10.168 13.124C12.255 10.1453 15.6582 8.15745 19.5352 8.00977L19.5371 8.00879C19.5537 8.00816 19.5703 8.00837 19.5869 8.00781C19.724 8.00317 19.8617 8 20 8L20.25 8.00293ZM5.72266 22.5303L0 28.2539V27.5469L5.62793 21.918C5.6553 22.1234 5.6868 22.3275 5.72266 22.5303ZM16.2637 26.8398L16.2617 26.8408C16.2784 26.8013 16.2954 26.7627 16.3135 26.7256C16.3203 26.7116 16.3275 26.6982 16.334 26.6855C16.3125 26.7277 16.289 26.7808 16.2637 26.8398ZM40 17.9531L33.9854 23.9668C34.051 23.6832 34.1043 23.4321 34.1445 23.2412L34.1641 23.1748L34.1865 23.0967L34.1963 23.0488L40 17.2461V17.9531ZM5.87012 16.7266C5.80321 17.0165 5.74649 17.3101 5.69727 17.6064L0 23.3047V22.5977L5.87012 16.7266ZM40 13.0039L34.4297 18.5732C34.409 18.3615 34.3832 18.1513 34.3535 17.9424L40 12.2969V13.0039ZM0 18.3555V17.6484L17.6484 0H18.3555L0 18.3555ZM40 8.05371L33.458 14.5947C33.3909 14.4277 33.3202 14.2625 33.2471 14.0986L40 7.34668V8.05371ZM0 13.4053V12.6982L12.6992 0H13.4062L0 13.4053ZM40 3.10352L31.6865 11.416C31.5868 11.2805 31.4851 11.1465 31.3809 11.0146L40 2.39648V3.10352ZM29.2881 8.86523C29.1595 8.75783 29.0288 8.65278 28.8965 8.5498L37.4473 0H38.1543L29.2881 8.86523ZM0 8.45508V7.74805L7.74805 0H8.45508L0 8.45508ZM26.2783 6.92578C26.1183 6.84878 25.9562 6.77534 25.793 6.7041L32.498 0H33.2051L26.2783 6.92578ZM17.6064 5.69727C17.3101 5.74649 17.0165 5.80321 16.7266 5.87012L22.5977 0H23.3047L17.6064 5.69727ZM22.5322 5.7207C22.3295 5.685 22.1254 5.65316 21.9199 5.62598L27.5469 0H28.2539L22.5322 5.7207ZM0 3.50586V2.79883L2.79883 0H3.50586L0 3.50586Z" fill="currentColor"/>
                </svg>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
              <span>{g.name}</span>
              {g.keys[0] && (
                <code style={{
                  fontSize: 10,
                  fontWeight: 500,
                  backgroundColor: 'rgba(0,0,0,0.06)',
                  padding: '1px 4px',
                  color: '#6b7280',
                }}>{g.keys[0].key}</code>
              )}
            </div>
            <div style={{ color: '#6b7280', lineHeight: 1.5, marginBottom: guidanceTool === 'collapse' ? 0 : 10 }}>
              {g.desc.split('\n\n').map((p, i) => <p key={i} style={{ margin: 0, marginTop: i > 0 ? 8 : 0 }}>{p}</p>)}
            </div>
            {g.usage.map((line, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 3, lineHeight: 1.4 }}>
                <span style={{ color: '#9ca3af', flexShrink: 0 }}>–</span>
                <span>{line}</span>
              </div>
            ))}
            {guidanceTool === 'collapse' && onSnapPositionChange && (
              <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: 10, paddingTop: 8 }}>
                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Position</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 3, width: 'fit-content' }}>
                  {SNAP_POSITIONS.map(pos => {
                    const isActive = pos === snapPos;
                    return (
                      <button
                        key={pos}
                        type="button"
                        onClick={() => { setGuidanceTool(null); guidanceVisibleRef.current = false; clearPrediction(); onSnapPositionChange(pos); }}
                        title={pos}
                        style={{
                          width: 24,
                          height: 16,
                          border: 'none',
                          cursor: 'pointer',
                          padding: 0,
                          backgroundColor: isActive ? '#1f2937' : 'rgba(0,0,0,0.08)',
                          transition: 'background-color 100ms ease',
                        }}
                        onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.15)'; }}
                        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.08)'; }}
                      />
                    );
                  })}
                </div>
              </div>
            )}
            {guidanceTool === 'collapse' && mcpStatus && Object.keys(mcpStatus).length > 0 && (() => {
              const connected = Object.entries(mcpStatus)
                .filter(([, s]) => s.found && !s.disabled)
                .map(([name]) => name.charAt(0).toUpperCase() + name.slice(1));
              const unconfigured = Object.entries(mcpStatus)
                .filter(([, s]) => !s.found)
                .map(([name]) => name);
              if (connected.length === 0 && unconfigured.length === 0) return null;
              const unconfiguredLabels = unconfigured.map((n) => n.charAt(0).toUpperCase() + n.slice(1));
              return (
                <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: 10, paddingTop: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: connected.length > 0 ? '#22c55e' : 'rgba(0,0,0,0.2)',
                    flexShrink: 0,
                  }} />
                  {connected.length > 0 ? (
                    <span style={{ color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>
                        Registry available in {connected.join(', ')}
                        {mcpJustInstalled && ' — restart CLI to activate'}
                      </span>
                      {unconfigured.length > 0 && onInstallMcp && !mcpJustInstalled && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onInstallMcp(); }}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: '#3b82f6',
                            fontSize: 10,
                            fontWeight: 500,
                            fontFamily: 'inherit',
                            padding: 0,
                            cursor: 'pointer',
                            pointerEvents: 'auto',
                            textDecoration: 'underline',
                            textUnderlineOffset: 2,
                          }}
                        >
                          + {unconfiguredLabels.join(', ')}
                        </button>
                      )}
                    </span>
                  ) : unconfigured.length > 0 && onInstallMcp ? (
                    <span style={{ color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>Connect Popmelt MCP</span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onInstallMcp(); }}
                        style={{
                          border: 'none',
                          background: '#1f2937',
                          color: '#fff',
                          fontSize: 10,
                          fontWeight: 600,
                          fontFamily: 'inherit',
                          padding: '2px 8px',
                          cursor: 'pointer',
                          pointerEvents: 'auto',
                        }}
                      >
                        Connect
                      </button>
                    </span>
                  ) : null}
                </div>
              );
            })()}
            {g.keys.length > 1 && (
              <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: 8, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {g.keys.slice(1).map((k, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: k.accent ? '#fff' : '#6b7280' }}>
                    <code style={{
                      fontSize: 10,
                      backgroundColor: k.accent ? state.activeColor : 'rgba(0,0,0,0.06)',
                      color: k.accent ? '#fff' : undefined,
                      padding: '1px 4px',
                      whiteSpace: 'nowrap',
                    }}>{k.key}</code>
                    <span style={{ color: k.accent ? state.activeColor : undefined, fontWeight: k.accent ? 600 : undefined }}>{k.desc}</span>
                  </div>
                ))}
              </div>
            )}
            {/* Annotation quick-nav list (counter guidance only) */}
            {guidanceTool === 'counter' && allAnnotationGroups.length > 0 && (() => {
              // "Active" label
              const activeLabel = (
                <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: 8, paddingTop: 8 }}>
                  <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active</div>
                </div>
              );
              // Group by pathname
              const byRoute = new Map<string, AnnotationGroup[]>();
              for (const g of allAnnotationGroups) {
                const route = g.pathname || currentPathname;
                if (!byRoute.has(route)) byRoute.set(route, []);
                byRoute.get(route)!.push(g);
              }
              const routes = [...byRoute.entries()];
              const multiRoute = routes.length > 1;

              return (
                <div>
                  {activeLabel}
                  <div style={{ maxHeight: 200, overflowY: 'auto', scrollbarWidth: 'thin' }}>
                  {routes.map(([route, groups]) => (
                    <div key={route} style={{ marginBottom: multiRoute ? 4 : 0 }}>
                      {groups.map((group) => {
                        const textAnn = group.annotations.find(a => a.type === 'text' && a.text);
                        const preview = textAnn?.text || `[${group.annotations[0]?.type ?? 'annotation'}]`;
                        const isSelected = state.selectedAnnotationIds.includes(group.id);
                        const groupIndex = allAnnotationGroups.indexOf(group);
                        const groupNumber = groupIndex + 1;
                        const groupColor = group.annotations[0]?.color ?? state.activeColor;

                        return (
                          <div
                            key={group.id}
                            onClick={() => {
                              const isOnPage = !group.pathname || group.pathname === currentPathname;
                              if (!isOnPage) {
                                sessionStorage.setItem('popmelt-pending-focus', JSON.stringify({
                                  annotationId: group.id,
                                  pathname: group.pathname,
                                }));
                                window.location.href = group.pathname!;
                                return;
                              }
                              setFocusedGroupIndex(groupIndex);
                              dispatch({ type: 'SELECT_ELEMENT', payload: null });
                              dispatch({ type: 'SELECT_ANNOTATION', payload: { id: group.id } });
                              // Open thread panel if this annotation has a thread
                              if (onViewThread) {
                                const threadId = group.annotations.find(a => a.threadId)?.threadId;
                                if (threadId) onViewThread(threadId);
                              }
                              guidanceVisibleRef.current = false;
                              setGuidanceTool(null);
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'baseline',
                              gap: 4,
                              padding: '2px 0',
                              cursor: 'pointer',
                            }}
                            onMouseEnter={(e) => {
                              const badge = e.currentTarget.querySelector('[data-route-badge]') as HTMLElement;
                              if (badge) { badge.style.backgroundColor = groupColor; badge.style.color = '#fff'; }
                            }}
                            onMouseLeave={(e) => {
                              if (isSelected) return;
                              const badge = e.currentTarget.querySelector('[data-route-badge]') as HTMLElement;
                              if (badge) { badge.style.backgroundColor = 'rgba(0,0,0,0.06)'; badge.style.color = '#6b7280'; }
                            }}
                          >
                            <code data-route-badge style={{
                              fontSize: 10,
                              color: isSelected ? '#fff' : '#6b7280',
                              backgroundColor: isSelected ? groupColor : 'rgba(0,0,0,0.06)',
                              padding: '1px 4px',
                              flexShrink: 0,
                              whiteSpace: 'nowrap',
                            }}>{groupNumber}. {multiRoute ? route : ''}</code>
                            <span style={{
                              fontSize: 11,
                              color: isSelected ? '#1f2937' : '#6b7280',
                              fontWeight: isSelected ? 600 : 400,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              minWidth: 0,
                            }}>{preview}</span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  </div>
                </div>
              );
            })()}
            {/* Recent threads (counter guidance only) */}
            {guidanceTool === 'counter' && (() => {
              const activeThreadIds = new Set(
                allAnnotationGroups.flatMap(g => g.annotations.map(a => a.threadId).filter(Boolean))
              );
              const filtered = recentThreads.filter(t => !activeThreadIds.has(t.id));
              if (filtered.length === 0) return null;
              const timeAgo = (ts: number) => {
                const sec = Math.floor((Date.now() - ts) / 1000);
                if (sec < 60) return 'now';
                const min = Math.floor(sec / 60);
                if (min < 60) return `${min}m`;
                const hr = Math.floor(min / 60);
                if (hr < 24) return `${hr}h`;
                const d = Math.floor(hr / 24);
                return `${d}d`;
              };
              return (
                <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: 8, paddingTop: 8 }}>
                  <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Recent</div>
                  {filtered.map(t => (
                    <div
                      key={t.id}
                      onClick={() => {
                        // Parse first elementIdentifier to re-tag the element
                        const eid = t.elementIdentifiers[0];
                        if (eid) {
                          // Format is "pathname:selector" or just "selector"
                          const colonIdx = eid.indexOf(':');
                          // Heuristic: if it starts with / it's pathname-qualified
                          const hasPathname = colonIdx > 0 && eid[0] === '/';
                          const pathname = hasPathname ? eid.slice(0, colonIdx) : undefined;
                          const selector = hasPathname ? eid.slice(colonIdx + 1) : eid;
                          const isOnPage = !pathname || pathname === currentPathname;

                          if (!isOnPage) {
                            // Navigate to the page, stash thread info for post-nav pickup
                            sessionStorage.setItem('popmelt-pending-thread', JSON.stringify({
                              threadId: t.id, selector, preview: t.preview,
                            }));
                            window.location.href = pathname!;
                            return;
                          }

                          // Try to find the element and re-create the annotation
                          try {
                            const el = document.querySelector(selector);
                            if (el) {
                              const rect = el.getBoundingClientRect();
                              const annId = Math.random().toString(36).slice(2, 9);
                              dispatch({
                                type: 'ADD_TEXT',
                                payload: {
                                  id: annId,
                                  point: { x: rect.left + rect.width, y: rect.top },
                                  text: t.preview,
                                  linkedSelector: selector,
                                  linkedAnchor: 'top-left',
                                },
                              });
                              dispatch({ type: 'SET_ANNOTATION_THREAD', payload: { ids: [annId], threadId: t.id } });
                              dispatch({ type: 'SET_ANNOTATION_STATUS', payload: { ids: [annId], status: 'resolved' } });
                            }
                          } catch { /* invalid selector */ }
                        }

                        if (onViewThread) onViewThread(t.id);
                        guidanceVisibleRef.current = false;
                        setGuidanceTool(null);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '2px 0',
                        cursor: 'pointer',
                        color: '#6b7280',
                        fontSize: 11,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = '#1f2937'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = '#6b7280'; }}
                    >
                      <span style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}>{t.preview}</span>
                      <span style={{
                        flexShrink: 0,
                        fontSize: 10,
                        color: '#9ca3af',
                      }}>{timeAgo(t.createdAt)}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        );
      })()}
      <div
        ref={(el) => { if (externalToolbarRef) externalToolbarRef.current = el; }}
        id="devtools-toolbar"
        style={toolbarStyle}
        onMouseEnter={onToolbarMouseEnter}
        onMouseMove={handleToolbarMouseMove}
      >
        {borderOverlay}
        <div style={{ display: 'flex', flexDirection: 'row', gap: 4, alignItems: 'center' }}>
          {/* Comment tool (first position) */}
          <span onMouseEnter={() => handleToolHoverStart('inspector')} onMouseLeave={handleToolHoverEnd}>
            <ToolButton
              active={state.isAnnotating && state.activeTool === 'inspector'}
              siblingActive={state.isAnnotating}
              onClick={() => handleToolSelect('inspector')}
            >
              <MessageCircle size={20} strokeWidth={1.5} />
            </ToolButton>
          </span>

          {/* Hand tool (padding handles) */}
          <span onMouseEnter={() => handleToolHoverStart('hand')} onMouseLeave={handleToolHoverEnd}>
            <ToolButton
              active={state.isAnnotating && state.activeTool === 'hand'}
              siblingActive={state.isAnnotating}
              onClick={() => handleToolSelect('hand')}
            >
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Hand size={20} strokeWidth={1.5} />
                {state.styleModifications.filter(m => !m.captured).length > 0 && (
                  <div style={{
                    position: 'absolute',
                    top: -7,
                    right: -9,
                    minWidth: 14,
                    height: 14,
                    borderRadius: 0,
                    backgroundColor: state.activeColor,
                    color: '#fff',
                    fontSize: 9,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 2px',
                    lineHeight: 1,
                  }}>
                    {state.styleModifications.filter(m => !m.captured).length}
                  </div>
                )}
              </div>
            </ToolButton>
          </span>

          {/* Shape tool combo: icon button + dot cycle in a tight wrapper */}
          {(() => {
            const currentShape = shapeTools[activeShapeIndex]!;
            const ShapeIcon = currentShape.icon;
            const isShapeActive = state.isAnnotating && shapeToolTypes.has(state.activeTool);
            return (
              <span onMouseEnter={() => handleToolHoverStart(currentShape.type)} onMouseLeave={handleToolHoverEnd}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                  <ToolButton
                    active={isShapeActive}
                    siblingActive={state.isAnnotating}
                    onClick={() => handleToolSelect(currentShape.type)}
                  >
                    <ShapeIcon size={20} strokeWidth={1.5} />
                  </ToolButton>
                  <button
                    type="button"
                    onClick={() => {
                      const nextIndex = (activeShapeIndex + 1) % shapeTools.length;
                      setActiveShapeIndex(nextIndex);
                      handleToolSelect(shapeTools[nextIndex]!.type);
                    }}
                    title="Cycle shape tool"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 2,
                      width: 12,
                      height: 32,
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      padding: '0 2px',
                      opacity: state.isAnnotating && !isShapeActive ? 0.5 : 1,
                      transition: 'opacity 150ms ease',
                    }}
                  >
                    {shapeTools.map((_, i) => (
                      <div
                        key={i}
                        style={{
                          width: 3,
                          height: 3,
                          borderRadius: '50%',
                          backgroundColor: i === activeShapeIndex ? colors.iconDefault : 'rgba(0,0,0,0.2)',
                          transition: 'background-color 150ms ease',
                        }}
                      />
                    ))}
                  </button>
                </div>
              </span>
            );
          })()}

          {/* Standalone tools (Text) */}
          {standaloneTools.map(({ type, icon: Icon, label, shortcut }) => (
            <span key={type} onMouseEnter={() => handleToolHoverStart(type)} onMouseLeave={handleToolHoverEnd}>
              <ToolButton
                active={state.isAnnotating && state.activeTool === type}
                siblingActive={state.isAnnotating}
                onClick={() => handleToolSelect(type)}
              >
                <Icon size={20} strokeWidth={1.5} />
              </ToolButton>
            </span>
          ))}

          {/* Model (design model browser / component promoter) */}
          <span onMouseEnter={() => handleToolHoverStart('model')} onMouseLeave={handleToolHoverEnd}>
            <ToolButton
              active={state.isAnnotating && state.activeTool === 'model'}
              siblingActive={state.isAnnotating}
              onClick={() => handleToolSelect('model')}
            >
              <Component size={17} strokeWidth={1.5} />
            </ToolButton>
          </span>
        </div>

        <ToolSeparator />

        <div style={{ display: 'flex', flexDirection: 'row', gap: 4, alignItems: 'center' }}>
          {(allAnnotationGroups.length > 0 || state.styleModifications.length > 0 || state.spacingTokenChanges.filter(c => !c.captured).length > 0) && (() => {
            // Check if focused on an annotation group (vs style modification)
            const focusedGroup = focusedGroupIndex !== null && focusedGroupIndex < allAnnotationGroups.length
              ? allAnnotationGroups[focusedGroupIndex]
              : null;
            const allCaptured = state.annotations.length > 0 && state.annotations.every(a => a.status && a.status !== 'pending');
            // Style modifications are never "captured", only annotations
            const isCaptured = focusedGroupIndex !== null
              ? focusedGroup?.annotations.some(a => a.status && a.status !== 'pending') ?? false
              : allCaptured;
            const activeColor = `oklch(0.628 0.258 ${hue})`;

            return (
              <span onMouseEnter={() => handleToolHoverStart('counter')} onMouseLeave={handleToolHoverEnd}>
              <button
                ref={counterRef}
                type="button"
                onClick={() => {
                  // Skip cycling if this was a long press (color reset)
                  if (longPressTriggeredRef.current) {
                    longPressTriggeredRef.current = false;
                    return;
                  }
                  handleCycleAnnotation();
                }}
                onMouseDown={handleCounterMouseDown}
                onMouseUp={handleCounterMouseUp}
                onMouseLeave={handleCounterMouseUp}
                title=""
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  minWidth: 20,
                  height: 20,
                  padding: '0 8px',
                  marginRight: 4,
                  border: 'none',
                  borderRadius: 0,
                  background: (isCaptured && focusedGroupIndex === null) ? '#999999' : activeColor,
                  cursor: 'pointer',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#ffffff',
                  transition: 'background 150ms ease',
                }}
              >
                {(() => {
                  const totalCount = allAnnotationGroups.length + state.styleModifications.length + state.spacingTokenChanges.filter(c => !c.captured).length;
                  if (focusedGroupIndex !== null) {
                    return <>{focusedGroupIndex + 1}<span style={{ opacity: 0.4, display: 'flex', gap: 4 }}><span>/</span><span>{totalCount}</span></span></>;
                  }
                  // Unfocused: "pageCount / totalCount" when there are off-page items
                  const pageCount = annotationGroups.length + state.styleModifications.length + state.spacingTokenChanges.filter(c => !c.captured).length;
                  if (totalCount > pageCount) {
                    return <>{pageCount}<span style={{ opacity: 0.4, display: 'flex', gap: 4 }}><span>/</span><span>{totalCount}</span></span></>;
                  }
                  return totalCount;
                })()}
              </button>
              </span>
            );
          })()}
          {(state.annotations.length > 0 || state.styleModifications.length > 0) && (
            <span onMouseEnter={() => handleToolHoverStart('clear')} onMouseLeave={handleToolHoverEnd}>
              <ToolButton
                siblingActive={state.isAnnotating}
                onClick={handleClear}
                title="Clear all (⌘⌫)"
              >
                <Trash2 size={17} strokeWidth={1.5} />
              </ToolButton>
            </span>
          )}
          {onProviderChange && (
            <>
            <div style={{ width: 1, height: 20, backgroundColor: 'rgba(0, 0, 0, 0.05)', margin: '0 2px' }} />
            <span onMouseEnter={() => handleToolHoverStart('provider')} onMouseLeave={handleToolHoverEnd} style={{ display: 'contents' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
              <ToolButton
                onClick={() => onProviderChange(provider === 'claude' ? 'codex' : 'claude')}
              >
                {provider === 'claude' ? <ClaudeIcon /> : <CodexIcon />}
              </ToolButton>
              <button
                type="button"
                onClick={() => {
                  const nextIndex = (modelIndex + 1) % modelCount;
                  onModelChange?.(nextIndex);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 32,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  padding: '0 4px 0 0',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: 10,
                  fontWeight: 500,
                  color: colors.iconDefault,
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{modelLabel}</span>
                <span style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}>
                  {Array.from({ length: modelCount }, (_, i) => (
                    <div
                      key={i}
                      style={{
                        width: 3,
                        height: 3,
                        borderRadius: '50%',
                        backgroundColor: i === modelIndex ? colors.iconDefault : 'rgba(0,0,0,0.2)',
                        transition: 'background-color 150ms ease',
                      }}
                    />
                  ))}
                </span>
              </button>
            </div>
            </span>
            </>
          )}
          <div
            ref={expandedCollapseRef}
            style={{ display: 'inline-flex', cursor: 'pointer' }}
          >
            <button type="button" onClick={handleCollapse} title="Collapse (⌘⌘)" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, border: 'none', background: 'none', padding: 0, cursor: 'inherit' }}>
              <svg data-popmelt-logo width="30" height="30" viewBox="0 0 40 40" fill={crosshairColor} stroke="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M20.25 8.00293H20.249C21.5098 8.0286 22.7219 8.25094 23.8584 8.63672L23.8604 8.63574C23.8961 8.64787 23.9312 8.66145 23.9668 8.67383C24.0611 8.70686 24.1548 8.74106 24.248 8.77637C24.2915 8.79273 24.3357 8.80727 24.3789 8.82422L24.376 8.82617C27.6145 10.0955 30.1646 12.7301 31.3213 16.0234L31.3232 16.0225C31.3327 16.0493 31.3404 16.0766 31.3496 16.1035C31.7691 17.3256 32 18.6356 32 20C32 20.8726 31.9366 21.6706 31.7598 22.4902L31.7197 22.6328C31.6412 23.0066 31.5136 23.6108 31.3408 24.2217L31.3398 24.2246C31.2967 24.377 31.251 24.5299 31.2021 24.6797C30.9215 25.5403 30.5473 26.2998 30.0879 26.2998C29.7613 26.2996 29.5995 25.9674 29.4316 25.6221C29.2501 25.2487 29.0614 24.8605 28.6484 24.8604C27.8532 24.8604 27.2081 25.5046 27.208 26.2998V27.0771C27.2079 27.6079 26.9661 28.112 26.5205 28.4004C25.9146 28.7925 25.2357 28.6462 24.7959 28.2061L24.7949 28.208C24.7897 28.2028 24.7854 28.1967 24.7803 28.1914C24.7654 28.1761 24.7507 28.1606 24.7363 28.1445C24.7105 28.1156 24.6858 28.0857 24.6621 28.0547C24.6461 28.0339 24.6302 28.013 24.6152 27.9912C24.5931 27.9591 24.5726 27.9257 24.5527 27.8916C24.5392 27.8685 24.5261 27.8452 24.5137 27.8213C24.5093 27.8128 24.5043 27.8045 24.5 27.7959L24.501 27.7939C24.3932 27.5763 24.3282 27.3276 24.3281 27.0576V26.2998C24.328 25.5993 23.8278 25.0158 23.165 24.8867V24.8877C23.0752 24.8702 22.9826 24.8604 22.8877 24.8604C22.8446 24.8604 22.8019 24.8624 22.7598 24.8662C22.0247 24.9312 21.4483 25.5479 21.4482 26.2998C21.4482 26.9127 21.4608 27.5305 21.4736 28.1494L21.4951 29.3135C21.5 29.7013 21.5015 30.089 21.4971 30.4756C21.4874 31.3103 20.8426 32 20.0078 32C19.1732 31.9998 18.5292 31.3102 18.5195 30.4756C18.5159 30.1613 18.5176 29.8464 18.5205 29.5312V29.5322C18.5212 29.4593 18.5206 29.3864 18.5215 29.3135L18.5303 28.8154V28.8145C18.5343 28.5927 18.5384 28.371 18.543 28.1494C18.5558 27.5305 18.5684 28.1129 18.5684 27.5C18.5684 26.7047 17.9232 26.0596 17.1279 26.0596C16.907 26.0596 16.6978 26.1103 16.5107 26.1992C16.2161 26.3393 15.9767 26.5769 15.834 26.8701C15.8269 26.8846 15.8201 26.8993 15.8135 26.9141C15.7821 26.9845 15.7562 27.0579 15.7363 27.1338C15.7243 27.1798 15.7155 27.2267 15.708 27.2744C15.7012 27.3175 15.6953 27.361 15.6924 27.4053C15.6903 27.4366 15.6885 27.4681 15.6885 27.5V28.7383C15.6883 29.9234 14.4911 30.7248 13.4961 30.0811C13.0505 29.7926 12.8086 29.2886 12.8086 28.7578V26.2998C12.8086 25.9737 12.6984 25.674 12.5156 25.4326C12.4437 25.3381 12.3612 25.2521 12.2686 25.1777V25.1768C12.0219 24.9788 11.709 24.8604 11.3682 24.8604C10.9892 24.8604 10.8622 24.8872 10.7295 25.2295C10.5837 25.6055 10.4302 26 9.92773 26C9.33081 25.9996 8.95963 25.2403 8.71484 24.3799C8.5591 23.8325 8.45907 23.571 8.3623 23.0107C8.3501 22.9401 8.33284 22.8403 8.31738 22.7529C8.12812 21.9466 8.02043 21.1089 8.00293 20.249V20.25L8 20C8 19.8617 8.00317 19.724 8.00781 19.5869C8.00837 19.5703 8.00816 19.5537 8.00879 19.5371L8.00977 19.5352C8.0998 17.1716 8.87444 14.9844 10.1396 13.1631C10.1488 13.1499 10.1587 13.1372 10.168 13.124C12.255 10.1453 15.6582 8.15745 19.5352 8.00977L19.5371 8.00879C19.5537 8.00816 19.5703 8.00837 19.5869 8.00781C19.724 8.00317 19.8617 8 20 8L20.25 8.00293Z" />
                </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
