'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { BridgeEvent } from '../hooks/useBridgeConnection';
import { FONT_FAMILY, PADDING } from '../tools/text';

// ---------------------------------------------------------------------------
// Lightweight markdown → React renderer (zero dependencies)
// Supports: headings, bold, italic, bold+italic, inline code, code blocks,
//           links, unordered/ordered lists, tables, horizontal rules
// ---------------------------------------------------------------------------

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Parse inline markdown (bold, italic, code, links) into React nodes */
function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters — longer/greedier patterns first
  const re = /(`[^`]+`)|(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(_([^_]+?)_)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1]) {
      // inline code
      nodes.push(
        <code key={match.index} style={{
          fontFamily: MONO, fontSize: '0.9em',
          backgroundColor: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 2,
        }}>
          {match[1].slice(1, -1)}
        </code>,
      );
    } else if (match[3] !== undefined) {
      // bold+italic ***…***
      nodes.push(<strong key={match.index}><em>{match[3]}</em></strong>);
    } else if (match[5] !== undefined) {
      // bold **…**
      nodes.push(<strong key={match.index}>{match[5]}</strong>);
    } else if (match[7] !== undefined) {
      // italic *…*
      nodes.push(<em key={match.index}>{match[7]}</em>);
    } else if (match[9] !== undefined) {
      // italic _…_
      nodes.push(<em key={match.index}>{match[9]}</em>);
    } else if (match[11] !== undefined && match[12] !== undefined) {
      // link [text](url)
      nodes.push(
        <a key={match.index} href={match[12]} target="_blank" rel="noopener noreferrer"
          style={{ color: 'inherit', textDecoration: 'underline' }}>
          {match[11]}
        </a>,
      );
    }
    last = match.index + match[0].length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Render a full markdown string to React elements */
function renderMarkdown(src: string): ReactNode {
  const lines = src.split('\n');
  const elements: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block ```
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={elements.length} style={{
          fontFamily: MONO, fontSize: '0.9em', lineHeight: 1.4,
          backgroundColor: 'rgba(0,0,0,0.04)', padding: '6px 8px',
          margin: '4px 0', overflowX: 'auto', whiteSpace: 'pre',
        }}>
          {codeLines.join('\n')}
        </pre>,
      );
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      elements.push(<hr key={elements.length} style={{ border: 'none', borderTop: '1px solid rgba(0,0,0,0.1)', margin: '6px 0' }} />);
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const sizes: Record<number, number> = { 1: 16, 2: 14, 3: 13, 4: 12 };
      elements.push(
        <div key={elements.length} style={{
          fontWeight: 700, fontSize: sizes[level] ?? 12,
          margin: '8px 0 2px',
        }}>
          {parseInline(headingMatch[2]!)}
        </div>,
      );
      i++;
      continue;
    }

    // Table (| col | col |)
    if (line.trimStart().startsWith('|') && line.trimEnd().endsWith('|')) {
      const tableRows: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('|') && lines[i]!.trimEnd().endsWith('|')) {
        tableRows.push(lines[i]!);
        i++;
      }
      // Filter out separator rows (|---|---|)
      const isSeparator = (r: string) => /^\|[\s\-:|]+\|$/.test(r);
      const dataRows = tableRows.filter(r => !isSeparator(r));
      const parseCells = (r: string) => r.split('|').slice(1, -1).map(c => c.trim());

      elements.push(
        <table key={elements.length} style={{
          borderCollapse: 'collapse', margin: '4px 0', fontSize: '0.95em', width: '100%',
        }}>
          <tbody>
            {dataRows.map((row, ri) => (
              <tr key={ri}>
                {parseCells(row).map((cell, ci) => {
                  const Tag = ri === 0 ? 'th' : 'td';
                  return (
                    <Tag key={ci} style={{
                      border: '1px solid rgba(0,0,0,0.1)',
                      padding: '3px 6px',
                      textAlign: 'left',
                      fontWeight: ri === 0 ? 600 : 400,
                    }}>
                      {parseInline(cell)}
                    </Tag>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // Unordered list (- or *)
    const ulMatch = line.match(/^(\s*)([-*])\s+(.+)/);
    if (ulMatch) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        const m = lines[i]!.match(/^\s*[-*]\s+(.+)/);
        if (m) items.push(<li key={items.length}>{parseInline(m[1]!)}</li>);
        i++;
      }
      elements.push(
        <ul key={elements.length} style={{ margin: '2px 0', paddingLeft: 20 }}>{items}</ul>,
      );
      continue;
    }

    // Ordered list (1. 2. etc)
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        const m = lines[i]!.match(/^\s*\d+\.\s+(.+)/);
        if (m) items.push(<li key={items.length}>{parseInline(m[1]!)}</li>);
        i++;
      }
      elements.push(
        <ol key={elements.length} style={{ margin: '2px 0', paddingLeft: 20 }}>{items}</ol>,
      );
      continue;
    }

    // Blank line → spacer
    if (line.trim() === '') {
      elements.push(<div key={elements.length} style={{ height: 4 }} />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <div key={elements.length} style={{ margin: '2px 0' }}>
        {parseInline(line)}
      </div>,
    );
    i++;
  }

  return <>{elements}</>;
}

type ThreadMessage = {
  role: 'human' | 'assistant';
  timestamp: number;
  jobId: string;
  feedbackSummary?: string;
  responseText?: string;
  question?: string;
  replyToQuestion?: string;
};

type PlanAnnotation = {
  id: string;
  planTaskId?: string;
  status?: string;
  text?: string;
  threadId?: string;
  color: string;
};

type ThreadPanelProps = {
  threadId: string;
  bridgeUrl: string;
  accentColor: string;
  isStreaming?: boolean;
  streamingResponse?: string;
  streamingThinking?: string;
  streamingEvents?: BridgeEvent[];
  onClose: () => void;
  onReply?: (threadId: string, reply: string) => void;
  activePlan?: { planId: string; status: string; goal: string; tasks?: { id: string; instruction: string }[] } | null;
  planAnnotations?: PlanAnnotation[];
  inFlightJobs?: Map<string, { annotationIds: Set<string>; threadId?: string }>;
  onViewThread?: (threadId: string) => void;
};

// Match the toolbar's 16px inset, leave room for the 48px toolbar + gap at bottom
const panelStyle: CSSProperties = {
  position: 'fixed',
  top: 16,
  right: 16,
  bottom: 72, // 16px inset + 48px toolbar + 8px gap
  width: 400,
  backgroundColor: '#ffffff',
  border: '1px solid rgba(0, 0, 0, 0.1)',
  zIndex: 10000,
  display: 'flex',
  flexDirection: 'column',
  fontFamily: FONT_FAMILY,
  fontSize: 12,
  color: '#1f2937',
};

const baseHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '4px 5px 4px 10px',
  fontWeight: 600,
  fontSize: 12,
};

const messagesStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '8px 0',
  scrollbarWidth: 'none',
};

const SCROLLBAR_CSS = `
[data-devtools="thread-panel-messages"]:hover {
  scrollbar-width: thin !important;
}
[data-devtools="thread-panel-messages"]::-webkit-scrollbar {
  width: 0;
}
[data-devtools="thread-panel-messages"]:hover::-webkit-scrollbar {
  width: 6px;
}
[data-devtools="thread-panel-messages"]::-webkit-scrollbar-thumb {
  background: rgba(0,0,0,0.15);
  border-radius: 3px;
}
`;

const replyAreaStyle: CSSProperties = {
  borderTop: '1px solid rgba(0, 0, 0, 0.08)',
  padding: 12,
};

function stripInternalTags(text: string): string {
  return text
    .replace(/<resolution>[\s\S]*?<\/resolution>/g, '')
    .replace(/<question>[\s\S]*?<\/question>/g, '')
    .trim();
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const THINKING_WORDS = [
  'reviewing', 'considering', 'thinking', 'zhuzhing',
  'iterating', 'tweaking', 'reflecting', 'noodling',
  'pondering', 'finessing', 'polishing', 'riffing',
];
const WORD_INTERVAL = 3000;
const CROSSHAIR_INTERVAL = 250;

/** Claude sparkle icon */
function ClaudeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M16.546 8.154L12.462 19.788C12.346 20.124 12.106 20.292 11.742 20.292C11.378 20.292 11.138 20.124 11.022 19.788L6.954 8.154C6.906 8.01 6.882 7.89 6.882 7.794C6.882 7.458 7.05 7.266 7.386 7.218L8.178 7.098C8.514 7.05 8.73 7.194 8.826 7.53L11.742 16.578L14.682 7.53C14.778 7.194 14.994 7.05 15.33 7.098L16.122 7.218C16.458 7.266 16.626 7.458 16.626 7.794C16.626 7.89 16.594 8.01 16.546 8.154Z"
        fill="#6b7280"
      />
    </svg>
  );
}

