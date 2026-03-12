'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type MutableRefObject,
} from 'react';

import { getDiscoveredBridgeUrl, getSourceId, useBridgeConnection } from '../hooks/useBridgeConnection';
import { useAnnotationState } from '../hooks/useAnnotationState';
import { usePathname } from '../hooks/usePathname';
import type { AnnotationResolution, SpacingTokenChange, SpacingTokenMod } from '../tools/types';
import { addComponentToModel, checkBridgeHealth, fetchCapabilities, fetchJobEvents, fetchModel, installMcp, removeComponentFromModel, removeModelToken, sendReplyToBridge, sendToBridge, synthesizeRules, updateModelToken, type McpDetectionResult } from '../utils/bridge-client';
import { buildFeedbackData, captureFullPage, captureScreenshot, copyToClipboard, cssColorToHex, stitchBlobs } from '../utils/screenshot';
import { AnnotationCanvas } from './AnnotationCanvas';
import { AnnotationToolbar } from './AnnotationToolbar';
import { BridgeEventStack } from './BridgeStatusPanel';
import { ShadowChrome } from './ShadowChrome';
import { ShadowHost } from './ShadowHost';
import { CLAUDE_MODELS, CODEX_MODELS } from './providers';
import { ThreadPanel } from './ThreadPanel';

export { MODEL_MAP } from './providers';

type PopmeltContextValue = {
  isEnabled: boolean;
};

const PopmeltContext = createContext<PopmeltContextValue | null>(null);

type PopmeltProviderProps = PropsWithChildren<{
  enabled?: boolean;
  bridgeUrl?: string;
  /** Framework router push — used for multi-page screenshot capture.
   *  Pass your SPA router's navigate function (e.g. Next.js `router.push`). */
  navigate?: (url: string) => void | Promise<unknown>;
}>;

const PROVIDER_STORAGE_KEY = 'devtools-provider';
const MODEL_STORAGE_KEY = 'devtools-model';
const THREAD_ID_STORAGE_KEY = 'devtools-open-thread-id';
const SYNTHESIZE_THREAD_STORAGE_KEY = 'popmelt-synthesize-thread';

/** Perform a soft (SPA) navigation without causing a full page reload.
 *  When a framework `navigate` function is provided, uses it directly.
 *  Falls back to pushState + popstate (unreliable with some frameworks). */
async function softNavigate(page: string, navigateFn?: (url: string) => void | Promise<unknown>): Promise<void> {
  if (navigateFn) {
    await navigateFn(page);
  } else {
    window.history.pushState(window.history.state, '', page);
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  }

  // Wait for the route transition + DOM to settle
  await new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimeout(resolve, 600);
    }));
  });
}

// Cross-provider equivalence map (by index → index)
// Claude:  0 Opus 4.6,  1 Sonn 4.6
// Codex:   0 GPT 5.4,   1 Codex 5.3,  2 Spark 5.3
const EQUIV_CLAUDE_TO_CODEX: Record<number, number> = { 0: 0, 1: 1 };
const EQUIV_CODEX_TO_CLAUDE: Record<number, number> = { 0: 0, 1: 1, 2: 1 };

function equivalentModelIndex(fromProvider: string, toProvider: string, currentIndex: number): number {
  const toModels = toProvider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
  if (fromProvider === 'claude' && toProvider === 'codex') {
    return EQUIV_CLAUDE_TO_CODEX[currentIndex] ?? Math.min(currentIndex, toModels.length - 1);
  }
  if (fromProvider === 'codex' && toProvider === 'claude') {
    return EQUIV_CODEX_TO_CLAUDE[currentIndex] ?? Math.min(currentIndex, toModels.length - 1);
  }
  return Math.min(currentIndex, toModels.length - 1);
}

