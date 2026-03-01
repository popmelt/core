'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type { AnnotationResolution } from '../tools/types';
import { checkBridgeHealth, discoverBridge } from '../utils/bridge-client';

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
  lastErrorByJob: Record<string, string>;
  pendingQuestions: PendingQuestion[];
  incrementalResolutions: AnnotationResolution[];
  capabilitiesVersion: number;
};

// ---------------------------------------------------------------------------
// Stable client identity — survives React remounts AND Vite HMR module re-execution
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _hotEarly: { data?: Record<string, unknown> } | undefined = typeof import.meta !== 'undefined' ? (import.meta as any).hot : undefined;

const SOURCE_ID: string =
  (_hotEarly?.data?.sourceId as string) ??
  (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2));

if (_hotEarly?.data) {
  (_hotEarly.data as Record<string, unknown>).sourceId = SOURCE_ID;
}

/** Return this client's stable sourceId (for tagging bridge requests). */
export function getSourceId(): string {
  return SOURCE_ID;
}

// ---------------------------------------------------------------------------
// Module-level singleton store — survives React remounts (HMR, Astro refresh)
//
// Vite HMR can re-execute this module (when any file in its import chain
// changes), which would reset all module-level variables. We use
// import.meta.hot.data to preserve critical state across those reloads.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _hot: { data?: Record<string, unknown> } | undefined = typeof import.meta !== 'undefined' ? (import.meta as any).hot : undefined;
const _hmrData = _hot?.data as Record<string, unknown> | undefined;

const INITIAL_STATE: BridgeConnectionState = {
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
  lastErrorByJob: {},
  pendingQuestions: [],
  incrementalResolutions: [],
  capabilitiesVersion: 0,
};

let store: BridgeConnectionState = (_hmrData?.store as BridgeConnectionState) ?? { ...INITIAL_STATE };
const listeners = (_hmrData?.listeners as Set<() => void>) ?? new Set<() => void>();
let activeEs: EventSource | null = (_hmrData?.activeEs as EventSource | null) ?? null;
let activeBridgeUrl: string | null = (_hmrData?.activeBridgeUrl as string | null) ?? null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectionGeneration = (_hmrData?.connectionGeneration as number) ?? 0;

// Persist state into HMR data so the next module instance can pick it up
if (_hot?.data) {
  // Use getter/setters so the HMR data always reflects the latest values
  Object.defineProperties(_hot.data, {
    store: { get: () => store, configurable: true },
    listeners: { get: () => listeners, configurable: true },
    activeEs: { get: () => activeEs, configurable: true },
    activeBridgeUrl: { get: () => activeBridgeUrl, configurable: true },
    connectionGeneration: { get: () => connectionGeneration, configurable: true },
    discoveredBridgeUrl: { get: () => discoveredBridgeUrl, configurable: true },
  });
}

// ---------------------------------------------------------------------------
// Bridge discovery cache — survives React remounts
// ---------------------------------------------------------------------------

let discoveredBridgeUrl: string | null = (_hmrData?.discoveredBridgeUrl as string | null) ?? null;
let discoveryPromise: Promise<string | null> | null = null;

/**
 * Discover and cache the correct bridge URL for this tab.
 * - Explicit non-default URL → use it directly (user override).
 * - Already discovered → return cached.
 * - Otherwise → run discoverBridge(), cache result.
 */
async function ensureDiscovered(explicitUrl?: string): Promise<string | null> {
  const DEFAULT_URL = 'http://localhost:1111';

  // Explicit non-default URL — user override, skip discovery
  if (explicitUrl && explicitUrl !== DEFAULT_URL) {
    discoveredBridgeUrl = explicitUrl;
    return explicitUrl;
  }

  // Already discovered
  if (discoveredBridgeUrl) return discoveredBridgeUrl;

  // Discovery in progress — await existing promise
  if (discoveryPromise) return discoveryPromise;

  // Run discovery
  discoveryPromise = discoverBridge(explicitUrl).then((result) => {
    discoveredBridgeUrl = result?.url ?? null;
    discoveryPromise = null;
    return discoveredBridgeUrl;
  }).catch(() => {
    discoveryPromise = null;
    return null;
  });

  return discoveryPromise;
}

/** Return the discovered bridge URL (or null if not yet discovered). */
export function getDiscoveredBridgeUrl(): string | null {
  return discoveredBridgeUrl;
}

