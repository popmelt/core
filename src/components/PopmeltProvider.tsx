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
} from 'react';

import { useBridgeConnection, type PendingPlan } from '../hooks/useBridgeConnection';
import { useAnnotationState } from '../hooks/useAnnotationState';
import type { AnnotationResolution, SpacingTokenChange, SpacingTokenMod } from '../tools/types';
import { addComponentToModel, approvePlan, fetchCapabilities, fetchModel, installMcp, removeComponentFromModel, removeModelToken, sendPlanExecution, sendPlanReview, sendPlanToBridge, sendReplyToBridge, sendToBridge, updateModelToken, type McpDetectionResult } from '../utils/bridge-client';
import { resolveRegionToElement } from '../utils/dom';
import { buildPageManifest } from '../utils/page-manifest';
import { buildFeedbackData, captureFullPage, captureScreenshot, copyToClipboard, cssColorToHex, stitchBlobs } from '../utils/screenshot';
import { AnnotationCanvas } from './AnnotationCanvas';
import { AnnotationToolbar } from './AnnotationToolbar';
import { BridgeEventStack } from './BridgeStatusPanel';
import { ThreadPanel } from './ThreadPanel';

type PopmeltContextValue = {
  isEnabled: boolean;
};

const PopmeltContext = createContext<PopmeltContextValue | null>(null);

type PopmeltProviderProps = PropsWithChildren<{
  enabled?: boolean;
  bridgeUrl?: string;
}>;

const DEFAULT_BRIDGE_URL = 'http://localhost:1111';
const PROVIDER_STORAGE_KEY = 'devtools-provider';
const MODEL_STORAGE_KEY = 'devtools-model';
const THREAD_ID_STORAGE_KEY = 'devtools-open-thread-id';
const ACTIVE_PLAN_STORAGE_KEY = 'devtools-active-plan';

// Model definitions per provider
const CLAUDE_MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonn 4.6' },
] as const;

