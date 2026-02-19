'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { BridgeEvent } from '../hooks/useBridgeConnection';
import { POPMELT_BORDER } from '../styles/border';
import { FONT_FAMILY, PADDING } from '../tools/text';
import { renderMarkdown } from '../utils/threadMarkdown';

type ThreadMessage = {
  role: 'human' | 'assistant';
  timestamp: number;
  jobId: string;
  feedbackSummary?: string;
  responseText?: string;
  question?: string;
  replyToQuestion?: string;
  toolsUsed?: string[];
  resolutions?: {
    annotationId: string;
    status: string;
    summary: string;
    filesModified?: string[];
    declaredScope?: { breadth: string; target: string } | null;
    inferredScope?: { breadth: string; target: string } | null;
    finalScope?: { breadth: string; target: string } | null;
  }[];
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
  streamingEvents?: BridgeEvent[];
  onClose: () => void;
  onReply?: (threadId: string, reply: string, images?: Blob[]) => void;
  activePlan?: { planId: string; status: string; goal: string; tasks?: { id: string; instruction: string }[] } | null;
  planAnnotations?: PlanAnnotation[];
  inFlightJobs?: Record<string, { annotationIds: string[]; threadId?: string }>;
  onViewThread?: (threadId: string) => void;
  onApprovePlan?: () => void;
  onDismissPlan?: () => void;
};

const PANEL_WIDTH = 400;
const EDGE_PAD = 16;
const BORDER = 3; // POPMELT_BORDER borderWidth
const TOOLBAR_GAP = 16;
const THREAD_POS_KEY = 'devtools-thread-panel-position';

/** Right-aligned with the toolbar (right: 16), top: 16 */
function getDefaultPosition() {
  return {
    top: EDGE_PAD,
    left: window.innerWidth - PANEL_WIDTH - 2 * BORDER - EDGE_PAD,
  };
}

function getMaxHeight(top: number, left: number) {
  const toolbar = document.getElementById('devtools-toolbar');
  const toolbarRect = toolbar?.getBoundingClientRect();
  let bottomLimit = window.innerHeight - EDGE_PAD;
  if (toolbarRect && left + PANEL_WIDTH + 2 * BORDER > toolbarRect.left) {
    bottomLimit = toolbarRect.top - TOOLBAR_GAP;
  }
  return Math.max(200, bottomLimit - Math.max(0, top));
}

