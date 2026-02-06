'use client';

import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { BridgeConnectionState } from '../hooks/useBridgeConnection';

type InFlightJob = {
  annotationIds: Set<string>;
  styleSelectors: Set<string>;
  color: string;
};

type BridgeEventStackProps = {
  bridge: BridgeConnectionState & { clearEvents: () => void };
  bridgeUrl: string;
  inFlightJobs: Map<string, InFlightJob>;
  isVisible: boolean;
  onHover: (hovering: boolean) => void;
  clearSignal: number;
  onReply?: (threadId: string, reply: string) => void;
};

type StreamEntry = {
  jobId: string;
  color: string;
  status: 'working' | 'queued' | 'done' | 'error';
};

const stackContainerStyle: CSSProperties = {
  position: 'fixed',
  bottom: 70,
  right: 16,
  zIndex: 9999,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  backgroundColor: 'rgba(255, 255, 255, 0.85)',
  border: '1px solid rgba(0, 0, 0, 0.1)',
  backdropFilter: 'blur(32px)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  color: '#1f2937',
  whiteSpace: 'nowrap' as const,
};

function stripInternalTags(text: string): string {
  return text
    .replace(/<resolution>[\s\S]*?<\/resolution>/g, '')
    .replace(/<question>[\s\S]*?<\/question>/g, '')
    .trim();
}

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

/** Animated dot spinner: cycles through ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ */
function DotSpinner({ color }: { color: string }) {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, 80);
    return () => clearInterval(id);
  }, []);

  return (
    <span style={{ color, fontWeight: 700, fontSize: 13, lineHeight: 1, width: 10, display: 'inline-block' }}>
      {frames[frame]}
    </span>
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

function Checkmark() {
  return (
    <span style={{ color: '#22c55e', fontSize: 12, lineHeight: 1, width: 10, display: 'inline-block' }}>✓</span>
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

export function BridgeEventStack({ bridge, inFlightJobs, isVisible, onHover, clearSignal, onReply }: BridgeEventStackProps) {
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [expandedResponse, setExpandedResponse] = useState(false);
  const [replyText, setReplyText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Clear on signal
  useEffect(() => {
    if (clearSignal > 0) {
      setEntries([]);
      setExpandedResponse(false);
      setReplyText('');
    }
  }, [clearSignal]);

  // Add new jobs from inFlightJobs
  useEffect(() => {
    setEntries((prev) => {
      const existingIds = new Set(prev.map((e) => e.jobId));
      const newEntries = [...prev];
      for (const [jobId, job] of inFlightJobs) {
        if (!existingIds.has(jobId)) {
          newEntries.push({ jobId, color: job.color, status: 'queued' });
        }
      }
      return newEntries.length !== prev.length ? newEntries : prev;
    });
  }, [inFlightJobs]);

  // Update active job status
  useEffect(() => {
    if (!bridge.activeJobId) return;
    setEntries((prev) =>
      prev.map((e) =>
        e.jobId === bridge.activeJobId && e.status !== 'done' && e.status !== 'error'
          ? { ...e, status: 'working' }
          : e,
      ),
    );
  }, [bridge.activeJobId]);

  // Update completed job status
  const prevCompletedRef = useRef<string | null>(null);
  useEffect(() => {
    const completedId = bridge.lastCompletedJobId;
    if (!completedId || completedId === prevCompletedRef.current) return;
    prevCompletedRef.current = completedId;

    const isError = bridge.events.some(
      (e) => e.type === 'error' && (e.data.jobId === completedId || bridge.status === 'error'),
    );

    setEntries((prev) =>
      prev.map((e) => (e.jobId === completedId ? { ...e, status: isError ? 'error' : 'done' } : e)),
    );
  }, [bridge.lastCompletedJobId, bridge.events, bridge.status]);

  // Response text: show during streaming or after completion
  const rawResponseText = bridge.status === 'streaming'
    ? bridge.currentResponse
    : bridge.lastResponseText;
  const responseText = rawResponseText ? stripInternalTags(rawResponseText) : null;

  // Auto-scroll when streaming
  useEffect(() => {
    if (scrollRef.current && expandedResponse) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [responseText, expandedResponse]);

  const threadId = bridge.lastThreadId ?? null;
  const isStreaming = bridge.status === 'streaming';

  const handleReplySubmit = () => {
    if (!replyText.trim() || !threadId || !onReply) return;
    onReply(threadId, replyText.trim());
    setReplyText('');
  };

  const handleReplyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleReplySubmit();
    }
  };

  if (!isVisible || (entries.length === 0 && !responseText)) return null;

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
            ? formatStepText(bridge.events)
            : entry.status === 'queued'
              ? 'Queued'
              : entry.status === 'done'
                ? 'Done'
                : 'Error';

        return (
          <div key={entry.jobId} style={rowStyle}>
            {entry.status === 'working' && <DotSpinner color={entry.color} />}
            {entry.status === 'queued' && <ColorSquare color={entry.color} />}
            {entry.status === 'done' && <Checkmark />}
            {entry.status === 'error' && <ErrorDot />}
            <span style={{ color: entry.status === 'queued' ? '#9ca3af' : '#1f2937' }}>{label}</span>
          </div>
        );
      })}

      {responseText && (
        <div
          style={{
            ...rowStyle,
            flexDirection: 'column',
            alignItems: 'flex-start',
            cursor: 'pointer',
            maxWidth: 360,
          }}
          onClick={() => setExpandedResponse((v) => !v)}
        >
          <span style={{ color: '#6b7280', fontSize: 10 }}>
            {expandedResponse ? '\u25BC' : '\u25B6'} Response
            {isStreaming && <>{' '}<DotSpinner color="#6b7280" /></>}
          </span>
          <div
            ref={scrollRef}
            style={{
              fontSize: 10,
              color: '#374151',
              whiteSpace: expandedResponse ? 'pre-wrap' : 'nowrap',
              overflow: 'hidden',
              textOverflow: expandedResponse ? undefined : 'ellipsis',
              maxHeight: expandedResponse ? 300 : 16,
              overflowY: expandedResponse ? 'auto' : 'hidden',
              width: '100%',
              lineHeight: 1.4,
              wordBreak: expandedResponse ? 'break-word' : undefined,
            }}
          >
            {responseText}
          </div>

          {/* Reply input when expanded, done streaming, and thread available */}
          {expandedResponse && threadId && onReply && !isStreaming && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ width: '100%', marginTop: 6, borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 6 }}
            >
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={handleReplyKeyDown}
                placeholder="Reply… (Cmd+Enter to send)"
                rows={2}
                style={{
                  width: '100%',
                  padding: '4px 6px',
                  fontSize: 10,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  backgroundColor: 'rgba(0, 0, 0, 0.03)',
                  color: '#1f2937',
                  border: '1px solid rgba(0, 0, 0, 0.1)',
                  borderRadius: 0,
                  outline: 'none',
                  resize: 'vertical',
                  lineHeight: 1.4,
                  boxSizing: 'border-box' as const,
                }}
              />
              <button
                onClick={handleReplySubmit}
                disabled={!replyText.trim()}
                style={{
                  marginTop: 4,
                  padding: '2px 8px',
                  fontSize: 10,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  backgroundColor: replyText.trim() ? '#1f2937' : 'rgba(0,0,0,0.06)',
                  color: replyText.trim() ? '#ffffff' : '#9ca3af',
                  border: 'none',
                  cursor: replyText.trim() ? 'pointer' : 'default',
                }}
              >
                Send
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