const CODEX_MODELS = [
  { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
  { id: 'gpt-5.3-codex-spark', label: 'Spark 5.3' },
  { id: 'gpt-5.1-codex-mini', label: 'Mini 5.1' },
] as const;

export const MODEL_MAP = { claude: CLAUDE_MODELS, codex: CODEX_MODELS } as const;

// Cross-provider equivalence: index 0 = fast, index 1 = thorough
function equivalentModelIndex(fromProvider: string, toProvider: string, currentIndex: number): number {
  const fromModels = fromProvider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
  const toModels = toProvider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
  return Math.min(currentIndex, toModels.length - 1);
}

export function PopmeltProvider({
  children,
  enabled = process.env.NODE_ENV === 'development',
  bridgeUrl = DEFAULT_BRIDGE_URL,
}: PopmeltProviderProps) {
  const [state, dispatch] = useAnnotationState();
  const bridge = useBridgeConnection(bridgeUrl);
  const annotationImagesRef = useRef(new Map<string, Blob[]>());
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
  const [availableProviders, setAvailableProviders] = useState<string[]>(['claude', 'codex']);

  // MCP server detection results per provider
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpDetectionResult>>({});
  const [mcpJustInstalled, setMcpJustInstalled] = useState(false);

  // Fetch capabilities when bridge connects
  useEffect(() => {
    if (!bridge.isConnected) return;
    fetchCapabilities(bridgeUrl).then(caps => {
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
  }, [bridge.isConnected, bridgeUrl]);

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
    const result = await installMcp(bridgeUrl);
    if (!result) return;
    const mcp: Record<string, McpDetectionResult> = {};
    for (const [name, p] of Object.entries(result.capabilities.providers)) {
      if (p.mcp) mcp[name] = p.mcp;
    }
    setMcpStatus(mcp);
    if (result.results.some(r => r.installed)) {
      setMcpJustInstalled(true);
    }
  }, [bridgeUrl]);

  // Model tool state: track component names in the local design model
  const [modelComponentNames, setModelComponentNames] = useState<Set<string>>(new Set());
  const [modelSelectedComponent, setModelSelectedComponent] = useState<string | null>(null);
  // Bidirectional hover: canvas tells us what's hovered, panel tells us what's hovered
  const [modelCanvasHoveredComponent, setModelCanvasHoveredComponent] = useState<string | null>(null);
  const [modelPanelHoveredComponent, setModelPanelHoveredComponent] = useState<{ name: string; instanceIndex: number } | null>(null);
  const [modelSpacingTokenHover, setModelSpacingTokenHover] = useState<{ name: string; px: number; token?: import('../utils/domQuery').TokenBinding } | null>(null);

  // Fetch model component names on mount and when bridge connects
  useEffect(() => {
    if (!bridge.isConnected) return;
    fetchModel(bridgeUrl).then(model => {
      if (model?.components) {
        setModelComponentNames(new Set(Object.keys(model.components)));
      }
    });
  }, [bridge.isConnected, bridgeUrl]);

  const handleModelComponentsAdd = useCallback(async (names: string[]) => {
    const added: string[] = [];
    for (const name of names) {
      try {
        const result = await addComponentToModel(name, bridgeUrl);
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
  }, [bridgeUrl]);

  const handleModelComponentFocus = useCallback((name: string) => {
    setModelSelectedComponent(name);
  }, []);

  const handleModelComponentAdded = useCallback(() => {
    // Re-fetch model to update component names
    fetchModel(bridgeUrl).then(model => {
      if (model?.components) {
        setModelComponentNames(new Set(Object.keys(model.components)));
      }
    });
  }, [bridgeUrl]);

  const handleModelComponentRemoved = useCallback(async (name: string) => {
    try {
      const result = await removeComponentFromModel(name, bridgeUrl);
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
  }, [bridgeUrl]);

  // Undo-tracked spacing token modification: dispatches to reducer so Cmd+Z works
  const handleModifySpacingToken = useCallback((mod: SpacingTokenMod, change: SpacingTokenChange) => {
    dispatch({ type: 'MODIFY_SPACING_TOKEN', payload: mod });
    dispatch({ type: 'ADD_SPACING_TOKEN_CHANGE', payload: change });
  }, [dispatch]);

  // Undo-tracked spacing token deletion
  const handleDeleteSpacingToken = useCallback((tokenPath: string, originalValue: string) => {
    dispatch({ type: 'DELETE_SPACING_TOKEN', payload: { tokenPath, originalValue } });
  }, [dispatch]);

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
        removeModelToken(path, bridgeUrl).catch(err =>
          console.error('[Popmelt] Failed to sync token delete:', err)
        );
      } else {
        // Token was modified (or undo restored a value) — update on bridge
        updateModelToken(path, mod.currentValue, bridgeUrl).catch(err =>
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
      updateModelToken(path, prevMod.originalValue, bridgeUrl).catch(err =>
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
  }, [state.spacingTokenMods, bridgeUrl]);

  // Thread panel state (declared early so callbacks can reference setOpenThreadId)
  const [openThreadId, setOpenThreadId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(THREAD_ID_STORAGE_KEY) || null;
  });

  // Active plan state
  const [activePlan, setActivePlan] = useState<{
    planId: string;
    threadId?: string;
    goal: string;
    tasks?: PendingPlan['tasks'];
    status: 'planning' | 'awaiting_approval' | 'executing' | 'reviewing' | 'done';
  } | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = localStorage.getItem(ACTIVE_PLAN_STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });

  // Persist openThreadId and activePlan to localStorage
  useEffect(() => {
    if (openThreadId) {
      localStorage.setItem(THREAD_ID_STORAGE_KEY, openThreadId);
    } else {
      localStorage.removeItem(THREAD_ID_STORAGE_KEY);
    }
  }, [openThreadId]);

  useEffect(() => {
    if (activePlan) {
      localStorage.setItem(ACTIVE_PLAN_STORAGE_KEY, JSON.stringify(activePlan));
    } else {
      localStorage.removeItem(ACTIVE_PLAN_STORAGE_KEY);
    }
  }, [activePlan]);

  // Per-job in-flight tracking: jobId → { annotationIds, styleSelectors, color, threadId }
  // Persisted in sessionStorage so state survives HMR remounts (Astro/Vite tear down React islands).
  const IN_FLIGHT_STORAGE_KEY = 'popmelt-in-flight-jobs';
  const [inFlightJobs, setInFlightJobs] = useState<Record<string, { annotationIds: string[]; styleSelectors: string[]; color: string; threadId?: string; planId?: string }>>(() => {
    try {
      const stored = sessionStorage.getItem(IN_FLIGHT_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  // Sync inFlightJobs to sessionStorage
  useEffect(() => {
    try {
      if (Object.keys(inFlightJobs).length > 0) {
        sessionStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(inFlightJobs));
      } else {
        sessionStorage.removeItem(IN_FLIGHT_STORAGE_KEY);
      }
    } catch {}
  }, [inFlightJobs]);

  // Recovery: annotations hydrate from localStorage via PASTE_ANNOTATIONS (after mount).
  // Any annotation stuck in 'in_flight' with no matching active job is a ghost — reset it.
  // Also clear stale activePlan (planning/executing with no backing job).
  const didRecoverRef = useRef(false);
  useEffect(() => {
    if (didRecoverRef.current) return;
    if (state.annotations.length === 0) return; // not hydrated yet
    didRecoverRef.current = true;
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
    // Clear activePlan if it's in a transient state with no backing job
    if (activePlan && (activePlan.status === 'planning' || activePlan.status === 'executing' || activePlan.status === 'reviewing') && Object.keys(inFlightJobs).length === 0) {
      setActivePlan(null);
    }
  }, [state.annotations, inFlightJobs, dispatch, activePlan]);

  // Flatten all in-flight annotation IDs and style selectors for the canvas
  const inFlightAnnotationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const job of Object.values(inFlightJobs)) {
      for (const id of job.annotationIds) ids.add(id);
    }
    return ids;
  }, [inFlightJobs]);

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

  // Clear specific job's annotations when it completes or errors
  useEffect(() => {
    if (bridge.lastCompletedJobId && bridge.lastCompletedJobId in inFlightJobs) {
      setInFlightJobs((prev) => {
        const { [bridge.lastCompletedJobId!]: _, ...rest } = prev;
        return rest;
      });
    }
  }, [bridge.lastCompletedJobId]);

  // Handle resolutions from done events (process ALL unprocessed, not just latest)
  const processedDoneJobIdsRef = useRef(new Set<string>());
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

  // On reconnect to idle bridge, clear any stale in-flight state
  const prevBridgeStatus = useRef(bridge.status);
  useEffect(() => {
    const prev = prevBridgeStatus.current;
    prevBridgeStatus.current = bridge.status;

    if (prev === 'disconnected' && bridge.status === 'idle') {
      setInFlightJobs({});
    }
  }, [bridge.status]);

  const handleScreenshot = useCallback(async (): Promise<boolean> => {
    const canvas = document.getElementById('devtools-canvas') as HTMLCanvasElement | null;
    if (!canvas) return false;

    const blobs = await captureScreenshot(document.body, canvas, state.annotations);
    if (blobs.length === 0) return false;

    const success = await copyToClipboard(blobs, state.annotations, state.styleModifications);
    if (success) {
      dispatch({ type: 'MARK_CAPTURED' });
    }
    return success;
  }, [state.annotations, state.styleModifications, dispatch]);

  // Plan goal handler: captures full-page screenshot and sends to planner
  const handlePlanGoal = useCallback(async (goal: string): Promise<boolean> => {
    try {
      // Collect triggering annotations for screenshot overlay and feedback context
      const activeAnnotations = state.annotations.filter(a => (a.status ?? 'pending') === 'pending');

      const screenshotBlob = await captureFullPage(document.body, activeAnnotations);
      if (!screenshotBlob) return false;

      const manifest = buildPageManifest();

      // Include pending annotations, uncaptured style mods, and inspected element as context
      const uncapturedStyleMods = state.styleModifications.filter(m => !m.captured);
      const inspectedInfo = state.inspectedElement?.info;
      const hasFeedback = activeAnnotations.length > 0 || uncapturedStyleMods.length > 0 || !!inspectedInfo;
      const feedbackJson = hasFeedback
        ? JSON.stringify(buildFeedbackData(activeAnnotations, uncapturedStyleMods, inspectedInfo))
        : undefined;

      const { planId, threadId } = await sendPlanToBridge(
        screenshotBlob,
        goal,
        bridgeUrl,
        provider,
        currentModel.id,
        window.location.href,
        { width: window.innerWidth, height: window.innerHeight },
        manifest,
        feedbackJson,
      );

      setActivePlan({
        planId,
        threadId,
        goal,
        status: 'planning',
      });

      // Tag pending text annotations with the plan's threadId so badges can find them
      if (threadId) {
        const pendingTextIds = state.annotations
          .filter(a => a.type === 'text' && (a.status ?? 'pending') === 'pending')
          .map(a => a.id);
        if (pendingTextIds.length > 0) {
          dispatch({ type: 'SET_ANNOTATION_THREAD', payload: { ids: pendingTextIds, threadId } });
        }
      }
      dispatch({ type: 'MARK_CAPTURED' });

      // Open thread panel to show planner streaming
      if (threadId) setOpenThreadId(threadId);

      return true;
    } catch (err) {
      console.error('[Pare] Failed to send plan:', err);
      return false;
    }
  }, [bridgeUrl, provider, currentModel.id, state.annotations, state.styleModifications, state.inspectedElement, dispatch]);

  // Materialize plan tasks as annotations on the canvas
  const materializePlan = useCallback(async (tasks: PendingPlan['tasks']) => {
    const planId = activePlan?.planId;
    if (!planId) return;

    // Compute distinct hue per worker so each task gets a unique color
    const baseHueMatch = state.activeColor.match(/oklch\([^)]*\s+([\d.]+)\s*\)/);
    const baseHue = baseHueMatch?.[1] ? parseFloat(baseHueMatch[1]) : 29;
    const hueStep = tasks.length > 1 ? 360 / tasks.length : 0;

    // Stagger annotation creation for visual effect
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      const taskHue = (baseHue + i * hueStep) % 360;
      const taskColor = `oklch(0.628 0.258 ${Math.round(taskHue)})`;

      // Scroll the region into view (instant to ensure position is correct for elementFromPoint)
      const regionCenterY = task.region.y + task.region.height / 2;
      const viewportH = window.innerHeight;
      if (regionCenterY < window.scrollY || regionCenterY > window.scrollY + viewportH) {
        window.scrollTo({
          top: Math.max(0, regionCenterY - viewportH / 2),
          behavior: 'instant',
        });
        // Double rAF for paint settle
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      }

      // Resolve region to DOM element
      const resolved = resolveRegionToElement(task.region);

      const groupId = Math.random().toString(36).substring(2, 9);
      // Use the resolved element's bounding rect (in page coords) for tighter fit
      const region = resolved
        ? {
            x: resolved.rect.left + window.scrollX,
            y: resolved.rect.top + window.scrollY,
            width: resolved.rect.width,
            height: resolved.rect.height,
          }
        : task.region;

      dispatch({
        type: 'ADD_PLAN_ANNOTATION',
        payload: {
          groupId,
          planId,
          planTaskId: task.id,
          instruction: task.instruction,
          region,
          color: taskColor,
          linkedSelector: resolved?.selector,
          elements: resolved ? [resolved.info] : undefined,
        },
      });

      // 200ms stagger between annotations
      if (i < tasks.length - 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }, [activePlan?.planId, state.activeColor, dispatch]);

  const handleAttachImages = useCallback((annotationId: string, images: Blob[]) => {
    const existing = annotationImagesRef.current.get(annotationId) || [];
    annotationImagesRef.current.set(annotationId, [...existing, ...images]);
  }, []);

  const handleSendToClaude = useCallback(async (): Promise<boolean> => {
    const canvas = document.getElementById('devtools-canvas') as HTMLCanvasElement | null;
    if (!canvas) return false;

    // Detect planner mode: no pending annotations = planner goal
    const activeAnnotations = state.annotations.filter(a => (a.status ?? 'pending') === 'pending');
    const uncapturedSpacingChanges = state.spacingTokenChanges.filter(c => !c.captured);
    if (activeAnnotations.length === 0 && state.styleModifications.filter(m => !m.captured).length === 0 && uncapturedSpacingChanges.length === 0) {
      // No annotations, style changes, or spacing token changes — this is handled by the toolbar goal input
      return false;
    }

    // Capture screenshot
    const blobs = await captureScreenshot(document.body, canvas, state.annotations);
    if (blobs.length === 0) return false;

    // Stitch into single image
    const stitchedBlob = await stitchBlobs(blobs);
    if (!stitchedBlob) return false;

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

    // Send to bridge
    try {
      const hexColor = cssColorToHex(state.activeColor);
      const { jobId, threadId: assignedThreadId } = await sendToBridge(
        stitchedBlob, feedbackJson, bridgeUrl, hexColor, provider, currentModel.id,
        pastedImages.size > 0 ? pastedImages : undefined,
      );

      // Clean up sent image blobs from the side-channel
      for (const annId of pastedImages.keys()) {
        annotationImagesRef.current.delete(annId);
      }

      // Track which annotations and style modifications are in-flight for this job
      const sentAnnotationIds = activeAnnotations.map(a => a.id);
      const sentStyleSelectors = state.styleModifications.filter(m => !m.captured).map(m => m.selector);
      setInFlightJobs((prev) => ({
        ...prev,
        [jobId]: {
          annotationIds: sentAnnotationIds,
          styleSelectors: sentStyleSelectors,
          color: state.activeColor,
          threadId: assignedThreadId,
        },
      }));

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
      console.error('[Pare] Failed to send to bridge:', err);
      return false;
    }
  }, [state.annotations, state.styleModifications, state.spacingTokenChanges, state.activeColor, dispatch, bridgeUrl, provider, currentModel.id]);

  // Handle reply to a question from Claude
  const handleReply = useCallback(async (threadId: string, reply: string, images?: Blob[]) => {
    try {
      const hexColor = cssColorToHex(state.activeColor);
      const { jobId } = await sendReplyToBridge(threadId, reply, bridgeUrl, hexColor, provider, currentModel.id, images);

      // Track the new continuation job (no specific annotations — reuses thread context)
      setInFlightJobs(prev => ({
        ...prev,
        [jobId]: {
          annotationIds: [],
          styleSelectors: [],
          color: state.activeColor,
          threadId,
        },
      }));

      // Transition thread annotations back to in_flight (from waiting_input, resolved, or needs_review)
      const threadAnnotations = state.annotations.filter(
        a => a.threadId === threadId && (a.status === 'waiting_input' || a.status === 'resolved' || a.status === 'needs_review')
      );
      if (threadAnnotations.length > 0) {
        dispatch({
          type: 'SET_ANNOTATION_STATUS',
          payload: { ids: threadAnnotations.map(a => a.id), status: 'in_flight' },
        });
        // Re-track them as in-flight for the new job
        setInFlightJobs(prev => {
          const job = prev[jobId];
          if (!job) return prev;
          return {
            ...prev,
            [jobId]: {
              ...job,
              annotationIds: [...job.annotationIds, ...threadAnnotations.map(a => a.id)],
            },
          };
        });
      }

      bridge.dismissQuestion(threadId);
    } catch (err) {
      console.error('[Pare] Failed to send reply:', err);
    }
  }, [state.activeColor, state.annotations, bridgeUrl, bridge.dismissQuestion, dispatch, provider, currentModel.id]);

  // Handle plan approval: single-session execution for all tasks
  const handleApprovePlan = useCallback(async () => {
    if (!activePlan || !activePlan.planId) return;

    try {
      // Approve on server side
      await approvePlan(activePlan.planId, bridgeUrl);

      setActivePlan(prev => prev ? { ...prev, status: 'executing' } : null);

      // Capture ONE full-page screenshot
      const screenshotBlob = await captureFullPage(document.body);
      if (!screenshotBlob) return;

      // Collect plan annotations that are still pending (user may have deleted some)
      const planAnnotations = state.annotations.filter(
        a => a.planId === activePlan.planId && a.type !== 'text' && (a.status ?? 'pending') === 'pending'
      );

      // Build tasks array from plan annotations
      const tasks = planAnnotations.map(ann => {
        const textAnn = ann.groupId
          ? state.annotations.find(a => a.groupId === ann.groupId && a.type === 'text')
          : undefined;
        // Extract region from rectangle points [topLeft, bottomRight]
        const p0 = ann.points[0] ?? { x: 0, y: 0 };
        const p1 = ann.points[1] ?? p0;
        const x = Math.min(p0.x, p1.x);
        const y = Math.min(p0.y, p1.y);
        const width = Math.abs(p1.x - p0.x) || 100;
        const height = Math.abs(p1.y - p0.y) || 100;
        return {
          planTaskId: ann.planTaskId || ann.id,
          annotationId: ann.id,
          instruction: textAnn?.text || ann.text || 'No instruction',
          region: { x, y, width, height },
          linkedSelector: ann.linkedSelector,
          elements: ann.elements?.map(el => ({ selector: el.selector, reactComponent: el.reactComponent })),
        };
      });

      if (tasks.length === 0) return;

      // Send single execution job
      const { jobId } = await sendPlanExecution(
        screenshotBlob,
        activePlan.planId,
        tasks,
        bridgeUrl,
        provider,
        currentModel.id,
      );

      // Collect ALL plan annotation IDs (rect + text) for in-flight tracking
      const allPlanAnnotationIds: string[] = [];
      const seen = new Set<string>();
      for (const ann of planAnnotations) {
        if (!seen.has(ann.id)) { seen.add(ann.id); allPlanAnnotationIds.push(ann.id); }
        if (ann.groupId) {
          for (const mate of state.annotations) {
            if (mate.groupId === ann.groupId && !seen.has(mate.id)) {
              seen.add(mate.id);
              allPlanAnnotationIds.push(mate.id);
            }
          }
        }
      }

      // Track one in-flight entry with ALL plan annotation IDs
      setInFlightJobs(prev => ({
        ...prev,
        [jobId]: {
          annotationIds: allPlanAnnotationIds,
          styleSelectors: [],
          color: state.activeColor,
          planId: activePlan.planId,
        },
      }));

      // Mark all plan annotations (rect + text) as in_flight
      dispatch({
        type: 'SET_ANNOTATION_STATUS',
        payload: { ids: allPlanAnnotationIds, status: 'in_flight' },
      });

      dispatch({ type: 'MARK_CAPTURED' });

    } catch (err) {
      console.error('[Pare] Failed to approve plan:', err);
    }
  }, [activePlan, state.annotations, state.activeColor, bridgeUrl, provider, currentModel.id, dispatch]);

  const handleDismissPlan = useCallback(() => {
    setActivePlan(null);
    // Clear plan annotations
    if (activePlan?.planId) {
      const planAnnotations = state.annotations.filter(a => a.planId === activePlan.planId);
      for (const ann of planAnnotations) {
        dispatch({ type: 'DELETE_ANNOTATION', payload: { id: ann.id } });
      }
    }
  }, [activePlan, state.annotations, dispatch]);

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

  // Handle plan_ready events → trigger materialization (and auto-approve single-task plans)
  const processedPlanIdsRef = useRef(new Set<string>());
  const pendingAutoApproveRef = useRef<string | null>(null);
  useEffect(() => {
    for (const plan of bridge.pendingPlans) {
      if (processedPlanIdsRef.current.has(plan.planId)) continue;
      processedPlanIdsRef.current.add(plan.planId);

      const isSingleTask = plan.tasks.length === 1;

      setActivePlan(prev => {
        if (prev?.planId !== plan.planId) return prev;
        return {
          ...prev,
          tasks: plan.tasks,
          threadId: plan.threadId,
          status: isSingleTask ? 'executing' : 'awaiting_approval',
        };
      });

      // Materialize annotations then auto-approve if single task
      materializePlan(plan.tasks).then(() => {
        if (isSingleTask) {
          pendingAutoApproveRef.current = plan.planId;
        }
      });

      bridge.dismissPlan(plan.planId);
    }
  }, [bridge.pendingPlans]);

  // Auto-approve single-task plans after materialization completes
  useEffect(() => {
    if (!pendingAutoApproveRef.current) return;
    if (!activePlan || activePlan.planId !== pendingAutoApproveRef.current) return;

    // Check that the plan annotations have been materialized
    const planAnns = state.annotations.filter(a => a.planId === activePlan.planId && a.type !== 'text');
    if (planAnns.length === 0) return;

    pendingAutoApproveRef.current = null;
    handleApprovePlan();
  }, [activePlan, state.annotations, handleApprovePlan]);

  // Handle plan review events
  useEffect(() => {
    for (const review of bridge.planReviews) {
      if (!activePlan || activePlan.planId !== review.planId) continue;
      if (review.verdict === 'pass') {
        setActivePlan(prev => prev ? { ...prev, status: 'done' } : null);
      }
      // If fail, the plan stays in executing state — could trigger re-work
    }
  }, [bridge.planReviews, activePlan]);

  // Track when all plan workers complete → trigger review
  const reviewTriggeredRef = useRef(new Set<string>());
  useEffect(() => {
    if (!activePlan || activePlan.status !== 'executing') return;
    if (reviewTriggeredRef.current.has(activePlan.planId)) return;

    // Check if any plan-related jobs are still in flight
    const planJobs = Object.entries(inFlightJobs).filter(([_, j]) => j.planId === activePlan.planId);
    if (planJobs.length > 0) return;

    // All workers done — check if there are any plan annotations with resolved/needs_review status
    const planAnnotations = state.annotations.filter(a =>
      a.planId === activePlan.planId && (a.status === 'resolved' || a.status === 'needs_review')
    );
    if (planAnnotations.length === 0) return;

    // Guard against re-triggering
    reviewTriggeredRef.current.add(activePlan.planId);

    // Trigger review pass
    (async () => {
      try {
        setActivePlan(prev => prev ? { ...prev, status: 'reviewing' } : null);
        const screenshotBlob = await captureFullPage(document.body);
        if (!screenshotBlob) return;
        await sendPlanReview(activePlan.planId, screenshotBlob, bridgeUrl, provider, currentModel.id);
      } catch (err) {
        console.error('[Pare] Failed to trigger review:', err);
      }
    })();
  }, [activePlan, inFlightJobs, state.annotations, bridgeUrl, provider, currentModel.id]);

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

  // Mutual exclusion: close thread panel when model/library panel opens
  useEffect(() => {
    if (state.activeTool === 'model' && openThreadId) {
      setOpenThreadId(null);
    }
  }, [state.activeTool]);

  // Find the active jobId for the open thread (for per-job streaming data)
  // Only matches jobs belonging to this thread — no fallback to avoid cross-thread leaking
  const threadActiveJobId = useMemo(() => {
    if (!openThreadId) return null;
    for (const [jobId, job] of Object.entries(inFlightJobs)) {
      if (job.threadId === openThreadId) return jobId;
    }
    return null;
  }, [openThreadId, inFlightJobs]);

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
  }, [bridge.clearEvents]);

  // Cleanup hide timeout
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  const contextValue = useMemo(
    () => ({ isEnabled: enabled }),
    [enabled]
  );

  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <PopmeltContext.Provider value={contextValue}>
      {children}

      <AnnotationCanvas
        state={state}
        dispatch={dispatch}
        onScreenshot={handleScreenshot}
        inFlightAnnotationIds={inFlightAnnotationIds}
        inFlightStyleSelectors={inFlightStyleSelectors}
        inFlightSelectorColors={inFlightSelectorColors}
        onAttachImages={handleAttachImages}
        onReply={bridge.isConnected ? handleReply : undefined}
        onViewThread={bridge.isConnected ? handleViewThread : undefined}
        activePlan={activePlan}
        onModelComponentsAdd={bridge.isConnected ? handleModelComponentsAdd : undefined}
        onModelComponentFocus={bridge.isConnected ? handleModelComponentFocus : undefined}
        onModelComponentHover={setModelCanvasHoveredComponent}
        modelComponentNames={modelComponentNames}
        modelPanelHoveredComponent={modelPanelHoveredComponent}
        modelSpacingTokenHover={modelSpacingTokenHover}
      />

      <AnnotationToolbar
        state={state}
        dispatch={dispatch}
        onScreenshot={handleScreenshot}
        onSendToClaude={bridge.isConnected ? handleSendToClaude : undefined}
        onPlanGoal={bridge.isConnected ? handlePlanGoal : undefined}
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
        isThreadPanelOpen={openThreadId !== null}
        activePlan={activePlan}
        mcpStatus={mcpStatus}
        onInstallMcp={bridge.isConnected ? handleInstallMcp : undefined}
        mcpJustInstalled={mcpJustInstalled}
        bridgeUrl={bridgeUrl}
        modelSelectedComponent={modelSelectedComponent}
        modelCanvasHoveredComponent={modelCanvasHoveredComponent}
        onModelComponentHover={setModelPanelHoveredComponent}
        onSpacingTokenHover={setModelSpacingTokenHover}
        onModifySpacingToken={bridge.isConnected ? handleModifySpacingToken : undefined}
        onDeleteSpacingToken={bridge.isConnected ? handleDeleteSpacingToken : undefined}
        modelRefreshKey={modelRefreshKey}
        onModelComponentAdded={handleModelComponentAdded}
        onModelComponentRemoved={handleModelComponentRemoved}
      />

      {openThreadId && bridge.isConnected && (
        <ThreadPanel
          threadId={openThreadId}
          bridgeUrl={bridgeUrl}
          accentColor={state.annotations.find(a => a.threadId === openThreadId)?.color ?? state.activeColor}
          isStreaming={threadActiveJobId !== null}
          streamingResponse={threadActiveJobId ? (bridge.jobResponses[threadActiveJobId] ?? '') : ''}
          streamingThinking={threadActiveJobId ? (bridge.jobThinking[threadActiveJobId] ?? '') : ''}
          streamingEvents={threadActiveJobId ? bridge.events.filter(e => e.data.jobId === threadActiveJobId) : []}
          onClose={() => setOpenThreadId(null)}
          onReply={handleReply}
          activePlan={activePlan}
          planAnnotations={activePlan ? state.annotations.filter(a => a.planId === activePlan.planId && a.type !== 'text') : undefined}
          inFlightJobs={inFlightJobs}
          onViewThread={handleViewThread}
          onApprovePlan={activePlan?.status === 'awaiting_approval' ? handleApprovePlan : undefined}
          onDismissPlan={activePlan?.status === 'awaiting_approval' ? handleDismissPlan : undefined}
        />
      )}

      {bridge.isConnected && (
        <BridgeEventStack
          bridge={bridge}
          bridgeUrl={bridgeUrl}
          inFlightJobs={inFlightJobs}
          isVisible={eventStreamVisible || bridge.lastResponseText !== null || bridge.activeJobIds.length > 0}
          onHover={handleEventStreamHover}
          clearSignal={clearSignal}
          onReply={handleReply}
        />
      )}
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
