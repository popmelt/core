'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { BridgeEvent } from '../hooks/useBridgeConnection';
import { FONT_FAMILY, PADDING } from '../tools/text';
import { renderMarkdown } from '../utils/threadMarkdown';
import { ProviderIcon, modelLabel } from './providers';

type ToolGroupItem = {
  label: string;
  detail?: string;
};

type PersistedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool_group'; tool: string; items: ToolGroupItem[] };

type ThreadMessage = {
  role: 'human' | 'assistant';
  timestamp: number;
  jobId: string;
  feedbackSummary?: string;
  responseText?: string;
  question?: string;
  replyToQuestion?: string;
  toolsUsed?: string[];
  segments?: PersistedSegment[];
  cancelled?: boolean;
  error?: string;
  // Image URLs (converted from filesystem paths by the server)
  screenshotUrl?: string;
  screenshotUrls?: Record<string, string>; // pathname → /files/ URL
  imageUrls?: Record<string, string[]>; // annotationId → /files/ URLs
  replyImageUrls?: string[]; // images attached to a reply
  resolutions?: {
    annotationId: string;
    status: string;
    summary: string;
    filesModified?: string[];
    declaredScope?: { breadth: string; target: string } | null;
    inferredScope?: { breadth: string; target: string } | null;
    finalScope?: { breadth: string; target: string } | null;
  }[];
  model?: string;
  provider?: string;
};

type ThreadPanelProps = {
  threadId: string;
  bridgeUrl: string;
  accentColor: string;
  isStreaming?: boolean;
  streamingEvents?: BridgeEvent[];
  onClose: () => void;
  onReply?: (threadId: string, reply: string, images?: Blob[]) => void;
  onCancel?: () => void;
  lastError?: string;
  onMouseEnter?: () => void;
  toolbarRef?: React.MutableRefObject<HTMLDivElement | null>;
  currentModel?: string;
  currentProvider?: string;
  annotationNumber?: number;
  annotationText?: string;
};

const PANEL_WIDTH = 400;
const EDGE_PAD = 16;
const BORDER = 3; // POPMELT_BORDER borderWidth
const ANIMATED_BORDER_OUTSET = 3; // animated border extends this far outside the panel
const ANIMATED_BORDER_PADDING = 4; // inner padding when animated border is showing
const TOOLBAR_GAP = 8;
const THREAD_POS_KEY = 'devtools-thread-panel-position';

/** Right-aligned with the toolbar (right: 16), top: 16 */
/** Border-box width (content + padding + border) — used for positioning */
const PANEL_BOX_WIDTH = PANEL_WIDTH + 2 * BORDER + 2 * ANIMATED_BORDER_PADDING;
/** Full visual width including overlay outset — used for overlap detection */
const PANEL_VISUAL_WIDTH = PANEL_BOX_WIDTH + 2 * ANIMATED_BORDER_OUTSET;

function getDefaultPosition() {
  return {
    top: EDGE_PAD,
    left: window.innerWidth - PANEL_BOX_WIDTH - EDGE_PAD,
  };
}

function getMaxHeight(top: number, left: number, toolbarEl?: HTMLDivElement | null) {
  const toolbarRect = toolbarEl?.getBoundingClientRect();
  // Subtract border + padding + outset since box-sizing is content-box
  const boxChrome = 2 * BORDER + 2 * ANIMATED_BORDER_PADDING;
  let bottomLimit = window.innerHeight - EDGE_PAD - boxChrome;
  if (toolbarRect && left + PANEL_VISUAL_WIDTH > toolbarRect.left) {
    bottomLimit = toolbarRect.top - TOOLBAR_GAP - boxChrome;
  }
  return Math.max(200, bottomLimit - Math.max(0, top));
}

const basePanelStyle: CSSProperties = {
  width: PANEL_WIDTH,
  backgroundColor: '#eaeaea',
  borderWidth: 3,
  borderStyle: 'solid',
  borderColor: 'transparent',
  boxSizing: 'content-box',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'visible',
  padding: 4,
  fontFamily: FONT_FAMILY,
  fontSize: 12,
  color: '#1f2937',
  pointerEvents: 'auto',
};

const baseHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '4px 5px 4px 10px',
  margin: 0,
  fontWeight: 600,
  fontSize: 12,
  overflow: 'hidden',
};

const messagesStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: 0,
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
  borderTop: '1px solid rgba(0, 0, 0, 0.12)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '0 8px 0 10px',
};

