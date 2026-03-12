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
  onClickJob?: (jobId: string) => void;
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
  bottom: 78,
  right: 16,
  zIndex: 9999,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
};

// Stacking constants — row height must approximate actual rendered height
const ROW_HEIGHT = 24; // 4+4 padding + ~14 text + 2 border
const PEEK_PX = 6;
const COLLAPSED_OVERLAP = ROW_HEIGHT - PEEK_PX; // negative margin to hide most of each card
const EXPANDED_GAP = 8;

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 3,
  padding: 0,
  backgroundColor: '#eaeaea',
  ...POPMELT_BORDER,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
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
  const content = last.data.content ? String(last.data.content) : null;

  switch (tool) {
    case 'Read':
      return basename ? `Reading ${basename}` : 'Reading file';
    case 'Edit':
      return basename ? `Editing ${basename}` : 'Editing file';
    case 'Write':
      return basename ? `Writing ${basename}` : 'Writing file';
    case 'Bash': {
      if (!content) return 'Running command';
      const line = content.split('\n')[0]!.trim();
      return line.length <= 40 ? line : line.slice(0, 37) + '…';
    }
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

  // "Applied changes" only if file-editing tools were actually used
  const FILE_EDIT_TOOLS = new Set(['Edit', 'Write']);
  const editedFiles = events.some(
    e => e.type === 'tool_use' && e.data.jobId === jobId && FILE_EDIT_TOOLS.has(String(e.data.tool || '')),
  );
  if (editedFiles) return 'Applied changes';

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


// Native-listener buttons for shadow DOM compat (stopPropagation + click)
function CancelButton({ onCancel }: { onCancel: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: MouseEvent) => { e.stopPropagation(); onCancel(); };
    const enter = () => { el.style.opacity = '0.5'; };
    const leave = () => { el.style.opacity = '0.7'; };
    el.addEventListener('click', handler);
    el.addEventListener('mouseenter', enter);
    el.addEventListener('mouseleave', leave);
    return () => { el.removeEventListener('click', handler); el.removeEventListener('mouseenter', enter); el.removeEventListener('mouseleave', leave); };
  }, [onCancel]);
  return (
    <button
      ref={ref}
      style={{ background: 'none', border: 'none', cursor: 'pointer',
               color: '#ffffff', opacity: 0.7, fontSize: 14, padding: '0 2px', lineHeight: 1 }}
      title="Cancel"
    >×</button>
  );
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: MouseEvent) => { e.stopPropagation(); onDismiss(); };
    const enter = () => { el.style.opacity = '0.5'; };
    const leave = () => { el.style.opacity = '0.7'; };
    el.addEventListener('click', handler);
    el.addEventListener('mouseenter', enter);
    el.addEventListener('mouseleave', leave);
    return () => { el.removeEventListener('click', handler); el.removeEventListener('mouseenter', enter); el.removeEventListener('mouseleave', leave); };
  }, [onDismiss]);
  return (
    <button
      ref={ref}
      style={{ background: 'none', border: 'none', cursor: 'pointer',
               color: '#ffffff', opacity: 0.7, fontSize: 14, padding: '0 2px', lineHeight: 1 }}
      title="Dismiss"
    >×</button>
  );
}

