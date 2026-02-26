'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { FONT_FAMILY, LINE_HEIGHT, MAX_DISPLAY_WIDTH, PADDING, getEffectiveMaxWidth, wrapLines } from '../tools/text';
import type { Annotation, AnnotationLifecycleStatus } from '../tools/types';
import { findElementBySelector } from '../utils/dom';

export const BADGE_HEIGHT = 22; // Matches ElementHighlight tooltip height
export const BADGE_HIT_PAD = 12; // Invisible expanded hit area around badges

// Thinking spinner for in-flight annotations
const SPINNER_FRAME_COUNT = 3;
const SPINNER_INTERVAL = 250;

const THINKING_WORDS = [
  'reviewing', 'considering', 'thinking', 'zhuzhing',
  'iterating', 'tweaking', 'reflecting', 'noodling',
  'pondering', 'finessing', 'polishing', 'riffing',
];
const WORD_INTERVAL = 3000;


/**
 * Fixed-position badge wrapper that stays within the viewport via CSS clamping.
 * left/top are clamped to ≥0, and translate() pulls the badge back if it
 * overflows the right or bottom edge. 100% inside translate refers to the
 * element's own rendered size, so no JS measurement is needed.
 */
export function BadgeHitArea({ left, top, style, children, ...props }: {
  left: number;
  top: number;
  style?: CSSProperties;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'style'>) {
  return (
    <div data-devtools="badge-hit-area" {...props} style={{
      position: 'fixed',
      left: `max(0px, ${left}px)`,
      top: `max(0px, ${top}px)`,
      padding: BADGE_HIT_PAD,
      transform: `translate(min(0px, calc(100vw - max(0px, ${left}px) - 100%)), min(0px, calc(100vh - max(0px, ${top}px) - 100%)))`,
      ...style,
    }}>
      {children}
    </div>
  );
}

// Unified badge: shows thinking spinner when in-flight, reply count when resolved.
// Click always opens the thread panel.
export function AnnotationBadges({
  annotations,
  supersededAnnotations,
  inFlightIds,
  scrollX,
  scrollY,
  annotationGroupMap,
  onViewThread,
  onSelectAnnotation,
  canvasRef,
}: {
  annotations: Annotation[];
  supersededAnnotations: Set<Annotation>;
  inFlightIds?: Set<string>;
  scrollX: number;
  scrollY: number;
  annotationGroupMap: Map<string, number>;
  onViewThread?: (threadId: string) => void;
  onSelectAnnotation?: (id: string) => void;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
}) {
  const [charIndex, setCharIndex] = useState(0);
  const [wordIndex, setWordIndex] = useState(() => Math.floor(Math.random() * THINKING_WORDS.length));

  // Only run spinner timers when there are in-flight annotations
  const hasInFlight = !!(inFlightIds && inFlightIds.size > 0);
  useEffect(() => {
    if (!hasInFlight) return;
    const charTimer = setInterval(() => {
      setCharIndex((i) => (i + 1) % SPINNER_FRAME_COUNT);
    }, SPINNER_INTERVAL);
    const wordTimer = setInterval(() => {
      setWordIndex((i) => (i + 1) % THINKING_WORDS.length);
    }, WORD_INTERVAL);
    return () => {
      clearInterval(charTimer);
      clearInterval(wordTimer);
    };
  }, [hasInFlight]);

  type BadgePos = {
    id: string;
    threadId?: string;
    x: number;
    y: number;
    size: number;
    color: string;
    isInFlight: boolean;
    isNeedsReview: boolean;
    replyCount: number;
  };

  const badges: BadgePos[] = [];

  for (const annotation of annotations) {
    if (annotation.type !== 'text' || !annotation.text || !annotation.points[0]) continue;
    if (supersededAnnotations.has(annotation)) continue;

    const groupAnns = annotation.groupId
      ? annotations.filter(a => a.groupId === annotation.groupId)
      : [annotation];

    const isInFlight = !!(inFlightIds && (
      inFlightIds.has(annotation.id) ||
      groupAnns.some(a => inFlightIds.has(a.id))
    ));
    const status: AnnotationLifecycleStatus = annotation.status ?? 'pending';
    const groupMateResolved = groupAnns.some(
      a => a.status === 'resolved' || a.status === 'needs_review'
    );
    const hasThread = groupAnns.some(a => a.threadId);

    // Show badge if in-flight, resolved/needs_review, or has a thread
    if (!isInFlight && status !== 'resolved' && status !== 'needs_review' && !groupMateResolved && !hasThread) continue;

    const threadId = annotation.threadId || groupAnns.find(a => a.threadId)?.threadId;
    const isNeedsReview = status === 'needs_review' || groupAnns.some(a => a.status === 'needs_review');
    const replyCount = groupAnns.reduce((n, a) => n + (a.replyCount ?? 0), 0);

    const point = annotation.points[0];
    const fontSize = annotation.fontSize || 12;
    const lineHeightPx = fontSize * LINE_HEIGHT;
    const lines = annotation.text.split('\n');

    const groupNumber = annotationGroupMap.get(annotation.id);
    const displayLines = groupNumber !== undefined
      ? [groupNumber + '. ' + (lines[0] || ''), ...lines.slice(1)]
      : lines;

    // Reuse the display canvas context for text measurement so DPR scaling
    // and font hinting match the actual rendered text (avoids wrapping drift).
    const ctx = canvasRef?.current?.getContext('2d') ?? document.createElement('canvas').getContext('2d');
    if (!ctx) continue;

    ctx.font = `${fontSize}px ${FONT_FAMILY}`;

    // Account for viewport-constrained wrapping
    const viewportX = point.x - scrollX;
    const effectiveMax = getEffectiveMaxWidth(viewportX);
    const capWidth = effectiveMax !== undefined ? Math.min(MAX_DISPLAY_WIDTH, effectiveMax) : MAX_DISPLAY_WIDTH;
    const wrapped = wrapLines(ctx, displayLines, capWidth);
    const maxWidth = Math.min(capWidth, Math.max(...wrapped.map(l => ctx.measureText(l).width)));
    const wrappedHeight = wrapped.length * lineHeightPx;
    const originalHeight = displayLines.length * lineHeightPx;
    const yShift = wrappedHeight - originalHeight;

    badges.push({
      id: annotation.id,
      threadId,
      x: point.x + maxWidth + PADDING,
      y: point.y - PADDING - yShift,
      size: wrappedHeight + PADDING * 2,
      color: annotation.color,
      isInFlight,
      isNeedsReview,
      replyCount,
    });
  }

  if (badges.length === 0) return null;

  const clickable = !!onViewThread;

  return (
    <>
      {badges.map((pos) => (
        <BadgeHitArea
          key={pos.id}
          left={pos.x - scrollX - BADGE_HIT_PAD}
          top={pos.y - scrollY - BADGE_HIT_PAD}
          onClick={clickable && pos.threadId ? () => {
            onSelectAnnotation?.(pos.id);
            onViewThread!(pos.threadId!);
          } : undefined}
          style={{
            pointerEvents: clickable ? 'auto' : 'none',
            cursor: clickable && pos.threadId ? 'pointer' : undefined,
            zIndex: 9999,
          }}
        >
          <div
            data-devtools="annotation-badge"
            style={{
              height: pos.size,
              display: 'flex',
              alignItems: 'center',
              backgroundColor: pos.color,
              fontFamily: FONT_FAMILY,
              fontSize: 12,
              color: '#ffffff',
              userSelect: 'none',
              padding: `0 ${PADDING}px`,
              gap: 4,
              whiteSpace: 'nowrap',
            }}
          >
            {pos.isInFlight ? (
              <>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: 'middle' }}>
                  {charIndex === 1 ? (
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
                <span style={{ opacity: 0.7 }}>{THINKING_WORDS[wordIndex]}</span>
              </>
            ) : (
              <>
                {pos.isNeedsReview ? (
                  <span style={{ fontWeight: 700 }}>?</span>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="12" y1="3" x2="12" y2="9" />
                    <line x1="12" y1="15" x2="12" y2="21" />
                    <line x1="3" y1="12" x2="9" y2="12" />
                    <line x1="15" y1="12" x2="21" y2="12" />
                  </svg>
                )}
                <span style={{ opacity: 0.7 }}>
                  {pos.replyCount > 0
                    ? `${pos.replyCount} ${pos.replyCount === 1 ? 'reply' : 'replies'}`
                    : 'Cancelled'}
                </span>
              </>
            )}
          </div>
        </BadgeHitArea>
      ))}
    </>
  );
}

// Marching ants border for in-flight style modifications
export function MarchingAntsBorders({
  inFlightSelectorColors,
  animated = true,
}: {
  inFlightSelectorColors: Map<string, string>;
  animated?: boolean;
}) {
  const [borders, setBorders] = useState<
    { selector: string; top: number; left: number; width: number; height: number; color: string }[]
  >([]);

  useEffect(() => {
    if (inFlightSelectorColors.size === 0) {
      setBorders([]);
      return;
    }

    let rafId: number | null = null;

    const updateBorders = () => {
      const newBorders: typeof borders = [];

      for (const [selector, color] of inFlightSelectorColors) {
        const el = findElementBySelector(selector);
        if (!el) continue;

        const rect = el.getBoundingClientRect();
        newBorders.push({
          selector,
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          color,
        });
      }

      setBorders(newBorders);
    };

    const scheduleUpdate = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateBorders);
    };

    updateBorders();

    window.addEventListener('scroll', scheduleUpdate, true);
    window.addEventListener('resize', scheduleUpdate, true);

    const observer = new MutationObserver(scheduleUpdate);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['style', 'class'],
    });

    return () => {
      window.removeEventListener('scroll', scheduleUpdate, true);
      window.removeEventListener('resize', scheduleUpdate, true);
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [inFlightSelectorColors]);

  if (borders.length === 0) return null;

  const cornerDotStyle: CSSProperties = {
    position: 'absolute',
    width: 2,
    height: 2,
    pointerEvents: 'none',
  };

  return (
    <>
      {animated && <style>{`@keyframes popmelt-march { to { stroke-dashoffset: -6; } }`}</style>}
      {borders.map((border) => (
        <div
          key={border.selector}
          data-devtools="marching-ants"
          style={{
            position: 'fixed',
            top: border.top,
            left: border.left,
            width: border.width,
            height: border.height,
            pointerEvents: 'none',
            zIndex: 9995,
            overflow: 'visible',
          }}
        >
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
            <rect
              x="0.5"
              y="0.5"
              width={Math.max(0, border.width - 1)}
              height={Math.max(0, border.height - 1)}
              fill="none"
              stroke={border.color}
              strokeWidth="1"
              strokeDasharray="2 4"
              style={animated ? { animation: 'popmelt-march 0.5s steps(2) infinite' } : undefined}
            />
          </svg>
          <div style={{ ...cornerDotStyle, top: -1, left: -1, backgroundColor: border.color }} />
          <div style={{ ...cornerDotStyle, top: -1, right: -1, backgroundColor: border.color }} />
          <div style={{ ...cornerDotStyle, bottom: -1, left: -1, backgroundColor: border.color }} />
          <div style={{ ...cornerDotStyle, bottom: -1, right: -1, backgroundColor: border.color }} />
        </div>
      ))}
    </>
  );
}

