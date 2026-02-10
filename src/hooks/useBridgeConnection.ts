'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AnnotationResolution } from '../tools/types';
import { checkBridgeHealth } from '../utils/bridge-client';

export type BridgeEvent = {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
};

export type PendingQuestion = {
  jobId: string;
  threadId: string;
  question: string;
  annotationIds?: string[];
  timestamp: number;
};

export type PendingPlan = {
  jobId: string;
  planId: string;
  tasks: { id: string; instruction: string; region: { x: number; y: number; width: number; height: number }; priority?: number }[];
  threadId?: string;
  timestamp: number;
};

export type PlanReviewResult = {
  planId: string;
  verdict: 'pass' | 'fail';
  summary: string;
  issues?: string[];
  timestamp: number;
};

export type BridgeConnectionState = {
  isConnected: boolean;
  status: 'disconnected' | 'idle' | 'streaming' | 'error';
  // Per-job streaming accumulators
  jobResponses: Record<string, string>;
  jobThinking: Record<string, string>;
  activeJobIds: string[];
  // Backward-compat single-job fields (track most recently started job)
  currentResponse: string;
  currentThinking: string;
  activeJobId: string | null;
  events: BridgeEvent[];
  lastCompletedJobId: string | null;
  lastResponseText: string | null;
  lastThreadId: string | null;
  pendingQuestions: PendingQuestion[];
  pendingPlans: PendingPlan[];
  planReviews: PlanReviewResult[];
  incrementalResolutions: AnnotationResolution[];
};

