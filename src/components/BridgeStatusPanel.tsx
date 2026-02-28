'use client';

import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';

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
  onCancel?: (jobId: string) => void;
  onHoverJob?: (jobId: string | null) => void;
  isConnected?: boolean;
  dismissedThreadIds?: Set<string>;
};

type StreamEntry = {
  jobId: string;
  color: string;
  status: 'working' | 'queued' | 'done' | 'error';
  doneLabel?: string;
  threadId?: string;
  errorMessage?: string;
  cancelled?: boolean;
};

const stackContainerStyle: CSSProperties = {
  position: 'fixed',
  bottom: 86,
  right: 16,
  zIndex: 9999,
  display: 'flex',
  flexDirection: 'column',
};

// Stacking constants — row height must approximate actual rendered height
const ROW_HEIGHT = 24; // 4+4 padding + ~14 text + 2 border
const PEEK_PX = 6;
const COLLAPSED_OVERLAP = ROW_HEIGHT - PEEK_PX; // negative margin to hide most of each card
const EXPANDED_GAP = 8;

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

/** Shorten an error message for the pill label */
function truncateLabel(msg: string): string {
  // Strip "Error: " prefix if present
  const clean = msg.replace(/^Error:\s*/i, '');
  return clean.length > 40 ? clean.slice(0, 37) + '...' : clean;
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


export function BridgeEventStack({ bridge, inFlightJobs, isVisible, onHover, clearSignal, onViewThread, onCancel, onHoverJob, isConnected, dismissedThreadIds }: BridgeEventStackProps) {
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [isHovered, setIsHovered] = useState(false);

  // Clear on signal
  useEffect(() => {
    if (clearSignal > 0) {
      setEntries([]);
    }
  }, [clearSignal]);

  // Remove entries whose thread was dismissed (annotation deleted)
  useEffect(() => {
    if (!dismissedThreadIds || dismissedThreadIds.size === 0) return;
    setEntries((prev) => {
      const filtered = prev.filter((e) => !e.threadId || !dismissedThreadIds.has(e.threadId));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [dismissedThreadIds]);

  // Add new jobs from inFlightJobs + fallback from bridge.activeJobIds after HMR remount.
  // Also backfill threadId/color on existing entries when inFlightJobs arrives after a
  // race with the SSE job_started event.
  useEffect(() => {
    setEntries((prev) => {
      const existingIds = new Set(prev.map((e) => e.jobId));
      let changed = false;
      const newEntries = prev.map((entry) => {
        const job = inFlightJobs[entry.jobId];
        if (job && (!entry.threadId || entry.color === '#888')) {
          changed = true;
          return {
            ...entry,
            threadId: entry.threadId || job.threadId,
            color: entry.color === '#888' ? job.color : entry.color,
          };
        }
        return entry;
      });
      for (const [jobId, job] of Object.entries(inFlightJobs)) {
        if (!existingIds.has(jobId)) {
          newEntries.push({ jobId, color: job.color, status: 'queued', threadId: job.threadId });
          changed = true;
        }
      }
      // Safety net: if bridge reports active jobs not tracked by inFlightJobs
      // (e.g. sessionStorage unavailable), create fallback entries
      for (const jobId of bridge.activeJobIds) {
        if (!existingIds.has(jobId) && !newEntries.some(e => e.jobId === jobId)) {
          const startEvt = bridge.events.find(e => e.type === 'job_started' && e.data.jobId === jobId);
          newEntries.push({
            jobId, color: '#888', status: 'working',
            threadId: startEvt?.data?.threadId as string | undefined,
          });
          changed = true;
        }
      }
      return changed ? newEntries : prev;
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

    const errorEvent = bridge.events.find(
      (e) => e.type === 'error' && (e.data.jobId === completedId || bridge.status === 'error'),
    );
    const isError = !!errorEvent;

    const doneLabel = isError ? undefined : deriveDoneLabel(bridge.events, completedId);
    const errorMessage = errorEvent ? String(errorEvent.data.message || '') : undefined;
    const cancelled = errorEvent ? !!errorEvent.data.cancelled : undefined;

    const errorThreadId = errorEvent?.data.threadId as string | undefined;

    setEntries((prev) =>
      prev.map((e) =>
        e.jobId === completedId
          ? { ...e, status: isError ? 'error' : 'done', doneLabel, errorMessage, cancelled, threadId: e.threadId || errorThreadId }
          : e,
      ),
    );
  }, [bridge.lastCompletedJobId, bridge.events, bridge.status]);

  if (!isVisible || (entries.length === 0 && isConnected !== false)) return null;

  const collapsed = !isHovered && entries.length > 1;

  return (
    <div
      style={stackContainerStyle}
      data-devtools
      onMouseEnter={() => { setIsHovered(true); onHover(true); }}
      onMouseLeave={() => { setIsHovered(false); onHover(false); onHoverJob?.(null); }}
    >
      {[...entries].reverse().map((entry, i) => {
        const isLast = i === entries.length - 1;
        const distFromFront = entries.length - 1 - i;

        const label =
          entry.status === 'working'
            ? formatStepText(bridge.events.filter(e => e.data.jobId === entry.jobId))
            : entry.status === 'queued'
              ? 'Queued'
              : entry.status === 'done'
                ? (entry.doneLabel || 'Done')
                : entry.cancelled
                  ? 'Cancelled'
                  : entry.errorMessage
                    ? truncateLabel(entry.errorMessage)
                    : 'Error';

        return (
          <div
            key={entry.jobId}
            style={{
              position: 'relative',
              zIndex: i,
              marginBottom: collapsed
                ? (isLast ? 0 : -COLLAPSED_OVERLAP)
                : (isLast ? 0 : EXPANDED_GAP),
              transform: collapsed
                ? `scale(${Math.max(0.94, 1 - distFromFront * 0.02)})`
                : 'scale(1)',
              opacity: collapsed ? Math.max(0.5, 1 - distFromFront * 0.15) : 1,
              transformOrigin: 'bottom right',
              transition: 'margin-bottom 250ms ease, transform 250ms ease, opacity 250ms ease',
            }}
          >
              <div
                style={{ ...rowStyle, cursor: entry.threadId && onViewThread ? 'pointer' : undefined }}
                onClick={entry.threadId && onViewThread ? () => onViewThread(entry.threadId!) : undefined}
                onMouseEnter={onHoverJob ? () => onHoverJob(entry.jobId) : undefined}
                onMouseLeave={onHoverJob ? () => onHoverJob(null) : undefined}
                title={entry.errorMessage || undefined}
              >
                {entry.status === 'working' && <DotSpinner color={entry.color} />}
                {entry.status === 'queued' && <ColorSquare color={entry.color} />}
                {entry.status === 'done' && <Checkmark color={entry.color} />}
                {entry.status === 'error' && <ErrorDot />}
                <span style={{ color: entry.status === 'queued' ? '#9ca3af' : '#1f2937' }}>{label}</span>
                {entry.status === 'working' && onCancel && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onCancel(entry.jobId); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer',
                             color: '#9ca3af', fontSize: 14, padding: '0 4px', lineHeight: 1 }}
                    title="Cancel"
                  >×</button>
                )}
                {(entry.status === 'done' || entry.status === 'error') && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setEntries(prev => prev.filter(el => el.jobId !== entry.jobId)); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer',
                             color: '#9ca3af', fontSize: 14, padding: '0 4px', lineHeight: 1 }}
                    title="Dismiss"
                  >×</button>
                )}
              </div>
          </div>
        );
      })}
      {isConnected === false && entries.length > 0 && (
        <div style={{ ...rowStyle, color: '#9ca3af' }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: '#f59e0b' }} />
          <span>Reconnecting…</span>
        </div>
      )}
    </div>
  );
}