/** Animated crosshair icon + cycling adjective — mirrors the annotation canvas thinking badge */
function ThinkingBadge({ color }: { color: string }) {
  const [frame, setFrame] = useState(0);
  const [wordIndex, setWordIndex] = useState(() => Math.floor(Math.random() * THINKING_WORDS.length));

  useEffect(() => {
    const frameTimer = setInterval(() => setFrame(f => (f + 1) % 2), CROSSHAIR_INTERVAL);
    const wordTimer = setInterval(() => setWordIndex(i => (i + 1) % THINKING_WORDS.length), WORD_INTERVAL);
    return () => { clearInterval(frameTimer); clearInterval(wordTimer); };
  }, []);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
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
      <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
        {THINKING_WORDS[wordIndex]}
      </span>
    </span>
  );
}

/** Format tool_use events into a step label like the BridgeEventStack does */
function formatToolStep(events: BridgeEvent[]): string | null {
  const toolEvents = events.filter(e => e.type === 'tool_use');
  if (toolEvents.length === 0) return null;
  const last = toolEvents[toolEvents.length - 1]!;
  const tool = String(last.data.tool || '');
  const file = last.data.file ? String(last.data.file) : null;
  const basename = file ? file.split('/').pop() ?? file : null;
  switch (tool) {
    case 'Read': return basename ? `Reading ${basename}` : 'Reading file';
    case 'Edit': return basename ? `Editing ${basename}` : 'Editing file';
    case 'Write': return basename ? `Writing ${basename}` : 'Writing file';
    case 'Bash': return 'Running command';
    case 'Glob': return 'Searching files';
    case 'Grep': return 'Searching code';
    case 'WebFetch': return 'Fetching page';
    case 'WebSearch': return 'Searching web';
    default: return tool ? `Using ${tool}` : null;
  }
}

