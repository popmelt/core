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
import type { AnnotationResolution } from '../tools/types';
import { FONT_FAMILY } from '../tools/text';
import { approvePlan, sendPlanReview, sendPlanToBridge, sendReplyToBridge, sendToBridge } from '../utils/bridge-client';
import { resolveRegionToElement } from '../utils/dom';
import { buildFeedbackData, captureFullPage, captureScreenshot, copyToClipboard, cssColorToHex, stitchBlobs } from '../utils/screenshot';
import { AnnotationCanvas } from './AnnotationCanvas';
import { AnnotationToolbar } from './AnnotationToolbar';
import { BridgeEventStack } from './BridgeStatusPanel';
import { ThreadPanel } from './ThreadPanel';

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
const MODEL_STORAGE_KEY = 'devtools-model';

// Model definitions per provider
const CLAUDE_MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonn 4.5' },
] as const;

const CODEX_MODELS = [
  { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
  { id: 'gpt-5.1-codex-mini', label: 'Mini 5.1' },
] as const;

export const MODEL_MAP = { claude: CLAUDE_MODELS, codex: CODEX_MODELS } as const;

// Cross-provider equivalence: index 0 = fast, index 1 = thorough
function equivalentModelIndex(fromProvider: string, toProvider: string, currentIndex: number): number {
  const fromModels = fromProvider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
  const toModels = toProvider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
  return Math.min(currentIndex, toModels.length - 1);
}

function PlanApprovalBar({ taskCount, onApprove, onDismiss }: {
  taskCount: number;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-devtools="plan-approval-bar"
      style={{
        position: 'fixed',
        bottom: 72,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        backgroundColor: '#ffffff',
        border: '1px solid rgba(0, 0, 0, 0.1)',
        zIndex: 10001,
        fontFamily: FONT_FAMILY,
        fontSize: 12,
        color: '#1f2937',
      }}
    >
      <span style={{ fontWeight: 600 }}>
        {taskCount} task{taskCount !== 1 ? 's' : ''} planned
      </span>
      <span style={{ color: '#6b7280' }}>
        Review annotations, then approve to start workers
      </span>
      <button
        onClick={onApprove}
        style={{
          padding: '4px 14px',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: FONT_FAMILY,
          backgroundColor: '#1f2937',
          color: '#ffffff',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        Approve
      </button>
      <button
        onClick={onDismiss}
        style={{
          padding: '4px 14px',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: FONT_FAMILY,
          backgroundColor: 'transparent',
          color: '#6b7280',
          border: '1px solid rgba(0, 0, 0, 0.1)',
          cursor: 'pointer',
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

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
  const [modelIndex, setModelIndex] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const saved = localStorage.getItem(MODEL_STORAGE_KEY);
    return saved ? parseInt(saved, 10) || 0 : 0;
  });

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
  // Thread panel state (declared early so callbacks can reference setOpenThreadId)
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  // Active plan state
  const [activePlan, setActivePlan] = useState<{
    planId: string;
    threadId?: string;
    goal: string;
    tasks?: PendingPlan['tasks'];
    status: 'planning' | 'awaiting_approval' | 'executing' | 'reviewing' | 'done';
  } | null>(null);

  // Per-job in-flight tracking: jobId → { annotationIds, styleSelectors, color, threadId }
  const [inFlightJobs, setInFlightJobs] = useState<Map<string, { annotationIds: Set<string>; styleSelectors: Set<string>; color: string; threadId?: string; planId?: string }>>(new Map());

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
        payload: {
          resolutions: latestDone.data.resolutions as AnnotationResolution[],
          threadId: latestDone.data.threadId as string | undefined,
        },
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

  // Plan goal handler: captures full-page screenshot and sends to planner
  const handlePlanGoal = useCallback(async (goal: string): Promise<boolean> => {
    try {
      const screenshotBlob = await captureFullPage(document.body);
      if (!screenshotBlob) return false;

      const { planId, threadId } = await sendPlanToBridge(
        screenshotBlob,
        goal,
        bridgeUrl,
        provider,
        currentModel.id,
        window.location.href,
        { width: window.innerWidth, height: window.innerHeight },
      );

      setActivePlan({
        planId,
        threadId,
        goal,
        status: 'planning',
      });

      // Open thread panel to show planner streaming
      if (threadId) setOpenThreadId(threadId);

      return true;
    } catch (err) {
      console.error('[DevTools] Failed to send plan:', err);
      return false;
    }
  }, [bridgeUrl, provider, currentModel.id]);

  // Materialize plan tasks as annotations on the canvas
  const materializePlan = useCallback(async (tasks: PendingPlan['tasks']) => {
    const planId = activePlan?.planId;
    if (!planId) return;

    // Stagger annotation creation for visual effect
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;

      // Scroll the region into view
      const regionCenterY = task.region.y + task.region.height / 2;
      const viewportH = window.innerHeight;
      if (regionCenterY < window.scrollY || regionCenterY > window.scrollY + viewportH) {
        window.scrollTo({
          top: Math.max(0, regionCenterY - viewportH / 2),
          behavior: 'smooth',
        });
        // Wait for scroll to settle
        await new Promise(r => setTimeout(r, 300));
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
          color: state.activeColor,
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

  const handleSendToClaude = useCallback(async (): Promise<boolean> => {
    const canvas = document.getElementById('devtools-canvas') as HTMLCanvasElement | null;
    if (!canvas) return false;

    // Detect planner mode: no pending annotations = planner goal
    const activeAnnotations = state.annotations.filter(a => (a.status ?? 'pending') === 'pending');
    if (activeAnnotations.length === 0 && state.styleModifications.filter(m => !m.captured).length === 0) {
      // No annotations or style changes — this is handled by the toolbar goal input
      return false;
    }

    // Capture screenshot
    const blobs = await captureScreenshot(document.body, canvas, state.annotations);
    if (blobs.length === 0) return false;

    // Stitch into single image
    const stitchedBlob = await stitchBlobs(blobs);
    if (!stitchedBlob) return false;

    // Build feedback data
    const feedbackData = buildFeedbackData(activeAnnotations, state.styleModifications);
    const feedbackJson = JSON.stringify(feedbackData);

    // Send to bridge
    try {
      const hexColor = cssColorToHex(state.activeColor);
      const { jobId, threadId: assignedThreadId } = await sendToBridge(stitchedBlob, feedbackJson, bridgeUrl, hexColor, provider, currentModel.id);

      // Track which annotations and style modifications are in-flight for this job
      const sentAnnotationIds = new Set(activeAnnotations.map(a => a.id));
      const sentStyleSelectors = new Set(
        state.styleModifications.filter(m => !m.captured).map(m => m.selector)
      );
      setInFlightJobs((prev) => new Map(prev).set(jobId, {
        annotationIds: sentAnnotationIds,
        styleSelectors: sentStyleSelectors,
        color: state.activeColor,
        threadId: assignedThreadId,
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
  }, [state.annotations, state.styleModifications, state.activeColor, dispatch, bridgeUrl, provider, currentModel.id]);

  // Handle reply to a question from Claude
  const handleReply = useCallback(async (threadId: string, reply: string) => {
    try {
      const hexColor = cssColorToHex(state.activeColor);
      const { jobId } = await sendReplyToBridge(threadId, reply, bridgeUrl, hexColor, provider, currentModel.id);

      // Track the new continuation job (no specific annotations — reuses thread context)
      setInFlightJobs(prev => new Map(prev).set(jobId, {
        annotationIds: new Set<string>(),
        styleSelectors: new Set<string>(),
        color: state.activeColor,
        threadId,
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
          const job = prev.get(jobId);
          if (job) {
            for (const a of threadAnnotations) job.annotationIds.add(a.id);
          }
          return new Map(prev);
        });
      }

      bridge.dismissQuestion(threadId);
    } catch (err) {
      console.error('[DevTools] Failed to send reply:', err);
    }
  }, [state.activeColor, state.annotations, bridgeUrl, bridge.dismissQuestion, dispatch, provider, currentModel.id]);

  // Handle plan approval: dispatch workers for each approved annotation
  const handleApprovePlan = useCallback(async () => {
    if (!activePlan || !activePlan.planId) return;

    try {
      // Approve on server side
      await approvePlan(activePlan.planId, bridgeUrl);

      setActivePlan(prev => prev ? { ...prev, status: 'executing' } : null);

      // Collect plan annotations that are still pending (user may have deleted some)
      const planAnnotations = state.annotations.filter(
        a => a.planId === activePlan.planId && a.type !== 'text' && (a.status ?? 'pending') === 'pending'
      );

      const canvas = document.getElementById('devtools-canvas') as HTMLCanvasElement | null;
      if (!canvas) return;

      // Send each annotation as a worker job
      for (const ann of planAnnotations) {
        const blobs = await captureScreenshot(document.body, canvas, [ann]);
        if (blobs.length === 0) continue;

        const stitchedBlob = await stitchBlobs(blobs);
        if (!stitchedBlob) continue;

        const feedbackData = buildFeedbackData([ann], []);
        const feedbackJson = JSON.stringify(feedbackData);
        const hexColor = cssColorToHex(ann.color);

        const { jobId, threadId: assignedThreadId } = await sendToBridge(
          stitchedBlob, feedbackJson, bridgeUrl, hexColor, provider, currentModel.id
        );

        // Track in-flight
        setInFlightJobs(prev => new Map(prev).set(jobId, {
          annotationIds: new Set([ann.id]),
          styleSelectors: new Set<string>(),
          color: ann.color,
          threadId: assignedThreadId,
          planId: activePlan.planId,
        }));

        // Mark annotation as in-flight
        dispatch({
          type: 'SET_ANNOTATION_STATUS',
          payload: { ids: [ann.id], status: 'in_flight' },
        });
      }

      dispatch({ type: 'MARK_CAPTURED' });

    } catch (err) {
      console.error('[DevTools] Failed to approve plan:', err);
    }
  }, [activePlan, state.annotations, bridgeUrl, provider, currentModel.id, dispatch]);

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
    const planJobs = Array.from(inFlightJobs.entries()).filter(([_, j]) => j.planId === activePlan.planId);
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
        console.error('[DevTools] Failed to trigger review:', err);
      }
    })();
  }, [activePlan, inFlightJobs, state.annotations, bridgeUrl, provider, currentModel.id]);

  // Compute the active job's annotation color for the toolbar spinner
  const activeJobColor = useMemo(() => {
    if (bridge.activeJobId && inFlightJobs.has(bridge.activeJobId)) {
      return inFlightJobs.get(bridge.activeJobId)!.color;
    }
    const entries = Array.from(inFlightJobs.values());
    return entries.length > 0 ? entries[entries.length - 1]!.color : undefined;
  }, [bridge.activeJobId, inFlightJobs]);

  const handleViewThread = useCallback((threadId: string) => {
    setOpenThreadId(threadId);
  }, []);

  // Find the active jobId for the open thread (for per-job streaming data)
  // Falls back to any active job so the panel always shows current activity
  const threadActiveJobId = useMemo(() => {
    if (!openThreadId) return null;
    // Prefer the job matched to this thread
    for (const [jobId, job] of inFlightJobs) {
      if (job.threadId === openThreadId) return jobId;
    }
    // Fall back to any active job so tool activity still shows in the panel
    if (bridge.activeJobIds.length > 0) {
      return bridge.activeJobIds[bridge.activeJobIds.length - 1]!;
    }
    return null;
  }, [openThreadId, inFlightJobs, bridge.activeJobIds]);

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
        onViewThread={bridge.isConnected ? handleViewThread : undefined}
        isThreadPanelOpen={openThreadId !== null}
      />

      <AnnotationToolbar
        state={state}
        dispatch={dispatch}
        onScreenshot={handleScreenshot}
        onSendToClaude={bridge.isConnected ? handleSendToClaude : undefined}
        onPlanGoal={bridge.isConnected ? handlePlanGoal : undefined}
        hasActiveJobs={inFlightJobs.size > 0 || bridge.activeJobIds.length > 0}
        activeJobColor={activeJobColor}
        onCrosshairHover={handleEventStreamHover}
        onClear={handleClearEventStream}
        provider={provider}
        onProviderChange={bridge.isConnected ? handleProviderChange : undefined}
        modelIndex={modelIndex}
        modelCount={models.length}
        modelLabel={currentModel.label}
        onModelChange={bridge.isConnected ? handleModelChange : undefined}
        onViewThread={bridge.isConnected ? handleViewThread : undefined}
        isThreadPanelOpen={openThreadId !== null}
        activePlan={activePlan}
      />

      {/* Plan approval bar */}
      {activePlan?.status === 'awaiting_approval' && (
        <PlanApprovalBar
          taskCount={activePlan.tasks?.length ?? 0}
          onApprove={handleApprovePlan}
          onDismiss={handleDismissPlan}
        />
      )}

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