const basePanelStyle: CSSProperties = {
  width: PANEL_WIDTH,
  backgroundColor: '#ffffff',
  ...POPMELT_BORDER,
  boxSizing: 'content-box',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
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
  margin: '3px 3px 0',
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

/** Claude logo icon */
function ClaudeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1200 1200" fill="#6b7280" stroke="none" style={{ flexShrink: 0 }}>
      <path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z" />
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

/** Format a single tool_use event into a step label */
function formatToolEvent(event: BridgeEvent): string | null {
  const tool = String(event.data.tool || '');
  const file = event.data.file ? String(event.data.file) : null;
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
  | { kind: 'tool'; label: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string };

/** Build a chronological timeline of interleaved tool actions and text from streaming events */
function buildStreamSegments(events: BridgeEvent[]): StreamSegment[] {
  const segments: StreamSegment[] = [];

  for (const e of events) {
    if (e.type === 'tool_use') {
      const label = formatToolEvent(e);
      if (label) segments.push({ kind: 'tool', label });
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

export function ThreadPanel({
  threadId,
  bridgeUrl,
  accentColor,
  isStreaming,
  streamingEvents,
  onClose,
  onReply,
  activePlan,
  planAnnotations,
  inFlightJobs,
  onViewThread,
  onApprovePlan,
  onDismissPlan,
}: ThreadPanelProps) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [replyImages, setReplyImages] = useState<Blob[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const prevStreamingRef = useRef(isStreaming);

  // Draggable position — persisted to localStorage
  const positionRef = useRef(getDefaultPosition());
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const hasSavedPosition = useRef(false);
  const [, forceUpdate] = useState(0);

  // On mount, restore saved position
  useEffect(() => {
    try {
      const stored = localStorage.getItem(THREAD_POS_KEY);
      if (stored) {
        const pos = JSON.parse(stored);
        if (typeof pos.top === 'number' && typeof pos.left === 'number') {
          hasSavedPosition.current = true;
          positionRef.current = { top: pos.top, left: pos.left };
          forceUpdate(n => n + 1);
        }
      }
    } catch { /* ignore */ }
  }, []);

  // Recalculate on resize
  useEffect(() => {
    const onResize = () => {
      if (!hasSavedPosition.current) {
        positionRef.current = getDefaultPosition();
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

      const clampedLeft = Math.max(EDGE_PAD, Math.min(window.innerWidth - PANEL_WIDTH - 2 * BORDER - EDGE_PAD, positionRef.current.left + rawX));
      const clampedTop = Math.max(EDGE_PAD, positionRef.current.top + rawY);

      dragOffset.current = {
        x: clampedLeft - positionRef.current.left,
        y: clampedTop - positionRef.current.top,
      };

      const panel = panelRef.current;
      if (!panel) return;
      panel.style.top = `${clampedTop}px`;
      panel.style.left = `${clampedLeft}px`;
      panel.style.height = `${getMaxHeight(clampedTop, clampedLeft)}px`;
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      const finalTop = positionRef.current.top + dragOffset.current.y;
      const finalLeft = positionRef.current.left + dragOffset.current.x;
      positionRef.current = { top: finalTop, left: finalLeft };
      dragOffset.current = { x: 0, y: 0 };
      hasSavedPosition.current = true;
      try { localStorage.setItem(THREAD_POS_KEY, JSON.stringify({ top: finalTop, left: finalLeft })); } catch { /* ignore */ }
      dragging.current = false;
    };

    const onDoubleClick = () => {
      positionRef.current = getDefaultPosition();
      dragOffset.current = { x: 0, y: 0 };
      hasSavedPosition.current = false;
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

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamSegments.length, isStreaming]);

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
    // Optimistically show the reply immediately
    setMessages(prev => [...prev, {
      role: 'human' as const,
      timestamp: Date.now(),
      jobId: 'pending',
      replyToQuestion: images ? `${text} [${images.length} image${images.length > 1 ? 's' : ''}]` : text,
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
  const maxHeight = getMaxHeight(currentTop, currentLeft);

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
      style={{ ...basePanelStyle, height: maxHeight, position: 'fixed', top: currentTop, left: currentLeft, zIndex: 10000 }}
      data-devtools="thread-panel"
    >
      {/* Header — draggable via native listeners */}
      <div
        ref={headerRef}
        style={{ ...baseHeaderStyle, backgroundColor: accentColor, color: '#ffffff', cursor: 'grab', userSelect: 'none', WebkitUserSelect: 'none' } as CSSProperties}
      >
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
            : stripInternalTags(msg.responseText || '');

          // Show the question field separately (it's stripped from responseText by stripInternalTags)
          const questionText = !isHuman ? msg.question : undefined;

          // Build resolution summary for assistant messages that applied changes
          const hasResolutions = !isHuman && msg.resolutions && msg.resolutions.length > 0;
          const hasToolsUsed = !isHuman && msg.toolsUsed && msg.toolsUsed.length > 0;

          if (!text && !questionText && !hasResolutions) return null;

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
              {text && (
                <div style={{
                  lineHeight: 1.5,
                  wordBreak: 'break-word',
                }}>
                  {isHuman ? text : renderMarkdown(text)}
                </div>
              )}
              {questionText && (
                <div style={{
                  marginTop: text ? 4 : 0,
                  lineHeight: 1.5,
                  wordBreak: 'break-word',
                }}>
                  {renderMarkdown(questionText)}
                </div>
              )}
              {/* Tool activity + resolution summary */}
              {(hasToolsUsed || hasResolutions) && (
                <div style={{
                  marginTop: text || questionText ? 6 : 0,
                  padding: '4px 8px',
                  backgroundColor: 'rgba(0, 0, 0, 0.03)',
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: '#6b7280',
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
                        {scopeLabel && (
                          <span style={{
                            marginLeft: 6,
                            padding: '1px 5px',
                            backgroundColor: 'rgba(0, 0, 0, 0.06)',
                            fontSize: 10,
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          }}>
                            {scopeLabel}
                          </span>
                        )}
                        {r.summary ? ` \u2014 ${r.summary}` : ''}
                      </div>
                    );
                  })}
                </div>
              )}
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
              const isInFlight = inFlightJobs && Object.values(inFlightJobs).some(j => j.annotationIds.includes(ann.id));
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

        {/* Plan approval — inline after the task list */}
        {activePlan?.status === 'awaiting_approval' && onApprovePlan && onDismissPlan && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid rgba(0, 0, 0, 0.04)' }}>
            <div style={{ fontWeight: 600, fontSize: 12 }}>
              {planAnnotations?.length ?? 0} task{(planAnnotations?.length ?? 0) !== 1 ? 's' : ''} planned
            </div>
            <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2, marginBottom: 8 }}>
              Review annotations, then approve to start workers
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={onApprovePlan}
                style={{
                  padding: '5px 14px',
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
                onClick={onDismissPlan}
                style={{
                  padding: '5px 14px',
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
          </div>
        )}

        {/* Live streaming section — unified chronological timeline */}
        {isStreaming && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid rgba(0, 0, 0, 0.04)' }}>
            {/* Claude header with crosshair thinking badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
              <ClaudeIcon size={11} />
              <span style={{ fontWeight: 600, fontSize: 11, color: '#6b7280' }}>
                Claude Code
              </span>
              {streamPhase && (
                <span style={{ fontSize: 10, color: '#b0b7c3', fontStyle: 'italic' }}>
                  {streamPhase}
                </span>
              )}
              <span style={{ marginLeft: 'auto' }}>
                <ThinkingBadge color={accentColor} />
              </span>
            </div>

            {/* Interleaved tool actions, thinking, and response text */}
            {streamSegments.map((seg, i) => {
              if (seg.kind === 'tool') {
                return (
                  <div
                    key={i}
                    style={{
                      paddingLeft: 12,
                      fontSize: 11,
                      color: '#9ca3af',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      lineHeight: 1.6,
                    }}
                  >
                    {seg.label}
                  </div>
                );
              }
              if (seg.kind === 'thinking') {
                return (
                  <div
                    key={i}
                    style={{
                      paddingLeft: 12,
                      marginTop: 2,
                      marginBottom: 2,
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
                    marginTop: 2,
                    marginBottom: 2,
                    lineHeight: 1.5,
                    wordBreak: 'break-word',
                  }}
                >
                  {renderMarkdown(stripped)}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Reply area */}
      {onReply && (
        <div style={replyAreaStyle}>
          {replyImages.length > 0 && (
            <div style={{
              fontSize: 11,
              color: '#6b7280',
              marginBottom: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}>
              <span>{replyImages.length} image{replyImages.length > 1 ? 's' : ''} attached</span>
              <button
                onClick={() => setReplyImages([])}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 11,
                  color: '#9ca3af',
                  padding: '0 2px',
                }}
              >
                &times;
              </button>
            </div>
          )}
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
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