// Question badge for waiting_input annotations — crosshair icon, click to expand reply form
export function QuestionBadges({
  annotations,
  supersededAnnotations,
  scrollX,
  scrollY,
  onReply,
  annotationGroupMap,
  canvasRef,
}: {
  annotations: Annotation[];
  supersededAnnotations: Set<Annotation>;
  scrollX: number;
  scrollY: number;
  onReply: (threadId: string, reply: string) => void;
  annotationGroupMap: Map<string, number>;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
}) {
  const waitingAnnotations = annotations.filter(a => {
    if (supersededAnnotations.has(a)) return false;
    return a.status === 'waiting_input' && a.question && a.threadId;
  });

  if (waitingAnnotations.length === 0) return null;

  // Deduplicate by threadId — show one badge per thread, positioned at first matching text annotation
  const seenThreads = new Set<string>();
  const badges: { annotation: Annotation; x: number; y: number; size: number }[] = [];

  for (const annotation of waitingAnnotations) {
    if (!annotation.threadId || seenThreads.has(annotation.threadId)) continue;
    seenThreads.add(annotation.threadId);

    // Find the text annotation for this group (or the annotation itself if text)
    const textAnn = annotation.type === 'text' ? annotation :
      annotations.find(a => a.groupId && a.groupId === annotation.groupId && a.type === 'text') || annotation;

    if (textAnn.type === 'text' && textAnn.text && textAnn.points[0]) {
      const point = textAnn.points[0];
      const fontSize = textAnn.fontSize || 12;
      const lineHeightPx = fontSize * LINE_HEIGHT;
      const lines = textAnn.text.split('\n');

      const groupNumber = annotationGroupMap.get(textAnn.id);
      const displayLines = groupNumber !== undefined
        ? [groupNumber + '. ' + (lines[0] || ''), ...lines.slice(1)]
        : lines;

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      ctx.font = `${fontSize}px ${FONT_FAMILY}`;

      const viewportX = point.x - scrollX;
      const effectiveMax = getEffectiveMaxWidth(viewportX);
      const capWidth = effectiveMax !== undefined ? Math.min(MAX_DISPLAY_WIDTH, effectiveMax) : MAX_DISPLAY_WIDTH;
      const wrapped = wrapLines(ctx, displayLines, capWidth);
      const maxWidth = Math.min(capWidth, Math.max(...wrapped.map(l => ctx.measureText(l).width)));
      const wrappedHeight = wrapped.length * lineHeightPx;
      const originalHeight = displayLines.length * lineHeightPx;
      const yShift = wrappedHeight - originalHeight;
      const annotationHeight = wrappedHeight + PADDING * 2;

      badges.push({
        annotation,
        x: point.x + maxWidth + PADDING,
        y: point.y - PADDING - yShift,
        size: annotationHeight,
      });
    }
  }

  if (badges.length === 0) return null;

  return (
    <>
      {badges.map(({ annotation, x, y, size }) => (
        <QuestionBadge
          key={`question-${annotation.threadId}`}
          annotation={annotation}
          x={x - scrollX}
          y={y - scrollY}
          size={size}
          onReply={onReply}
        />
      ))}
    </>
  );
}