export function ThreadPanel({
  threadId,
  bridgeUrl,
  accentColor,
  isStreaming,
  streamingResponse,
  streamingThinking,
  streamingEvents,
  onClose,
  onReply,
  activePlan,
  planAnnotations,
  inFlightJobs,
  onViewThread,
}: ThreadPanelProps) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const prevStreamingRef = useRef(isStreaming);

  // Fetch thread data
  const fetchThread = useCallback(() => {
    fetch(`${bridgeUrl}/thread/${threadId}`)
      .then(r => r.json())
      .then(data => {
        setMessages(data.messages ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [bridgeUrl, threadId]);

  useEffect(() => {
    setLoading(true);
    fetchThread();
  }, [fetchThread]);

  // Re-fetch when streaming completes (new messages from the agent)
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      fetchThread();
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, fetchThread]);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingResponse, streamingThinking, isStreaming]);

  // Close on Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Close on click outside is handled by the backdrop element below

  const handleSubmit = useCallback(() => {
    if (!replyText.trim() || !onReply) return;
    const text = replyText.trim();
    // Optimistically show the reply immediately
    setMessages(prev => [...prev, {
      role: 'human' as const,
      timestamp: Date.now(),
      jobId: 'pending',
      replyToQuestion: text,
    }]);
    onReply(threadId, text);
    setReplyText('');
  }, [replyText, threadId, onReply]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  // Derive live streaming display
  const toolStep = streamingEvents ? formatToolStep(streamingEvents) : null;
  const thinkingText = streamingThinking || '';
  const responseText = streamingResponse ? stripInternalTags(streamingResponse) : '';

  const cornerDotStyle: CSSProperties = {
    position: 'absolute',
    width: 2,
    height: 2,
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    pointerEvents: 'none',
  };

  return (
    <>
    {/* Invisible backdrop to catch clicks outside the panel */}
    <div
      data-devtools="thread-panel-backdrop"
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: panelStyle.zIndex as number - 1,
      }}
    />
    <div
      ref={panelRef}
      style={panelStyle}
      data-devtools="thread-panel"
    >
      {/* Corner dots */}
      <div style={{ ...cornerDotStyle, top: -1, left: -1 }} />
      <div style={{ ...cornerDotStyle, top: -1, right: -1 }} />
      <div style={{ ...cornerDotStyle, bottom: -1, left: -1 }} />
      <div style={{ ...cornerDotStyle, bottom: -1, right: -1 }} />

      {/* Header */}
      <div style={{ ...baseHeaderStyle, backgroundColor: accentColor, color: '#ffffff' }}>
        <span>Conversation</span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 16,
            color: '#ffffff',
            padding: '0 4px',
            lineHeight: 1,
          }}
        >
          &times;
        </button>
      </div>

      {/* Scrollbar-on-hover CSS */}
      <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS }} />

      {/* Messages */}
      <div ref={scrollRef} style={messagesStyle} data-devtools="thread-panel-messages">
        {loading && (
          <div style={{ padding: 16, color: '#9ca3af', textAlign: 'center' }}>
            Loading...
          </div>
        )}

        {!loading && messages.length === 0 && !isStreaming && (
          <div style={{ padding: 16, color: '#9ca3af', textAlign: 'center' }}>
            No messages yet.
          </div>
        )}

        {messages.map((msg, i) => {
          const isHuman = msg.role === 'human';
          const text = isHuman
            ? (msg.replyToQuestion || msg.feedbackSummary || '(annotation)')
            : stripInternalTags(msg.responseText || msg.question || '');

          if (!text) return null;

          const isLatest = i === messages.length - 1;

          return (
            <div
              key={`${msg.jobId}-${i}`}
              style={{
                padding: '8px 16px',
                borderBottom: '1px solid rgba(0, 0, 0, 0.04)',
                opacity: isLatest ? 1 : 0.5,
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                marginBottom: 4,
              }}>
                {!isHuman && <ClaudeIcon size={11} />}
                <span style={{
                  fontWeight: 600,
                  fontSize: 11,
                  color: isHuman ? accentColor : '#6b7280',
                }}>
                  {isHuman ? 'You' : 'Claude Code'}
                </span>
                <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 'auto' }}>
                  {formatTimestamp(msg.timestamp)}
                </span>
              </div>
              <div style={{
                lineHeight: 1.5,
                wordBreak: 'break-word',
              }}>
                {isHuman ? text : renderMarkdown(text)}
              </div>
            </div>
          );
        })}

        {/* Plan task list */}
        {activePlan && planAnnotations && planAnnotations.length > 0 && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid rgba(0, 0, 0, 0.04)' }}>
            <div style={{ fontWeight: 600, fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
              Plan Tasks
            </div>
            {planAnnotations.map((ann) => {
              const task = activePlan.tasks?.find(t => t.id === ann.planTaskId);
              const isInFlight = inFlightJobs && Array.from(inFlightJobs.values()).some(j => j.annotationIds.has(ann.id));
              const statusLabel = isInFlight ? 'running' : (ann.status ?? 'pending');
              const statusColor = statusLabel === 'resolved' ? '#10b981'
                : statusLabel === 'running' ? ann.color
                : statusLabel === 'needs_review' ? '#f59e0b'
                : '#9ca3af';

              return (
                <div
                  key={ann.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '4px 0',
                    cursor: ann.threadId && onViewThread ? 'pointer' : 'default',
                  }}
                  onClick={() => {
                    if (ann.threadId && onViewThread) onViewThread(ann.threadId);
                  }}
                >
                  <div style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: statusColor,
                    marginTop: 4,
                    flexShrink: 0,
                  }} />
                  <div style={{ flex: 1, fontSize: 11, lineHeight: 1.4 }}>
                    <div>{task?.instruction || ann.text || ann.planTaskId}</div>
                    <div style={{ color: '#9ca3af', fontSize: 10 }}>{statusLabel}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Live streaming section */}
        {isStreaming && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid rgba(0, 0, 0, 0.04)' }}>
            {/* Claude header with crosshair thinking badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
              <ClaudeIcon size={11} />
              <span style={{ fontWeight: 600, fontSize: 11, color: '#6b7280' }}>
                Claude Code
              </span>
              <span style={{ marginLeft: 'auto' }}>
                <ThinkingBadge color={accentColor} />
              </span>
            </div>

            {/* Tool activity */}
            {toolStep && (
              <div style={{
                paddingLeft: 12,
                marginBottom: 4,
                fontSize: 11,
                color: '#9ca3af',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}>
                {toolStep}
              </div>
            )}

            {/* Thinking text (model's internal monologue) */}
            {thinkingText && (
              <div style={{
                paddingLeft: 12,
                marginBottom: 4,
                fontSize: 11,
                color: '#9ca3af',
                fontStyle: 'italic',
                lineHeight: 1.4,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 120,
                overflowY: 'auto',
              }}>
                {thinkingText}
              </div>
            )}

            {/* Response text so far */}
            {responseText && (
              <div style={{
                paddingLeft: 12,
                lineHeight: 1.5,
                wordBreak: 'break-word',
              }}>
                {renderMarkdown(responseText)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reply area */}
      {onReply && (
        <div style={replyAreaStyle}>
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply... (Cmd+Enter to send)"
            style={{
              width: '100%',
              minHeight: 60,
              padding: PADDING,
              fontSize: 12,
              fontFamily: FONT_FAMILY,
              backgroundColor: 'rgba(0, 0, 0, 0.03)',
              color: '#1f2937',
              border: '1px solid rgba(0, 0, 0, 0.1)',
              borderRadius: 0,
              outline: 'none',
              resize: 'vertical',
              lineHeight: 1.4,
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
            <button
              onClick={handleSubmit}
              disabled={!replyText.trim()}
              style={{
                padding: '5px 14px',
                fontSize: 11,
                fontFamily: FONT_FAMILY,
                fontWeight: 600,
                backgroundColor: replyText.trim() ? accentColor : 'rgba(0,0,0,0.1)',
                color: replyText.trim() ? '#ffffff' : 'rgba(0,0,0,0.3)',
                border: 'none',
                cursor: replyText.trim() ? 'pointer' : 'default',
              }}
            >
              Send &#8984;&#9166;
            </button>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
