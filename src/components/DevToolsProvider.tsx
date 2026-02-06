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

import { useBridgeConnection } from '../hooks/useBridgeConnection';
import { useAnnotationState } from '../hooks/useAnnotationState';
import type { AnnotationResolution } from '../tools/types';
import { sendReplyToBridge, sendToBridge } from '../utils/bridge-client';
import { buildFeedbackData, captureScreenshot, copyToClipboard, cssColorToHex, stitchBlobs } from '../utils/screenshot';
import { AnnotationCanvas } from './AnnotationCanvas';
import { AnnotationToolbar } from './AnnotationToolbar';
import { BridgeEventStack } from './BridgeStatusPanel';

type DevToolsContextValue = {
  isEnabled: boolean;
};

const DevToolsContext = createContext<DevToolsContextValue | null>(null);

type DevToolsProviderProps = PropsWithChildren<{
  enabled?: boolean;
  bridgeUrl?: string;
}>;

const DEFAULT_BRIDGE_URL = 'http://localhost:1111';
const PROVIDER_STORAGE_KEY = 'devtools-provider';

export function DevToolsProvider({
  children,
  enabled = process.env.NODE_ENV === 'development',
  bridgeUrl = DEFAULT_BRIDGE_URL,
}: DevToolsProviderProps) {
  const [state, dispatch] = useAnnotationState();
  const bridge = useBridgeConnection(bridgeUrl);
  const [provider, setProvider] = useState<string>(() => {
    if (typeof window === 'undefined') return 'claude';
    return localStorage.getItem(PROVIDER_STORAGE_KEY) || 'claude';
  });

  const handleProviderChange = useCallback((newProvider: string) => {
    setProvider(newProvider);
    localStorage.setItem(PROVIDER_STORAGE_KEY, newProvider);
  }, []);
  // Per-job in-flight tracking: jobId → { annotationIds, styleSelectors }
  const [inFlightJobs, setInFlightJobs] = useState<Map<string, { annotationIds: Set<string>; styleSelectors: Set<string>; color: string }>>(new Map());

  // Flatten all in-flight annotation IDs and style selectors for the canvas
  const inFlightAnnotationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const job of inFlightJobs.values()) {
      for (const id of job.annotationIds) ids.add(id);
    }
    return ids;
  }, [inFlightJobs]);

  const inFlightStyleSelectors = useMemo(() => {
    const selectors = new Set<string>();
    for (const job of inFlightJobs.values()) {
      for (const sel of job.styleSelectors) selectors.add(sel);
    }
    return selectors;
  }, [inFlightJobs]);

  // Map each in-flight selector to its job's annotation color (for marching ants borders)
  // Includes both style modification selectors and linked annotation selectors
  const inFlightSelectorColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of inFlightJobs.values()) {
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
      if (inFlightJobsRef.current.size > 0) return;

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
    if (bridge.lastCompletedJobId && inFlightJobs.has(bridge.lastCompletedJobId)) {
      setInFlightJobs((prev) => {
        const next = new Map(prev);
        next.delete(bridge.lastCompletedJobId!);
        return next;
      });
    }
  }, [bridge.lastCompletedJobId]);

  // Handle resolutions from done events
  useEffect(() => {
    const doneEvents = bridge.events.filter(e => e.type === 'done' && e.data.resolutions);
    if (doneEvents.length === 0) return;

    const latestDone = doneEvents[doneEvents.length - 1];
    if (latestDone && Array.isArray(latestDone.data.resolutions)) {
      dispatch({
        type: 'APPLY_RESOLUTIONS',
        payload: { resolutions: latestDone.data.resolutions as AnnotationResolution[] },
      });
    }
  }, [bridge.events, dispatch]);

  // On reconnect to idle bridge, clear any stale in-flight state
  const prevBridgeStatus = useRef(bridge.status);
  useEffect(() => {
    const prev = prevBridgeStatus.current;
    prevBridgeStatus.current = bridge.status;

    if (prev === 'disconnected' && bridge.status === 'idle') {
      setInFlightJobs(new Map());
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

  const handleSendToClaude = useCallback(async (): Promise<boolean> => {
    const canvas = document.getElementById('devtools-canvas') as HTMLCanvasElement | null;
    if (!canvas) return false;

    // Capture screenshot
    const blobs = await captureScreenshot(document.body, canvas, state.annotations);
    if (blobs.length === 0) return false;

    // Stitch into single image
    const stitchedBlob = await stitchBlobs(blobs);
    if (!stitchedBlob) return false;

    // Build feedback data
    const activeAnnotations = state.annotations.filter(a => (a.status ?? 'pending') === 'pending');
    const feedbackData = buildFeedbackData(activeAnnotations, state.styleModifications);
    const feedbackJson = JSON.stringify(feedbackData);

    // Send to bridge
    try {
      const hexColor = cssColorToHex(state.activeColor);
      const { jobId } = await sendToBridge(stitchedBlob, feedbackJson, bridgeUrl, hexColor, provider);

      // Track which annotations and style modifications are in-flight for this job
      const sentAnnotationIds = new Set(activeAnnotations.map(a => a.id));
      const sentStyleSelectors = new Set(
        state.styleModifications.filter(m => !m.captured).map(m => m.selector)
      );
      setInFlightJobs((prev) => new Map(prev).set(jobId, {
        annotationIds: sentAnnotationIds,
        styleSelectors: sentStyleSelectors,
        color: state.activeColor,
      }));

      dispatch({ type: 'MARK_CAPTURED' });

      // Shift hue by ~60° for next round so successive iterations are visually distinct
      const hueMatch = state.activeColor.match(/oklch\([^)]*\s+([\d.]+)\s*\)/);
      const currentHue = hueMatch?.[1] ? parseFloat(hueMatch[1]) : 29;
      const nextHue = (currentHue + 60) % 360;
      dispatch({ type: 'SET_COLOR', payload: `oklch(0.628 0.258 ${nextHue})` });

      return true;
    } catch (err) {
      console.error('[DevTools] Failed to send to bridge:', err);
      return false;
    }
  }, [state.annotations, state.styleModifications, state.activeColor, dispatch, bridgeUrl, provider]);

  // Handle reply to a question from Claude
  const handleReply = useCallback(async (threadId: string, reply: string) => {
    try {
      const hexColor = cssColorToHex(state.activeColor);
      const { jobId } = await sendReplyToBridge(threadId, reply, bridgeUrl, hexColor, provider);

      // Track the new continuation job (no specific annotations — reuses thread context)
      setInFlightJobs(prev => new Map(prev).set(jobId, {
        annotationIds: new Set<string>(),
        styleSelectors: new Set<string>(),
        color: state.activeColor,
      }));

      // Transition annotations back to in_flight
      const waitingAnnotations = state.annotations.filter(
        a => a.threadId === threadId && a.status === 'waiting_input'
      );
      if (waitingAnnotations.length > 0) {
        dispatch({
          type: 'SET_ANNOTATION_STATUS',
          payload: { ids: waitingAnnotations.map(a => a.id), status: 'in_flight' },
        });
        // Re-track them as in-flight for the new job
        setInFlightJobs(prev => {
          const job = prev.get(jobId);
          if (job) {
            for (const a of waitingAnnotations) job.annotationIds.add(a.id);
          }
          return new Map(prev);
        });
      }

      bridge.dismissQuestion(threadId);
    } catch (err) {
      console.error('[DevTools] Failed to send reply:', err);
    }
  }, [state.activeColor, state.annotations, bridgeUrl, bridge.dismissQuestion, dispatch, provider]);

  // Handle question events from bridge → dispatch SET_ANNOTATION_QUESTION
  const processedQuestionJobIdsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const q of bridge.pendingQuestions) {
      if (processedQuestionJobIdsRef.current.has(q.jobId)) continue;
      processedQuestionJobIdsRef.current.add(q.jobId);

      if (q.annotationIds && q.annotationIds.length > 0) {
        dispatch({
          type: 'SET_ANNOTATION_QUESTION',
          payload: {
            ids: q.annotationIds,
            question: q.question,
            threadId: q.threadId,
          },
        });
      }
    }
  }, [bridge.pendingQuestions, dispatch]);

  // Compute the active job's annotation color for the toolbar spinner
  const activeJobColor = useMemo(() => {
    if (bridge.activeJobId && inFlightJobs.has(bridge.activeJobId)) {
      return inFlightJobs.get(bridge.activeJobId)!.color;
    }
    const entries = Array.from(inFlightJobs.values());
    return entries.length > 0 ? entries[entries.length - 1]!.color : undefined;
  }, [bridge.activeJobId, inFlightJobs]);

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
    <DevToolsContext.Provider value={contextValue}>
      {children}

      <AnnotationCanvas
        state={state}
        dispatch={dispatch}
        onScreenshot={handleScreenshot}
        inFlightAnnotationIds={inFlightAnnotationIds}
        inFlightStyleSelectors={inFlightStyleSelectors}
        inFlightSelectorColors={inFlightSelectorColors}
        onReply={bridge.isConnected ? handleReply : undefined}
      />

      <AnnotationToolbar
        state={state}
        dispatch={dispatch}
        onScreenshot={handleScreenshot}
        onSendToClaude={bridge.isConnected ? handleSendToClaude : undefined}
        hasActiveJobs={inFlightJobs.size > 0 || bridge.status === 'streaming'}
        activeJobColor={activeJobColor}
        onCrosshairHover={handleEventStreamHover}
        onClear={handleClearEventStream}
        provider={provider}
        onProviderChange={bridge.isConnected ? handleProviderChange : undefined}
      />

      {bridge.isConnected && (
        <BridgeEventStack
          bridge={bridge}
          bridgeUrl={bridgeUrl}
          inFlightJobs={inFlightJobs}
          isVisible={eventStreamVisible || bridge.lastResponseText !== null || bridge.status === 'streaming'}
          onHover={handleEventStreamHover}
          clearSignal={clearSignal}
          onReply={handleReply}
        />
      )}
    </DevToolsContext.Provider>
  );
}

export function useDevTools() {
  const ctx = useContext(DevToolsContext);
  if (!ctx) {
    throw new Error('useDevTools must be used within DevToolsProvider');
  }
  return ctx;
}