function QuestionBadge({
  annotation,
  x,
  y,
  size,
  onReply,
}: {
  annotation: Annotation;
  x: number;
  y: number;
  size: number;
  onReply: (threadId: string, reply: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [replyText, setReplyText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [expanded]);

  // Close on click outside
  useEffect(() => {
    if (!expanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    // Escape key (for clicks outside the textarea)
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [expanded]);

  const handleSubmit = useCallback(() => {
    if (!replyText.trim() || !annotation.threadId) return;
    onReply(annotation.threadId, replyText.trim());
    setReplyText('');
    setExpanded(false);
  }, [replyText, annotation.threadId, onReply]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const badgeLeft = expanded ? x : x - BADGE_HIT_PAD;
  const badgeTop = expanded ? y : y - BADGE_HIT_PAD;

  return (
    <div
      ref={panelRef}
      data-devtools="question-badge"
      style={{
        position: 'fixed',
        left: `max(0px, ${badgeLeft}px)`,
        top: `max(0px, ${badgeTop}px)`,
        padding: expanded ? 0 : BADGE_HIT_PAD,
        transform: `translate(min(0px, calc(100vw - max(0px, ${badgeLeft}px) - 100%)), min(0px, calc(100vh - max(0px, ${badgeTop}px) - 100%)))`,
        zIndex: expanded ? 10002 : 9999,
        pointerEvents: 'auto',
        cursor: expanded ? undefined : 'pointer',
      }}
    >
      {/* Collapsed: crosshair icon + reply? label */}
      {!expanded && (
        <div
          onClick={() => setExpanded(true)}
          style={{
            height: size,
            display: 'flex',
            alignItems: 'center',
            backgroundColor: annotation.color,
            padding: `0 ${PADDING}px`,
            gap: 4,
            fontFamily: FONT_FAMILY,
            fontSize: 12,
            color: '#ffffff',
            whiteSpace: 'nowrap',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="12" y1="3" x2="12" y2="9" />
            <line x1="12" y1="15" x2="12" y2="21" />
            <line x1="3" y1="12" x2="9" y2="12" />
            <line x1="15" y1="12" x2="21" y2="12" />
          </svg>
          <span style={{ opacity: 0.7 }}>reply?</span>
        </div>
      )}

      {/* Expanded: question + reply textarea — white panel */}
      {expanded && (
        <div
          style={{
            minWidth: 260,
            maxWidth: 360,
            backgroundColor: '#ffffff',
            fontFamily: FONT_FAMILY,
            fontSize: 12,
            color: '#1f2937',
            border: '1px solid rgba(0, 0, 0, 0.1)',
          }}
        >
          {/* Question text */}
          <div style={{ padding: `${PADDING + 2}px ${PADDING + 4}px`, lineHeight: 1.4 }}>
            {annotation.question}
          </div>

          {/* Reply area */}
          <div style={{ padding: `0 ${PADDING}px ${PADDING}px` }}>
            <textarea
              ref={textareaRef}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your reply..."
              style={{
                width: '100%',
                minHeight: 40,
                padding: PADDING,
                fontSize: 12,
                fontFamily: FONT_FAMILY,
                backgroundColor: 'rgba(0, 0, 0, 0.04)',
                color: '#1f2937',
                border: '1px solid rgba(0, 0, 0, 0.1)',
                borderRadius: 0,
                outline: 'none',
                resize: 'vertical',
                lineHeight: 1.4,
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                onClick={handleSubmit}
                disabled={!replyText.trim()}
                style={{
                  padding: '4px 12px',
                  fontSize: 11,
                  fontFamily: FONT_FAMILY,
                  fontWeight: 600,
                  backgroundColor: replyText.trim() ? annotation.color : 'rgba(0,0,0,0.1)',
                  color: replyText.trim() ? '#ffffff' : 'rgba(0,0,0,0.3)',
                  border: 'none',
                  cursor: replyText.trim() ? 'pointer' : 'default',
                }}
              >
                Send &#8984;&#9166;
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