function stripInternalTags(text: string): string {
  return text
    .replace(/<resolution>[\s\S]*?<\/resolution>/g, '')
    .replace(/<question>[\s\S]*?<\/question>/g, '')
    .replace(/<plan>[\s\S]*?<\/plan>/g, '')
    .replace(/<review>[\s\S]*?<\/review>/g, '')
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

const THUMB_SIZE = 32;

const thumbStyle: CSSProperties = {
  width: THUMB_SIZE,
  height: THUMB_SIZE,
  objectFit: 'cover',
  cursor: 'pointer',
  border: '1px solid rgba(0,0,0,0.1)',
};

/** Parse multi-page feedbackSummary into per-route sections.
 *  Format: `` `/{path}`\n- annotation text\n`/{path2}`\n- text ``
 *  Returns null if no route sections found (single-page). */
function parseRouteSections(summary: string): { route: string; text: string }[] | null {
  const routeRe = /^`(\/[^`]*)`$/gm;
  const matches = [...summary.matchAll(routeRe)];
  if (matches.length === 0) return null;

  const sections: { route: string; text: string }[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const route = m[1]!;
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : summary.length;
    const text = summary.slice(start, end).trim();
    sections.push({ route, text });
  }
  return sections;
}

/** Collect reply image URLs (for reply messages only) */
function collectReplyImages(msg: ThreadMessage, bridgeUrl: string): { url: string; label: string }[] {
  const images: { url: string; label: string }[] = [];
  if (msg.replyImageUrls) {
    for (const url of msg.replyImageUrls) {
      const full = url.startsWith('blob:') || url.startsWith('http') ? url : `${bridgeUrl}${url}`;
      images.push({ url: full, label: 'pasted image' });
    }
  }
  return images;
}

/** Collect pasted annotation images (not screenshots) */
function collectPastedImages(msg: ThreadMessage, bridgeUrl: string): { url: string; label: string }[] {
  const images: { url: string; label: string }[] = [];
  if (msg.imageUrls) {
    for (const [, urls] of Object.entries(msg.imageUrls)) {
      for (const relUrl of urls) {
        images.push({ url: `${bridgeUrl}${relUrl}`, label: 'pasted image' });
      }
    }
  }
  return images;
}

/** Full-screen lightbox overlay */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        backgroundColor: 'rgba(0,0,0,0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'zoom-out',
      }}
    >
      <img
        src={src}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '90vw',
          maxHeight: '90vh',
          objectFit: 'contain',
          cursor: 'default',
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        }}
      />
    </div>
  );
}

/** Format a single tool_use event into a step label */
function formatToolEvent(event: BridgeEvent): string | null {
  const tool = String(event.data.tool || '');
  const file = event.data.file ? String(event.data.file) : null;
  const basename = file ? file.split('/').pop() ?? file : null;
  const content = event.data.content ? String(event.data.content) : null;
  switch (tool) {
    case 'Read': return basename ? `Reading ${basename}` : 'Reading file';
    case 'Edit': return basename ? `Editing ${basename}` : 'Editing file';
    case 'Write': return basename ? `Writing ${basename}` : 'Writing file';
    case 'Bash': return content ? truncateCommand(content) : 'Running command';
    case 'Glob': return 'Searching files';
    case 'Grep': return 'Searching code';
    case 'WebFetch': return 'Fetching page';
    case 'WebSearch': return 'Searching web';
    default: return tool ? `Using ${tool}` : null;
  }
}

/** Truncate a shell command to a readable label */
function truncateCommand(cmd: string): string {
  // Take first line only, trim whitespace
  const line = cmd.split('\n')[0]!.trim();
  if (line.length <= 60) return line;
  return line.slice(0, 57) + '…';
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'Bash']);

/** Derive a phase label from the tool stream — null until there's a clear signal */
function getStreamPhase(events: BridgeEvent[]): string | null {
  let readOnlyCount = 0;
  let hasMutation = false;
  for (const e of events) {
    if (e.type !== 'tool_use') continue;
    const tool = String(e.data.tool || '');
    if (MUTATING_TOOLS.has(tool)) hasMutation = true;
    else if (READ_ONLY_TOOLS.has(tool)) readOnlyCount++;
  }
  if (!hasMutation && readOnlyCount >= 3) return 'researching';
  if (hasMutation) return 'applying changes';
  return null;
}

type StreamSegment =
  | { kind: 'tool_group'; tool: string; items: ToolGroupItem[] }
  | { kind: 'file_content'; file: string; content: string; ext: string; isPlan: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string };

/** Build a chronological timeline of interleaved tool actions and text from streaming events */
function buildStreamSegments(events: BridgeEvent[]): StreamSegment[] {
  const segments: StreamSegment[] = [];

  for (const e of events) {
    if (e.type === 'tool_use') {
      const label = formatToolEvent(e);
      const tool = String(e.data.tool || '');
      const file = e.data.file ? String(e.data.file) : null;
      const content = e.data.content ? String(e.data.content) : null;
      const detail = file ?? content ?? undefined;

      if (label) {
        const last = segments[segments.length - 1];
        if (last && last.kind === 'tool_group' && last.tool === tool) {
          last.items.push({ label, detail });
        } else {
          segments.push({ kind: 'tool_group', tool, items: [{ label, detail }] });
        }
      }

      // Surface file content for Write/Edit on text files
      if (content && file) {
        const ext = file.includes('.') ? `.${file.split('.').pop()!.toLowerCase()}` : '';
        const isPlan = file.includes('.claude/plans/');
        segments.push({ kind: 'file_content', file, content, ext, isPlan });
      }
    } else if (e.type === 'delta') {
      const text = String(e.data.text || '');
      if (!text) continue;
      const last = segments[segments.length - 1];
      if (last && last.kind === 'text') {
        last.text += text;
      } else {
        segments.push({ kind: 'text', text });
      }
    } else if (e.type === 'thinking') {
      const text = String(e.data.text || '');
      if (!text) continue;
      const last = segments[segments.length - 1];
      if (last && last.kind === 'thinking') {
        last.text += text;
      } else {
        segments.push({ kind: 'thinking', text });
      }
    }
  }

  return segments;
}

/** Collapsible inline display of file content written by the agent */
function FileContentBlock({
  file,
  content,
  ext,
  isPlan,
  onAccept,
}: {
  file: string;
  content: string;
  ext: string;
  isPlan: boolean;
  onAccept?: () => void;
}) {
  const [expanded, setExpanded] = useState(isPlan);
  const basename = file.split('/').pop() ?? file;
  const isMarkdown = ext === '.md';

  return (
    <div style={{
      margin: '4px 0 4px 12px',
      border: '1px solid rgba(0,0,0,0.08)',
      backgroundColor: 'rgba(255,255,255,0.6)',
      fontSize: 11,
    }}>
      <div
        onClick={() => setExpanded(v => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          cursor: 'pointer',
          userSelect: 'none',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: '#374151',
        }}
      >
        <span style={{ fontSize: 9, color: '#9ca3af' }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{basename}</span>
        {isPlan && <span style={{ fontSize: 9, color: '#6366f1', fontFamily: 'inherit' }}>plan</span>}
      </div>
      {expanded && (
        <>
          <div style={{
            maxHeight: 300,
            overflowY: 'auto',
            padding: '6px 10px',
            borderTop: '1px solid rgba(0,0,0,0.06)',
            lineHeight: 1.5,
            wordBreak: 'break-word',
          }}>
            {isMarkdown ? (
              renderMarkdown(content)
            ) : (
              <pre style={{
                margin: 0,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 11,
                whiteSpace: 'pre-wrap',
              }}>{content}</pre>
            )}
          </div>
          {isPlan && onAccept && (
            <div style={{ padding: '4px 8px', borderTop: '1px solid rgba(0,0,0,0.06)', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={(e) => { e.stopPropagation(); onAccept(); }}
                style={{
                  background: '#111',
                  color: '#fff',
                  border: 'none',
                  padding: '4px 12px',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Accept
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Summarize a tool group into a single collapsed label */
/** Run-length encode consecutive identical strings: ["a","a","b","a","a","a"] → ["a (x2)","b","a (x3)"] */
function rlEncode(items: string[]): string[] {
  const runs: { val: string; count: number }[] = [];
  for (const v of items) {
    const last = runs[runs.length - 1];
    if (last && last.val === v) last.count++;
    else runs.push({ val: v, count: 1 });
  }
  return runs.map(r => r.count > 1 ? `${r.val} (x${r.count})` : r.val);
}

function toolGroupSummary(tool: string, items: ToolGroupItem[]): string {
  switch (tool) {
    case 'Bash': {
      const cmds = items.map(it => (it.label || '').split(/\s/)[0]!).filter(Boolean);
      return `Used Bash: ${rlEncode(cmds).join(', ')}`;
    }
    case 'Read':
      return `Read: ${items.map(it => it.label.replace(/^Reading /, '')).join(', ')}`;
    case 'Edit':
      return `Edited: ${items.map(it => it.label.replace(/^Editing /, '')).join(', ')}`;
    case 'Write':
      return `Wrote: ${items.map(it => it.label.replace(/^Writing /, '')).join(', ')}`;
    case 'Grep':
      return items.length === 1 ? 'Searched code' : `Searched code (${items.length})`;
    case 'Glob':
      return items.length === 1 ? 'Searched files' : `Searched files (${items.length})`;
    default:
      return `Used ${tool}: ${items.map(it => it.label).join(', ')}`;
  }
}

const TOOL_GROUP_STYLE: CSSProperties = {
  fontSize: 11,
  color: '#9ca3af',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  lineHeight: 1.6,
};

/** Render an expanded item label with the command/filename bolded */
function BoldedItemLabel({ label }: { label: string }) {
  const spaceIdx = label.indexOf(' ');
  if (spaceIdx === -1) return <>{label}</>;
  return <><b>{label.slice(0, spaceIdx)}</b>{label.slice(spaceIdx)}</>;
}

/** Collapsible line showing a group of same-tool invocations */
function ToolGroupLine({ tool, items }: { tool: string; items: ToolGroupItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = items.length > 1;

  return (
    <div style={TOOL_GROUP_STYLE}>
      <div
        onClick={canExpand ? () => setExpanded(v => !v) : undefined}
        style={{ cursor: canExpand ? 'pointer' : 'default', userSelect: 'none', color: '#9ca3af' }}
      >
        {canExpand && (
          <span style={{ fontSize: 13, marginRight: 4 }}>{expanded ? '\u25BE' : '\u25B8'}</span>
        )}
        {toolGroupSummary(tool, items)}
      </div>
      {expanded && (
        <div style={{ marginLeft: 17 }}>
          {items.map((it, j) => (
            <div key={j}><BoldedItemLabel label={it.detail ?? it.label} /></div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ThreadPanel({
  threadId,
  bridgeUrl,
  accentColor,
  isStreaming,
  streamingEvents,
  onClose,
  onReply,
  onCancel,
  lastError,
  onMouseEnter: onPanelMouseEnter,
  toolbarRef,
  currentModel,
  currentProvider,
  annotationNumber,
  annotationText,
}: ThreadPanelProps) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [replyImages, setReplyImages] = useState<Blob[]>([]);
  const [inputFocused, setInputFocused] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [belowCount, setBelowCount] = useState(0);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const prevStreamingRef = useRef(isStreaming);

  // Draggable position — persisted to localStorage
  const positionRef = useRef(getDefaultPosition());
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const dockedRight = useRef(true); // true = track right edge on resize
  const [, forceUpdate] = useState(0);

  // On mount, restore saved position
  useEffect(() => {
    try {
      const stored = localStorage.getItem(THREAD_POS_KEY);
      if (stored) {
        const pos = JSON.parse(stored);
        if (typeof pos.top === 'number' && typeof pos.left === 'number') {
          const maxLeft = window.innerWidth - PANEL_BOX_WIDTH - EDGE_PAD;
          const clamped = {
            top: Math.max(EDGE_PAD, Math.min(pos.top, window.innerHeight - EDGE_PAD - 200)),
            left: Math.max(EDGE_PAD, Math.min(pos.left, maxLeft)),
          };
          // Consider docked if within 2px of right edge
          dockedRight.current = clamped.left >= maxLeft - 2;
          positionRef.current = clamped;
          forceUpdate(n => n + 1);
        }
      }
    } catch { /* ignore */ }
  }, []);

  // Recalculate on resize — if docked to right edge, snap to default;
  // otherwise clamp to stay within viewport.
  useEffect(() => {
    const onResize = () => {
      if (dockedRight.current) {
        positionRef.current = getDefaultPosition();
      } else {
        const pos = positionRef.current;
        const maxLeft = window.innerWidth - PANEL_BOX_WIDTH - EDGE_PAD;
        positionRef.current = {
          top: Math.max(EDGE_PAD, Math.min(pos.top, window.innerHeight - EDGE_PAD - 200)),
          left: Math.max(EDGE_PAD, Math.min(pos.left, maxLeft)),
        };
      }
      forceUpdate(n => n + 1);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // All drag handling via native listeners — bypasses React event delegation
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
      dragging.current = true;
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        offsetX: dragOffset.current.x,
        offsetY: dragOffset.current.y,
      };
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const ds = dragStart.current;
      const rawX = ds.offsetX + (e.clientX - ds.x);
      const rawY = ds.offsetY + (e.clientY - ds.y);

      const clampedLeft = Math.max(EDGE_PAD, Math.min(window.innerWidth - PANEL_BOX_WIDTH - EDGE_PAD, positionRef.current.left + rawX));
      const clampedTop = Math.max(EDGE_PAD, positionRef.current.top + rawY);

      dragOffset.current = {
        x: clampedLeft - positionRef.current.left,
        y: clampedTop - positionRef.current.top,
      };

      const panel = panelRef.current;
      if (!panel) return;
      panel.style.top = `${clampedTop}px`;
      panel.style.left = `${clampedLeft}px`;
      panel.style.height = `${getMaxHeight(clampedTop, clampedLeft, toolbarRef?.current)}px`;
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      const finalTop = positionRef.current.top + dragOffset.current.y;
      const finalLeft = positionRef.current.left + dragOffset.current.x;
      positionRef.current = { top: finalTop, left: finalLeft };
      dragOffset.current = { x: 0, y: 0 };
      const maxLeft = window.innerWidth - PANEL_BOX_WIDTH - EDGE_PAD;
      dockedRight.current = finalLeft >= maxLeft - 2;
      try { localStorage.setItem(THREAD_POS_KEY, JSON.stringify({ top: finalTop, left: finalLeft })); } catch { /* ignore */ }
      dragging.current = false;
    };

    const onDoubleClick = () => {
      positionRef.current = getDefaultPosition();
      dragOffset.current = { x: 0, y: 0 };
      dockedRight.current = true;
      try { localStorage.removeItem(THREAD_POS_KEY); } catch { /* ignore */ }
      forceUpdate(n => n + 1);
    };

    header.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    header.addEventListener('dblclick', onDoubleClick);

    return () => {
      header.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      header.removeEventListener('dblclick', onDoubleClick);
    };
  }, []);

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

  // Build a unified chronological timeline interleaving tool events and text
  const streamSegments = streamingEvents ? buildStreamSegments(streamingEvents) : [];
  const streamPhase = streamingEvents ? getStreamPhase(streamingEvents) : null;

  // Track scroll position
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const threshold = 40;
      setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < threshold);
      // Count message blocks whose bottom edge is below the visible area
      const visibleBottom = el.scrollTop + el.clientHeight;
      const msgs = el.querySelectorAll('[data-msg]');
      let count = 0;
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i] as HTMLElement;
        if (m.offsetTop + m.offsetHeight > visibleBottom + 20) count++;
      }
      setBelowCount(count);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll to bottom on new content (only if already at bottom)
  useEffect(() => {
    if (atBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamSegments.length, isStreaming, atBottom]);

  // Close on Escape — stopPropagation prevents the AnnotationCanvas handler
  // (which listens on window) from also clearing the annotation selection.
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Close on click outside is handled by the backdrop element below

  const handleSubmit = useCallback(() => {
    if (!replyText.trim() || !onReply) return;
    const text = replyText.trim();
    const images = replyImages.length > 0 ? replyImages : undefined;
    // Create object URLs for immediate thumbnail display
    const localImageUrls = images ? images.map(b => URL.createObjectURL(b)) : undefined;
    // Optimistically show the reply immediately
    setMessages(prev => [...prev, {
      role: 'human' as const,
      timestamp: Date.now(),
      jobId: 'pending',
      replyToQuestion: text,
      ...(localImageUrls ? { replyImageUrls: localImageUrls } : {}),
    }]);
    onReply(threadId, text, images);
    setReplyText('');
    setReplyImages([]);
  }, [replyText, replyImages, threadId, onReply]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    const imageBlobs: Blob[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageBlobs.push(file);
      }
    }
    if (imageBlobs.length > 0) {
      e.preventDefault();
      setReplyImages(prev => [...prev, ...imageBlobs]);
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const currentTop = positionRef.current.top + dragOffset.current.y;
  const currentLeft = positionRef.current.left + dragOffset.current.x;
  const maxHeight = getMaxHeight(currentTop, currentLeft, toolbarRef?.current);

  return (
    <>
    {/* Invisible backdrop to catch clicks outside the panel */}
    <div
      data-devtools="thread-panel-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
      }}
    />
    <div
      ref={panelRef}
      style={{
        ...basePanelStyle,
        height: maxHeight,
        position: 'fixed',
        top: currentTop,
        left: currentLeft,
        zIndex: 10000,
      }}
      data-devtools="thread-panel"
      onMouseEnter={onPanelMouseEnter}
    >
      {(() => {
        const tileColor = isStreaming ? accentColor : 'rgb(0,0,0)';
        const svgTile = `<svg xmlns='http://www.w3.org/2000/svg' width='5' height='5'><path d='M-1,1 l2,-2 M0,5 l5,-5 M4,6 l2,-2' stroke='${tileColor}' stroke-width='.75'/></svg>`;
        const bgUrl = `url("data:image/svg+xml,${encodeURIComponent(svgTile)}")`;
        return (
          <>
            <style>{`@keyframes popmelt-border-march { to { background-position: 0 -5px; } }
