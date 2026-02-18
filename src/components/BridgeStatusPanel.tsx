'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { BridgeConnectionState } from '../hooks/useBridgeConnection';
import { POPMELT_BORDER } from '../styles/border';

type InFlightJob = {
  annotationIds: string[];
  styleSelectors: string[];
  color: string;
  threadId?: string;
};

type BridgeEventStackProps = {
  bridge: BridgeConnectionState & { clearEvents: () => void };
  bridgeUrl: string;
  inFlightJobs: Record<string, InFlightJob>;
  isVisible: boolean;
  onHover: (hovering: boolean) => void;
  clearSignal: number;
  onReply?: (threadId: string, reply: string) => void;
  onViewThread?: (threadId: string) => void;
};

type StreamEntry = {
  jobId: string;
  color: string;
  status: 'working' | 'queued' | 'done' | 'error';
  doneLabel?: string;
  threadId?: string;
};

const stackContainerStyle: CSSProperties = {
  position: 'fixed',
  bottom: 70,
  right: 16,
  zIndex: 9999,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  backgroundColor: 'rgba(255, 255, 255, 0.85)',
  ...POPMELT_BORDER,
  backdropFilter: 'blur(32px)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  color: '#1f2937',
  whiteSpace: 'nowrap' as const,
  transition: 'transform 200ms ease, opacity 200ms ease',
};

function formatStepText(events: BridgeConnectionState['events']): string {
  const toolEvents = events.filter((e) => e.type === 'tool_use');
  if (toolEvents.length === 0) return 'Starting…';

  const last = toolEvents[toolEvents.length - 1]!;
  const tool = String(last.data.tool || '');
  const file = last.data.file ? String(last.data.file) : null;
  const basename = file ? file.split('/').pop() ?? file : null;

  switch (tool) {
    case 'Read':
      return basename ? `Reading ${basename}` : 'Reading file';
    case 'Edit':
      return basename ? `Editing ${basename}` : 'Editing file';
    case 'Write':
      return basename ? `Writing ${basename}` : 'Writing file';
    case 'Bash':
      return 'Running command';
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    default:
      return tool ? `Using ${tool}` : 'Working…';
  }
}

/** Derive a completion label from the bridge events for a given jobId */
function deriveDoneLabel(events: BridgeConnectionState['events'], jobId: string): string {
  // Check if the agent asked a question
  const hasQuestion = events.some(
    e => e.type === 'question' && e.data.jobId === jobId,
  );
  if (hasQuestion) return 'Has a question';

  // Check if resolutions were applied
  const doneEvent = events.find(
    e => e.type === 'done' && e.data.jobId === jobId,
  );
  if (doneEvent) {
    const resolutions = doneEvent.data.resolutions;
    if (Array.isArray(resolutions) && resolutions.length > 0) return 'Applied changes';
  }

  return 'Replied';
}

/** Animated four-dot crosshair spinner — matches canvas thinking badge */
function DotSpinner({ color }: { color: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % 2);
    }, 250);
    return () => clearInterval(id);
  }, []);

  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill={color} style={{ verticalAlign: 'middle', flexShrink: 0 }}>
      {frame === 1 ? (
        <>
          <circle cx="7" cy="7" r="2" />
          <circle cx="17" cy="7" r="2" />
          <circle cx="7" cy="17" r="2" />
          <circle cx="17" cy="17" r="2" />
        </>
      ) : (
        <>
          <circle cx="12" cy="6" r="2" />
          <circle cx="6" cy="12" r="2" />
          <circle cx="18" cy="12" r="2" />
          <circle cx="12" cy="18" r="2" />
        </>
      )}
    </svg>
  );
}

function ColorSquare({ color }: { color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        backgroundColor: color,
        opacity: 0.6,
      }}
    />
  );
}

function Checkmark({ color }: { color: string }) {
  return (
    <span style={{ color, fontSize: 12, lineHeight: 1, width: 10, display: 'inline-block' }}>✓</span>
  );
}

function ErrorDot() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: '#ef4444',
      }}
    />
  );
}

