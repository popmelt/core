'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

export type BridgeConnectionState = {
  isConnected: boolean;
  status: 'disconnected' | 'idle' | 'streaming' | 'error';
  currentResponse: string;
  events: BridgeEvent[];
  activeJobId: string | null;
  lastCompletedJobId: string | null;
  lastResponseText: string | null;
  lastThreadId: string | null;
  pendingQuestions: PendingQuestion[];
};

export function useBridgeConnection(bridgeUrl = 'http://localhost:1111') {
  const [state, setState] = useState<BridgeConnectionState>({
    isConnected: false,
    status: 'disconnected',
    currentResponse: '',
    events: [],
    activeJobId: null,
    lastCompletedJobId: null,
    lastResponseText: null,
    lastThreadId: null,
    pendingQuestions: [],
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
      // Check if there's an active job we're reconnecting into
      checkBridgeHealth(bridgeUrl).then((health) => {
        const hasActiveJob = health?.activeJob?.status === 'running';
        setState((prev) => ({
          ...prev,
          isConnected: true,
          status: hasActiveJob ? 'streaming' : 'idle',
          activeJobId: hasActiveJob ? (health.activeJob?.id ?? null) : prev.activeJobId,
        }));
      });
    });

    es.addEventListener('job_started', (e) => {
      const data = JSON.parse(e.data);
      setState((prev) => ({
        ...prev,
        status: 'streaming',
        currentResponse: '',
        lastResponseText: null,
        lastThreadId: null,
        activeJobId: data.jobId,
        events: [
          ...prev.events,
          { type: 'job_started', data, timestamp: Date.now() },
        ],
      }));
    });

    es.addEventListener('delta', (e) => {
      const data = JSON.parse(e.data);
      setState((prev) => ({
        ...prev,
        currentResponse: prev.currentResponse + (data.text || ''),
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
      setState((prev) => ({
        ...prev,
        lastCompletedJobId: data.jobId ?? prev.activeJobId,
        lastResponseText: prev.currentResponse || data.responseText || null,
        lastThreadId: data.threadId ?? null,
        events: [
          ...prev.events,
          { type: 'done', data, timestamp: Date.now() },
        ],
      }));
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

    es.addEventListener('queue_drained', () => {
      setState((prev) => ({
        ...prev,
        status: prev.status === 'error' ? 'error' : 'idle',
        activeJobId: null,
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
        setState((prev) => ({
          ...prev,
          status: 'error',
          lastCompletedJobId: data.jobId ?? prev.activeJobId,
          events: [
            ...prev.events,
            { type: 'error', data, timestamp: Date.now() },
          ],
        }));
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
    setState((prev) => ({ ...prev, events: [], currentResponse: '', lastResponseText: null, lastThreadId: null }));
  }, []);

  const dismissQuestion = useCallback((threadId: string) => {
    setState((prev) => ({
      ...prev,
      pendingQuestions: prev.pendingQuestions.filter(q => q.threadId !== threadId),
    }));
  }, []);

  return { ...state, clearEvents, dismissQuestion };
}