[data-popmelt-reply]::placeholder { opacity: 0.35; }`}</style>
            <div style={{
              position: 'absolute',
              inset: -3,
              padding: 5,
              backgroundImage: bgUrl,
              backgroundSize: '5px 5px',
              WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) border-box',
              WebkitMaskComposite: 'xor',
              mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0) border-box',
              maskComposite: 'exclude' as string,
              pointerEvents: 'none' as const,
              ...(isStreaming && { animation: 'popmelt-border-march 0.8s linear infinite' }),
            }} />
          </>
        );
      })()}
      {/* Inner clip wrapper — needed so overflow:visible on outer panel (for animated border) doesn't leak content */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1, minHeight: 0 }}>
      {/* Header — draggable via native listeners */}
      <div
        ref={headerRef}
        style={{ ...baseHeaderStyle, backgroundColor: accentColor, color: '#ffffff', cursor: 'grab', userSelect: 'none', WebkitUserSelect: 'none' } as CSSProperties}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
          <span style={{ flexShrink: 0 }}>{annotationNumber ? `${annotationNumber}.` : 'Conversation'}</span>
          {annotationText && (
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {annotationText}
            </span>
          )}
        </span>
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

      {/* Scrollbar-on-hover CSS + selection highlight mirroring annotation color */}
      <style dangerouslySetInnerHTML={{ __html: SCROLLBAR_CSS + `