/** Wraps a child so swiping right dismisses it. */
function SwipeDismiss({ onDismiss, children }: { onDismiss: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startY: number; locked: boolean } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const THRESHOLD = 60;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { startX: e.clientX, startY: e.clientY, locked: false };
    ref.current?.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // Lock direction after 4px of movement
    if (!d.locked) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      d.locked = true;
      // If more vertical than horizontal, abort swipe
      if (Math.abs(dy) > Math.abs(dx)) { drag.current = null; return; }
    }
    setOffset(Math.max(0, dx)); // right only
  }, []);

  const onPointerUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    if (offset >= THRESHOLD) {
      setDismissed(true);
      setTimeout(onDismiss, 200);
    } else {
      setOffset(0);
    }
  }, [offset, onDismiss]);

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        transform: dismissed ? 'translateX(120%)' : `translateX(${offset}px)`,
        opacity: dismissed ? 0 : 1 - offset / (THRESHOLD * 3),
        transition: drag.current ? 'none' : 'transform 200ms ease, opacity 200ms ease',
        touchAction: 'pan-y',
      }}
    >
      {children}
    </div>
  );
}

export function BridgeEventStack({ bridge, inFlightJobs, isVisible, onHover, clearSignal, onViewThread }: BridgeEventStackProps) {
  const [entries, setEntries] = useState<StreamEntry[]>([]);

  // Clear on signal
  useEffect(() => {
    if (clearSignal > 0) {
      setEntries([]);
    }
  }, [clearSignal]);

  // Add new jobs from inFlightJobs + fallback from bridge.activeJobIds after HMR remount
  useEffect(() => {
    setEntries((prev) => {
      const existingIds = new Set(prev.map((e) => e.jobId));
      const newEntries = [...prev];
      for (const [jobId, job] of Object.entries(inFlightJobs)) {
        if (!existingIds.has(jobId)) {
          newEntries.push({ jobId, color: job.color, status: 'queued', threadId: job.threadId });
        }
      }
      // Safety net: if bridge reports active jobs not tracked by inFlightJobs
      // (e.g. sessionStorage unavailable), create fallback entries
      for (const jobId of bridge.activeJobIds) {
        if (!existingIds.has(jobId) && !inFlightJobs[jobId]) {
          newEntries.push({ jobId, color: '#888', status: 'working' });
        }
      }
      return newEntries.length !== prev.length ? newEntries : prev;
    });
  }, [inFlightJobs, bridge.activeJobIds]);

  // Update active job statuses (supports concurrent jobs)
  useEffect(() => {
    if (bridge.activeJobIds.length === 0) return;
    const activeSet = new Set(bridge.activeJobIds);
    setEntries((prev) =>
      prev.map((e) =>
        activeSet.has(e.jobId) && e.status !== 'done' && e.status !== 'error'
          ? { ...e, status: 'working' }
          : e,
      ),
    );
  }, [bridge.activeJobIds]);

  // Update completed job status with detailed label
  const prevCompletedRef = useRef<string | null>(null);
  useEffect(() => {
    const completedId = bridge.lastCompletedJobId;
    if (!completedId || completedId === prevCompletedRef.current) return;
    prevCompletedRef.current = completedId;

    const isError = bridge.events.some(
      (e) => e.type === 'error' && (e.data.jobId === completedId || bridge.status === 'error'),
    );

    const doneLabel = isError ? undefined : deriveDoneLabel(bridge.events, completedId);

    setEntries((prev) =>
      prev.map((e) =>
        e.jobId === completedId
          ? { ...e, status: isError ? 'error' : 'done', doneLabel }
          : e,
      ),
    );
  }, [bridge.lastCompletedJobId, bridge.events, bridge.status]);

  if (!isVisible || entries.length === 0) return null;

  return (
    <div
      style={stackContainerStyle}
      data-devtools
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {entries.map((entry) => {
        const label =
          entry.status === 'working'
            ? formatStepText(bridge.events.filter(e => e.data.jobId === entry.jobId))
            : entry.status === 'queued'
              ? 'Queued'
              : entry.status === 'done'
                ? (entry.doneLabel || 'Done')
                : 'Error';

        return (
          <SwipeDismiss key={entry.jobId} onDismiss={() => setEntries(prev => prev.filter(e => e.jobId !== entry.jobId))}>
            <div
              style={{ ...rowStyle, cursor: entry.threadId && onViewThread ? 'pointer' : undefined }}
              onClick={entry.threadId && onViewThread ? () => onViewThread(entry.threadId!) : undefined}
            >
              {entry.status === 'working' && <DotSpinner color={entry.color} />}
              {entry.status === 'queued' && <ColorSquare color={entry.color} />}
              {entry.status === 'done' && <Checkmark color={entry.color} />}
              {entry.status === 'error' && <ErrorDot />}
              <span style={{ color: entry.status === 'queued' ? '#9ca3af' : '#1f2937' }}>{label}</span>
            </div>
          </SwipeDismiss>
        );
      })}
    </div>
  );
}