export function BridgeEventStack({ bridge, inFlightJobs, isVisible, onHover, clearSignal, onViewThread, onClickJob, onCancel, onHoverJob, isConnected, dismissedThreadIds }: BridgeEventStackProps) {
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
      // Prune entries that are still "queued" but no longer in inFlightJobs
      // (job was cleaned up before it ever started on this client)
      const inFlightIds = new Set(Object.keys(inFlightJobs));
      const activeIds = new Set(bridge.activeJobIds);
      const prunedEntries = newEntries.filter(e => {
        if (e.status !== 'queued') return true;
        // Keep if still tracked as in-flight or if the bridge says it's active
        return inFlightIds.has(e.jobId) || activeIds.has(e.jobId);
      });
      if (prunedEntries.length !== newEntries.length) changed = true;
      // Safety net: if bridge reports active jobs not tracked by inFlightJobs
      // (e.g. sessionStorage unavailable), create fallback entries
      const prunedIds = new Set(prunedEntries.map(e => e.jobId));
      for (const jobId of bridge.activeJobIds) {
        if (!prunedIds.has(jobId)) {
          const startEvt = bridge.events.find(e => e.type === 'job_started' && e.data.jobId === jobId);
          prunedEntries.push({
            jobId, color: '#888', status: 'working',
            threadId: startEvt?.data?.threadId as string | undefined,
          });
          changed = true;
        }
      }
      return changed ? prunedEntries : prev;
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

  // Whether the stack will actually render (used as effect dep so native
  // listeners re-attach when the component transitions from null → visible).
  const isRendered = isVisible && (entries.length > 0 || isConnected === false);

  // Native event listeners for shadow DOM compat (React synthetic events
  // don't reliably cross the shadow boundary in this portal setup).
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isRendered) return;
    const el = containerRef.current;
    if (!el) return;
    const onEnter = () => { setIsHovered(true); onHover(true); };
    const onLeave = () => { setIsHovered(false); onHover(false); onHoverJob?.(null); };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    return () => { el.removeEventListener('mouseenter', onEnter); el.removeEventListener('mouseleave', onLeave); };
  }, [isRendered, onHover, onHoverJob]);

  // Ref map for row-level native listeners
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const setRowRef = useCallback((jobId: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(jobId, el);
    else rowRefs.current.delete(jobId);
  }, []);

  // Attach native click/hover listeners to each row
  useEffect(() => {
    if (!isRendered) return;
    const cleanups: (() => void)[] = [];
    for (const entry of entries) {
      const el = rowRefs.current.get(entry.jobId);
      if (!el) continue;

      if (onClickJob) {
        const jobId = entry.jobId;
        const onClick = () => onClickJob(jobId);
        el.addEventListener('click', onClick);
        cleanups.push(() => el.removeEventListener('click', onClick));
      }

      if (onHoverJob) {
        const jobId = entry.jobId;
        const onEnter = () => onHoverJob(jobId);
        const onLeave = () => onHoverJob(null);
        el.addEventListener('mouseenter', onEnter);
        el.addEventListener('mouseleave', onLeave);
        cleanups.push(() => { el.removeEventListener('mouseenter', onEnter); el.removeEventListener('mouseleave', onLeave); });
      }
    }
    return () => cleanups.forEach(fn => fn());
  }, [isRendered, entries, onClickJob, onHoverJob]);

  if (!isRendered) return null;

  // Deduplicate entries by threadId — show one badge per conversation thread.
  // Entries without a threadId pass through as-is.
  const STATUS_PRIORITY: Record<StreamEntry['status'], number> = { working: 3, queued: 2, error: 1, done: 0 };
  const deduped: StreamEntry[] = [];
  const threadBest = new Map<string, StreamEntry>();
  for (const entry of entries) {
    if (!entry.threadId) { deduped.push(entry); continue; }
    const existing = threadBest.get(entry.threadId);
    if (!existing || STATUS_PRIORITY[entry.status] > STATUS_PRIORITY[existing.status]
        || (STATUS_PRIORITY[entry.status] === STATUS_PRIORITY[existing.status])) {
      threadBest.set(entry.threadId, entry);
    }
  }
  for (const entry of threadBest.values()) deduped.push(entry);

  // Compute queue position labels for queued entries
  const queuedEntries = deduped.filter(e => e.status === 'queued');
  const queuePosLabels = new Map<string, string>();
  queuedEntries.forEach((e, idx) => {
    queuePosLabels.set(e.jobId, `(${idx + 1}/${queuedEntries.length})`);
  });

  const collapsed = !isHovered && deduped.length > 1;

  return (
    <div
      ref={containerRef}
      style={stackContainerStyle}
      data-devtools
    >
      <style>{`@keyframes popmelt-badge-march { to { background-position: 0 -5px; } }`}</style>
      {[...deduped].reverse().map((entry, i) => {
        const isLast = i === deduped.length - 1;
        const distFromFront = deduped.length - 1 - i;

        const label =
          entry.status === 'working'
            ? formatStepText(bridge.events.filter(e => e.data.jobId === entry.jobId))
            : entry.status === 'queued'
              ? `Queued ${queuePosLabels.get(entry.jobId) ?? ''}`
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
                ref={(el) => setRowRef(entry.jobId, el)}
                style={{
                  ...rowStyle,
                  position: 'relative',
                  overflow: 'visible',
                  cursor: onClickJob ? 'pointer' : undefined,
                  ...(entry.status === 'working' && { borderImage: 'none', borderColor: 'transparent' }),
                }}
                title={entry.errorMessage || undefined}
              >
                {entry.status === 'working' && (() => {
                  const svgTile = `<svg xmlns='http://www.w3.org/2000/svg' width='5' height='5'><path d='M-1,1 l2,-2 M0,5 l5,-5 M4,6 l2,-2' stroke='${entry.color}' stroke-width='.75'/></svg>`;
                  return (
                    <div style={{
                      position: 'absolute',
                      inset: -3,
                      padding: 5,
                      backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(svgTile)}")`,
                      backgroundSize: '5px 5px',
                      WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) border-box',
                      WebkitMaskComposite: 'xor',
                      mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) border-box',
                      maskComposite: 'exclude' as string,
                      pointerEvents: 'none' as const,
                      animation: 'popmelt-badge-march 0.8s linear infinite',
                    }} />
                  );
                })()}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  padding: '3px 5px 3px 8px',
                  margin: 3,
                  backgroundColor: entry.status === 'error' ? '#ef4444' : entry.color,
                  color: '#ffffff',
                }}>
                  {entry.status === 'working' && <DotSpinner color="#ffffff" />}
                  {entry.status === 'queued' && <ColorSquare color="#ffffff" />}
                  {entry.status === 'done' && <Checkmark color="#ffffff" />}
                  {entry.status === 'error' && <ErrorDot />}
                  <span style={{ opacity: entry.status === 'queued' ? 0.6 : 1, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                  {entry.status === 'working' && onCancel && (
                    <CancelButton onCancel={() => onCancel(entry.jobId)} />
                  )}
                  {(entry.status === 'done' || entry.status === 'error') && (
                    <DismissButton onDismiss={() => setEntries(prev => prev.filter(el =>
                      entry.threadId ? el.threadId !== entry.threadId : el.jobId !== entry.jobId
                    ))} />
                  )}
                </div>
              </div>
          </div>
        );
      })}
      {isConnected === false && entries.length > 0 && (
        <div style={rowStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '3px 5px 3px 8px', margin: 3, backgroundColor: '#f59e0b', color: '#ffffff' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: '#ffffff', opacity: 0.6 }} />
            <span>Reconnecting…</span>
          </div>
        </div>
      )}
    </div>
  );
}