export function PopmeltProvider({
  children,
  enabled = process.env.NODE_ENV === 'development',
  bridgeUrl = typeof window !== 'undefined'
    ? (window as any).__POPMELT_BRIDGE_URL__ ?? 'http://localhost:1111'
    : 'http://localhost:1111',
  navigate: navigateProp,
}: PopmeltProviderProps) {
  const [state, dispatch] = useAnnotationState();
  const bridge = useBridgeConnection(bridgeUrl, enabled);

  // Refs for shadow DOM elements (used instead of getElementById)
  const canvasRef = useRef<HTMLCanvasElement>(null) as MutableRefObject<HTMLCanvasElement | null>;
  const toolbarRef = useRef<HTMLDivElement>(null) as MutableRefObject<HTMLDivElement | null>;

  // Track the resolved bridge URL (after discovery)
  const resolvedBridgeUrl = getDiscoveredBridgeUrl() ?? bridgeUrl;
  const annotationImagesRef = useRef(new Map<string, Blob[]>());
  const pageScreenshotsRef = useRef(new Map<string, Blob>());
  const isProgrammaticNavRef = useRef(false);
  const currentPathname = usePathname();
  const [provider, setProvider] = useState<string>(() => {
    if (typeof window === 'undefined') return 'claude';
    return localStorage.getItem(PROVIDER_STORAGE_KEY) || 'claude';
  });
  const [modelIndex, setModelIndex] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const saved = localStorage.getItem(MODEL_STORAGE_KEY);
    return saved ? parseInt(saved, 10) || 0 : 0;
  });

  // Available providers (detected from bridge capabilities)
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);

  // MCP server detection results per provider
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpDetectionResult>>({});
  const [mcpJustInstalled, setMcpJustInstalled] = useState(false);

  // Fetch capabilities when bridge connects
  useEffect(() => {
    if (!bridge.isConnected) return;
    fetchCapabilities(resolvedBridgeUrl).then(caps => {
      if (!caps) return;
      const available = Object.entries(caps.providers)
        .filter(([, v]) => v.available)
        .map(([k]) => k);
      if (available.length > 0) {
        setAvailableProviders(available);
      }
      const mcp: Record<string, McpDetectionResult> = {};
      for (const [name, provider] of Object.entries(caps.providers)) {
        if (provider.mcp) mcp[name] = provider.mcp;
      }
      setMcpStatus(mcp);
      // Clear justInstalled flag if all providers are now configured
      const allConfigured = Object.values(mcp).every(s => s.found);
      if (allConfigured) setMcpJustInstalled(false);
    });
  }, [bridge.isConnected, bridge.capabilitiesVersion, resolvedBridgeUrl]);

  // Auto-switch provider if current one isn't available
  useEffect(() => {
    if (availableProviders.length > 0 && !availableProviders.includes(provider)) {
      const fallback = availableProviders[0]!;
      setProvider(fallback);
      localStorage.setItem(PROVIDER_STORAGE_KEY, fallback);
    }
  }, [availableProviders, provider]);

  const models = provider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
  const currentModel = models[modelIndex] ?? models[0]!;

  const handleProviderChange = useCallback((newProvider: string) => {
    const oldProvider = provider;
    setProvider(newProvider);
    localStorage.setItem(PROVIDER_STORAGE_KEY, newProvider);
    // Map to equivalent model tier
    const newIndex = equivalentModelIndex(oldProvider, newProvider, modelIndex);
    setModelIndex(newIndex);
    localStorage.setItem(MODEL_STORAGE_KEY, String(newIndex));
  }, [provider, modelIndex]);

  const handleModelChange = useCallback((newIndex: number) => {
    setModelIndex(newIndex);
    localStorage.setItem(MODEL_STORAGE_KEY, String(newIndex));
  }, []);

  const handleInstallMcp = useCallback(async () => {
    const result = await installMcp(resolvedBridgeUrl);
    if (!result) return;
    const mcp: Record<string, McpDetectionResult> = {};
    for (const [name, p] of Object.entries(result.capabilities.providers)) {
      if (p.mcp) mcp[name] = p.mcp;
    }
    setMcpStatus(mcp);
    if (result.results.some(r => r.installed)) {
      setMcpJustInstalled(true);
    }
  }, [resolvedBridgeUrl]);

  // Model tool state: track component names in the local design model
  const [modelComponentNames, setModelComponentNames] = useState<Set<string>>(new Set());
  const [modelSelectedComponent, setModelSelectedComponent] = useState<string | null>(null);
  // Bidirectional hover: canvas tells us what's hovered, panel tells us what's hovered
  const [modelCanvasHoveredComponent, setModelCanvasHoveredComponent] = useState<string | null>(null);
  const [modelPanelHoveredComponent, setModelPanelHoveredComponent] = useState<{ name: string; instanceIndex: number } | null>(null);
  const [modelSpacingTokenHover, setModelSpacingTokenHover] = useState<{ name: string; px: number; token?: import('../utils/spacingAnalysis').TokenBinding } | null>(null);

  // Fetch model component names on mount and when bridge connects
  useEffect(() => {
    if (!bridge.isConnected) return;
    fetchModel(resolvedBridgeUrl).then(model => {
      if (model?.components) {
        setModelComponentNames(new Set(Object.keys(model.components)));
      }
    });
  }, [bridge.isConnected, resolvedBridgeUrl]);

  const handleModelComponentsAdd = useCallback(async (names: string[]) => {
    const added: string[] = [];
    for (const name of names) {
      try {
        const result = await addComponentToModel(name, resolvedBridgeUrl);
        if (result.added) {
          added.push(name);
        }
      } catch (err) {
        console.error('[Popmelt] Failed to add component to model:', name, err);
      }
    }
    if (added.length > 0) {
      setModelComponentNames(prev => {
        const next = new Set(prev);
        for (const name of added) next.add(name);
        return next;
      });
      setModelSelectedComponent(added[added.length - 1]!);
    }
  }, [resolvedBridgeUrl]);

  const handleModelComponentFocus = useCallback((name: string) => {
    setModelSelectedComponent(name);
  }, []);

  const handleModelComponentAdded = useCallback(() => {
    // Re-fetch model to update component names
    fetchModel(resolvedBridgeUrl).then(model => {
      if (model?.components) {
        setModelComponentNames(new Set(Object.keys(model.components)));
      }
    });
  }, [resolvedBridgeUrl]);

  const handleModelComponentRemoved = useCallback(async (name: string) => {
    try {
      const result = await removeComponentFromModel(name, resolvedBridgeUrl);
      if (result.removed) {
        setModelComponentNames(prev => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    } catch (err) {
      console.error('[Popmelt] Failed to remove component from model:', err);
    }
  }, [resolvedBridgeUrl]);

  // Undo-tracked spacing token modification: dispatches to reducer so Cmd+Z works
  const handleModifySpacingToken = useCallback((mod: SpacingTokenMod, change: SpacingTokenChange) => {
    dispatch({ type: 'MODIFY_SPACING_TOKEN', payload: mod });
    dispatch({ type: 'ADD_SPACING_TOKEN_CHANGE', payload: change });
  }, [dispatch]);

  // Undo-tracked spacing token deletion
  const handleDeleteSpacingToken = useCallback((tokenPath: string, originalValue: string) => {
    dispatch({ type: 'DELETE_SPACING_TOKEN', payload: { tokenPath, originalValue } });
  }, [dispatch]);

  // Synthesize rules state (threadId persists across refresh)
  const [synthesizeJobId, setSynthesizeJobId] = useState<string | null>(null);
  const [synthesizeThreadId, setSynthesizeThreadId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(SYNTHESIZE_THREAD_STORAGE_KEY) || null;
  });
  useEffect(() => {
    if (synthesizeThreadId) {
      localStorage.setItem(SYNTHESIZE_THREAD_STORAGE_KEY, synthesizeThreadId);
    } else {
      localStorage.removeItem(SYNTHESIZE_THREAD_STORAGE_KEY);
    }
  }, [synthesizeThreadId]);

  // Sync effect: when spacingTokenMods change (including via undo/redo), reconcile bridge + DOM
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  const prevTokenModsRef = useRef<SpacingTokenMod[]>([]);
  useEffect(() => {
    const prev = prevTokenModsRef.current;
    const curr = state.spacingTokenMods;
    prevTokenModsRef.current = curr;

    // Build maps for diffing
    const prevMap = new Map(prev.map(m => [m.tokenPath, m]));
    const currMap = new Map(curr.map(m => [m.tokenPath, m]));

    let needsRefresh = false;

    // Handle mods that changed or appeared
    for (const [path, mod] of currMap) {
      const prevMod = prevMap.get(path);
      if (prevMod && prevMod.currentValue === mod.currentValue) continue; // unchanged

      needsRefresh = true;

      if (mod.currentValue === '__deleted__') {
        // Token was deleted (or redo'd to deleted state) — remove from bridge
        removeModelToken(path, resolvedBridgeUrl).catch(err =>
          console.error('[Popmelt] Failed to sync token delete:', err)
        );
      } else {
        // Token was modified (or undo restored a value) — update on bridge
        updateModelToken(path, mod.currentValue, resolvedBridgeUrl).catch(err =>
          console.error('[Popmelt] Failed to sync token update:', err)
        );
      }

      // Sync DOM inline styles for all targets
      for (const target of mod.targets) {
        const el = document.querySelector(target.selector) as HTMLElement | null;
        if (!el) continue;
        if (mod.currentValue === '__deleted__') {
          // Revert to original
          el.style.removeProperty(target.property);
        } else {
          const px = mod.currentPx;
          if (px > 0) {
            el.style.setProperty(target.property, `${px}px`, 'important');
          }
        }
      }
    }

    // Handle mods that disappeared (undo removed them entirely → restore original)
    for (const [path, prevMod] of prevMap) {
      if (currMap.has(path)) continue; // still present
      needsRefresh = true;

      // Restore original value on bridge
      updateModelToken(path, prevMod.originalValue, resolvedBridgeUrl).catch(err =>
        console.error('[Popmelt] Failed to restore token on undo:', err)
      );

      // Revert DOM inline styles
      for (const target of prevMod.targets) {
        const el = document.querySelector(target.selector) as HTMLElement | null;
        if (!el) continue;
        el.style.removeProperty(target.property);
      }
    }

    if (needsRefresh) {
      setModelRefreshKey(k => k + 1);
    }
  }, [state.spacingTokenMods, resolvedBridgeUrl]);

  // Thread panel state (declared early so callbacks can reference setOpenThreadId)
  const [openThreadId, setOpenThreadId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(THREAD_ID_STORAGE_KEY) || null;
  });

  // Fallback accent color for the thread panel when the annotation is off-page
  const threadColorFallbackRef = useRef<string | null>(null);

  // ThreadIds whose annotations were deleted — BridgeEventStack hides matching entries
  const [dismissedThreadIds, setDismissedThreadIds] = useState<Set<string>>(new Set());

  // Annotation IDs to highlight when hovering a status badge
  const [highlightedAnnotationIds, setHighlightedAnnotationIds] = useState<Set<string> | null>(null);

  // Persist openThreadId to localStorage
  useEffect(() => {
    if (openThreadId) {
      localStorage.setItem(THREAD_ID_STORAGE_KEY, openThreadId);
    } else {
      localStorage.removeItem(THREAD_ID_STORAGE_KEY);
    }
  }, [openThreadId]);

  // Per-job in-flight tracking: jobId → { annotationIds, styleSelectors, color, threadId }
  // Persisted in localStorage so state is shared across tabs on the same origin
  // and survives both HMR remounts and full page refreshes.
  const IN_FLIGHT_STORAGE_KEY = 'popmelt-in-flight-jobs';
  const [inFlightJobs, setInFlightJobs] = useState<Record<string, { annotationIds: string[]; styleSelectors: string[]; color: string; threadId?: string }>>(() => {
    try {
      const stored = localStorage.getItem(IN_FLIGHT_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  // Sync inFlightJobs to localStorage
  useEffect(() => {
    try {
      if (Object.keys(inFlightJobs).length > 0) {
        localStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(inFlightJobs));
      } else {
        localStorage.removeItem(IN_FLIGHT_STORAGE_KEY);
      }
    } catch {}
  }, [inFlightJobs]);

  // Cross-tab sync: pick up changes made by other tabs
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== IN_FLIGHT_STORAGE_KEY) return;
      try {
        const updated = e.newValue ? JSON.parse(e.newValue) : {};
        setInFlightJobs(updated);
      } catch {}
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Persistent map of jobId→annotationIds (survives job completion, used for hover highlight)
  const jobAnnotationMapRef = useRef<Map<string, string[]>>(new Map());
  // Persistent map of jobId→threadId (survives job removal, used for error lookup)
  const jobThreadMapRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const [jobId, job] of Object.entries(inFlightJobs)) {
      if (job.annotationIds.length > 0) {
        jobAnnotationMapRef.current.set(jobId, job.annotationIds);
      }
      if (job.threadId) {
        jobThreadMapRef.current.set(jobId, job.threadId);
      }
    }
  }, [inFlightJobs]);

  // Recovery: annotations hydrate from localStorage via PASTE_ANNOTATIONS (after mount).
  // Any annotation stuck in 'in_flight' with no matching active job is a ghost — reset it.
  // Runs on every inFlightJobs change (not just once) so that reconciliation pruning
  // triggers ghost cleanup even if it happens after the initial mount.
  const prevInFlightKeysRef = useRef<string>('');
  useEffect(() => {
    if (state.annotations.length === 0) return; // not hydrated yet
    // Only re-check when inFlightJobs keys actually change (avoids redundant dispatches)
    const keySig = Object.keys(inFlightJobs).sort().join(',');
    if (keySig === prevInFlightKeysRef.current) return;
    prevInFlightKeysRef.current = keySig;

    const activeJobAnnotationIds = new Set<string>();
    for (const job of Object.values(inFlightJobs)) {
      for (const id of job.annotationIds) activeJobAnnotationIds.add(id);
    }
    const stuckIds = state.annotations
      .filter(a => {
        if (activeJobAnnotationIds.has(a.id)) return false;
        // In-flight with no job → ghost
        if (a.status === 'in_flight') return true;
        // Submitted (captured/threaded) but stuck at pending → prior buggy recovery
        if ((a.status === 'pending' || !a.status) && (a.captured || a.threadId)) return true;
        return false;
      })
      .map(a => a.id);
    if (stuckIds.length > 0) {
      dispatch({ type: 'SET_ANNOTATION_STATUS', payload: { ids: stuckIds, status: 'dismissed' } });
    }
  }, [state.annotations, inFlightJobs, dispatch]);

  // Flatten all in-flight annotation IDs and style selectors for the canvas
  const inFlightAnnotationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const job of Object.values(inFlightJobs)) {
      for (const id of job.annotationIds) ids.add(id);
    }
    return ids;
  }, [inFlightJobs]);

  // Annotation IDs whose jobs are actively running (not just queued)
  const activeAnnotationIds = useMemo(() => {
    const activeSet = new Set(bridge.activeJobIds);
    const ids = new Set<string>();
    for (const [jobId, job] of Object.entries(inFlightJobs)) {
      if (activeSet.has(jobId)) {
        for (const id of job.annotationIds) ids.add(id);
      }
    }
    return ids;
  }, [inFlightJobs, bridge.activeJobIds]);

  // Queue position labels for queued (not active) annotation IDs, e.g. "(1/2)"
  const queuePositionMap = useMemo(() => {
    const activeSet = new Set(bridge.activeJobIds);
    const queuedJobs = Object.entries(inFlightJobs).filter(([id]) => !activeSet.has(id));
    const total = queuedJobs.length;
    const map = new Map<string, string>();
    queuedJobs.forEach(([, job], idx) => {
      const label = `(${idx + 1}/${total})`;
      for (const id of job.annotationIds) map.set(id, label);
    });
    return map;
  }, [inFlightJobs, bridge.activeJobIds]);

  const inFlightStyleSelectors = useMemo(() => {
    const selectors = new Set<string>();
    for (const job of Object.values(inFlightJobs)) {
      for (const sel of job.styleSelectors) selectors.add(sel);
    }
    return selectors;
  }, [inFlightJobs]);

  // Map each in-flight selector to its job's annotation color (for marching ants borders)
  // Includes both style modification selectors and linked annotation selectors
  const inFlightSelectorColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of Object.values(inFlightJobs)) {
      // Style modification selectors
      for (const sel of job.styleSelectors) {
        map.set(sel, job.color);
      }
      // Linked annotation selectors — find elements that in-flight annotations point to
      for (const annId of job.annotationIds) {
        const ann = state.annotations.find(a => a.id === annId);
        if (!ann) continue;
        if (ann.linkedSelector) {
          map.set(ann.linkedSelector, job.color);
        }
        // Check group mates for linked selectors
        if (ann.groupId) {
          for (const mate of state.annotations) {
            if (mate.groupId === ann.groupId && mate.linkedSelector) {
              map.set(mate.linkedSelector, job.color);
            }
          }
        }
      }
    }
    return map;
  }, [inFlightJobs, state.annotations]);

  // Refs for orphan cleanup (avoids re-subscribing observer on every state change)
  const annotationsRef = useRef(state.annotations);
  annotationsRef.current = state.annotations;
  const styleModsRef = useRef(state.styleModifications);
  styleModsRef.current = state.styleModifications;
  const inFlightJobsRef = useRef(inFlightJobs);
  inFlightJobsRef.current = inFlightJobs;

  // Cleanup orphaned annotations/modifications when DOM elements are removed
  useEffect(() => {
    let timeoutId: NodeJS.Timeout | null = null;

    const checkOrphans = () => {
      // Skip orphan cleanup entirely while any jobs are in-flight.
      // HMR from Claude's edits temporarily removes DOM nodes, causing
      // false-positive orphan detection. Wait until all jobs finish.
      if (Object.keys(inFlightJobsRef.current).length > 0) return;

      const annotations = annotationsRef.current;
      const styleModifications = styleModsRef.current;

      const orphanedLinkedSelectors: string[] = [];
      const orphanedStyleSelectors: string[] = [];

      // Check annotations with data-pm linked selectors
      for (const ann of annotations) {
        if (!ann.linkedSelector || !ann.linkedSelector.startsWith('[data-pm=')) continue;

        // Page-scoped annotations are never orphan-cleaned. data-pm attributes
        // are ephemeral and don't survive navigation; the position tracking
        // effect re-establishes them via structural selector fallback.
        if (ann.pathname) continue;

        // Skip annotations that were sent to Claude (captured or have a status)
        // — they may be mid-resolution and their DOM is being rewritten
        if (ann.captured || (ann.status && ann.status !== 'pending')) continue;

        // Try primary selector
        let el = document.querySelector(ann.linkedSelector);

        // Try structural fallback
        if (!el && ann.elements?.[0]?.selector) {
          el = document.querySelector(ann.elements[0].selector);
        }

        if (!el) {
          orphanedLinkedSelectors.push(ann.linkedSelector);
        }
      }

      // Check style modifications
      for (const mod of styleModifications) {
        if (!document.querySelector(mod.selector)) {
          orphanedStyleSelectors.push(mod.selector);
        }
      }

      if (orphanedLinkedSelectors.length > 0 || orphanedStyleSelectors.length > 0) {
        dispatch({
          type: 'CLEANUP_ORPHANED',
          payload: { linkedSelectors: orphanedLinkedSelectors, styleSelectors: orphanedStyleSelectors },
        });
      }
    };

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(m => m.removedNodes.length > 0)) {
        if (timeoutId) clearTimeout(timeoutId);
        // Longer delay to let HMR settle before checking
        timeoutId = setTimeout(checkOrphans, 3000);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [dispatch]);

  // Capture-on-leave: screenshot the departing page on SPA navigation
  // so off-page annotations get their own screenshot at submit time
  const lastKnownPathnameRef = useRef(typeof window !== 'undefined' ? window.location.pathname : '/');
  useEffect(() => {
    const captureAndCache = (prevPath: string) => {
      if (isProgrammaticNavRef.current) return; // Skip during programmatic navigation
      const newPath = window.location.pathname;
      if (prevPath === newPath) return; // No actual navigation

      // Check if any pending annotations belong to the departing page
      const departing = annotationsRef.current.filter(
        a => a.pathname === prevPath && (a.status ?? 'pending') === 'pending'
      );
      console.log(`[Popmelt] Navigation from ${prevPath} → ${newPath}, ${departing.length} pending annotations on departing page`);
      if (departing.length === 0) return;

      const canvas = canvasRef.current;
      if (!canvas) {
        console.warn('[Popmelt] No canvas ref for capture-on-leave');
        return;
      }

      // Initiate capture — domToCanvas clones the DOM synchronously in this tick,
      // the async rendering operates on that clone, so we capture the old page's state
      captureScreenshot(document.body, canvas, departing, { dpr: 1 })
        .then(blobs => stitchBlobs(blobs))
        .then(blob => {
          if (blob) {
            pageScreenshotsRef.current.set(prevPath, blob);
            console.log(`[Popmelt] Cached screenshot for ${prevPath} (${(blob.size / 1024).toFixed(0)}KB)`);
          } else {
            console.warn(`[Popmelt] Capture-on-leave produced no blob for ${prevPath}`);
          }
        })
        .catch((err) => {
          console.warn('[Popmelt] Capture-on-leave failed:', err);
        });

      // Safety: limit cache size to prevent memory buildup
      if (pageScreenshotsRef.current.size > 20) {
        const entries = [...pageScreenshotsRef.current.entries()];
        pageScreenshotsRef.current = new Map(entries.slice(-10));
      }
    };

    // pushState/replaceState — CustomEvent with prevPath in detail
    const handleLocationChange = (e: Event) => {
      const prevPath = (e as CustomEvent<{ prevPath: string }>).detail?.prevPath;
      if (prevPath) {
        captureAndCache(prevPath);
        lastKnownPathnameRef.current = window.location.pathname;
      }
    };

    // popstate (back/forward) — no prevPath in event, use tracked pathname
    const handlePopState = () => {
      const prevPath = lastKnownPathnameRef.current;
      captureAndCache(prevPath);
      lastKnownPathnameRef.current = window.location.pathname;
    };

    window.addEventListener('popmelt:locationchange', handleLocationChange);
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popmelt:locationchange', handleLocationChange);
      window.removeEventListener('popstate', handlePopState);
    };
  }, []); // No deps — uses refs for current state

  // Clear specific job's annotations when it completes or errors
  useEffect(() => {
    if (bridge.lastCompletedJobId && bridge.lastCompletedJobId in inFlightJobs) {
      setInFlightJobs((prev) => {
        const { [bridge.lastCompletedJobId!]: _, ...rest } = prev;
        return rest;
      });
    }
    // On synthesize job completion, refresh model and clear synthesize state
    if (bridge.lastCompletedJobId && bridge.lastCompletedJobId === synthesizeJobId) {
      setModelRefreshKey(k => k + 1);
      setSynthesizeJobId(null);
    }
  }, [bridge.lastCompletedJobId, synthesizeJobId]);

  // Track which done events have been processed (shared by reconciliation + live SSE handler)
  const processedDoneJobIdsRef = useRef(new Set<string>());

  // Safety net: reconcile inFlightJobs against the bridge server after (re)connect.
  // When Vite HMR re-executes useBridgeConnection.ts, the module-level store resets
  // (no lastCompletedJobId, no events), but localStorage may still have stale inFlightJobs.
  // Validate once per connection by checking the server's actual active job list.
  const hasReconciledJobsRef = useRef(false);
  useEffect(() => {
    if (!bridge.isConnected) {
      hasReconciledJobsRef.current = false;
      return;
    }
    if (hasReconciledJobsRef.current) return;
    hasReconciledJobsRef.current = true;

    // Reconcile immediately — the SSE layer handles its own job tracking independently,
    // so there's no need to delay for job_started events.
    checkBridgeHealth(resolvedBridgeUrl).then(async (health) => {
      if (!health) return;
      const activeJobs = health.activeJobs ?? [];
      const recentJobs = health.recentJobs ?? [];
      const serverActiveIds = new Set<string>(
        activeJobs.map((j: { id: string }) => j.id),
      );

      // Collect locally-tracked job IDs (including provisional _pending_ keys)
      // before we mutate state, so we know which recentJobs to recover.
      const localSnapshot: Record<string, { annotationIds: string[] }> =
        JSON.parse(localStorage.getItem(IN_FLIGHT_STORAGE_KEY) || '{}');

      // Build a set of annotation IDs from local in-flight entries for matching
      const localAnnotationIds = new Set<string>();
      for (const entry of Object.values(localSnapshot)) {
        if (entry.annotationIds) for (const id of entry.annotationIds) localAnnotationIds.add(id);
      }

      setInFlightJobs(prev => {
        const next = { ...prev };
        // Prune stale entries (locally tracked but no longer active on server).
        // Keep recent provisional `_pending_` entries — they represent HTTP requests still in flight.
        // Prune old _pending_ entries (>30s) — they're from crashed/abandoned sessions.
        const now = Date.now();
        for (const id of Object.keys(next)) {
          if (id.startsWith('_pending_')) {
            const ts = parseInt(id.replace(/^_pending_(?:reply_)?/, ''), 10);
            if (!isNaN(ts) && now - ts > 30_000) delete next[id];
            continue;
          }
          if (!serverActiveIds.has(id)) delete next[id];
        }
        // Adopt server-active jobs missing locally (e.g. after refresh or from another tab)
        for (const j of activeJobs) {
          if (!next[j.id] && (j.annotationIds?.length || j.threadId)) {
            next[j.id] = {
              annotationIds: j.annotationIds ?? [],
              styleSelectors: [],
              color: j.color ?? '#888',
              threadId: j.threadId,
            };
          }
        }
        // Clean up _pending_ entries whose annotations are covered by a recentJob
        // (the HTTP request completed, job ran, and finished during refresh window)
        const recentAnnotationIds = new Set<string>();
        for (const rj of recentJobs) {
          if (rj.annotationIds) for (const id of rj.annotationIds) recentAnnotationIds.add(id);
        }
        for (const id of Object.keys(next)) {
          if (!id.startsWith('_pending_')) continue;
          const entry = next[id];
          if (entry && entry.annotationIds.some(aid => recentAnnotationIds.has(aid))) {
            delete next[id];
          }
        }
        return next;
      });

      // Recover resolutions for jobs that completed during the refresh window.
      // These appear in recentJobs but their done event was never processed.
      for (const recent of recentJobs) {
        if (recent.status !== 'done') continue;
        if (!recent.annotationIds?.length) continue;
        // Only recover if we were tracking this job locally (by annotationId overlap)
        if (!recent.annotationIds.some(id => localAnnotationIds.has(id))) continue;
        // Skip if already processed (e.g. from SSE backfill)
        if (processedDoneJobIdsRef.current.has(recent.id)) continue;

        try {
          const result = await fetchJobEvents(resolvedBridgeUrl, recent.id);
          if (!result) continue;
          const doneEvent = result.events.find(e => e.type === 'done');
          if (doneEvent && Array.isArray(doneEvent.resolutions)) {
            processedDoneJobIdsRef.current.add(recent.id);
            dispatch({
              type: 'APPLY_RESOLUTIONS',
              payload: {
                resolutions: doneEvent.resolutions as AnnotationResolution[],
                threadId: (doneEvent.threadId as string) ?? undefined,
              },
            });
          }
        } catch {
          // Event buffer may have expired — thread panel will still show persisted data
        }
      }
    });
  }, [bridge.isConnected, resolvedBridgeUrl, dispatch]);

  // Handle resolutions from done events (process ALL unprocessed, not just latest)
  useEffect(() => {
    const doneEvents = bridge.events.filter(e => e.type === 'done' && e.data.resolutions);
    for (const event of doneEvents) {
      const jobId = event.data.jobId as string;
      if (processedDoneJobIdsRef.current.has(jobId)) continue;
      processedDoneJobIdsRef.current.add(jobId);

      if (Array.isArray(event.data.resolutions)) {
        dispatch({
          type: 'APPLY_RESOLUTIONS',
          payload: {
            resolutions: event.data.resolutions as AnnotationResolution[],
            threadId: event.data.threadId as string | undefined,
          },
        });
      }
    }
  }, [bridge.events, dispatch]);

  // Handle cancelled jobs — dismiss their annotations so badges don't show "1 reply"
  const processedCancelJobIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const cancelEvents = bridge.events.filter(e => e.type === 'error' && e.data.cancelled);
    for (const event of cancelEvents) {
      const jobId = event.data.jobId as string;
      if (!jobId || processedCancelJobIdsRef.current.has(jobId)) continue;
      processedCancelJobIdsRef.current.add(jobId);

      const job = inFlightJobs[jobId];
      if (job && job.annotationIds.length > 0) {
        dispatch({ type: 'SET_ANNOTATION_STATUS', payload: { ids: job.annotationIds, status: 'dismissed' } });
      }
    }
  }, [bridge.events, inFlightJobs, dispatch]);

  // Handle incremental resolutions from plan executor (task_resolved events)
  const lastIncrementalCountRef = useRef(0);
  useEffect(() => {
    const resolutions = bridge.incrementalResolutions;
    if (resolutions.length <= lastIncrementalCountRef.current) return;
    const newResolutions = resolutions.slice(lastIncrementalCountRef.current);
    lastIncrementalCountRef.current = resolutions.length;

    dispatch({
      type: 'APPLY_RESOLUTIONS',
      payload: { resolutions: newResolutions },
    });
  }, [bridge.incrementalResolutions, dispatch]);

  // Reset incremental counter when resolutions are cleared
  useEffect(() => {
    if (bridge.incrementalResolutions.length === 0) {
      lastIncrementalCountRef.current = 0;
    }
  }, [bridge.incrementalResolutions.length]);

  // (Stale in-flight cleanup is handled by the reconciliation effect above —
  // a blanket clear on disconnected→idle was racing with reconciliation and
  // preventing resolution recovery for jobs that completed during refresh.)

  const handleScreenshot = useCallback(async (): Promise<boolean> => {
    const canvas = canvasRef.current;
    if (!canvas) return false;

    const blobs = await captureScreenshot(document.body, canvas, state.annotations);
    if (blobs.length === 0) return false;

    const success = await copyToClipboard(blobs, state.annotations, state.styleModifications);
    if (success) {
      dispatch({ type: 'MARK_CAPTURED' });
    }
    return success;
  }, [state.annotations, state.styleModifications, dispatch]);

  const handleAttachImages = useCallback((annotationId: string, images: Blob[]) => {
    const existing = annotationImagesRef.current.get(annotationId) || [];
    annotationImagesRef.current.set(annotationId, [...existing, ...images]);
  }, []);

  const handleSendToClaude = useCallback(async (): Promise<boolean> => {
    const canvas = canvasRef.current;
    if (!canvas) return false;

    // Detect planner mode: no pending annotations = planner goal
    const activeAnnotations = state.annotations.filter(a => (a.status ?? 'pending') === 'pending');
    const uncapturedSpacingChanges = state.spacingTokenChanges.filter(c => !c.captured);
    if (activeAnnotations.length === 0 && state.styleModifications.filter(m => !m.captured).length === 0 && uncapturedSpacingChanges.length === 0) {
      // No annotations, style changes, or spacing token changes — this is handled by the toolbar goal input
      return false;
    }

    // Group annotations by pathname to determine which pages need screenshots
    const annotationsByPage = new Map<string, typeof activeAnnotations>();
    for (const ann of activeAnnotations) {
      const page = ann.pathname || currentPathname;
      if (!annotationsByPage.has(page)) annotationsByPage.set(page, []);
      annotationsByPage.get(page)!.push(ann);
    }

    // Build per-page screenshot map
    const screenshotMap = new Map<string, Blob>();
    const offPages = [...annotationsByPage.keys()].filter(p => p !== currentPathname);

    if (offPages.length > 0) {
      // Programmatic navigation: visit each off-page, capture, return
      const originalPath = currentPathname;
      const originalScroll = { x: window.scrollX, y: window.scrollY };
      isProgrammaticNavRef.current = true;

      for (const page of offPages) {
        try {
          console.log(`[Popmelt] Navigating to ${page} for screenshot capture`);
          await softNavigate(page, navigateProp);

          if (window.location.pathname !== page) {
            console.warn(`[Popmelt] Navigation to ${page} did not take effect (at ${window.location.pathname})`);
          }

          const pageAnnotations = annotationsByPage.get(page) || [];
          const blobs = await captureScreenshot(document.body, canvas, pageAnnotations, { dpr: 1 });
          const stitched = await stitchBlobs(blobs);
          if (stitched) {
            screenshotMap.set(page, stitched);
            console.log(`[Popmelt] Captured ${page} (${(stitched.size / 1024).toFixed(0)}KB)`);
          }
        } catch (err) {
          console.warn(`[Popmelt] Failed to capture ${page}:`, err);
        }
      }

      // Navigate back to the original page
      await softNavigate(originalPath, navigateProp);
      window.scrollTo(originalScroll.x, originalScroll.y);
      isProgrammaticNavRef.current = false;
    }

    // Capture the current page (always fresh)
    const currentPageAnnotations = activeAnnotations.filter(
      a => (a.pathname || currentPathname) === currentPathname
    );
    const currentBlobs = await captureScreenshot(document.body, canvas, currentPageAnnotations.length > 0 ? state.annotations : [], { dpr: 1 });
    if (currentBlobs.length > 0) {
      const stitched = await stitchBlobs(currentBlobs);
      if (stitched) screenshotMap.set(currentPathname, stitched);
    }

    if (screenshotMap.size === 0) return false;

    // Build feedback data (include uncaptured spacing token changes)
    const feedbackData = buildFeedbackData(activeAnnotations, state.styleModifications, undefined, uncapturedSpacingChanges.length > 0 ? uncapturedSpacingChanges : undefined);
    const feedbackJson = JSON.stringify(feedbackData);

    // Gather pasted images for pending annotations
    const pastedImages = new Map<string, Blob[]>();
    for (const ann of activeAnnotations) {
      const blobs = annotationImagesRef.current.get(ann.id);
      if (blobs && blobs.length > 0) {
        pastedImages.set(ann.id, blobs);
      }
      // Also check group mates (text annotation may hold images for a grouped shape)
      if (ann.groupId) {
        for (const mate of activeAnnotations) {
          if (mate.groupId === ann.groupId && mate.id !== ann.id) {
            const mateBlobs = annotationImagesRef.current.get(mate.id);
            if (mateBlobs && mateBlobs.length > 0) {
              pastedImages.set(mate.id, mateBlobs);
            }
          }
        }
      }
    }

    // Send to bridge — use Map when annotations span multiple pages (even if some screenshots are missing),
    // single Blob for single-page backward compat
    const isMultiPage = annotationsByPage.size > 1;
    console.log(`[Popmelt] Submit: ${annotationsByPage.size} page(s), ${screenshotMap.size} screenshot(s), pages: [${[...annotationsByPage.keys()].join(', ')}], cached: [${[...pageScreenshotsRef.current.keys()].join(', ')}]`);
    const screenshots: Blob | Map<string, Blob> = isMultiPage
      ? screenshotMap
      : screenshotMap.get(currentPathname) ?? screenshotMap;

    // Pre-compute annotation/style IDs before the async send
    const sentAnnotationIds = activeAnnotations.map(a => a.id);
    const sentStyleSelectors = state.styleModifications.filter(m => !m.captured).map(m => m.selector);
    const hexColor = cssColorToHex(state.activeColor);

    // Write a provisional in-flight entry BEFORE the HTTP request so badge state
    // survives even if the user refreshes during the roundtrip. Uses a temp key
    // that gets swapped for the real jobId after the response.
    const provisionalKey = `_pending_${Date.now()}`;
    const provisionalEntry = {
      annotationIds: sentAnnotationIds,
      styleSelectors: sentStyleSelectors,
      color: state.activeColor,
      threadId: undefined as string | undefined,
    };
    try {
      const prev = JSON.parse(localStorage.getItem(IN_FLIGHT_STORAGE_KEY) || '{}');
      prev[provisionalKey] = provisionalEntry;
      localStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(prev));
    } catch {}
    setInFlightJobs(prev => ({ ...prev, [provisionalKey]: provisionalEntry }));

    // Send to bridge
    try {
      const { jobId, threadId: assignedThreadId } = await sendToBridge(
        screenshots, feedbackJson, resolvedBridgeUrl, hexColor, provider, currentModel.id,
        pastedImages.size > 0 ? pastedImages : undefined,
        getSourceId(),
      );

      // Clean up sent image blobs from the side-channel
      for (const annId of pastedImages.keys()) {
        annotationImagesRef.current.delete(annId);
      }

      // Clear used page screenshot cache entries
      for (const page of annotationsByPage.keys()) {
        pageScreenshotsRef.current.delete(page);
      }

      // Swap provisional key for real jobId
      const jobEntry = { ...provisionalEntry, threadId: assignedThreadId };
      try {
        const prev = JSON.parse(localStorage.getItem(IN_FLIGHT_STORAGE_KEY) || '{}');
        delete prev[provisionalKey];
        prev[jobId] = jobEntry;
        localStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(prev));
      } catch {}

      setInFlightJobs(prev => {
        const { [provisionalKey]: _, ...rest } = prev;
        return { ...rest, [jobId]: jobEntry };
      });

      dispatch({ type: 'MARK_CAPTURED' });

      // Tag annotations with their threadId so spinners/badges can link to the thread panel
      if (assignedThreadId && sentAnnotationIds.length > 0) {
        dispatch({ type: 'SET_ANNOTATION_THREAD', payload: { ids: sentAnnotationIds, threadId: assignedThreadId } });
      }

      // Shift hue by ~60° for next round so successive iterations are visually distinct
      const hueMatch = state.activeColor.match(/oklch\([^)]*\s+([\d.]+)\s*\)/);
      const currentHue = hueMatch?.[1] ? parseFloat(hueMatch[1]) : 29;
      const nextHue = (currentHue + 60) % 360;
      dispatch({ type: 'SET_COLOR', payload: `oklch(0.628 0.258 ${nextHue})` });

      return true;
    } catch (err) {
      // Clean up provisional entry on failure
      try {
        const prev = JSON.parse(localStorage.getItem(IN_FLIGHT_STORAGE_KEY) || '{}');
        delete prev[provisionalKey];
        localStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(prev));
      } catch {}
      setInFlightJobs(prev => {
        const { [provisionalKey]: _, ...rest } = prev;
        return rest;
      });
      console.error('[Pare] Failed to send to bridge:', err);
      return false;
    }
  }, [state.annotations, state.styleModifications, state.spacingTokenChanges, state.activeColor, dispatch, resolvedBridgeUrl, provider, currentModel.id, currentPathname, navigateProp]);

  // Handle synthesize rules request — reopen existing thread if one exists
  const handleSynthesizeRules = useCallback(async () => {
    // If we already have a synthesize thread, just reopen it
    if (synthesizeThreadId) {
      setOpenThreadId(synthesizeThreadId);
      return;
    }

    try {
      const { jobId, threadId } = await synthesizeRules(resolvedBridgeUrl, provider, currentModel.id);
      setSynthesizeJobId(jobId);
      setSynthesizeThreadId(threadId);

      // Track in inFlightJobs so the thread panel gets streaming data
      const entry = { annotationIds: [], styleSelectors: [], color: '#6b7280', threadId };
      setInFlightJobs(prev => ({ ...prev, [jobId]: entry }));

      // Open the thread panel
      setOpenThreadId(threadId);
    } catch (err) {
      console.error('[Popmelt] Failed to start synthesize:', err);
    }
  }, [resolvedBridgeUrl, provider, currentModel.id, synthesizeThreadId]);

  // Handle reply to a question from Claude
  const handleReply = useCallback(async (threadId: string, reply: string, images?: Blob[]) => {
    // Inherit the thread's original color
    const threadColor = Object.values(inFlightJobsRef.current).find(j => j.threadId === threadId)?.color
      ?? state.annotations.find(a => a.threadId === threadId)?.color
      ?? state.activeColor;

    // Identify thread annotations to re-track
    const threadAnnotations = state.annotations.filter(
      a => a.threadId === threadId && (a.status === 'waiting_input' || a.status === 'resolved' || a.status === 'needs_review')
    );
    const reTrackedIds = threadAnnotations.map(a => a.id);

    // Provisional entry BEFORE the HTTP request
    const provisionalKey = `_pending_reply_${Date.now()}`;
    const provisionalEntry = {
      annotationIds: reTrackedIds,
      styleSelectors: [] as string[],
      color: threadColor,
      threadId,
    };
    try {
      const prev = JSON.parse(localStorage.getItem(IN_FLIGHT_STORAGE_KEY) || '{}');
      prev[provisionalKey] = provisionalEntry;
      localStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(prev));
    } catch {}
    setInFlightJobs(prev => ({ ...prev, [provisionalKey]: provisionalEntry }));

    try {
      const hexColor = cssColorToHex(state.activeColor);
      const { jobId } = await sendReplyToBridge(threadId, reply, resolvedBridgeUrl, hexColor, provider, currentModel.id, images, getSourceId());

      // Swap provisional key for real jobId
      const replyJobEntry = { ...provisionalEntry };
      try {
        const prev = JSON.parse(localStorage.getItem(IN_FLIGHT_STORAGE_KEY) || '{}');
        delete prev[provisionalKey];
        prev[jobId] = replyJobEntry;
        localStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(prev));
      } catch {}

      setInFlightJobs(prev => {
        const { [provisionalKey]: _, ...rest } = prev;
        return { ...rest, [jobId]: replyJobEntry };
      });

      if (threadAnnotations.length > 0) {
        dispatch({
          type: 'SET_ANNOTATION_STATUS',
          payload: { ids: reTrackedIds, status: 'in_flight' },
        });
      }

      bridge.dismissQuestion(threadId);
    } catch (err) {
      // Clean up provisional entry on failure
      try {
        const prev = JSON.parse(localStorage.getItem(IN_FLIGHT_STORAGE_KEY) || '{}');
        delete prev[provisionalKey];
        localStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(prev));
      } catch {}
      setInFlightJobs(prev => {
        const { [provisionalKey]: _, ...rest } = prev;
        return rest;
      });
      console.error('[Pare] Failed to send reply:', err);
    }
  }, [state.activeColor, state.annotations, resolvedBridgeUrl, bridge.dismissQuestion, dispatch, provider, currentModel.id]);

  // Handle question events from bridge → dispatch SET_ANNOTATION_QUESTION
  const processedQuestionJobIdsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const q of bridge.pendingQuestions) {
      if (processedQuestionJobIdsRef.current.has(q.jobId)) continue;
      processedQuestionJobIdsRef.current.add(q.jobId);

      let targetIds = q.annotationIds && q.annotationIds.length > 0
        ? q.annotationIds
        : undefined;

      // Fallback: find annotations by threadId (covers planner questions with no annotationIds)
      if (!targetIds && q.threadId) {
        targetIds = state.annotations
          .filter(a => a.threadId === q.threadId)
          .map(a => a.id);
      }

      if (targetIds && targetIds.length > 0) {
        dispatch({
          type: 'SET_ANNOTATION_QUESTION',
          payload: {
            ids: targetIds,
            question: q.question,
            threadId: q.threadId,
          },
        });
      }
    }
  }, [bridge.pendingQuestions, dispatch, state.annotations]);

  // Compute the active job's annotation color for the toolbar spinner
  const activeJobColor = useMemo(() => {
    if (bridge.activeJobId && bridge.activeJobId in inFlightJobs) {
      return inFlightJobs[bridge.activeJobId]!.color;
    }
    const values = Object.values(inFlightJobs);
    return values.length > 0 ? values[values.length - 1]!.color : undefined;
  }, [bridge.activeJobId, inFlightJobs]);

  const handleViewThread = useCallback((threadId: string) => {
    setOpenThreadId(threadId);
  }, []);

  const handleClickJob = useCallback((jobId: string) => {
    const job = inFlightJobs[jobId];
    const threadId = job?.threadId || jobThreadMapRef.current.get(jobId);
    if (threadId) {
      threadColorFallbackRef.current = job?.color ?? null;
      setOpenThreadId(threadId);
    }
  }, [inFlightJobs]);

  const handleHoverJob = useCallback((jobId: string | null) => {
    if (!jobId) { setHighlightedAnnotationIds(null); return; }
    const annotationIds = jobAnnotationMapRef.current.get(jobId);
    if (annotationIds && annotationIds.length > 0) {
      setHighlightedAnnotationIds(new Set(annotationIds));
    } else {
      setHighlightedAnnotationIds(null);
    }
  }, []);

  const handleCancelJob = useCallback(async (jobId?: string) => {
    try {
      const url = jobId
        ? `${resolvedBridgeUrl}/cancel?jobId=${jobId}`
        : `${resolvedBridgeUrl}/cancel`;
      await fetch(url, { method: 'POST' });
    } catch {
      // Best-effort
    }
  }, [resolvedBridgeUrl]);

  // Mutual exclusion: close thread panel when model/library panel opens
  // (except synthesize threads — keep both panels visible for reference)
  useEffect(() => {
    if (state.activeTool === 'model' && openThreadId && openThreadId !== synthesizeThreadId) {
      setOpenThreadId(null);
    }
  }, [state.activeTool]);

  // Close thread panel when toolbar collapses; restore when it expands
  const stashedThreadIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state.isAnnotating) {
      // Toolbar collapsed — stash the open thread and close the panel
      if (openThreadId) {
        stashedThreadIdRef.current = openThreadId;
        setOpenThreadId(null);
      }
    } else {
      // Toolbar expanded — restore the stashed thread
      if (stashedThreadIdRef.current) {
        setOpenThreadId(stashedThreadIdRef.current);
        stashedThreadIdRef.current = null;
      }
    }
  }, [state.isAnnotating]);

  // Find the active jobId for the open thread (for per-job streaming data)
  // Only matches jobs belonging to this thread — no fallback to avoid cross-thread leaking
  const threadActiveJobId = useMemo(() => {
    if (!openThreadId) return null;
    // Check inFlightJobs first (has richer data from the submit callback)
    for (const [jobId, job] of Object.entries(inFlightJobs)) {
      if (job.threadId === openThreadId) return jobId;
    }
    // Fall back to bridge store's activeJobThreads (populated from enriched /status on reconnect)
    for (const [jobId, threadId] of Object.entries(bridge.activeJobThreads)) {
      if (threadId === openThreadId) return jobId;
    }
    return null;
  }, [openThreadId, inFlightJobs, bridge.activeJobThreads]);

  const threadAnnotation = openThreadId ? state.annotations.find(a => a.threadId === openThreadId) : undefined;

  // Memoize streamingEvents to avoid creating a new array reference on every render.
  // The bridge.events array grows monotonically, so length is a stable change signal.
  const EMPTY_EVENTS: typeof bridge.events = [];
  const threadStreamingEvents = useMemo(
    () => threadActiveJobId ? bridge.events.filter(e => e.data.jobId === threadActiveJobId) : EMPTY_EVENTS,
    [threadActiveJobId, bridge.events.length],
  );

  // Memoize accentColor to avoid reference churn on every render
  const threadAccentColor = useMemo(
    () => threadAnnotation?.color ?? threadColorFallbackRef.current ?? state.activeColor,
    [threadAnnotation?.color, state.activeColor],
  );
  const threadAnnotationNumber = threadAnnotation ? state.annotations.indexOf(threadAnnotation) + 1 : undefined;

  // Sync toolbar color to match the open thread's annotation color
  useEffect(() => {
    const color = threadAnnotation?.color ?? threadColorFallbackRef.current;
    if (openThreadId && color) {
      dispatch({ type: 'SET_COLOR', payload: color });
    }
  }, [openThreadId]);

  // Event stream hover visibility (debounced to bridge gap between crosshair and stack)
  const [eventStreamVisible, setEventStreamVisible] = useState(false);
  const [clearSignal, setClearSignal] = useState(0);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleEventStreamHover = useCallback((hovering: boolean) => {
    if (hovering) {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      setEventStreamVisible(true);
    } else {
      hideTimeoutRef.current = setTimeout(() => {
        setEventStreamVisible(false);
        hideTimeoutRef.current = null;
      }, 150);
    }
  }, []);

  const handleClearEventStream = useCallback(() => {
    setClearSignal((s) => s + 1);
    bridge.clearEvents();
    setOpenThreadId(null);
    setDismissedThreadIds(new Set());
    // Kill all active jobs on the bridge
    handleCancelJob();
  }, [bridge.clearEvents, handleCancelJob]);

  // Cleanup hide timeout
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  // SSR safety: render children immediately, defer Popmelt chrome to client.
  // This avoids the BailoutToCSR issue when PopmeltProvider wraps page content.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const contextValue = useMemo(
    () => ({ isEnabled: enabled }),
    [enabled]
  );

  if (!enabled || !mounted) {
    return (
      <PopmeltContext.Provider value={contextValue}>
        {children}
      </PopmeltContext.Provider>
    );
  }

  return (
    <PopmeltContext.Provider value={contextValue}>
      {children}

      <AnnotationCanvas
        state={state}
        dispatch={dispatch}
        onScreenshot={handleScreenshot}
        inFlightAnnotationIds={inFlightAnnotationIds}
        activeAnnotationIds={activeAnnotationIds}
        queuePositionMap={queuePositionMap}
        inFlightStyleSelectors={inFlightStyleSelectors}
        inFlightSelectorColors={inFlightSelectorColors}
        onAttachImages={handleAttachImages}
        onReply={bridge.isConnected ? handleReply : undefined}
        onViewThread={bridge.isConnected ? handleViewThread : undefined}
        onCloseThread={(threadId) => {
          setOpenThreadId(null);
          if (threadId) setDismissedThreadIds((prev) => new Set(prev).add(threadId));
        }}
        onModelComponentsAdd={bridge.isConnected ? handleModelComponentsAdd : undefined}
        onModelComponentFocus={bridge.isConnected ? handleModelComponentFocus : undefined}
        onModelComponentHover={setModelCanvasHoveredComponent}
        modelComponentNames={modelComponentNames}
        modelPanelHoveredComponent={modelPanelHoveredComponent}
        modelSpacingTokenHover={modelSpacingTokenHover}
        highlightedAnnotationIds={highlightedAnnotationIds}
        focusedThreadAnnotationId={threadAnnotation?.id}
        externalCanvasRef={canvasRef}
        toolbarRef={toolbarRef}
      />

      <ShadowHost>
        <ShadowChrome>
          <AnnotationToolbar
            state={state}
            dispatch={dispatch}
            onScreenshot={handleScreenshot}
            onSendToClaude={bridge.isConnected ? handleSendToClaude : undefined}
            hasActiveJobs={Object.keys(inFlightJobs).length > 0 || bridge.activeJobIds.length > 0}
            activeJobColor={activeJobColor}
            onCrosshairHover={handleEventStreamHover}
            onClear={handleClearEventStream}
            provider={provider}
            onProviderChange={bridge.isConnected && availableProviders.length > 1 ? handleProviderChange : undefined}
            availableProviders={availableProviders}
            modelIndex={modelIndex}
            modelCount={models.length}
            modelLabel={currentModel.label}
            onModelChange={bridge.isConnected ? handleModelChange : undefined}
            onViewThread={bridge.isConnected ? handleViewThread : undefined}
            isThreadPanelOpen={openThreadId !== null && openThreadId !== synthesizeThreadId}
            mcpStatus={mcpStatus}
            onInstallMcp={bridge.isConnected ? handleInstallMcp : undefined}
            mcpJustInstalled={mcpJustInstalled}
            bridgeUrl={resolvedBridgeUrl}
            isBridgeConnected={bridge.isConnected}
            modelSelectedComponent={modelSelectedComponent}
            modelCanvasHoveredComponent={modelCanvasHoveredComponent}
            onModelComponentHover={setModelPanelHoveredComponent}
            onSpacingTokenHover={setModelSpacingTokenHover}
            onModifySpacingToken={bridge.isConnected ? handleModifySpacingToken : undefined}
            onDeleteSpacingToken={bridge.isConnected ? handleDeleteSpacingToken : undefined}
            modelRefreshKey={modelRefreshKey}
            onModelComponentAdded={handleModelComponentAdded}
            onModelComponentRemoved={handleModelComponentRemoved}
            onSynthesizeRules={bridge.isConnected ? handleSynthesizeRules : undefined}
            isSynthesizing={synthesizeJobId !== null}
            toolbarRef={toolbarRef}
          />

          {openThreadId && bridge.isConnected && (
            <ThreadPanel
              threadId={openThreadId}
              bridgeUrl={resolvedBridgeUrl}
              accentColor={threadAccentColor}
              isStreaming={threadActiveJobId !== null}
              isQueued={threadActiveJobId !== null && !bridge.activeJobIds.includes(threadActiveJobId)}
              queuePosition={threadActiveJobId && !bridge.activeJobIds.includes(threadActiveJobId)
                ? (() => {
                    const activeSet = new Set(bridge.activeJobIds);
                    const queued = Object.keys(inFlightJobs).filter(id => !activeSet.has(id));
                    const idx = queued.indexOf(threadActiveJobId);
                    return idx >= 0 ? `(${idx + 1}/${queued.length})` : undefined;
                  })()
                : undefined}
              streamingEvents={threadStreamingEvents}
              onClose={() => setOpenThreadId(null)}
              onReply={handleReply}
              onCancel={threadActiveJobId ? () => handleCancelJob(threadActiveJobId) : undefined}
              lastError={
                bridge.lastErrorByJob?.[threadActiveJobId ?? '']
                ?? (bridge.lastCompletedJobId && jobThreadMapRef.current.get(bridge.lastCompletedJobId) === openThreadId
                  ? bridge.lastErrorByJob?.[bridge.lastCompletedJobId]
                  : undefined)
              }
              toolbarRef={toolbarRef}
              currentModel={currentModel.id}
              currentProvider={provider}
              annotationNumber={threadAnnotationNumber}
              annotationText={threadAnnotation?.text}
            />
          )}

          <BridgeEventStack
            bridge={bridge}
            bridgeUrl={resolvedBridgeUrl}
            inFlightJobs={inFlightJobs}
            isVisible={eventStreamVisible || bridge.lastResponseText !== null || bridge.activeJobIds.length > 0}
            onHover={handleEventStreamHover}
            clearSignal={clearSignal}
            onReply={handleReply}
            onViewThread={handleViewThread}
            onClickJob={handleClickJob}
            onCancel={handleCancelJob}
            onHoverJob={handleHoverJob}
            isConnected={bridge.isConnected}
            dismissedThreadIds={dismissedThreadIds}
          />
        </ShadowChrome>
      </ShadowHost>
    </PopmeltContext.Provider>
  );
}

export function usePopmelt() {
  const ctx = useContext(PopmeltContext);
  if (!ctx) {
    throw new Error('usePopmelt must be used within PopmeltProvider');
  }
  return ctx;
}