export function useBridgeConnection(bridgeUrl = 'http://localhost:1111') {
  const [state, setState] = useState<BridgeConnectionState>({
    isConnected: false,
    status: 'disconnected',
    jobResponses: {},
    jobThinking: {},
    activeJobIds: [],
    currentResponse: '',
    currentThinking: '',
    events: [],
    activeJobId: null,
    lastCompletedJobId: null,
    lastResponseText: null,
    lastThreadId: null,
    pendingQuestions: [],
    pendingPlans: [],
    planReviews: [],
    incrementalResolutions: [],
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const es = new EventSource(`${bridgeUrl}/events`);
    eventSourceRef.current = es;

    es.addEventListener('connected', () => {
      checkBridgeHealth(bridgeUrl).then((health) => {
        const activeJobs = health?.activeJobs ?? (health?.activeJob ? [health.activeJob] : []);
        const hasActiveJobs = activeJobs.length > 0;
        setState((prev) => ({
          ...prev,
          isConnected: true,
          status: hasActiveJobs ? 'streaming' : 'idle',
          activeJobId: hasActiveJobs ? activeJobs[activeJobs.length - 1]!.id : prev.activeJobId,
          activeJobIds: activeJobs.map(j => j.id),
        }));
      });
    });

    es.addEventListener('job_started', (e) => {
      const data = JSON.parse(e.data);
      const jobId = data.jobId as string;
      setState((prev) => ({
        ...prev,
        status: 'streaming',
        activeJobId: jobId,
        activeJobIds: [...prev.activeJobIds, jobId],
        jobResponses: { ...prev.jobResponses, [jobId]: '' },
        jobThinking: { ...prev.jobThinking, [jobId]: '' },
        currentResponse: '',
        currentThinking: '',
        lastResponseText: null,
        lastThreadId: null,
        events: [
          ...prev.events,
          { type: 'job_started', data, timestamp: Date.now() },
        ],
      }));
    });

    es.addEventListener('delta', (e) => {
      const data = JSON.parse(e.data);
      const jobId = data.jobId as string | undefined;
      const text = (data.text || '') as string;
      setState((prev) => ({
        ...prev,
        jobResponses: jobId
          ? { ...prev.jobResponses, [jobId]: (prev.jobResponses[jobId] || '') + text }
          : prev.jobResponses,
        currentResponse: (!jobId || jobId === prev.activeJobId)
          ? prev.currentResponse + text
          : prev.currentResponse,
      }));
    });

    es.addEventListener('thinking', (e) => {
      const data = JSON.parse(e.data);
      const jobId = data.jobId as string | undefined;
      const text = (data.text || '') as string;
      setState((prev) => ({
        ...prev,
        jobThinking: jobId
          ? { ...prev.jobThinking, [jobId]: (prev.jobThinking[jobId] || '') + text }
          : prev.jobThinking,
        currentThinking: (!jobId || jobId === prev.activeJobId)
          ? prev.currentThinking + text
          : prev.currentThinking,
      }));
    });

    es.addEventListener('tool_use', (e) => {
      const data = JSON.parse(e.data);
      setState((prev) => ({
        ...prev,
        events: [
          ...prev.events,
          { type: 'tool_use', data, timestamp: Date.now() },
        ],
      }));
    });

    es.addEventListener('done', (e) => {
      const data = JSON.parse(e.data);
      const completedJobId = data.jobId as string | undefined;
      setState((prev) => {
        const newActiveJobIds = completedJobId
          ? prev.activeJobIds.filter(id => id !== completedJobId)
          : prev.activeJobIds;

        // Clean up per-job accumulators
        const newJobResponses = { ...prev.jobResponses };
        const newJobThinking = { ...prev.jobThinking };
        const completedResponse = completedJobId ? newJobResponses[completedJobId] : undefined;
        if (completedJobId) {
          delete newJobResponses[completedJobId];
          delete newJobThinking[completedJobId];
        }

        // Update compat activeJobId if the completed job was the tracked one
        const newActiveJobId = completedJobId === prev.activeJobId
          ? (newActiveJobIds.length > 0 ? newActiveJobIds[newActiveJobIds.length - 1]! : null)
          : prev.activeJobId;

        return {
          ...prev,
          activeJobIds: newActiveJobIds,
          activeJobId: newActiveJobId,
          jobResponses: newJobResponses,
          jobThinking: newJobThinking,
          lastCompletedJobId: completedJobId ?? prev.activeJobId,
          lastResponseText: completedResponse || prev.currentResponse || data.responseText || null,
          lastThreadId: data.threadId ?? null,
          // Reset compat response if the completed job was the active one
          ...(completedJobId === prev.activeJobId ? {
            currentResponse: newActiveJobId ? (newJobResponses[newActiveJobId] || '') : '',
            currentThinking: newActiveJobId ? (newJobThinking[newActiveJobId] || '') : '',
          } : {}),
          events: [
            ...prev.events,
            { type: 'done', data, timestamp: Date.now() },
          ],
        };
      });
    });

    es.addEventListener('question', (e) => {
      const data = JSON.parse(e.data);
      setState((prev) => ({
        ...prev,
        pendingQuestions: [
          ...prev.pendingQuestions,
          {
            jobId: data.jobId,
            threadId: data.threadId,
            question: data.question,
            annotationIds: data.annotationIds,
            timestamp: Date.now(),
          },
        ],
        events: [
          ...prev.events,
          { type: 'question', data, timestamp: Date.now() },
        ],
      }));
    });

    es.addEventListener('plan_ready', (e) => {
      const data = JSON.parse(e.data);
      setState((prev) => ({
        ...prev,
        pendingPlans: [
          ...prev.pendingPlans,
          {
            jobId: data.jobId,
            planId: data.planId,
            tasks: data.tasks,
            threadId: data.threadId,
            timestamp: Date.now(),
          },
        ],
        events: [
          ...prev.events,
          { type: 'plan_ready', data, timestamp: Date.now() },
        ],
      }));
    });

    es.addEventListener('plan_review', (e) => {
      const data = JSON.parse(e.data);
      setState((prev) => ({
        ...prev,
        planReviews: [
          ...prev.planReviews,
          {
            planId: data.planId,
            verdict: data.verdict,
            summary: data.summary,
            issues: data.issues,
            timestamp: Date.now(),
          },
        ],
        events: [
          ...prev.events,
          { type: 'plan_review', data, timestamp: Date.now() },
        ],
      }));
    });

    es.addEventListener('task_resolved', (e) => {
      const data = JSON.parse(e.data);
      const resolutions = (data.resolutions ?? []) as AnnotationResolution[];
      setState((prev) => ({
        ...prev,
        incrementalResolutions: [...prev.incrementalResolutions, ...resolutions],
        events: [
          ...prev.events,
          { type: 'task_resolved', data, timestamp: Date.now() },
        ],
      }));
    });

    es.addEventListener('queue_drained', () => {
      setState((prev) => ({
        ...prev,
        status: prev.status === 'error' ? 'error' : 'idle',
        activeJobId: null,
        activeJobIds: [],
        currentResponse: '',
        currentThinking: '',
        jobResponses: {},
        jobThinking: {},
        incrementalResolutions: [],
      }));
    });

    es.addEventListener('error', (e) => {
      // SSE errors can be reconnection attempts or actual errors
      if (es.readyState === EventSource.CLOSED) {
        setState((prev) => ({
          ...prev,
          isConnected: false,
          status: 'disconnected',
        }));
        // Try to reconnect after a delay
        reconnectTimerRef.current = setTimeout(() => {
          checkBridgeHealth(bridgeUrl).then((status) => {
            if (status) connect();
          });
        }, 5000);
      } else if (e instanceof MessageEvent) {
        const data = JSON.parse(e.data);
        const errorJobId = (data.jobId ?? null) as string | null;
        setState((prev) => {
          const newActiveJobIds = errorJobId
            ? prev.activeJobIds.filter(id => id !== errorJobId)
            : prev.activeJobIds;

          // Only set status to error if no other jobs are running
          const newStatus = newActiveJobIds.length > 0 ? prev.status : 'error';

          return {
            ...prev,
            status: newStatus,
            activeJobIds: newActiveJobIds,
            lastCompletedJobId: errorJobId ?? prev.activeJobId,
            events: [
              ...prev.events,
              { type: 'error', data, timestamp: Date.now() },
            ],
          };
        });
      }
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setState((prev) => ({
          ...prev,
          isConnected: false,
          status: 'disconnected',
        }));
      }
    };
  }, [bridgeUrl]);

  // Check health on mount, connect if available
  useEffect(() => {
    checkBridgeHealth(bridgeUrl).then((status) => {
      if (status) {
        connect();
      }
    });

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [bridgeUrl, connect]);

  const clearEvents = useCallback(() => {
    setState((prev) => ({
      ...prev,
      events: [],
      currentResponse: '',
      currentThinking: '',
      jobResponses: {},
      jobThinking: {},
      lastResponseText: null,
      lastThreadId: null,
      incrementalResolutions: [],
    }));
  }, []);

  const dismissQuestion = useCallback((threadId: string) => {
    setState((prev) => ({
      ...prev,
      pendingQuestions: prev.pendingQuestions.filter(q => q.threadId !== threadId),
    }));
  }, []);

  const dismissPlan = useCallback((planId: string) => {
    setState((prev) => ({
      ...prev,
      pendingPlans: prev.pendingPlans.filter(p => p.planId !== planId),
    }));
  }, []);

  return { ...state, clearEvents, dismissQuestion, dismissPlan };
}