function getSnapshot(): BridgeConnectionState {
  return store;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function update(updater: (prev: BridgeConnectionState) => BridgeConnectionState) {
  store = updater(store);
  for (const l of listeners) l();
}

function connectBridge(bridgeUrl: string) {
  // Already connected to this URL
  if (activeEs && activeEs.readyState !== EventSource.CLOSED && activeBridgeUrl === bridgeUrl) return;

  // Clean up previous
  if (activeEs) { activeEs.close(); activeEs = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  activeBridgeUrl = bridgeUrl;
  const gen = ++connectionGeneration;
  const es = new EventSource(`${bridgeUrl}/events?sourceId=${SOURCE_ID}`);
  activeEs = es;
  const isStale = () => gen !== connectionGeneration;

  es.addEventListener('connected', () => {
    if (isStale()) return;
    checkBridgeHealth(bridgeUrl).then((health) => {
      if (isStale()) return;
      const activeJobs = health?.activeJobs ?? (health?.activeJob ? [health.activeJob] : []);
      const serverActiveIds = new Set(activeJobs.map((j: { id: string }) => j.id));
      const serverRecentJobs: Array<{ id: string; status: string; error?: string }> =
        (health as Record<string, unknown>)?.recentJobs as Array<{ id: string; status: string; error?: string }> ?? [];
      const recentById = new Map(serverRecentJobs.map(j => [j.id, j]));
      const hasActiveJobs = activeJobs.length > 0;

      update((prev) => {
        // Reconcile: any local active job not in server's active list is stale
        const reconciledErrors: Record<string, string> = { ...prev.lastErrorByJob };
        const staleJobIds = prev.activeJobIds.filter(id => !serverActiveIds.has(id));
        for (const id of staleJobIds) {
          const recent = recentById.get(id);
          if (recent?.status === 'error' && recent.error) {
            reconciledErrors[id] = recent.error;
          }
        }
        const reconciledActiveIds = prev.activeJobIds.filter(id => serverActiveIds.has(id));
        // Also include server active jobs not tracked locally
        for (const id of serverActiveIds) {
          if (!reconciledActiveIds.includes(id)) reconciledActiveIds.push(id);
        }

        return {
          ...prev,
          isConnected: true,
          status: hasActiveJobs ? 'streaming' : (staleJobIds.length > 0 ? 'idle' : (prev.status === 'disconnected' ? 'idle' : prev.status)),
          activeJobId: hasActiveJobs ? activeJobs[activeJobs.length - 1]!.id : (reconciledActiveIds.length > 0 ? reconciledActiveIds[reconciledActiveIds.length - 1]! : null),
          activeJobIds: reconciledActiveIds,
          lastErrorByJob: reconciledErrors,
          lastCompletedJobId: staleJobIds.length > 0 ? staleJobIds[staleJobIds.length - 1]! : prev.lastCompletedJobId,
        };
      });
    });
  });

  es.addEventListener('job_started', (e) => {
    if (isStale()) return;
    const data = JSON.parse(e.data);
    const jobId = data.jobId as string;
    update((prev) => ({
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
    if (isStale()) return;
    const data = JSON.parse(e.data);
    const jobId = data.jobId as string | undefined;
    const text = (data.text || '') as string;
    update((prev) => ({
      ...prev,
      jobResponses: jobId
        ? { ...prev.jobResponses, [jobId]: (prev.jobResponses[jobId] || '') + text }
        : prev.jobResponses,
      currentResponse: (!jobId || jobId === prev.activeJobId)
        ? prev.currentResponse + text
        : prev.currentResponse,
      events: [
        ...prev.events,
        { type: 'delta', data, timestamp: Date.now() },
      ],
    }));
  });

  es.addEventListener('thinking', (e) => {
    if (isStale()) return;
    const data = JSON.parse(e.data);
    const jobId = data.jobId as string | undefined;
    const text = (data.text || '') as string;
    update((prev) => ({
      ...prev,
      jobThinking: jobId
        ? { ...prev.jobThinking, [jobId]: (prev.jobThinking[jobId] || '') + text }
        : prev.jobThinking,
      currentThinking: (!jobId || jobId === prev.activeJobId)
        ? prev.currentThinking + text
        : prev.currentThinking,
      events: [
        ...prev.events,
        { type: 'thinking', data, timestamp: Date.now() },
      ],
    }));
  });

  es.addEventListener('tool_use', (e) => {
    if (isStale()) return;
    const data = JSON.parse(e.data);
    update((prev) => ({
      ...prev,
      events: [
        ...prev.events,
        { type: 'tool_use', data, timestamp: Date.now() },
      ],
    }));
  });

  es.addEventListener('done', (e) => {
    if (isStale()) return;
    const data = JSON.parse(e.data);
    const completedJobId = data.jobId as string | undefined;
    update((prev) => {
      const newActiveJobIds = completedJobId
        ? prev.activeJobIds.filter(id => id !== completedJobId)
        : prev.activeJobIds;

      const newJobResponses = { ...prev.jobResponses };
      const newJobThinking = { ...prev.jobThinking };
      const completedResponse = completedJobId ? newJobResponses[completedJobId] : undefined;
      if (completedJobId) {
        delete newJobResponses[completedJobId];
        delete newJobThinking[completedJobId];
      }

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
    if (isStale()) return;
    const data = JSON.parse(e.data);
    update((prev) => ({
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

  es.addEventListener('capabilities_changed', () => {
    if (isStale()) return;
    update((prev) => ({
      ...prev,
      capabilitiesVersion: prev.capabilitiesVersion + 1,
    }));
  });

  es.addEventListener('queue_drained', () => {
    if (isStale()) return;
    update((prev) => ({
      ...prev,
      status: prev.status === 'error' ? 'error' : 'idle',
      activeJobId: null,
      activeJobIds: [],
      currentResponse: '',
      currentThinking: '',
      jobResponses: {},
      jobThinking: {},
      lastErrorByJob: {},
      incrementalResolutions: [],
    }));
  });

  es.addEventListener('error', (e) => {
    if (isStale()) return;
    if (es.readyState === EventSource.CLOSED) {
      update((prev) => ({
        ...prev,
        isConnected: false,
        status: 'disconnected',
      }));
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectTimer = setTimeout(() => {
        checkBridgeHealth(bridgeUrl).then((status) => {
          if (status) connectBridge(bridgeUrl);
        });
      }, 5000);
    } else if (e instanceof MessageEvent) {
      const data = JSON.parse(e.data);
      const errorJobId = (data.jobId ?? null) as string | null;
      const errorMessage = (data.message ?? '') as string;
      update((prev) => {
        const newActiveJobIds = errorJobId
          ? prev.activeJobIds.filter(id => id !== errorJobId)
          : prev.activeJobIds;
        const newStatus = newActiveJobIds.length > 0 ? prev.status : 'error';
        return {
          ...prev,
          status: newStatus,
          activeJobIds: newActiveJobIds,
          lastCompletedJobId: errorJobId ?? prev.activeJobId,
          lastErrorByJob: errorJobId && errorMessage
            ? { ...prev.lastErrorByJob, [errorJobId]: errorMessage }
            : prev.lastErrorByJob,
          events: [
            ...prev.events,
            { type: 'error', data, timestamp: Date.now() },
          ],
        };
      });
    }
  });

  es.onerror = () => {
    if (isStale()) return;
    if (es.readyState === EventSource.CLOSED) {
      update((prev) => ({
        ...prev,
        isConnected: false,
        status: 'disconnected',
      }));
    }
  };
}

// ---------------------------------------------------------------------------
// React hook — thin wrapper over module-level store
// ---------------------------------------------------------------------------

export function useBridgeConnection(bridgeUrl = 'http://localhost:1111') {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Connect on mount — discover the correct port first
  useEffect(() => {
    ensureDiscovered(bridgeUrl).then((url) => {
      if (!url) return;
      checkBridgeHealth(url).then((status) => {
        if (status) connectBridge(url);
      });
    });
  }, [bridgeUrl]);

  const clearEvents = useCallback(() => {
    update(() => ({
      ...store,
      events: [],
      currentResponse: '',
      currentThinking: '',
      jobResponses: {},
      jobThinking: {},
      lastResponseText: null,
      lastThreadId: null,
      lastErrorByJob: {},
      incrementalResolutions: [],
    }));
  }, []);

  const dismissQuestion = useCallback((threadId: string) => {
    update((prev) => ({
      ...prev,
      pendingQuestions: prev.pendingQuestions.filter(q => q.threadId !== threadId),
    }));
  }, []);

  return { ...state, clearEvents, dismissQuestion };
}
