'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useCanvasDrawing } from '../hooks/useCanvasDrawing';
import { FONT_FAMILY, LINE_HEIGHT, PADDING } from '../tools/text';
import type { Annotation, AnnotationAction, AnnotationLifecycleStatus, AnnotationState, ElementInfo, Point } from '../tools/types';
import {
  captureElementsAtPoints,
  extractElementInfo,
  findElementBySelector,
  getTopmostElementAtPoint,
  getUniqueSelector,
} from '../utils/dom';
import { ElementHighlight } from './ElementHighlight';
import { ModifiedElementBadges } from './ModifiedElementBadges';
import { StylePanel } from './StylePanel';

type AnnotationCanvasProps = {
  state: AnnotationState;
  dispatch: React.Dispatch<AnnotationAction>;
  onScreenshot: () => Promise<boolean>;
  inFlightAnnotationIds?: Set<string>;
  inFlightStyleSelectors?: Set<string>;
  inFlightSelectorColors?: Map<string, string>;
  onReply?: (threadId: string, reply: string) => void;
};

type ActiveTextInput = {
  id: string;
  point: Point;
  text: string;
  fontSize: number;
  isNew: boolean;
  clickPoint?: Point; // Where the user clicked (for cursor positioning)
  groupId?: string; // Links to a shape annotation
  linkedSelector?: string; // CSS selector of linked DOM element
  linkedAnchor?: 'top-left' | 'bottom-left'; // Which corner to anchor to
  elements?: ElementInfo[]; // DOM elements for linked annotations
};

type HandleCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
type HandleCardinal = 'top' | 'bottom' | 'left' | 'right';
type LineHandle = 'start' | 'end';
type HandleType = HandleCorner | HandleCardinal | LineHandle;

const HANDLE_SIZE = 8;

const BADGE_HEIGHT = 22; // Matches ElementHighlight tooltip height
const ACTIVE_TEXT_STORAGE_KEY = 'devtools-active-text';

function calculateLinkedPosition(
  rect: DOMRect,
  anchor: 'top-left' | 'bottom-left',
  stackOffset = 0,
): Point {
  // Position so the textarea background (which starts at point - PADDING)
  // is flush above the badge/modification tooltip stack
  const x = rect.left + window.scrollX + PADDING;
  const y = anchor === 'top-left'
    ? rect.top + window.scrollY - BADGE_HEIGHT - (stackOffset * BADGE_HEIGHT) + PADDING
    : rect.bottom + window.scrollY + PADDING - 1 + (stackOffset * BADGE_HEIGHT);
  return { x, y };
}