[data-devtools="thread-panel"] ::selection { background: color-mix(in srgb, ${accentColor} 15%, transparent); }
` }} />

      {/* Messages */}
      <div ref={scrollRef} style={{ ...messagesStyle, opacity: inputFocused && replyText.trim() ? 0.65 : 1, transition: 'opacity 150ms ease' }} data-devtools="thread-panel-messages">
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
          // Cancelled or errored jobs get a distinct message
          if (msg.cancelled || msg.error) {
            return (
              <div
                data-msg
                key={`${msg.jobId}-${i}`}
                style={{
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11, color: msg.error ? '#dc2626' : '#9ca3af', fontStyle: 'italic' }}>
                    {msg.error ? 'Error' : 'Cancelled'}
                  </span>
                  <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 'auto' }}>
                    {formatTimestamp(msg.timestamp)}
                  </span>
                </div>
                {msg.error && (
                  <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.4 }}>
                    {msg.error}
                  </div>
                )}
              </div>
            );
          }

          const text = isHuman
            ? (msg.replyToQuestion || msg.feedbackSummary || '(annotation)')
            : stripInternalTags(msg.responseText || '');

          // Show the question field separately (it's stripped from responseText by stripInternalTags)
          const questionText = !isHuman ? msg.question : undefined;

          // Build resolution summary for assistant messages that applied changes
          const hasResolutions = !isHuman && msg.resolutions && msg.resolutions.length > 0;
          const hasSegments = !isHuman && msg.segments && msg.segments.length > 0;
          const hasToolsUsed = !isHuman && !hasSegments && msg.toolsUsed && msg.toolsUsed.length > 0;

          if (!text && !questionText && !hasResolutions && !hasSegments) return null;


          return (
            <div
              data-msg
              key={`${msg.jobId}-${i}`}
              style={{
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}>
                {!isHuman && <ProviderIcon provider={msg.provider} size={11} style={{ color: '#6b7280' }} />}
                <span style={{
                  fontWeight: 600,
                  fontSize: 11,
                  color: isHuman ? accentColor : '#6b7280',
                }}>
                  {isHuman ? 'You' : modelLabel(msg.model, msg.provider)}
                </span>
                <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 'auto' }}>
                  {formatTimestamp(msg.timestamp)}
                </span>
              </div>
              {/* Human messages: inline thumbnails next to route/annotation */}
              {isHuman && !msg.replyToQuestion && (() => {
                const routeSections = text ? parseRouteSections(text) : null;

                if (routeSections && msg.screenshotUrls) {
                  // Multi-page: render each route section with thumbnail to the left
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {routeSections.map((sec, j) => {
                        const relUrl = msg.screenshotUrls?.[sec.route];
                        const thumbUrl = relUrl ? `${bridgeUrl}${relUrl}` : null;
                        return (
                          <div key={j} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                            {thumbUrl ? (
                              <img
                                src={thumbUrl}
                                title={sec.route}
                                style={{ ...thumbStyle, flexShrink: 0, marginTop: 1 }}
                                onClick={() => setLightboxSrc(thumbUrl)}
                              />
                            ) : (
                              <div style={{ width: THUMB_SIZE, height: THUMB_SIZE, flexShrink: 0 }} />
                            )}
                            <div style={{ lineHeight: 1.5, wordBreak: 'break-word', minWidth: 0 }}>
                              <code style={{
                                fontSize: 10,
                                backgroundColor: 'rgba(0,0,0,0.06)',
                                padding: '1px 4px',
                              }}>{sec.route}</code>
                              {sec.text && <div style={{ marginTop: 2 }}>{renderMarkdown(sec.text)}</div>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                }

                // Single-page: thumbnail left, text right
                const thumbUrl = msg.screenshotUrl ? `${bridgeUrl}${msg.screenshotUrl}` : null;
                if (thumbUrl && text) {
                  return (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <img
                        src={thumbUrl}
                        title="screenshot"
                        style={{ ...thumbStyle, flexShrink: 0, marginTop: 1 }}
                        onClick={() => setLightboxSrc(thumbUrl)}
                      />
                      <div style={{ lineHeight: 1.5, wordBreak: 'break-word', minWidth: 0 }}>
                        {text.includes('\n') ? renderMarkdown(text) : text}
                      </div>
                    </div>
                  );
                }

                // No screenshot — plain text
                if (text) {
                  return (
                    <div style={{ lineHeight: 1.5, wordBreak: 'break-word' }}>
                      {text.includes('\n') ? renderMarkdown(text) : text}
                    </div>
                  );
                }
                return null;
              })()}
              {/* Reply messages or assistant: plain text */}
              {isHuman && msg.replyToQuestion && text && (
                <div style={{ lineHeight: 1.5, wordBreak: 'break-word' }}>
                  {text.includes('\n') ? renderMarkdown(text) : text}
                </div>
              )}
              {!isHuman && hasSegments && msg.segments!.map((seg, si) => {
                if (seg.kind === 'tool_group') {
                  return <ToolGroupLine key={si} tool={seg.tool} items={seg.items} />;
                }
                const stripped = stripInternalTags(seg.text);
                if (!stripped) return null;
                return (
                  <div key={si} style={{ lineHeight: 1.5, wordBreak: 'break-word' }}>
                    {renderMarkdown(stripped)}
                  </div>
                );
              })}
              {!isHuman && !hasSegments && text && (
                <div style={{ lineHeight: 1.5, wordBreak: 'break-word' }}>
                  {renderMarkdown(text)}
                </div>
              )}
              {/* Reply image thumbnails */}
              {isHuman && msg.replyToQuestion && (() => {
                const images = collectReplyImages(msg, bridgeUrl);
                if (images.length === 0) return null;
                return (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    {images.map((img, j) => (
                      <img key={j} src={img.url} title={img.label} style={thumbStyle} onClick={() => setLightboxSrc(img.url)} />
                    ))}
                  </div>
                );
              })()}
              {/* Pasted annotation images (not screenshots) */}
              {isHuman && !msg.replyToQuestion && (() => {
                const images = collectPastedImages(msg, bridgeUrl);
                if (images.length === 0) return null;
                return (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    {images.map((img, j) => (
                      <img key={j} src={img.url} title={img.label} style={thumbStyle} onClick={() => setLightboxSrc(img.url)} />
                    ))}
                  </div>
                );
              })()}
              {questionText && (
                <div style={{
                  lineHeight: 1.5,
                  wordBreak: 'break-word',
                }}>
                  {renderMarkdown(questionText)}
                </div>
              )}
              {/* Tool activity + resolution summary */}
              {(hasToolsUsed || hasResolutions) && (
                <div style={{
                  padding: '8px 16px',
                  backgroundColor: 'rgba(0, 0, 0, 0.03)',
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: '#374151',
                }}>
                  {hasToolsUsed && (
                    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10 }}>
                      {msg.toolsUsed!.map((t, j) => (
                        <div key={j}>{t}</div>
                      ))}
                    </div>
                  )}
                  {hasResolutions && msg.resolutions!.map((r, j) => {
                    const scope = r.finalScope ?? r.inferredScope;
                    const scopeLabel = scope ? `${scope.breadth} \u00b7 ${scope.target}` : null;
                    return (
                      <div key={j} style={{ marginTop: hasToolsUsed ? 4 : 0 }}>
                        <span style={{ color: r.status === 'resolved' ? '#10b981' : '#f59e0b' }}>
                          {r.status === 'resolved' ? 'Done' : 'Needs review'}
                        </span>
                        {r.summary ? ` \u2014 ${r.summary}` : ''}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Live streaming section — unified chronological timeline */}
        {isStreaming && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Claude header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <ProviderIcon provider={currentProvider} size={11} style={{ color: '#6b7280' }} />
              <span style={{ fontWeight: 600, fontSize: 11, color: '#6b7280' }}>
                {modelLabel(currentModel, currentProvider)}
              </span>
            </div>

            {/* Interleaved tool actions, thinking, and response text */}
            {streamSegments.map((seg, i) => {
              if (seg.kind === 'tool_group') {
                return <ToolGroupLine key={i} tool={seg.tool} items={seg.items} />;
              }
              if (seg.kind === 'file_content') {
                return (
                  <FileContentBlock
                    key={i}
                    file={seg.file}
                    content={seg.content}
                    ext={seg.ext}
                    isPlan={seg.isPlan}
                    onAccept={seg.isPlan && onReply ? () => onReply(threadId, 'Looks good, please proceed with implementation.') : undefined}
                  />
                );
              }
              if (seg.kind === 'thinking') {
                return (
                  <div
                    key={i}
                    style={{
                      paddingLeft: 12,
                      fontSize: 11,
                      color: '#9ca3af',
                      fontStyle: 'italic',
                      lineHeight: 1.4,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: 80,
                      overflowY: 'auto',
                    }}
                  >
                    {seg.text}
                  </div>
                );
              }
              // text segment
              const stripped = stripInternalTags(seg.text);
              if (!stripped) return null;
              return (
                <div
                  key={i}
                  style={{
                    paddingLeft: 12,
                    lineHeight: 1.5,
                    wordBreak: 'break-word',
                  }}
                >
                  {renderMarkdown(stripped)}
                </div>
              );
            })}

            {/* Thinking spinner + cancel at bottom of stream */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ThinkingBadge color={accentColor} />
              {onCancel && (
                <button onClick={onCancel} style={{
                  background: 'none', border: '1px solid rgba(0,0,0,0.1)',
                  color: '#6b7280', fontSize: 10, padding: '2px 8px',
                  cursor: 'pointer', fontFamily: 'inherit',
                  marginLeft: 'auto',
                }}>Cancel</button>
              )}
            </div>
          </div>
        )}

        {/* Scroll-to-bottom pill — sticky inside scroll container */}
        {!atBottom && messages.length > 0 && (
          <div style={{ position: 'sticky', bottom: 5, display: 'flex', justifyContent: 'flex-end', paddingRight: 3, pointerEvents: 'none' }}>
            <button
              onClick={() => {
                if (scrollRef.current) {
                  scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
                }
              }}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 4,
                fontSize: 10,
                fontFamily: FONT_FAMILY,
                color: 'transparent',
                backgroundColor: '#eaeaea',
                backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='5' height='5'><path d='M-1,1 l2,-2 M0,5 l5,-5 M4,6 l2,-2' stroke='rgb(0,0,0)' stroke-width='.75'/></svg>`)}")`,
                backgroundSize: '5px 5px',
                border: 'none',
                borderRadius: 0,
                cursor: 'pointer',
                pointerEvents: 'auto',
                userSelect: 'none',
              }}
            >
              <span style={{
                position: 'relative',
                backgroundColor: '#eaeaea',
                padding: '0 6px',
                color: '#374151',
                fontFamily: FONT_FAMILY,
                lineHeight: 1.4,
              }}>
                {belowCount} message{belowCount !== 1 ? 's' : ''} ↓
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Error banner */}
      {!isStreaming && lastError && (
        <div style={{
          padding: '8px 16px', backgroundColor: 'rgba(239, 68, 68, 0.06)',
          fontSize: 11, color: '#dc2626', lineHeight: 1.4,
        }}>
          <span style={{ fontWeight: 600 }}>Error: </span>{lastError}
        </div>
      )}

      {/* Reply area */}
      {onReply && (
        <div style={{ flexShrink: 0, position: 'relative' }}>
          {replyImages.length > 0 && (
            <div style={{ position: 'absolute', bottom: '100%', display: 'flex', gap: 4, padding: '6px 5px 5px', flexWrap: 'wrap' }}>
              {replyImages.map((blob, i) => (
                <span
                  key={i}
                  onClick={() => setReplyImages(prev => prev.filter((_, j) => j !== i))}
                  onMouseEnter={(e) => { const x = e.currentTarget.querySelector('[data-chip-x]') as HTMLElement; if (x) x.style.color = '#fff'; }}
                  onMouseLeave={(e) => { const x = e.currentTarget.querySelector('[data-chip-x]') as HTMLElement; if (x) x.style.color = 'rgba(255,255,255,0.4)'; }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 10,
                    color: '#fff',
                    backgroundColor: accentColor,
                    backdropFilter: 'blur(4px)',
                    padding: '2px 6px 2px 6px',
                    cursor: 'pointer',
                  }}
                >
                  image {i + 1}
                  <span data-chip-x style={{ fontSize: 12, lineHeight: 1, color: 'rgba(255,255,255,0.4)' }}>&times;</span>
                </span>
              ))}
            </div>
          )}
          <div style={{ ...replyAreaStyle, borderTop: `1px solid ${inputFocused && replyText.trim() ? accentColor : 'rgba(0,0,0,0.12)'}` }}>
          <input
            data-popmelt-reply
            autoFocus
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste as unknown as React.ClipboardEventHandler<HTMLInputElement>}
            placeholder="Reply here (cmd + enter to send)"
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 44,
              padding: '0 4px',
              fontSize: 12,
              fontFamily: FONT_FAMILY,
              backgroundColor: 'transparent',
              color: '#1f2937',
              border: 'none',
              outline: 'none',
              lineHeight: '40px',
              boxSizing: 'border-box',
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!replyText.trim()}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              padding: 0,
              background: 'none',
              border: 'none',
              cursor: replyText.trim() ? 'pointer' : 'default',
              color: replyText.trim() ? accentColor : 'rgba(0,0,0,0.2)',
              flexShrink: 0,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z" />
              <path d="M6 12h16" />
            </svg>
          </button>
          </div>
        </div>
      )}
      </div>{/* end inner clip wrapper */}
    </div>
    {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