export function AnnotationCanvas({ state, dispatch, onScreenshot, inFlightAnnotationIds, inFlightStyleSelectors, inFlightSelectorColors, onReply }: AnnotationCanvasProps) {
  const { canvasRef, redrawAll, resizeCanvas } = useCanvasDrawing();
  const [isDrawing, setIsDrawing] = useState(false);
  const [activeText, setActiveText] = useState<ActiveTextInput | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const saved = localStorage.getItem(ACTIVE_TEXT_STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [hoveredTextId, setHoveredTextId] = useState<string | null>(null);
  const [pendingRectangleText, setPendingRectangleText] = useState<{ point: Point; groupId: string } | null>(null);
  const [pendingLinkedText, setPendingLinkedText] = useState<{
    point: Point;
    linkedSelector: string;
    linkedAnchor: 'top-left' | 'bottom-left';
    elements: ElementInfo[];
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastPositionedTextId = useRef<string | null>(null);
  const mousePosition = useRef<Point>({ x: 0, y: 0 });

  // Clipboard state for copy/paste
  const clipboardRef = useRef<Annotation[]>([]);
  const pasteCountRef = useRef<number>(0);

  // Inspector mode state
  const [hoveredElement, setHoveredElement] = useState<Element | null>(null);
  const [hoveredElementInfo, setHoveredElementInfo] = useState<ElementInfo | null>(null);

  // Ref for in-flight selector check (avoids dependency cascading in handlers)
  const inFlightSelectorColorsRef = useRef(inFlightSelectorColors);
  inFlightSelectorColorsRef.current = inFlightSelectorColors;

  const isElementInFlight = useCallback((el: Element): boolean => {
    const colors = inFlightSelectorColorsRef.current;
    if (!colors || colors.size === 0) return false;
    for (const selector of colors.keys()) {
      try {
        if (el.matches(selector)) return true;
      } catch { /* invalid selector */ }
    }
    return false;
  }, []);

  // Refs to always have latest values for keyboard handlers (avoids stale closures)
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeTextRef = useRef(activeText);
  activeTextRef.current = activeText;
  const selectedIdsRef = useRef<string[]>([]);
  const onScreenshotRef = useRef(onScreenshot);
  onScreenshotRef.current = onScreenshot;

  // Drag state for repositioning any annotation
  const [dragState, setDragState] = useState<{
    annotation: Annotation;
    startPoint: Point;
    hasMoved: boolean;
  } | null>(null);

  // Selection state from shared state
  const selectedAnnotationIds = state.selectedAnnotationIds;
  selectedIdsRef.current = selectedAnnotationIds;

  const selectAnnotation = useCallback((id: string | null, addToSelection = false) => {
    dispatch({ type: 'SELECT_ANNOTATION', payload: { id, addToSelection } });
  }, [dispatch]);

  const clearSelection = useCallback(() => {
    dispatch({ type: 'SELECT_ANNOTATION', payload: { id: null } });
  }, [dispatch]);

  // Resize state for dragging handles
  const [resizeState, setResizeState] = useState<{
    annotationId: string;
    handle: HandleType;
    startPoint: Point;
    originalPoints: Point[];
    hasMoved: boolean;
  } | null>(null);

  // Scroll position for syncing annotations with page content
  const [scroll, setScroll] = useState({ x: window.scrollX, y: window.scrollY });

  // Handle resize
  useEffect(() => {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    return () => window.removeEventListener('resize', resizeCanvas);
  }, [resizeCanvas]);

  // Track scroll position
  useEffect(() => {
    const handleScroll = () => {
      setScroll({ x: window.scrollX, y: window.scrollY });
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Persist activeText (half-written annotations) to localStorage
  useEffect(() => {
    if (activeText) {
      localStorage.setItem(ACTIVE_TEXT_STORAGE_KEY, JSON.stringify(activeText));
    } else {
      localStorage.removeItem(ACTIVE_TEXT_STORAGE_KEY);
    }
  }, [activeText]);

  // Global wheel handler for text resize (works even when canvas has pointerEvents: none)
  // Also handles edit mode to ensure scroll is blocked
  useEffect(() => {
    const wheelHandler = (e: WheelEvent) => {
      // Handle edit mode scaling (activeText is set, but not linked annotations)
      if (activeText) {
        if (activeText.linkedSelector) return; // Linked annotations have fixed size
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? -2 : 2;
        setActiveText(prev => prev ? {
          ...prev,
          fontSize: Math.max(12, Math.min(72, prev.fontSize + delta)),
        } : null);
        return;
      }

      // Handle hover scaling (hoveredTextId is set)
      if (!hoveredTextId) return;

      e.preventDefault();
      const annotation = state.annotations.find((a) => a.id === hoveredTextId);
      if (annotation && annotation.type === 'text' && !annotation.linkedSelector) {
        const currentSize = annotation.fontSize || 12;
        const delta = e.deltaY > 0 ? -2 : 2;
        dispatch({
          type: 'UPDATE_TEXT_SIZE',
          payload: { id: hoveredTextId, fontSize: currentSize + delta },
        });
      }
    };

    window.addEventListener('wheel', wheelHandler, { passive: false });
    return () => {
      window.removeEventListener('wheel', wheelHandler);
    };
  }, [hoveredTextId, activeText, state.annotations, dispatch]);

  // Delete selected annotations with Delete/Backspace key
  // Escape clears selection or collapses toolbar
  // Copy/paste with Cmd+C/Cmd+V
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If editing text, let the text handler deal with it
        if (activeTextRef.current) return;

        // If annotations selected, deselect them
        if (selectedIdsRef.current.length > 0) {
          e.preventDefault();
          clearSelection();
          return;
        }
      }


      // Paste with Cmd/Ctrl+V
      if ((e.metaKey || e.ctrlKey) && e.key === 'v' && clipboardRef.current.length > 0 && !activeTextRef.current) {
        e.preventDefault();

        pasteCountRef.current++;
        const offset = pasteCountRef.current * 20;

        // Generate new IDs and optionally a new shared groupId
        const oldGroupId = clipboardRef.current[0]?.groupId;
        const newGroupId = oldGroupId ? Math.random().toString(36).substring(2, 9) : undefined;

        const pastedAnnotations: Annotation[] = clipboardRef.current.map((annotation) => ({
          ...annotation,
          id: Math.random().toString(36).substring(2, 9),
          groupId: annotation.groupId ? newGroupId : undefined,
          timestamp: Date.now(),
          points: annotation.points.map((p) => ({
            x: p.x + offset,
            y: p.y + offset,
          })),
        }));

        dispatch({
          type: 'PASTE_ANNOTATIONS',
          payload: { annotations: pastedAnnotations },
        });

        // Select the first non-text pasted annotation (or first if all are text)
        const toSelect = pastedAnnotations.find((a) => a.type !== 'text') || pastedAnnotations[0];
        if (toSelect) {
          selectAnnotation(toSelect.id);
        }
        return;
      }

      // Only handle delete if shapes are selected and not editing text
      const currentSelectedIds = selectedIdsRef.current;
      if (currentSelectedIds.length === 0 || activeTextRef.current) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        // Delete all selected annotations
        for (const id of currentSelectedIds) {
          dispatch({
            type: 'DELETE_ANNOTATION',
            payload: { id },
          });
        }
        clearSelection();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dispatch, clearSelection, selectAnnotation]); // All other values read from refs

  // Compute superseded annotation IDs: when multiple annotation rounds target
  // the same linkedSelector, only the newest round is visible
  const supersededIds = useMemo(() => {
    const ids = new Set<string>();
    // Group annotations by linkedSelector
    const bySelector = new Map<string, Annotation[]>();
    for (const a of state.annotations) {
      if (!a.linkedSelector) continue;
      const group = bySelector.get(a.linkedSelector) || [];
      group.push(a);
      bySelector.set(a.linkedSelector, group);
    }
    for (const group of bySelector.values()) {
      if (group.length <= 1) continue;
      // Sort by timestamp descending — newest first
      group.sort((a, b) => b.timestamp - a.timestamp);
      // All but the newest are superseded (plus their group mates)
      for (let i = 1; i < group.length; i++) {
        const old = group[i]!;
        ids.add(old.id);
        // Also hide group mates (e.g. the text label linked to this shape)
        if (old.groupId) {
          for (const mate of state.annotations) {
            if (mate.groupId === old.groupId) ids.add(mate.id);
          }
        }
      }
    }
    return ids;
  }, [state.annotations]);

  // Calculate annotation group map (for numbering text annotations)
  const annotationGroupMap = useMemo(() => {
    const map = new Map<string, number>();
    const seenGroupIds = new Set<string>();
    let groupIndex = 1;

    for (const annotation of state.annotations) {
      if (supersededIds.has(annotation.id)) continue;
      if (annotation.groupId) {
        if (!seenGroupIds.has(annotation.groupId)) {
          seenGroupIds.add(annotation.groupId);
          // Assign same group number to all annotations with this groupId
          const groupAnnotations = state.annotations.filter(a => a.groupId === annotation.groupId);
          for (const a of groupAnnotations) {
            map.set(a.id, groupIndex);
          }
          groupIndex++;
        }
      } else {
        map.set(annotation.id, groupIndex);
        groupIndex++;
      }
    }
    return map;
  }, [state.annotations, supersededIds]);

  // Redraw when state changes or scroll position changes
  useEffect(() => {
    // Filter out the annotation being edited and superseded annotations
    const visibleAnnotations = state.annotations.filter(a => {
      if (supersededIds.has(a.id)) return false;
      if (activeText && !activeText.isNew && a.id === activeText.id) return false;
      return true;
    });

    redrawAll(
      visibleAnnotations,
      state.currentPath,
      state.activeTool,
      state.activeColor,
      state.strokeWidth,
      selectedAnnotationIds,
      HANDLE_SIZE,
      scroll.x,
      scroll.y,
      annotationGroupMap
    );
  }, [state.annotations, state.currentPath, state.activeTool, state.activeColor, state.strokeWidth, redrawAll, activeText, selectedAnnotationIds, scroll, annotationGroupMap, supersededIds]);

  // Auto-create text annotation after drawing a rectangle
  useEffect(() => {
    if (pendingRectangleText) {
      const newId = Math.random().toString(36).substring(2, 9);
      setActiveText({
        id: newId,
        point: pendingRectangleText.point,
        text: '',
        fontSize: 12,
        isNew: true,
        groupId: pendingRectangleText.groupId,
      });
      setPendingRectangleText(null);
    }
  }, [pendingRectangleText]);

  // Auto-create text annotation from inspector click
  useEffect(() => {
    if (pendingLinkedText) {
      setActiveText({
        id: Math.random().toString(36).substring(2, 9),
        point: pendingLinkedText.point,
        text: '',
        fontSize: 12,
        isNew: true,
        linkedSelector: pendingLinkedText.linkedSelector,
        linkedAnchor: pendingLinkedText.linkedAnchor,
        elements: pendingLinkedText.elements,
      });
      setPendingLinkedText(null);
    }
  }, [pendingLinkedText]);

  // Focus input when active text changes
  useEffect(() => {
    if (activeText && inputRef.current) {
      // Delay focus to let the click event finish processing
      // Otherwise the textarea immediately loses focus
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;

        input.focus();

        // Only position cursor once per text editing session
        if (lastPositionedTextId.current === activeText.id) return;
        lastPositionedTextId.current = activeText.id;

        // If clicking on existing text, position cursor at click point
        if (!activeText.isNew && activeText.clickPoint) {
          const canvas = canvasRef.current;
          if (!canvas) return;

          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          ctx.font = `${activeText.fontSize}px ${FONT_FAMILY}`;
          const lineHeightPx = activeText.fontSize * LINE_HEIGHT;
          const lines = activeText.text.split('\n');

          // Find which line was clicked
          const yOffset = activeText.clickPoint.y - activeText.point.y;
          const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor(yOffset / lineHeightPx)));

          // Find character position on that line
          const xOffset = activeText.clickPoint.x - activeText.point.x;
          const line = lines[lineIndex] || '';
          let charIndex = 0;

          for (let i = 0; i <= line.length; i++) {
            const width = ctx.measureText(line.substring(0, i)).width;
            if (width > xOffset) {
              // Check if closer to this char or previous
              const prevWidth = i > 0 ? ctx.measureText(line.substring(0, i - 1)).width : 0;
              charIndex = (xOffset - prevWidth) < (width - xOffset) ? i - 1 : i;
              break;
            }
            charIndex = i;
          }

          // Calculate absolute position in text (accounting for newlines)
          let absolutePos = charIndex;
          for (let i = 0; i < lineIndex; i++) {
            absolutePos += (lines[i]?.length || 0) + 1; // +1 for newline
          }

          input.setSelectionRange(absolutePos, absolutePos);
        }
      });
    } else {
      // Reset when exiting edit mode
      lastPositionedTextId.current = null;
    }
  }, [activeText, canvasRef]);

  // Get point in document coordinates (accounts for scroll)
  const getPoint = useCallback((e: React.MouseEvent | React.TouchEvent): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    let clientX: number;
    let clientY: number;

    if ('touches' in e && e.touches[0]) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if ('clientX' in e) {
      clientX = e.clientX;
      clientY = e.clientY;
    } else {
      return { x: 0, y: 0 };
    }

    // Return document coordinates (viewport + scroll)
    return {
      x: clientX - rect.left + window.scrollX,
      y: clientY - rect.top + window.scrollY,
    };
  }, [canvasRef]);

  // Check if point is near a line segment
  const isPointNearLine = useCallback((point: Point, p1: Point, p2: Point, threshold: number): boolean => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
      // p1 and p2 are the same point
      const dist = Math.sqrt((point.x - p1.x) ** 2 + (point.y - p1.y) ** 2);
      return dist <= threshold;
    }

    // Project point onto line segment
    const t = Math.max(0, Math.min(1, ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lengthSq));
    const projX = p1.x + t * dx;
    const projY = p1.y + t * dy;
    const dist = Math.sqrt((point.x - projX) ** 2 + (point.y - projY) ** 2);
    return dist <= threshold;
  }, []);

  // Find any annotation at a given point
  const findAnnotationAtPoint = useCallback((point: Point): Annotation | null => {
    const SAFE_AREA = 4;

    for (let i = state.annotations.length - 1; i >= 0; i--) {
      const annotation = state.annotations[i];
      if (!annotation) continue;
      if (supersededIds.has(annotation.id)) continue;

      const hitThreshold = (annotation.strokeWidth || 3) + SAFE_AREA;

      switch (annotation.type) {
        case 'text': {
          if (!annotation.points[0] || !annotation.text) continue;
          const textPoint = annotation.points[0];
          const fontSize = annotation.fontSize || 12;

          const canvas = canvasRef.current;
          if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.font = `${fontSize}px ${FONT_FAMILY}`;
              const lines = annotation.text.split('\n');
              const maxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
              const totalHeight = lines.length * (fontSize * LINE_HEIGHT);

              if (
                point.x >= textPoint.x - PADDING - SAFE_AREA &&
                point.x <= textPoint.x + maxWidth + PADDING + SAFE_AREA &&
                point.y >= textPoint.y - PADDING - SAFE_AREA &&
                point.y <= textPoint.y + totalHeight + PADDING + SAFE_AREA
              ) {
                return annotation;
              }
            }
          }
          break;
        }

        case 'rectangle': {
          if (annotation.points.length < 2) continue;
          const start = annotation.points[0]!;
          const end = annotation.points[annotation.points.length - 1]!;
          const left = Math.min(start.x, end.x);
          const right = Math.max(start.x, end.x);
          const top = Math.min(start.y, end.y);
          const bottom = Math.max(start.y, end.y);

          // Check if near any edge
          const nearTop = isPointNearLine(point, { x: left, y: top }, { x: right, y: top }, hitThreshold);
          const nearBottom = isPointNearLine(point, { x: left, y: bottom }, { x: right, y: bottom }, hitThreshold);
          const nearLeft = isPointNearLine(point, { x: left, y: top }, { x: left, y: bottom }, hitThreshold);
          const nearRight = isPointNearLine(point, { x: right, y: top }, { x: right, y: bottom }, hitThreshold);

          if (nearTop || nearBottom || nearLeft || nearRight) {
            return annotation;
          }
          break;
        }

        case 'circle': {
          if (annotation.points.length < 2) continue;
          const start = annotation.points[0]!;
          const end = annotation.points[annotation.points.length - 1]!;
          const centerX = (start.x + end.x) / 2;
          const centerY = (start.y + end.y) / 2;
          const radiusX = Math.abs(end.x - start.x) / 2;
          const radiusY = Math.abs(end.y - start.y) / 2;

          // Distance from point to ellipse (approximate)
          const dx = point.x - centerX;
          const dy = point.y - centerY;
          const normalizedDist = Math.sqrt((dx / radiusX) ** 2 + (dy / radiusY) ** 2);

          if (Math.abs(normalizedDist - 1) * Math.max(radiusX, radiusY) <= hitThreshold) {
            return annotation;
          }
          break;
        }

        case 'line': {
          if (annotation.points.length < 2) continue;
          const start = annotation.points[0]!;
          const end = annotation.points[annotation.points.length - 1]!;

          if (isPointNearLine(point, start, end, hitThreshold)) {
            return annotation;
          }
          break;
        }

        case 'freehand': {
          if (annotation.points.length < 2) continue;

          // Check each segment of the freehand path
          for (let j = 0; j < annotation.points.length - 1; j++) {
            const p1 = annotation.points[j]!;
            const p2 = annotation.points[j + 1]!;
            if (isPointNearLine(point, p1, p2, hitThreshold)) {
              return annotation;
            }
          }
          break;
        }
      }
    }
    return null;
  }, [state.annotations, canvasRef, isPointNearLine, supersededIds]);

  // Find text annotation at a given point (for hover/resize)
  const findTextAtPoint = useCallback((point: Point): Annotation | null => {
    const annotation = findAnnotationAtPoint(point);
    return annotation?.type === 'text' ? annotation : null;
  }, [findAnnotationAtPoint]);

  // Find handle at a given point for any selected annotation
  // Returns both the handle type and the annotation ID
  const findHandleAtPoint = useCallback((point: Point): { handle: HandleType; annotationId: string } | null => {
    if (selectedAnnotationIds.length === 0) return null;

    const hitRadius = HANDLE_SIZE / 2 + 4; // Slightly larger hit area

    for (const selectedId of selectedAnnotationIds) {
      const annotation = state.annotations.find((a) => a.id === selectedId);
      if (!annotation || annotation.points.length < 2) continue;

      // Lines have start/end handles
      if (annotation.type === 'line') {
        const start = annotation.points[0]!;
        const end = annotation.points[annotation.points.length - 1]!;

        const distToStart = Math.sqrt((point.x - start.x) ** 2 + (point.y - start.y) ** 2);
        if (distToStart <= hitRadius) return { handle: 'start', annotationId: selectedId };

        const distToEnd = Math.sqrt((point.x - end.x) ** 2 + (point.y - end.y) ** 2);
        if (distToEnd <= hitRadius) return { handle: 'end', annotationId: selectedId };

        continue;
      }

      // Circles have cardinal handles (top, bottom, left, right)
      if (annotation.type === 'circle') {
        const start = annotation.points[0]!;
        const end = annotation.points[annotation.points.length - 1]!;
        const left = Math.min(start.x, end.x);
        const right = Math.max(start.x, end.x);
        const top = Math.min(start.y, end.y);
        const bottom = Math.max(start.y, end.y);
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;

        const cardinals: { handle: HandleCardinal; x: number; y: number }[] = [
          { handle: 'top', x: centerX, y: top },
          { handle: 'bottom', x: centerX, y: bottom },
          { handle: 'left', x: left, y: centerY },
          { handle: 'right', x: right, y: centerY },
        ];

        for (const { handle, x, y } of cardinals) {
          const dist = Math.sqrt((point.x - x) ** 2 + (point.y - y) ** 2);
          if (dist <= hitRadius) {
            return { handle, annotationId: selectedId };
          }
        }
        continue;
      }

      // Rectangle and freehand have corner handles (bounding box)
      if (annotation.type === 'rectangle' || annotation.type === 'freehand') {
        const start = annotation.points[0]!;
        const end = annotation.points[annotation.points.length - 1]!;

        // For freehand, calculate bounding box from all points
        let left: number, right: number, top: number, bottom: number;
        if (annotation.type === 'freehand') {
          left = Math.min(...annotation.points.map(p => p.x));
          right = Math.max(...annotation.points.map(p => p.x));
          top = Math.min(...annotation.points.map(p => p.y));
          bottom = Math.max(...annotation.points.map(p => p.y));
        } else {
          left = Math.min(start.x, end.x);
          right = Math.max(start.x, end.x);
          top = Math.min(start.y, end.y);
          bottom = Math.max(start.y, end.y);
        }

        const corners: { corner: HandleCorner; x: number; y: number }[] = [
          { corner: 'topLeft', x: left, y: top },
          { corner: 'topRight', x: right, y: top },
          { corner: 'bottomLeft', x: left, y: bottom },
          { corner: 'bottomRight', x: right, y: bottom },
        ];

        for (const { corner, x, y } of corners) {
          const dist = Math.sqrt((point.x - x) ** 2 + (point.y - y) ** 2);
          if (dist <= hitRadius) {
            return { handle: corner, annotationId: selectedId };
          }
        }
      }
    }

    return null;
  }, [selectedAnnotationIds, state.annotations]);

  // Track global mouse position for text hover detection (in document coordinates)
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Store in document coordinates
      mousePosition.current = {
        x: e.clientX + window.scrollX,
        y: e.clientY + window.scrollY
      };

      // Update hovered text for scroll-to-resize (when not actively editing)
      if (!activeText) {
        const textAtPoint = findTextAtPoint(mousePosition.current);
        setHoveredTextId(textAtPoint?.id || null);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [activeText, findTextAtPoint]);

  // Commit active text - defined before handlers that use it
  const commitActiveText = useCallback(() => {
    if (!activeText) return;

    if (activeText.text.trim()) {
      // Has text - add or update
      if (activeText.isNew) {
        dispatch({
          type: 'ADD_TEXT',
          payload: {
            point: activeText.point,
            text: activeText.text,
            fontSize: activeText.fontSize,
            groupId: activeText.groupId,
            linkedSelector: activeText.linkedSelector,
            linkedAnchor: activeText.linkedAnchor,
            elements: activeText.elements,
          },
        });
      } else {
        dispatch({
          type: 'UPDATE_TEXT',
          payload: { id: activeText.id, text: activeText.text },
        });
      }
    } else if (!activeText.isNew) {
      // Empty text on existing annotation - delete it
      dispatch({
        type: 'DELETE_ANNOTATION',
        payload: { id: activeText.id },
      });
    }
    // Empty text on new annotation - just discard (don't add)

    setActiveText(null);
  }, [activeText, dispatch]);

  const handlePointerDown = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!state.isAnnotating) return;

      const point = getPoint(e);
      const isShiftClick = 'shiftKey' in e && e.shiftKey;

      // Inspector mode: left-click pins a linked text annotation
      if (state.activeTool === 'inspector') {
        // Right-click is handled by onContextMenu, skip here
        if ('button' in e && e.button === 2) return;

        if (hoveredElement && !isElementInFlight(hoveredElement)) {
          const info = extractElementInfo(hoveredElement);
          const structuralSelector = getUniqueSelector(hoveredElement);
          const rect = hoveredElement.getBoundingClientRect();

          // Tag element with a stable data-pm attribute for selector resilience
          let pmId = hoveredElement.getAttribute('data-pm');
          if (!pmId) {
            pmId = Math.random().toString(36).substring(2, 8);
            hoveredElement.setAttribute('data-pm', pmId);
          }
          const pmSelector = `[data-pm="${pmId}"]`;

          // Count existing badges on this element: modification badge + other linked annotations
          const hasModBadge = state.styleModifications.some(m => {
            try { return hoveredElement.matches(m.selector); } catch { return false; }
          });
          const existingLinked = state.annotations.filter(a => {
            if (!a.linkedSelector) return false;
            try { return hoveredElement.matches(a.linkedSelector); } catch { return false; }
          }).length;
          const stackOffset = (hasModBadge ? 1 : 0) + existingLinked;

          // Determine anchor: top-left if there's room above (matches badge positioning), bottom-left otherwise
          const anchor: 'top-left' | 'bottom-left' = rect.top >= BADGE_HEIGHT * (1 + stackOffset) ? 'top-left' : 'bottom-left';
          const textPoint = calculateLinkedPosition(rect, anchor, stackOffset);

          setPendingLinkedText({
            point: textPoint,
            linkedSelector: pmSelector,
            linkedAnchor: anchor,
            // Keep structural selector in elements for fallback on reload
            elements: [{ ...info, selector: structuralSelector }],
          });
        }
        return;
      }

      // Check for handle click first (if annotations are selected)
      const handleResult = findHandleAtPoint(point);
      if (handleResult) {
        const annotation = state.annotations.find((a) => a.id === handleResult.annotationId);
        // Don't allow resizing non-pending annotations
        if (annotation && annotation.type !== 'text' && (annotation.status ?? 'pending') === 'pending') {
          setResizeState({
            annotationId: handleResult.annotationId,
            handle: handleResult.handle,
            startPoint: point,
            originalPoints: [...annotation.points],
            hasMoved: false,
          });
          return;
        }
      }

      // Check for existing annotation first (regardless of active tool)
      const existingAnnotation = findAnnotationAtPoint(point);
      if (existingAnnotation && existingAnnotation.points[0]) {
        // Commit any active text first
        if (activeText) {
          commitActiveText();
        }

        // Select shape when clicking on it (not text)
        if (existingAnnotation.type !== 'text') {
          selectAnnotation(existingAnnotation.id, isShiftClick);
          // Set active color to match the selected annotation's color
          if (existingAnnotation.color) {
            dispatch({ type: 'SET_COLOR', payload: existingAnnotation.color });
          }
        } else if (!isShiftClick) {
          clearSelection();
        }

        // Start drag tracking (will enter edit mode on mouseup if no drag and it's text)
        setDragState({
          annotation: existingAnnotation,
          startPoint: point,
          hasMoved: false,
        });
        return;
      }

      // Clicking on empty space - clear selection (unless shift is held)
      if (!isShiftClick) {
        clearSelection();
      }

      if (state.activeTool === 'text') {
        // Commit any active text first
        if (activeText) {
          commitActiveText();
        }

        // Create new text
        const newId = Math.random().toString(36).substring(2, 9);
        setActiveText({
          id: newId,
          point,
          text: '',
          fontSize: 12,
          isNew: true,
        });
        return;
      }

      setIsDrawing(true);
      dispatch({ type: 'START_PATH', payload: point });
    },
    [state.isAnnotating, state.activeTool, state.annotations, activeText, selectedAnnotationIds, hoveredElement, getPoint, findAnnotationAtPoint, findHandleAtPoint, dispatch, selectAnnotation, clearSelection, commitActiveText]
  );

  const handlePointerMove = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      const point = getPoint(e);

      // Inspector mode: highlight element under cursor (skip in-flight elements)
      if (state.activeTool === 'inspector' && state.isAnnotating) {
        // Convert to viewport coordinates
        const viewportX = point.x - window.scrollX;
        const viewportY = point.y - window.scrollY;
        const rawEl = getTopmostElementAtPoint(viewportX, viewportY);
        const el = rawEl && isElementInFlight(rawEl) ? null : rawEl;
        if (el !== hoveredElement) {
          setHoveredElement(el);
          setHoveredElementInfo(el ? extractElementInfo(el) : null);
        }
        return;
      }

      // Handle resizing annotation
      if (resizeState) {
        const { handle, originalPoints, hasMoved } = resizeState;
        const annotation = state.annotations.find((a) => a.id === resizeState.annotationId);
        if (!annotation) return;

        // Check modifier keys
        const isMouseEvent = 'metaKey' in e;
        const centerOrigin = isMouseEvent && (e.metaKey || e.ctrlKey);
        const lockAspect = isMouseEvent && e.shiftKey;

        let newPoints: Point[];

        // Lines: just move the endpoint (modifiers don't apply)
        if (annotation.type === 'line') {
          const start = originalPoints[0]!;
          const end = originalPoints[originalPoints.length - 1]!;

          if (handle === 'start') {
            newPoints = [point, end];
          } else {
            newPoints = [start, point];
          }
        }
        // Freehand: scale all points based on bounding box change
        else if (annotation.type === 'freehand') {
          const origLeft = Math.min(...originalPoints.map(p => p.x));
          const origRight = Math.max(...originalPoints.map(p => p.x));
          const origTop = Math.min(...originalPoints.map(p => p.y));
          const origBottom = Math.max(...originalPoints.map(p => p.y));
          const origCenterX = (origLeft + origRight) / 2;
          const origCenterY = (origTop + origBottom) / 2;
          const origWidth = origRight - origLeft || 1;
          const origHeight = origBottom - origTop || 1;
          const origAspect = origWidth / origHeight;

          let newLeft = origLeft, newRight = origRight, newTop = origTop, newBottom = origBottom;

          switch (handle) {
            case 'topLeft':
              newLeft = point.x;
              newTop = point.y;
              break;
            case 'topRight':
              newRight = point.x;
              newTop = point.y;
              break;
            case 'bottomLeft':
              newLeft = point.x;
              newBottom = point.y;
              break;
            case 'bottomRight':
              newRight = point.x;
              newBottom = point.y;
              break;
          }

          // Apply center origin (Cmd/Ctrl) - mirror changes to opposite side
          if (centerOrigin) {
            switch (handle) {
              case 'topLeft':
                newRight = origRight + (origLeft - newLeft);
                newBottom = origBottom + (origTop - newTop);
                break;
              case 'topRight':
                newLeft = origLeft - (newRight - origRight);
                newBottom = origBottom + (origTop - newTop);
                break;
              case 'bottomLeft':
                newRight = origRight + (origLeft - newLeft);
                newTop = origTop - (newBottom - origBottom);
                break;
              case 'bottomRight':
                newLeft = origLeft - (newRight - origRight);
                newTop = origTop - (newBottom - origBottom);
                break;
            }
          }

          // Apply aspect ratio lock (Shift)
          if (lockAspect) {
            const newWidth = newRight - newLeft;
            const newHeight = newBottom - newTop;
            const newAspect = Math.abs(newWidth / newHeight);
            if (newAspect > origAspect) {
              const adjustedWidth = Math.abs(newHeight) * origAspect * Math.sign(newWidth);
              if (handle === 'topLeft' || handle === 'bottomLeft') {
                newLeft = newRight - adjustedWidth;
              } else {
                newRight = newLeft + adjustedWidth;
              }
            } else {
              const adjustedHeight = Math.abs(newWidth) / origAspect * Math.sign(newHeight);
              if (handle === 'topLeft' || handle === 'topRight') {
                newTop = newBottom - adjustedHeight;
              } else {
                newBottom = newTop + adjustedHeight;
              }
            }
          }

          // Scale all points
          const finalWidth = newRight - newLeft || 1;
          const finalHeight = newBottom - newTop || 1;

          newPoints = originalPoints.map(p => ({
            x: newLeft + ((p.x - origLeft) / origWidth) * finalWidth,
            y: newTop + ((p.y - origTop) / origHeight) * finalHeight,
          }));
        }
        // Circle: resize with cardinal handles
        else if (annotation.type === 'circle') {
          const start = originalPoints[0]!;
          const end = originalPoints[originalPoints.length - 1]!;

          const origLeft = Math.min(start.x, end.x);
          const origRight = Math.max(start.x, end.x);
          const origTop = Math.min(start.y, end.y);
          const origBottom = Math.max(start.y, end.y);
          const origCenterX = (origLeft + origRight) / 2;
          const origCenterY = (origTop + origBottom) / 2;
          const origWidth = origRight - origLeft;
          const origHeight = origBottom - origTop;

          let newLeft = origLeft, newRight = origRight, newTop = origTop, newBottom = origBottom;

          switch (handle) {
            case 'top':
              newTop = point.y;
              if (centerOrigin) newBottom = origCenterY + (origCenterY - point.y);
              if (lockAspect) {
                const newHeight = newBottom - newTop;
                const halfWidth = newHeight * (origWidth / origHeight) / 2;
                newLeft = origCenterX - halfWidth;
                newRight = origCenterX + halfWidth;
              }
              break;
            case 'bottom':
              newBottom = point.y;
              if (centerOrigin) newTop = origCenterY - (point.y - origCenterY);
              if (lockAspect) {
                const newHeight = newBottom - newTop;
                const halfWidth = newHeight * (origWidth / origHeight) / 2;
                newLeft = origCenterX - halfWidth;
                newRight = origCenterX + halfWidth;
              }
              break;
            case 'left':
              newLeft = point.x;
              if (centerOrigin) newRight = origCenterX + (origCenterX - point.x);
              if (lockAspect) {
                const newWidth = newRight - newLeft;
                const halfHeight = newWidth * (origHeight / origWidth) / 2;
                newTop = origCenterY - halfHeight;
                newBottom = origCenterY + halfHeight;
              }
              break;
            case 'right':
              newRight = point.x;
              if (centerOrigin) newLeft = origCenterX - (point.x - origCenterX);
              if (lockAspect) {
                const newWidth = newRight - newLeft;
                const halfHeight = newWidth * (origHeight / origWidth) / 2;
                newTop = origCenterY - halfHeight;
                newBottom = origCenterY + halfHeight;
              }
              break;
          }

          newPoints = [
            { x: newLeft, y: newTop },
            { x: newRight, y: newBottom },
          ];
        }
        // Rectangle: resize with corner handles
        else {
          const start = originalPoints[0]!;
          const end = originalPoints[originalPoints.length - 1]!;

          const origLeft = Math.min(start.x, end.x);
          const origRight = Math.max(start.x, end.x);
          const origTop = Math.min(start.y, end.y);
          const origBottom = Math.max(start.y, end.y);
          const origCenterX = (origLeft + origRight) / 2;
          const origCenterY = (origTop + origBottom) / 2;
          const origWidth = origRight - origLeft || 1;
          const origHeight = origBottom - origTop || 1;
          const origAspect = origWidth / origHeight;

          let newLeft = origLeft, newRight = origRight, newTop = origTop, newBottom = origBottom;

          switch (handle) {
            case 'topLeft':
              newLeft = point.x;
              newTop = point.y;
              break;
            case 'topRight':
              newRight = point.x;
              newTop = point.y;
              break;
            case 'bottomLeft':
              newLeft = point.x;
              newBottom = point.y;
              break;
            case 'bottomRight':
              newRight = point.x;
              newBottom = point.y;
              break;
          }

          // Apply center origin (Cmd/Ctrl) - mirror changes to opposite side
          if (centerOrigin) {
            switch (handle) {
              case 'topLeft':
                newRight = origRight + (origLeft - newLeft);
                newBottom = origBottom + (origTop - newTop);
                break;
              case 'topRight':
                newLeft = origLeft - (newRight - origRight);
                newBottom = origBottom + (origTop - newTop);
                break;
              case 'bottomLeft':
                newRight = origRight + (origLeft - newLeft);
                newTop = origTop - (newBottom - origBottom);
                break;
              case 'bottomRight':
                newLeft = origLeft - (newRight - origRight);
                newTop = origTop - (newBottom - origBottom);
                break;
            }
          }

          // Apply aspect ratio lock (Shift)
          if (lockAspect) {
            const newWidth = newRight - newLeft;
            const newHeight = newBottom - newTop;
            const newAspect = Math.abs(newWidth / newHeight);
            if (newAspect > origAspect) {
              const adjustedWidth = Math.abs(newHeight) * origAspect * Math.sign(newWidth);
              if (handle === 'topLeft' || handle === 'bottomLeft') {
                newLeft = newRight - adjustedWidth;
              } else {
                newRight = newLeft + adjustedWidth;
              }
            } else {
              const adjustedHeight = Math.abs(newWidth) / origAspect * Math.sign(newHeight);
              if (handle === 'topLeft' || handle === 'topRight') {
                newTop = newBottom - adjustedHeight;
              } else {
                newBottom = newTop + adjustedHeight;
              }
            }
          }

          newPoints = [
            { x: newLeft, y: newTop },
            { x: newRight, y: newBottom },
          ];
        }

        dispatch({
          type: 'RESIZE_ANNOTATION',
          payload: {
            id: resizeState.annotationId,
            points: newPoints,
            saveUndo: !hasMoved,
          },
        });

        if (!hasMoved) {
          setResizeState({ ...resizeState, hasMoved: true });
        }
        return;
      }

      // Handle dragging annotation (but not non-pending annotations)
      if (dragState && (dragState.annotation.status ?? 'pending') === 'pending') {
        const dx = point.x - dragState.startPoint.x;
        const dy = point.y - dragState.startPoint.y;
        const hasMoved = Math.abs(dx) > 2 || Math.abs(dy) > 2;

        if (hasMoved && !dragState.hasMoved) {
          // First move - mark as moved, save undo state, and update start point for delta calculation
          setDragState({ ...dragState, hasMoved: true, startPoint: point });
          dispatch({
            type: 'MOVE_ANNOTATION',
            payload: {
              id: dragState.annotation.id,
              delta: { x: dx, y: dy },
              saveUndo: true, // Only save undo on first move
            },
          });
        } else if (dragState.hasMoved) {
          // Subsequent moves - calculate delta from last position (no undo save)
          const moveDx = point.x - dragState.startPoint.x;
          const moveDy = point.y - dragState.startPoint.y;
          setDragState({ ...dragState, startPoint: point });
          dispatch({
            type: 'MOVE_ANNOTATION',
            payload: {
              id: dragState.annotation.id,
              delta: { x: moveDx, y: moveDy },
            },
          });
        }
        return;
      }

      if (!isDrawing || !state.isAnnotating) return;
      dispatch({ type: 'CONTINUE_PATH', payload: point });
    },
    [isDrawing, state.isAnnotating, state.activeTool, dragState, resizeState, hoveredElement, getPoint, dispatch]
  );

  const handlePointerUp = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      // Handle end of resize
      if (resizeState) {
        setResizeState(null);
        return;
      }

      // Handle end of annotation drag
      if (dragState) {
        // Allow editing text only if not restored
        if (!dragState.hasMoved && dragState.annotation.type === 'text' && (dragState.annotation.status ?? 'pending') === 'pending') {
          // No drag occurred on text annotation - enter edit mode
          const point = getPoint(e);
          setActiveText({
            id: dragState.annotation.id,
            point: dragState.annotation.points[0]!,
            text: dragState.annotation.text || '',
            fontSize: dragState.annotation.fontSize || 12,
            isNew: false,
            clickPoint: point,
            groupId: dragState.annotation.groupId,
          });
        }
        // If dragged or non-text annotation, position is already updated - just clear drag state
        setDragState(null);
        return;
      }

      if (!isDrawing) return;

      // Minimum drag distance to create a shape (prevents accidental clicks)
      const MIN_DRAG_DISTANCE = 5;

      // Check if the shape is too small (clicked without dragging)
      if (state.currentPath.length >= 2) {
        const start = state.currentPath[0]!;
        const end = state.currentPath[state.currentPath.length - 1]!;
        const dx = Math.abs(end.x - start.x);
        const dy = Math.abs(end.y - start.y);

        // For rectangles and circles, check both dimensions
        // For lines, check the total distance
        const isTooSmall =
          state.activeTool === 'line'
            ? Math.sqrt(dx * dx + dy * dy) < MIN_DRAG_DISTANCE
            : dx < MIN_DRAG_DISTANCE && dy < MIN_DRAG_DISTANCE;

        if (isTooSmall && ['rectangle', 'circle', 'line'].includes(state.activeTool)) {
          setIsDrawing(false);
          dispatch({ type: 'CANCEL_PATH' });
          return;
        }
      }

      // Capture DOM elements at annotation bounds before finishing
      const elements = captureElementsAtPoints(state.currentPath);

      // For rectangles, calculate bottom-left position for auto text annotation
      if (state.activeTool === 'rectangle' && state.currentPath.length >= 2) {
        const start = state.currentPath[0]!;
        const end = state.currentPath[state.currentPath.length - 1]!;
        const left = Math.min(start.x, end.x);
        const bottom = Math.max(start.y, end.y);
        // Position text at the bottom-left corner (flush with rectangle edge)
        // Account for stroke width (extends outward by half) and padding
        const strokeOffset = state.strokeWidth / 2;
        // Generate a shared groupId to link rectangle and text
        const groupId = Math.random().toString(36).substring(2, 9);
        setPendingRectangleText({
          point: {
            x: left - strokeOffset + PADDING,
            y: bottom + strokeOffset + PADDING,
          },
          groupId,
        });
        setIsDrawing(false);
        dispatch({ type: 'FINISH_PATH', payload: { groupId, elements } });
        return;
      }

      setIsDrawing(false);
      dispatch({ type: 'FINISH_PATH', payload: { elements } });
    },
    [isDrawing, dragState, resizeState, getPoint, dispatch, state.activeTool, state.currentPath, state.strokeWidth]
  );


  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!activeText) return;
    setActiveText({ ...activeText, text: e.target.value });
  }, [activeText]);

  const handleTextKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setActiveText(null);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // Enter without Shift commits the text
      e.preventDefault();
      commitActiveText();
    }
    // Shift+Enter allows newline (default textarea behavior)
  }, [commitActiveText]);

  // Inspector right-click: open style panel
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (state.activeTool !== 'inspector' || !state.isAnnotating) return;
    e.preventDefault();
    if (hoveredElement && !isElementInFlight(hoveredElement)) {
      const info = extractElementInfo(hoveredElement);
      const selector = getUniqueSelector(hoveredElement);
      dispatch({
        type: 'SELECT_ELEMENT',
        payload: { el: hoveredElement, info: { ...info, selector } },
      });
    }
  }, [state.activeTool, state.isAnnotating, hoveredElement, dispatch, isElementInFlight]);

  // Position tracking: linked annotations follow their elements
  useEffect(() => {
    const linkedAnnotations = state.annotations.filter(a => a.linkedSelector);
    if (linkedAnnotations.length === 0) return;

    let rafId: number | null = null;

    const checkPositions = () => {
      const updates: { id: string; point: Point; linkedAnchor?: 'top-left' | 'bottom-left' }[] = [];
      for (const ann of linkedAnnotations) {
        let el = document.querySelector(ann.linkedSelector!);

        // Fallback: if data-pm selector fails (e.g. after reload), try structural selector from elements
        if (!el && ann.elements?.[0]?.selector && ann.linkedSelector!.startsWith('[data-pm=')) {
          el = document.querySelector(ann.elements[0].selector);
          if (el) {
            // Re-apply the data-pm attribute so future lookups use the fast path
            const pmId = ann.linkedSelector!.match(/data-pm="([^"]+)"/)?.[1];
            if (pmId) el.setAttribute('data-pm', pmId);
          }
        }

        if (!el) continue;
        const rect = el.getBoundingClientRect();

        // Count badges below this annotation: modification badge + earlier linked annotations on same element
        const hasModBadge = state.styleModifications.some(m => {
          try { return (el as Element).matches(m.selector); } catch { return false; }
        });
        const earlierLinked = linkedAnnotations.filter(a =>
          a.id !== ann.id && a.timestamp < ann.timestamp && a.linkedSelector === ann.linkedSelector
        ).length;
        const stackOffset = (hasModBadge ? 1 : 0) + earlierLinked;

        // Re-evaluate anchor based on current element position
        const anchor: 'top-left' | 'bottom-left' = rect.top >= BADGE_HEIGHT * (1 + stackOffset) ? 'top-left' : 'bottom-left';
        const newPoint = calculateLinkedPosition(rect, anchor, stackOffset);
        const current = ann.points[0];
        const anchorChanged = anchor !== ann.linkedAnchor;
        if (current && (anchorChanged || Math.abs(newPoint.x - current.x) > 1 || Math.abs(newPoint.y - current.y) > 1)) {
          updates.push({ id: ann.id, point: newPoint, linkedAnchor: anchorChanged ? anchor : undefined });
        }
      }
      if (updates.length > 0) {
        dispatch({ type: 'UPDATE_LINKED_POSITIONS', payload: { updates } });
      }
    };

    const scheduleCheck = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(checkPositions);
    };

    checkPositions();

    window.addEventListener('scroll', scheduleCheck, true);
    window.addEventListener('resize', scheduleCheck, true);
    window.addEventListener('load', scheduleCheck);
    document.fonts.ready.then(scheduleCheck);

    const observer = new MutationObserver(scheduleCheck);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['style', 'class'],
    });

    return () => {
      window.removeEventListener('scroll', scheduleCheck, true);
      window.removeEventListener('resize', scheduleCheck, true);
      window.removeEventListener('load', scheduleCheck);
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [state.annotations, dispatch]);

  // Determine cursor based on state
  const getCursor = (): string => {
    if (!state.isAnnotating) return 'default';
    if (resizeState) {
      // Show appropriate cursor while dragging handles
      const { handle } = resizeState;
      if (handle === 'start' || handle === 'end') {
        return 'move'; // Line endpoints
      }
      if (handle === 'top' || handle === 'bottom') {
        return 'ns-resize'; // Vertical resize for circle top/bottom
      }
      if (handle === 'left' || handle === 'right') {
        return 'ew-resize'; // Horizontal resize for circle left/right
      }
      if (handle === 'topLeft' || handle === 'bottomRight') {
        return 'nwse-resize';
      }
      return 'nesw-resize';
    }
    if (state.activeTool === 'text') return 'text';
    return 'crosshair';
  };

  const canvasStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    zIndex: 9998,
    pointerEvents: state.isAnnotating ? 'auto' : 'none',
    visibility: state.isAnnotating ? 'visible' : 'hidden',
    cursor: getCursor(),
  };

  // Calculate textarea dimensions based on content
  const getTextDimensions = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeText) return { width: 100, height: 12 * LINE_HEIGHT };

    const ctx = canvas.getContext('2d');
    if (!ctx) return { width: 100, height: activeText.fontSize * LINE_HEIGHT };

    ctx.font = `${activeText.fontSize}px ${FONT_FAMILY}`;

    // Measure placeholder width to ensure it's always fully visible
    const placeholderWidth = ctx.measureText('Type here...').width;
    const minWidth = placeholderWidth;

    const lines = activeText.text.split('\n');
    const maxWidth = lines.length > 0
      ? Math.max(minWidth, ...lines.map((line) => ctx.measureText(line || ' ').width))
      : minWidth;
    const height = Math.max(1, lines.length) * activeText.fontSize * LINE_HEIGHT;

    return { width: maxWidth, height };
  }, [activeText, canvasRef]);

  const textDimensions = getTextDimensions();

  // Text input position (convert from document to viewport coords for fixed positioning)
  const textInputStyle: CSSProperties = activeText
    ? {
        position: 'fixed',
        left: activeText.point.x - PADDING - scroll.x,
        top: activeText.point.y - PADDING - scroll.y,
        zIndex: 9999,
        width: textDimensions.width + PADDING * 2,
        height: textDimensions.height + PADDING * 2,
        padding: PADDING,
        fontSize: activeText.fontSize,
        fontFamily: FONT_FAMILY,
        color: '#ffffff',
        backgroundColor: state.activeColor,
        border: 'none',
        borderRadius: 0,
        outline: 'none',
        boxShadow: 'none',
        lineHeight: LINE_HEIGHT,
        resize: 'none',
        overflow: 'hidden',
        whiteSpace: 'pre',
      }
    : {};

  return (
    <>
      <canvas
        ref={canvasRef}
        id="devtools-canvas"
        style={canvasStyle}
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={(e) => handlePointerUp(e)}
        onMouseLeave={(e) => handlePointerUp(e)}
        onTouchStart={handlePointerDown}
        onTouchMove={handlePointerMove}
        onTouchEnd={(e) => handlePointerUp(e)}
        onContextMenu={handleContextMenu}
      />

      {activeText && (
        <>
          <style>{`#devtools-text-input::placeholder { color: rgba(255, 255, 255, 0.5); }`}</style>
          <textarea
            id="devtools-text-input"
            ref={inputRef}
            value={activeText.text}
            onChange={handleTextChange}
            onKeyDown={handleTextKeyDown}
            onBlur={commitActiveText}
            placeholder="Type here..."
            style={textInputStyle}
          />
        </>
      )}

      {/* Badges for modified elements (shown when toolbar expanded, hidden during inspection) */}
      {state.isAnnotating && state.styleModifications.length > 0 && (
        <ModifiedElementBadges
          styleModifications={state.styleModifications}
          isInspecting={!!state.inspectedElement}
          accentColor={state.activeColor}
          annotationGroupCount={new Set(state.annotations.map(a => a.groupId || a.id)).size}
          dispatch={dispatch}
          inFlightSelectors={inFlightStyleSelectors}
        />
      )}

      {/* Thinking spinners for in-flight annotations (hidden when toolbar collapsed) */}
      {state.isAnnotating && inFlightAnnotationIds && inFlightAnnotationIds.size > 0 && (
        <ThinkingSpinners
          annotations={state.annotations}
          inFlightIds={inFlightAnnotationIds}
          scrollX={scroll.x}
          scrollY={scroll.y}
          annotationGroupMap={annotationGroupMap}
        />
      )}

      {/* Resolution badges for resolved/needs_review annotations (hidden when toolbar collapsed) */}
      {state.isAnnotating && (
        <ResolutionBadges
          annotations={state.annotations}
          supersededIds={supersededIds}
          scrollX={scroll.x}
          scrollY={scroll.y}
          annotationGroupMap={annotationGroupMap}
          onReply={onReply}
        />
      )}

      {/* Question badges for waiting_input annotations */}
      {state.isAnnotating && onReply && (
        <QuestionBadges
          annotations={state.annotations}
          supersededIds={supersededIds}
          scrollX={scroll.x}
          scrollY={scroll.y}
          onReply={onReply}
          annotationGroupMap={annotationGroupMap}
        />
      )}

      {/* Marching ants borders for in-flight style modifications */}
      {state.isAnnotating && inFlightSelectorColors && inFlightSelectorColors.size > 0 && (
        <MarchingAntsBorders inFlightSelectorColors={inFlightSelectorColors} />
      )}

      {/* Inspector mode: Element highlight */}
      {state.activeTool === 'inspector' && state.isAnnotating && (
        <>
          {/* Hover highlight (not selected) */}
          {hoveredElement && !state.inspectedElement && (() => {
            // Hide the tooltip badge when a linked annotation is being created
            // or already exists for the hovered element
            const hasLinkedAnnotation = !!pendingLinkedText || !!activeText?.linkedSelector ||
              state.annotations.some(a => {
                if (!a.linkedSelector) return false;
                try { return hoveredElement.matches(a.linkedSelector); } catch { return false; }
              });

            return (
              <ElementHighlight
                element={hoveredElement}
                isSelected={false}
                elementInfo={hoveredElementInfo}
                color={state.activeColor}
                hideTooltip={hasLinkedAnnotation}
              />
            );
          })()}

          {/* Selected element highlight */}
          {state.inspectedElement && (() => {
            // Calculate annotation number: count annotation groups + position in style mods
            const annotationGroupCount = new Set(
              state.annotations.map(a => a.groupId || a.id)
            ).size;
            const selector = state.inspectedElement.info.selector;
            const styleModIndex = state.styleModifications.findIndex(m => m.selector === selector);
            const annotationNumber = styleModIndex >= 0
              ? annotationGroupCount + styleModIndex + 1
              : annotationGroupCount + state.styleModifications.length + 1;

            // Get change count and captured status for this element
            const modification = state.styleModifications.find(m => m.selector === selector);
            const changeCount = modification?.changes.length ?? 0;
            const isCaptured = !!(modification?.captured);

            return (
              <ElementHighlight
                element={state.inspectedElement.el}
                isSelected={true}
                elementInfo={state.inspectedElement.info}
                color={isCaptured ? '#999999' : state.activeColor}
                annotationNumber={annotationNumber}
                changeCount={changeCount}
              />
            );
          })()}

          {/* Style panel for selected element */}
          {state.inspectedElement && (
            <StylePanel
              element={state.inspectedElement.el}
              elementInfo={state.inspectedElement.info}
              selector={state.inspectedElement.info.selector}
              styleModifications={state.styleModifications}
              dispatch={dispatch}
              onClose={() => dispatch({ type: 'SELECT_ELEMENT', payload: null })}
              accentColor={state.activeColor}
            />
          )}
        </>
      )}
    </>
  );
}

// Thinking spinner for in-flight annotations
const SPINNER_FRAME_COUNT = 3;
const SPINNER_INTERVAL = 250;

const THINKING_WORDS = [
  'reviewing', 'considering', 'thinking', 'zhuzhing',
  'iterating', 'tweaking', 'reflecting', 'noodling',
  'pondering', 'finessing', 'polishing', 'riffing',
];
const WORD_INTERVAL = 3000;

function ThinkingSpinners({
  annotations,
  inFlightIds,
  scrollX,
  scrollY,
  annotationGroupMap,
}: {
  annotations: Annotation[];
  inFlightIds: Set<string>;
  scrollX: number;
  scrollY: number;
  annotationGroupMap: Map<string, number>;
}) {
  const [charIndex, setCharIndex] = useState(0);
  const [wordIndex, setWordIndex] = useState(() => Math.floor(Math.random() * THINKING_WORDS.length));

  useEffect(() => {
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
  }, []);

  // Find text annotations that are in-flight (or whose group mate is in-flight)
  const spinnerPositions: { x: number; y: number; size: number; color: string }[] = [];

  for (const annotation of annotations) {
    if (annotation.type !== 'text' || !annotation.text || !annotation.points[0]) continue;

    // Check if this text annotation or its group is in-flight
    const isInFlight = inFlightIds.has(annotation.id) ||
      (annotation.groupId && annotations.some(
        a => a.groupId === annotation.groupId && inFlightIds.has(a.id)
      ));

    if (!isInFlight) continue;

    const point = annotation.points[0];
    const fontSize = annotation.fontSize || 12;
    const lineHeightPx = fontSize * LINE_HEIGHT;
    const lines = annotation.text.split('\n');

    // Prepend group number if available
    const groupNumber = annotationGroupMap.get(annotation.id);
    const displayLines = groupNumber !== undefined
      ? [groupNumber + '. ' + (lines[0] || ''), ...lines.slice(1)]
      : lines;

    // Measure text width using a temporary canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;

    ctx.font = `${fontSize}px ${FONT_FAMILY}`;
    const maxWidth = Math.max(...displayLines.map((line) => ctx.measureText(line).width));
    const totalHeight = displayLines.length * lineHeightPx;

    // Square spinner flush with right edge of text bg, full annotation height
    const annotationHeight = totalHeight + PADDING * 2;

    spinnerPositions.push({
      x: point.x + maxWidth + PADDING, // right edge of text bg
      y: point.y - PADDING,            // top of text bg
      size: annotationHeight,
      color: annotation.color,
    });
  }

  if (spinnerPositions.length === 0) return null;

  return (
    <>
      {spinnerPositions.map((pos, i) => (
        <div
          key={i}
          data-devtools
          style={{
            position: 'fixed',
            left: pos.x - scrollX,
            top: pos.y - scrollY,
            height: pos.size,
            display: 'flex',
            alignItems: 'center',
            pointerEvents: 'none',
            zIndex: 9999,
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
        </div>
      ))}
    </>
  );
}

// Resolution badge overlay for resolved/needs_review annotations
// Positioned flush with right edge of text annotation (like ThinkingSpinners)
function ResolutionBadges({
  annotations,
  supersededIds,
  scrollX,
  scrollY,
  annotationGroupMap,
  onReply,
}: {
  annotations: Annotation[];
  supersededIds: Set<string>;
  scrollX: number;
  scrollY: number;
  annotationGroupMap: Map<string, number>;
  onReply?: (threadId: string, reply: string) => void;
}) {
  // Find text annotations that are resolved/needs_review (or whose group mate is)
  const badgePositions: { annotation: Annotation; x: number; y: number; size: number; isNeedsReview: boolean; groupNumber?: number }[] = [];

  for (const annotation of annotations) {
    if (annotation.type !== 'text' || !annotation.text || !annotation.points[0]) continue;
    if (supersededIds.has(annotation.id)) continue;

    // Check if this text annotation or its group mate is resolved
    const status: AnnotationLifecycleStatus = annotation.status ?? 'pending';
    const groupMateResolved = annotation.groupId && annotations.some(
      a => a.groupId === annotation.groupId && (a.status === 'resolved' || a.status === 'needs_review')
    );

    if (status !== 'resolved' && status !== 'needs_review' && !groupMateResolved) continue;

    const isNeedsReview = status === 'needs_review' ||
      (annotation.groupId && annotations.some(a => a.groupId === annotation.groupId && a.status === 'needs_review'));

    const point = annotation.points[0];
    const fontSize = annotation.fontSize || 12;
    const lineHeightPx = fontSize * LINE_HEIGHT;
    const lines = annotation.text.split('\n');

    const groupNumber = annotationGroupMap.get(annotation.id);
    const displayLines = groupNumber !== undefined
      ? [groupNumber + '. ' + (lines[0] || ''), ...lines.slice(1)]
      : lines;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;

    ctx.font = `${fontSize}px ${FONT_FAMILY}`;
    const maxWidth = Math.max(...displayLines.map((line) => ctx.measureText(line).width));
    const totalHeight = displayLines.length * lineHeightPx;
    const annotationHeight = totalHeight + PADDING * 2;

    badgePositions.push({
      annotation,
      x: point.x + maxWidth + PADDING,
      y: point.y - PADDING,
      size: annotationHeight,
      isNeedsReview: !!isNeedsReview,
      groupNumber,
    });
  }

  if (badgePositions.length === 0) return null;

  return (
    <>
      {badgePositions.map(({ annotation, x, y, size, isNeedsReview, groupNumber }) => (
        <ResolutionBadge
          key={`resolution-${annotation.id}`}
          annotation={annotation}
          annotations={annotations}
          x={x - scrollX}
          y={y - scrollY}
          size={size}
          isNeedsReview={!!isNeedsReview}
          groupNumber={groupNumber}
          onReply={onReply}
        />
      ))}
    </>
  );
}

function ResolutionBadge({
  annotation,
  annotations,
  x,
  y,
  size,
  isNeedsReview,
  groupNumber,
  onReply,
}: {
  annotation: Annotation;
  annotations: Annotation[];
  x: number;
  y: number;
  size: number;
  isNeedsReview: boolean;
  groupNumber?: number;
  onReply?: (threadId: string, reply: string) => void;
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

  // Close on click outside or escape
  useEffect(() => {
    if (!expanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
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

  // Gather conversation from the annotation group
  const groupAnnotations = annotation.groupId
    ? annotations.filter(a => a.groupId === annotation.groupId)
    : [annotation];
  const textAnn = groupAnnotations.find(a => a.type === 'text');
  const userMessage = textAnn?.text || '(no text)';
  const summary = groupAnnotations.find(a => a.resolutionSummary)?.resolutionSummary;
  const threadId = groupAnnotations.find(a => a.threadId)?.threadId;

  const handleSubmit = useCallback(() => {
    if (!replyText.trim() || !threadId || !onReply) return;
    onReply(threadId, replyText.trim());
    setReplyText('');
    setExpanded(false);
  }, [replyText, threadId, onReply]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <div
      ref={panelRef}
      data-devtools="resolution-badge"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 9999,
        pointerEvents: 'auto',
      }}
    >
      {/* Collapsed badge */}
      {!expanded && (
        <div
          onClick={() => setExpanded(true)}
          style={{
            height: size,
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            backgroundColor: annotation.color,
            fontFamily: FONT_FAMILY,
            fontSize: 12,
            color: '#ffffff',
            userSelect: 'none',
            padding: `0 ${PADDING}px`,
            gap: 4,
            whiteSpace: 'nowrap',
          }}
        >
          {isNeedsReview ? (
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
            {(() => {
              const groupAnns = annotation.groupId
                ? annotations.filter(a => a.groupId === annotation.groupId)
                : [annotation];
              const count = groupAnns.reduce((n, a) => n + (a.replyCount ?? 0), 0) || 1;
              return `${count} ${count === 1 ? 'reply' : 'replies'}`;
            })()}
          </span>
        </div>
      )}

      {/* Expanded inline conversation */}
      {expanded && (
        <div
          style={{
            minWidth: 280,
            maxWidth: 400,
            backgroundColor: '#ffffff',
            fontFamily: FONT_FAMILY,
            fontSize: 12,
            color: '#1f2937',
            border: '1px solid rgba(0, 0, 0, 0.1)',
          }}
        >
          {/* User message */}
          <div style={{
            padding: `${PADDING + 2}px ${PADDING + 4}px`,
            backgroundColor: annotation.color,
            color: '#ffffff',
            lineHeight: 1.4,
          }}>
            {userMessage}
          </div>

          {/* Claude response */}
          {summary && (
            <div style={{
              padding: `${PADDING + 2}px ${PADDING + 4}px`,
              lineHeight: 1.4,
              borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
            }}>
              {summary}
            </div>
          )}

          {/* Reply area */}
          {threadId && onReply && (
            <div style={{ padding: PADDING }}>
              <textarea
                ref={textareaRef}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Reply..."
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
          )}
        </div>
      )}
    </div>
  );
}

// Marching ants border for in-flight style modifications
function MarchingAntsBorders({
  inFlightSelectorColors,
}: {
  inFlightSelectorColors: Map<string, string>;
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
      <style>{`@keyframes popmelt-march { to { stroke-dashoffset: -6; } }`}</style>
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
              style={{ animation: 'popmelt-march 0.5s steps(2) infinite' }}
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
function QuestionBadges({
  annotations,
  supersededIds,
  scrollX,
  scrollY,
  onReply,
  annotationGroupMap,
}: {
  annotations: Annotation[];
  supersededIds: Set<string>;
  scrollX: number;
  scrollY: number;
  onReply: (threadId: string, reply: string) => void;
  annotationGroupMap: Map<string, number>;
}) {
  const waitingAnnotations = annotations.filter(a => {
    if (supersededIds.has(a.id)) return false;
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
      const maxWidth = Math.max(...displayLines.map((line) => ctx.measureText(line).width));
      const totalHeight = displayLines.length * lineHeightPx;
      const annotationHeight = totalHeight + PADDING * 2;

      badges.push({
        annotation,
        x: point.x + maxWidth + PADDING,
        y: point.y - PADDING,
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

  return (
    <div
      ref={panelRef}
      data-devtools="question-badge"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 9999,
        pointerEvents: 'auto',
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
            cursor: 'pointer',
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

export { useCanvasDrawing };
