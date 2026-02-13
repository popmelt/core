'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { generateId } from '../hooks/useAnnotationState';
import { useCanvasDrawing } from '../hooks/useCanvasDrawing';
import { useModifierKeys } from '../hooks/useModifierKeys';
import { useWheelZoom } from '../hooks/useWheelZoom';
import { FONT_FAMILY, LINE_HEIGHT, MAX_DISPLAY_WIDTH, PADDING } from '../tools/text';
import type { Annotation, AnnotationAction, AnnotationLifecycleStatus, AnnotationState, ElementInfo, Point } from '../tools/types';
import type { BorderRadiusCorner } from '../utils/dom';
import { computeSupersededAnnotations } from '../utils/superseded';
import {
  applyInlineStyle,
  captureElementsAtPoints,
  computeGapZones,
  extractElementInfo,
  findElementBySelector,
  isAutoGap,
  getComputedBorderRadius,
  getComputedGap,
  getComputedPadding,
  getComputedTextProperties,
  getTextBoundingRect,
  getTopmostElementAtPoint,
  getUniqueSelector,
  isFlexOrGrid,
  isTextElement,
} from '../utils/dom';
import { BorderRadiusHandles } from './BorderRadiusHandles';
import { ElementHighlight } from './ElementHighlight';
import { GapHandles } from './GapHandles';
import { ModifiedElementBadges } from './ModifiedElementBadges';
import { ModifiedElementBorders } from './ModifiedElementBorders';
import type { PaddingSide } from './PaddingHandles';
import { PaddingHandles } from './PaddingHandles';
import { StylePanel } from './StylePanel';
import { SwipeHints } from './SwipeHints';
import type { TextHandleProperty } from './TextHandles';
import { TextHandles } from './TextHandles';

type AnnotationCanvasProps = {
  state: AnnotationState;
  dispatch: React.Dispatch<AnnotationAction>;
  onScreenshot: () => Promise<boolean>;
  inFlightAnnotationIds?: Set<string>;
  inFlightStyleSelectors?: Set<string>;
  inFlightSelectorColors?: Map<string, string>;
  onAttachImages?: (annotationId: string, images: Blob[]) => void;
  onReply?: (threadId: string, reply: string) => void;
  onViewThread?: (threadId: string) => void;
  activePlan?: { planId: string; status: string; threadId?: string; tasks?: { id: string; instruction: string }[] } | null;
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
  images?: Blob[]; // Pasted images (in-memory only, not serialized)
};

type HandleCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
type HandleCardinal = 'top' | 'bottom' | 'left' | 'right';
type LineHandle = 'start' | 'end';
type HandleType = HandleCorner | HandleCardinal | LineHandle;

const HANDLE_SIZE = 8;
const PADDING_SNAP_STEPS = [0, 1, 2, 4, 8, 12, 16, 20, 24, 28, 32] as const;

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

export function AnnotationCanvas({ state, dispatch, onScreenshot, inFlightAnnotationIds, inFlightStyleSelectors, inFlightSelectorColors, onAttachImages, onReply, onViewThread, activePlan }: AnnotationCanvasProps) {
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

  // Hand tool state
  const handDragRef = useRef<{
    isDragging: boolean;
    side: PaddingSide | null;
    startX: number;
    startY: number;
    original: { top: number; right: number; bottom: number; left: number };
    element: Element | null;
    elementInfo: ElementInfo | null;
    selector: string | null;
    durableSelector: string | null;
  }>({ isDragging: false, side: null, startX: 0, startY: 0, original: { top: 0, right: 0, bottom: 0, left: 0 }, element: null, elementInfo: null, selector: null, durableSelector: null });

  const [handHoveredElement, setHandHoveredElement] = useState<Element | null>(null);
  const [handHoveredSide, setHandHoveredSide] = useState<PaddingSide | null>(null);
  const [stylePanelHint, setStylePanelHint] = useState<string | null>(null);
  const [handDragging, setHandDragging] = useState<{ side: PaddingSide; padding: { top: number; right: number; bottom: number; left: number } } | null>(null);
  const handCursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [handCursorPos, setHandCursorPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Gap handle state
  const gapDragRef = useRef<{
    isDragging: boolean;
    hasMoved: boolean;
    axis: 'row' | 'column' | null;
    startX: number;
    startY: number;
    originalRow: number;
    originalColumn: number;
    element: Element | null;
    elementInfo: ElementInfo | null;
    selector: string | null;
    durableSelector: string | null;
    isAuto: boolean;
    originalJustifyContent: string;
    visualGap: number;
  }>({ isDragging: false, hasMoved: false, axis: null, startX: 0, startY: 0, originalRow: 0, originalColumn: 0, element: null, elementInfo: null, selector: null, durableSelector: null, isAuto: false, originalJustifyContent: '', visualGap: 0 });

  const [gapHoveredElement, setGapHoveredElement] = useState<Element | null>(null);
  const [gapHoveredAxis, setGapHoveredAxis] = useState<'row' | 'column' | null>(null);
  const [gapDragging, setGapDragging] = useState<{ axis: 'row' | 'column'; row: number; column: number } | null>(null);
  const [gapIsAuto, setGapIsAuto] = useState(false);
  const [gapRefreshKey, setGapRefreshKey] = useState(0);

  // Swipe hint state
  const [swipeHint, setSwipeHint] = useState<{ modifier: 'shift' | 'alt'; target: HTMLElement } | null>(null);

  // Border radius handle state
  const radiusDragRef = useRef<{
    isDragging: boolean;
    corner: BorderRadiusCorner | null;
    startY: number;
    original: Record<BorderRadiusCorner, number>;
    maxRadius: number;
    element: Element | null;
    elementInfo: ElementInfo | null;
    selector: string | null;
    durableSelector: string | null;
  }>({ isDragging: false, corner: null, startY: 0, original: { 'top-left': 0, 'top-right': 0, 'bottom-right': 0, 'bottom-left': 0 }, maxRadius: 0, element: null, elementInfo: null, selector: null, durableSelector: null });

  const [radiusHoveredElement, setRadiusHoveredElement] = useState<Element | null>(null);
  const [radiusHoveredCorner, setRadiusHoveredCorner] = useState<BorderRadiusCorner | null>(null);
  const [radiusDragging, setRadiusDragging] = useState<{ corner: BorderRadiusCorner; radius: Record<BorderRadiusCorner, number> } | null>(null);

  // Text handle state
  const textDragRef = useRef<{
    isDragging: boolean;
    property: TextHandleProperty | null;
    startX: number;
    startY: number;
    originalFontSize: number;
    originalLineHeight: number;
    originalRatio: number;
    element: Element | null;
    elementInfo: ElementInfo | null;
    selector: string | null;
    durableSelector: string | null;
  }>({ isDragging: false, property: null, startX: 0, startY: 0, originalFontSize: 0, originalLineHeight: 0, originalRatio: 1.2, element: null, elementInfo: null, selector: null, durableSelector: null });

  const [textHoveredElement, setTextHoveredElement] = useState<Element | null>(null);
  const [textHoveredProperty, setTextHoveredProperty] = useState<TextHandleProperty | null>(null);
  const [textDragging, setTextDragging] = useState<{ property: TextHandleProperty; fontSize: number; lineHeight: number } | null>(null);

  // Track modifier keys via keydown/keyup (more reliable than reading from mouse events)
  const modifiersRef = useModifierKeys();

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
  useWheelZoom(activeText, setActiveText, hoveredTextId, state.annotations, dispatch);

  // Option + horizontal swipe over flex containers: cycle justify-content start ↔ center ↔ end
  // Finds nearest flex container at cursor position — works anywhere on the element, not just gap zones
  const gapHoveredElementRef = useRef<Element | null>(null);
  const gapHoveredAxisRef = useRef<'row' | 'column' | null>(null);
  gapHoveredElementRef.current = gapHoveredElement;
  gapHoveredAxisRef.current = gapHoveredAxis;

  useEffect(() => {
    const JUSTIFY_STEPS = ['flex-start', 'center', 'flex-end'] as const;
    const ALIGN_STEPS = ['flex-start', 'center', 'flex-end'] as const;
    const COOLDOWN_MS = 300;

    // Shared state
    let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
    let inCooldown = false;
    let lockedX: number | null = null;
    let lockedY: number | null = null;

    const findFlexContainer = (x: number, y: number): HTMLElement | null => {
      const el = getTopmostElementAtPoint(x, y);
      let current: Element | null = el;
      while (current && current !== document.documentElement) {
        const d = window.getComputedStyle(current).display;
        if (d === 'flex' || d === 'inline-flex') return current as HTMLElement;
        current = current.parentElement;
      }
      return null;
    };

    const getMainAxis = (flexEl: HTMLElement): 'horizontal' | 'vertical' => {
      const fd = window.getComputedStyle(flexEl).flexDirection;
      return (fd === 'column' || fd === 'column-reverse') ? 'vertical' : 'horizontal';
    };

    const tagElement = (el: HTMLElement): { selector: string; durableSelector: string } => {
      let pmId = el.getAttribute('data-pm');
      if (!pmId) { pmId = Math.random().toString(36).substring(2, 8); el.setAttribute('data-pm', pmId); }
      return { selector: `[data-pm="${pmId}"]`, durableSelector: getUniqueSelector(el) };
    };

    const enterCooldown = () => {
      inCooldown = true;
      if (cooldownTimer) clearTimeout(cooldownTimer);
      cooldownTimer = setTimeout(() => { inCooldown = false; cooldownTimer = null; }, COOLDOWN_MS);
    };

    const commitSwipeAction = (flexEl: HTMLElement, swipeAxis: 'horizontal' | 'vertical', direction: 1 | -1) => {
      const mainAxis = getMainAxis(flexEl);

      if (swipeAxis === mainAxis) {
        // Swipe along main axis → cycle justify-content
        const cs = window.getComputedStyle(flexEl);
        const currentJc = cs.justifyContent;
        const normalized = currentJc === 'normal' || currentJc === 'flex-start' || currentJc === 'start'
          ? 'flex-start'
          : currentJc === 'flex-end' || currentJc === 'end'
            ? 'flex-end'
            : currentJc === 'center'
              ? 'center'
              : null;

        if (!normalized) return;

        const currentIndex = JUSTIFY_STEPS.indexOf(normalized);
        const nextIndex = currentIndex + direction;
        if (nextIndex < 0 || nextIndex >= JUSTIFY_STEPS.length) return;

        const newJc = JUSTIFY_STEPS[nextIndex]!;
        const { selector, durableSelector } = tagElement(flexEl);

        applyInlineStyle(flexEl, 'justify-content', newJc);
        dispatch({
          type: 'MODIFY_STYLES_BATCH',
          payload: {
            selector, durableSelector,
            element: extractElementInfo(flexEl),
            changes: [{ property: 'justify-content', original: currentJc, modified: newJc }],
          },
        });
      } else {
        // Swipe along cross axis → flip flex-direction
        const cs = window.getComputedStyle(flexEl);
        const currentFd = cs.flexDirection;
        const newFd = mainAxis === 'horizontal' ? 'column' : 'row';
        const { selector, durableSelector } = tagElement(flexEl);

        applyInlineStyle(flexEl, 'flex-direction', newFd);
        dispatch({
          type: 'MODIFY_STYLES_BATCH',
          payload: {
            selector, durableSelector,
            element: extractElementInfo(flexEl),
            changes: [{ property: 'flex-direction', original: currentFd, modified: newFd }],
          },
        });
      }

      // Force GapHandles to recalculate bounds/zones after layout change
      setGapRefreshKey(k => k + 1);
    };

    const commitAlignAction = (flexEl: HTMLElement, swipeAxis: 'horizontal' | 'vertical', direction: 1 | -1) => {
      const mainAxis = getMainAxis(flexEl);
      const crossAxis: 'horizontal' | 'vertical' = mainAxis === 'horizontal' ? 'vertical' : 'horizontal';

      // Only respond to cross-axis swipes (the axis align-items controls)
      if (swipeAxis !== crossAxis) return;

      const cs = window.getComputedStyle(flexEl);
      const currentAi = cs.alignItems;
      const normalized = currentAi === 'normal' || currentAi === 'stretch' || currentAi === 'flex-start' || currentAi === 'start'
        ? 'flex-start'
        : currentAi === 'flex-end' || currentAi === 'end'
          ? 'flex-end'
          : currentAi === 'center'
            ? 'center'
            : null;

      if (!normalized) return;

      const currentIndex = ALIGN_STEPS.indexOf(normalized);
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= ALIGN_STEPS.length) return;

      const newAi = ALIGN_STEPS[nextIndex]!;
      const { selector, durableSelector } = tagElement(flexEl);

      applyInlineStyle(flexEl, 'align-items', newAi);
      dispatch({
        type: 'MODIFY_STYLES_BATCH',
        payload: {
          selector, durableSelector,
          element: extractElementInfo(flexEl),
          changes: [{ property: 'align-items', original: currentAi, modified: newAi }],
        },
      });

      setGapRefreshKey(k => k + 1);
    };

    // --- Mousemove handler (Shift/Alt + distance-based swipe) ---
    const SWIPE_DISTANCE = 20; // px from anchor to trigger
    let anchorX: number | null = null;
    let anchorY: number | null = null;
    let dispSign: 1 | -1 | 0 = 0; // established displacement direction from anchor

    const updateSwipeHint = (modifier: 'shift' | 'alt', x: number, y: number) => {
      const flexEl = findFlexContainer(x, y);
      if (flexEl) {
        setSwipeHint({ modifier, target: flexEl });
      } else {
        setSwipeHint(null);
      }
    };

    const keydownHandler = (e: KeyboardEvent) => {
      if (state.activeTool !== 'hand' || !state.isAnnotating) return;
      if (e.key === 'Shift' && !e.altKey) {
        const pos = handCursorRef.current;
        updateSwipeHint('shift', pos.x, pos.y);
      } else if (e.key === 'Alt' && !e.shiftKey) {
        const pos = handCursorRef.current;
        updateSwipeHint('alt', pos.x, pos.y);
      }
    };

    const moveHandler = (e: MouseEvent) => {
      if (state.activeTool !== 'hand' || !state.isAnnotating) return;
      const isShift = e.shiftKey && !e.altKey;
      const isAlt = e.altKey && !e.shiftKey;
      if ((!isShift && !isAlt) || e.buttons !== 0) {
        anchorX = null; anchorY = null; dispSign = 0; lockedX = null; lockedY = null;
        setSwipeHint(null);
        return;
      }

      if (lockedX === null) {
        lockedX = e.clientX; lockedY = e.clientY;
        updateSwipeHint(isShift ? 'shift' : 'alt', e.clientX, e.clientY);
      }

      if (inCooldown) return;

      // Set anchor on first move after cooldown expires (or first move with modifier)
      if (anchorX === null) { anchorX = e.clientX; anchorY = e.clientY; dispSign = 0; }

      const dx = e.clientX - anchorX;
      const dy = e.clientY - anchorY!;

      // Track primary displacement direction; if cursor reverses through anchor, reset
      const primaryDelta = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
      if (Math.abs(primaryDelta) > 3) {
        const curSign: 1 | -1 = primaryDelta > 0 ? 1 : -1;
        if (dispSign !== 0 && curSign !== dispSign) {
          // Direction reversed — restart from here
          anchorX = e.clientX; anchorY = e.clientY; dispSign = 0;
          return;
        }
        dispSign = curSign;
      }

      // Need at least one axis above distance threshold
      if (Math.abs(dx) < SWIPE_DISTANCE && Math.abs(dy) < SWIPE_DISTANCE) return;

      const flexEl = findFlexContainer(lockedX, lockedY!);
      if (!flexEl) return;

      const swipeAxis: 'horizontal' | 'vertical' = Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
      const delta = swipeAxis === 'horizontal' ? dx : dy;
      const direction: 1 | -1 = delta > 0 ? 1 : -1;

      // Reset anchor for next swipe
      anchorX = null; anchorY = null; dispSign = 0;
      if (isShift) {
        commitSwipeAction(flexEl, swipeAxis, direction);
      } else {
        commitAlignAction(flexEl, swipeAxis, direction);
      }
      enterCooldown();
    };

    const keyupHandler = (e: KeyboardEvent) => {
      if (e.key === 'Shift' || e.key === 'Alt') {
        lockedX = null; lockedY = null;
        anchorX = null; anchorY = null; dispSign = 0;
        setSwipeHint(null);
      }
    };

    const mousedownHandler = () => {
      setSwipeHint(null);
      anchorX = null; anchorY = null; dispSign = 0;
    };

    window.addEventListener('keydown', keydownHandler);
    window.addEventListener('mousemove', moveHandler);
    window.addEventListener('mousedown', mousedownHandler);
    window.addEventListener('keyup', keyupHandler);
    return () => {
      window.removeEventListener('keydown', keydownHandler);
      window.removeEventListener('mousemove', moveHandler);
      window.removeEventListener('mousedown', mousedownHandler);
      window.removeEventListener('keyup', keyupHandler);
      if (cooldownTimer) clearTimeout(cooldownTimer);
    };
  }, [state.activeTool, state.isAnnotating, dispatch]);

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

  // Compute superseded annotations: when multiple annotation rounds target
  // the same linkedSelector, only the newest round is visible.
  // Returns Set<Annotation> (object refs) to avoid duplicate-ID collisions.
  const supersededAnnotations = useMemo(
    () => computeSupersededAnnotations(state.annotations),
    [state.annotations],
  );

  // Calculate annotation group map (for numbering text annotations)
  const annotationGroupMap = useMemo(() => {
    const map = new Map<string, number>();
    const seenGroupIds = new Set<string>();
    let groupIndex = 1;

    for (const annotation of state.annotations) {
      if (supersededAnnotations.has(annotation)) continue;
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
  }, [state.annotations, supersededAnnotations]);

  // Derive focused selector colors from selected annotations (for dotted outlines on inspector-created elements)
  const focusedSelectorColors = useMemo(() => {
    if (selectedAnnotationIds.length === 0) return null;
    const map = new Map<string, string>();
    for (const id of selectedAnnotationIds) {
      const ann = state.annotations.find(a => a.id === id);
      if (!ann) continue;
      // Check this annotation and its group mates for linked selectors
      const group = ann.groupId
        ? state.annotations.filter(a => a.groupId === ann.groupId)
        : [ann];
      for (const a of group) {
        if (a.linkedSelector && !inFlightSelectorColors?.has(a.linkedSelector)) {
          const color = a.color || state.activeColor;
          map.set(a.linkedSelector, color);
        }
      }
    }
    return map.size > 0 ? map : null;
  }, [selectedAnnotationIds, state.annotations, state.activeColor, inFlightSelectorColors]);

  // Redraw when state changes or scroll position changes
  useEffect(() => {
    // Filter out the annotation being edited and superseded annotations
    const visibleAnnotations = state.annotations.filter(a => {
      if (supersededAnnotations.has(a)) return false;
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
  }, [state.annotations, state.currentPath, state.activeTool, state.activeColor, state.strokeWidth, redrawAll, activeText, selectedAnnotationIds, scroll, annotationGroupMap, supersededAnnotations]);

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
      if (supersededAnnotations.has(annotation)) continue;

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
  }, [state.annotations, canvasRef, isPointNearLine, supersededAnnotations]);

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

    const imageCount = activeText.images?.length || 0;

    if (activeText.text.trim() || imageCount > 0) {
      // Has text or images - add or update
      if (activeText.isNew) {
        const annotationId = generateId();
        dispatch({
          type: 'ADD_TEXT',
          payload: {
            point: activeText.point,
            text: activeText.text || (imageCount > 0 ? `[${imageCount} image${imageCount > 1 ? 's' : ''}]` : ''),
            fontSize: activeText.fontSize,
            id: annotationId,
            groupId: activeText.groupId,
            linkedSelector: activeText.linkedSelector,
            linkedAnchor: activeText.linkedAnchor,
            elements: activeText.elements,
            ...(imageCount > 0 ? { imageCount } : {}),
          },
        });
        if (imageCount > 0 && activeText.images && onAttachImages) {
          onAttachImages(annotationId, activeText.images);
        }
      } else {
        dispatch({
          type: 'UPDATE_TEXT',
          payload: {
            id: activeText.id,
            text: activeText.text || (imageCount > 0 ? `[${imageCount} image${imageCount > 1 ? 's' : ''}]` : ''),
            ...(imageCount > 0 ? { imageCount } : {}),
          },
        });
        if (imageCount > 0 && activeText.images && onAttachImages) {
          onAttachImages(activeText.id, activeText.images);
        }
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
  }, [activeText, dispatch, onAttachImages]);

  // --- Hand tool helpers ---

  const snapPadding = useCallback((value: number): number => {
    // Fixed steps up to 32
    for (let i = 0; i < PADDING_SNAP_STEPS.length - 1; i++) {
      const lo = PADDING_SNAP_STEPS[i]!;
      const hi = PADDING_SNAP_STEPS[i + 1]!;
      if (value <= (lo + hi) / 2) return lo;
      if (value < hi) return hi;
    }
    // Beyond 32: snap to nearest multiple of 8
    return Math.round(value / 8) * 8;
  }, []);

  const detectPaddingSide = useCallback((vx: number, vy: number, rect: DOMRect, padding: { top: number; right: number; bottom: number; left: number }): PaddingSide | null => {
    const contentTop = rect.top + Math.max(padding.top, 4);
    const contentBottom = rect.bottom - Math.max(padding.bottom, 4);
    const contentLeft = rect.left + Math.max(padding.left, 4);
    const contentRight = rect.right - Math.max(padding.right, 4);

    if (vx < rect.left || vx > rect.right || vy < rect.top || vy > rect.bottom) return null;

    const inTop = vy < contentTop;
    const inBottom = vy > contentBottom;
    const inLeft = vx < contentLeft;
    const inRight = vx > contentRight;

    if (inTop && inLeft) return padding.top >= padding.left ? 'top' : 'left';
    if (inTop && inRight) return padding.top >= padding.right ? 'top' : 'right';
    if (inBottom && inLeft) return padding.bottom >= padding.left ? 'bottom' : 'left';
    if (inBottom && inRight) return padding.bottom >= padding.right ? 'bottom' : 'right';

    if (inTop) return 'top';
    if (inBottom) return 'bottom';
    if (inLeft) return 'left';
    if (inRight) return 'right';
    return null;
  }, []);

  const handlePointerDown = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!state.isAnnotating) return;

      // If StylePanel is open (hand tool right-click inspect), close it on left-click only.
      // Right-click (button 2) is handled by contextmenu which replaces the selection directly.
      if (state.inspectedElement && state.activeTool === 'hand' && !('button' in e && e.button === 2)) {
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: 'SELECT_ELEMENT', payload: null });
        return;
      }

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

      // Hand tool: start gap drag
      if (state.activeTool === 'hand' && gapHoveredElement && gapHoveredAxis) {
        const el = gapHoveredElement;
        let pmId = el.getAttribute('data-pm');
        if (!pmId) { pmId = Math.random().toString(36).substring(2, 8); el.setAttribute('data-pm', pmId); }
        const gapDurableSelector = getUniqueSelector(el);
        const selector = `[data-pm="${pmId}"]`;
        const info = extractElementInfo(el);
        const gapValues = getComputedGap(el);
        const viewportX = point.x - window.scrollX;
        const viewportY = point.y - window.scrollY;
        const auto = gapIsAuto;
        const jc = window.getComputedStyle(el).justifyContent;

        // For auto gaps, use the visual gap from zone dimensions
        let visualGap = 0;
        if (auto) {
          const zones = computeGapZones(el);
          const hit = zones.find(z => z.axis === gapHoveredAxis);
          visualGap = hit ? (gapHoveredAxis === 'column' ? hit.w : hit.h) : 0;
        }

        applyInlineStyle(el, 'transition', 'none');

        gapDragRef.current = {
          isDragging: true,
          hasMoved: false,
          axis: gapHoveredAxis,
          startX: viewportX,
          startY: viewportY,
          originalRow: auto ? visualGap : gapValues.row,
          originalColumn: auto ? visualGap : gapValues.column,
          element: el,
          elementInfo: { ...info, selector },
          selector,
          durableSelector: gapDurableSelector,
          isAuto: auto,
          originalJustifyContent: jc,
          visualGap,
        };
        setGapDragging({ axis: gapHoveredAxis, row: auto ? visualGap : gapValues.row, column: auto ? visualGap : gapValues.column });
        return;
      }

      // Hand tool: start text handle drag
      if (state.activeTool === 'hand' && textHoveredElement && textHoveredProperty) {
        const el = textHoveredElement;
        let pmId = el.getAttribute('data-pm');
        if (!pmId) { pmId = Math.random().toString(36).substring(2, 8); el.setAttribute('data-pm', pmId); }
        const selector = `[data-pm="${pmId}"]`;
        const info = extractElementInfo(el);
        const { fontSize, lineHeight } = getComputedTextProperties(el);
        const ratio = fontSize > 0 ? lineHeight / fontSize : 1.2;
        const viewportX = point.x - window.scrollX;
        const viewportY = point.y - window.scrollY;

        applyInlineStyle(el, 'transition', 'none');

        const durableSelector = getUniqueSelector(el);
        textDragRef.current = {
          isDragging: true, property: textHoveredProperty,
          startX: viewportX, startY: viewportY,
          originalFontSize: fontSize, originalLineHeight: lineHeight, originalRatio: ratio,
          element: el, elementInfo: { ...info, selector }, selector, durableSelector,
        };
        setTextDragging({ property: textHoveredProperty, fontSize, lineHeight });
        return;
      }

      // Hand tool: start border radius drag
      if (state.activeTool === 'hand' && radiusHoveredElement && radiusHoveredCorner) {
        const el = radiusHoveredElement;
        let pmId = el.getAttribute('data-pm');
        if (!pmId) { pmId = Math.random().toString(36).substring(2, 8); el.setAttribute('data-pm', pmId); }
        const selector = `[data-pm="${pmId}"]`;
        const durableSelector = getUniqueSelector(el);
        const info = extractElementInfo(el);
        const original = getComputedBorderRadius(el);
        const rect = el.getBoundingClientRect();
        const maxRadius = Math.floor(rect.height / 2);
        const viewportY = point.y - window.scrollY;

        applyInlineStyle(el, 'transition', 'none');

        radiusDragRef.current = {
          isDragging: true, corner: radiusHoveredCorner, startY: viewportY,
          original, maxRadius, element: el, elementInfo: { ...info, selector }, selector, durableSelector,
        };
        setRadiusDragging({ corner: radiusHoveredCorner, radius: { ...original } });
        return;
      }

      // Hand tool: start padding drag
      if (state.activeTool === 'hand' && handHoveredElement && handHoveredSide) {
        const el = handHoveredElement;
        // Tag element with data-pm if needed
        let pmId = el.getAttribute('data-pm');
        if (!pmId) {
          pmId = Math.random().toString(36).substring(2, 8);
          el.setAttribute('data-pm', pmId);
        }
        const selector = `[data-pm="${pmId}"]`;
        const handDurableSelector = getUniqueSelector(el);
        const info = extractElementInfo(el);
        const original = getComputedPadding(el);
        const viewportX = point.x - window.scrollX;
        const viewportY = point.y - window.scrollY;

        // Freeze transitions so padding changes apply instantly
        applyInlineStyle(el, 'transition', 'none');

        handDragRef.current = {
          isDragging: true,
          side: handHoveredSide,
          startX: viewportX,
          startY: viewportY,
          original,
          element: el,
          elementInfo: { ...info, selector },
          selector,
          durableSelector: handDurableSelector,
        };
        setHandDragging({ side: handHoveredSide, padding: { ...original } });
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
    [state.isAnnotating, state.activeTool, state.inspectedElement, state.annotations, activeText, selectedAnnotationIds, hoveredElement, handHoveredElement, handHoveredSide, radiusHoveredElement, radiusHoveredCorner, gapHoveredElement, gapHoveredAxis, gapIsAuto, textHoveredElement, textHoveredProperty, getPoint, findAnnotationAtPoint, findHandleAtPoint, dispatch, selectAnnotation, clearSelection, commitActiveText]
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

      // Hand tool: hover detection and drag
      if (state.activeTool === 'hand' && state.isAnnotating) {
        const viewportX = point.x - window.scrollX;
        const viewportY = point.y - window.scrollY;

        handCursorRef.current = { x: viewportX, y: viewportY };
        setHandCursorPos({ x: viewportX, y: viewportY });

        const isCmdHeld = modifiersRef.current.cmd;
        const isShiftHeld = modifiersRef.current.shift;

        // Gap drag handling
        if (gapDragRef.current.isDragging) {
          const drag = gapDragRef.current;
          const el = drag.element;
          if (!el) return;

          // Detect first meaningful move
          if (!drag.hasMoved) {
            const dx = Math.abs(viewportX - drag.startX);
            const dy = Math.abs(viewportY - drag.startY);
            if (dx <= 2 && dy <= 2) return; // No meaningful movement yet
            drag.hasMoved = true;

            // Auto→fixed conversion on first move: remove justify distribution, set explicit gaps
            if (drag.isAuto) {
              applyInlineStyle(el, 'justify-content', 'normal');
              applyInlineStyle(el, 'row-gap', `${drag.visualGap}px`);
              applyInlineStyle(el, 'column-gap', `${drag.visualGap}px`);
              setGapIsAuto(false);
            }
          }

          const axis = drag.axis!;
          let newRow = drag.originalRow;
          let newColumn = drag.originalColumn;

          if (axis === 'column') {
            const delta = viewportX - drag.startX;
            newColumn = drag.originalColumn + delta;
            if (!isCmdHeld) newRow = drag.originalRow + delta;
          } else {
            const delta = viewportY - drag.startY;
            newRow = drag.originalRow + delta;
            if (!isCmdHeld) newColumn = drag.originalColumn + delta;
          }

          newRow = Math.max(0, newRow);
          newColumn = Math.max(0, newColumn);
          if (isShiftHeld) { newRow = snapPadding(newRow); newColumn = snapPadding(newColumn); }
          newRow = Math.round(newRow);
          newColumn = Math.round(newColumn);

          applyInlineStyle(el, 'row-gap', `${newRow}px`);
          applyInlineStyle(el, 'column-gap', `${newColumn}px`);
          setGapDragging({ axis, row: newRow, column: newColumn });
          return;
        }

        if (radiusDragRef.current.isDragging) {
          const drag = radiusDragRef.current;
          const el = drag.element;
          if (!el) return;

          const delta = viewportY - drag.startY;
          const corner = drag.corner!;
          const orig = drag.original;

          let newRadius = { ...orig };
          if (isCmdHeld) {
            let val = orig[corner] + delta;
            val = Math.max(0, Math.min(drag.maxRadius, val));
            if (isShiftHeld) val = snapPadding(val);
            val = Math.round(val);
            newRadius[corner] = val;
          } else {
            let val = orig[corner] + delta;
            val = Math.max(0, Math.min(drag.maxRadius, val));
            if (isShiftHeld) val = snapPadding(val);
            val = Math.round(val);
            newRadius = { 'top-left': val, 'top-right': val, 'bottom-right': val, 'bottom-left': val };
          }

          applyInlineStyle(el, 'border-top-left-radius', `${newRadius['top-left']}px`);
          applyInlineStyle(el, 'border-top-right-radius', `${newRadius['top-right']}px`);
          applyInlineStyle(el, 'border-bottom-right-radius', `${newRadius['bottom-right']}px`);
          applyInlineStyle(el, 'border-bottom-left-radius', `${newRadius['bottom-left']}px`);
          setRadiusDragging({ corner, radius: newRadius });
          return;
        }

        if (textDragRef.current.isDragging) {
          const drag = textDragRef.current;
          const el = drag.element;
          if (!el) return;

          const property = drag.property!;
          let newFontSize = drag.originalFontSize;
          let newLineHeight = drag.originalLineHeight;

          const TYPE_SCALE = [8, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96];

          if (property === 'font-size') {
            const delta = viewportX - drag.startX;
            newFontSize = drag.originalFontSize + delta;
            newFontSize = Math.max(1, newFontSize);
          } else {
            // Line-height drag: only changes line-height, font-size stays fixed
            const delta = viewportY - drag.startY;
            newLineHeight = drag.originalLineHeight + delta;
            newLineHeight = Math.max(newFontSize, newLineHeight);
          }

          if (isShiftHeld) {
            if (property === 'font-size') {
              // Snap font-size to type scale
              let closest = TYPE_SCALE[0]!;
              let closestDist = Math.abs(newFontSize - closest);
              for (const s of TYPE_SCALE) {
                const d = Math.abs(newFontSize - s);
                if (d < closestDist) { closest = s; closestDist = d; }
              }
              newFontSize = closest;
            } else {
              // Snap line-height ratio to 0.5 increments
              const ratio = newFontSize > 0 ? newLineHeight / newFontSize : 1.2;
              const snappedRatio = Math.round(ratio * 2) / 2;
              newLineHeight = newFontSize * Math.max(1, snappedRatio);
            }
          }

          newFontSize = Math.round(newFontSize);
          newLineHeight = Math.round(newLineHeight * 10) / 10;

          applyInlineStyle(el, 'font-size', `${newFontSize}px`);
          const lhRatio = newFontSize > 0 ? Math.round((newLineHeight / newFontSize) * 1000) / 1000 : 1.2;
          applyInlineStyle(el, 'line-height', `${lhRatio}`);
          setTextDragging({ property, fontSize: newFontSize, lineHeight: newLineHeight });
          return;
        }

        if (handDragRef.current.isDragging) {
          const drag = handDragRef.current;
          const el = drag.element;
          if (!el) return;

          const side = drag.side!;
          const orig = drag.original;

          let newTop = orig.top;
          let newRight = orig.right;
          let newBottom = orig.bottom;
          let newLeft = orig.left;

          // Calculate delta for the dragged side
          if (side === 'top') {
            const delta = drag.startY - viewportY;
            newTop = orig.top + delta;
            if (!isCmdHeld) newBottom = orig.bottom + delta;
          } else if (side === 'bottom') {
            const delta = viewportY - drag.startY;
            newBottom = orig.bottom + delta;
            if (!isCmdHeld) newTop = orig.top + delta;
          } else if (side === 'left') {
            const delta = drag.startX - viewportX;
            newLeft = orig.left + delta;
            if (!isCmdHeld) newRight = orig.right + delta;
          } else if (side === 'right') {
            const delta = viewportX - drag.startX;
            newRight = orig.right + delta;
            if (!isCmdHeld) newLeft = orig.left + delta;
          }

          // Clamp >= 0
          newTop = Math.max(0, newTop);
          newRight = Math.max(0, newRight);
          newBottom = Math.max(0, newBottom);
          newLeft = Math.max(0, newLeft);

          // Snap if shift held
          if (isShiftHeld) {
            newTop = snapPadding(newTop);
            newRight = snapPadding(newRight);
            newBottom = snapPadding(newBottom);
            newLeft = snapPadding(newLeft);
          }

          // Round to whole pixels
          newTop = Math.round(newTop);
          newRight = Math.round(newRight);
          newBottom = Math.round(newBottom);
          newLeft = Math.round(newLeft);

          // Apply inline style for live preview
          applyInlineStyle(el, 'padding', `${newTop}px ${newRight}px ${newBottom}px ${newLeft}px`);
          setHandDragging({ side, padding: { top: newTop, right: newRight, bottom: newBottom, left: newLeft } });
          return;
        }

        // Hover: detect element, check corners first (highest priority), then gap, then text, then padding
        // Skip <a> elements — links are invisible to the hand tool (style the wrapped element instead)
        let el = getTopmostElementAtPoint(viewportX, viewportY);
        while (el && el.tagName === 'A') el = el.parentElement;

        // Border radius corner detection — highest priority
        // Check both the topmost element and the previously-hovered element (sticky)
        // so moving slightly outside a child into parent padding/gap doesn't lose the corner
        {
          const HIT_RADIUS = 16;
          const candidates: Element[] = [];
          if (el) candidates.push(el);
          if (radiusHoveredElement && radiusHoveredElement !== el) candidates.push(radiusHoveredElement);

          let bestCorner: BorderRadiusCorner | null = null;
          let bestDist = HIT_RADIUS;
          let bestEl: Element | null = null;

          for (const candidate of candidates) {
            const rect = candidate.getBoundingClientRect();
            const br = getComputedBorderRadius(candidate);
            const corners: [BorderRadiusCorner, number, number][] = [
              ['top-left', rect.left, rect.top + br['top-left']],
              ['top-right', rect.right, rect.top + br['top-right']],
              ['bottom-right', rect.right, rect.bottom - br['bottom-right']],
              ['bottom-left', rect.left, rect.bottom - br['bottom-left']],
            ];
            for (const [corner, cx, cy] of corners) {
              const dist = Math.hypot(viewportX - cx, viewportY - cy);
              if (dist < bestDist) {
                bestDist = dist;
                bestCorner = corner;
                bestEl = candidate;
              }
            }
          }

          if (bestCorner && bestEl) {
            setRadiusHoveredElement(bestEl);
            setRadiusHoveredCorner(bestCorner);
            if (handHoveredElement) setHandHoveredElement(null);
            if (handHoveredSide) setHandHoveredSide(null);
            if (gapHoveredElement) setGapHoveredElement(null);
            if (gapHoveredAxis) setGapHoveredAxis(null);
            setGapIsAuto(false);
            if (textHoveredElement) setTextHoveredElement(null);
            if (textHoveredProperty) setTextHoveredProperty(null);
            return;
          }
        }
        if (radiusHoveredElement) setRadiusHoveredElement(null);
        if (radiusHoveredCorner) setRadiusHoveredCorner(null);

        // Gap detection: check element and ancestors for flex/grid gap zones
        // Ancestor walk is needed for zero-gap layouts where the cursor lands on a deeply-nested child
        {
          const gapCandidates: Element[] = [];
          if (el && isFlexOrGrid(el)) gapCandidates.push(el);
          let ancestor: Element | null = el?.parentElement ?? null;
          while (ancestor && ancestor !== document.body && gapCandidates.length < 3) {
            if (isFlexOrGrid(ancestor)) gapCandidates.push(ancestor);
            ancestor = ancestor.parentElement;
          }

          for (const candidate of gapCandidates) {
            const zones = computeGapZones(candidate);
            const hit = zones.find(z =>
              viewportX >= z.x && viewportX <= z.x + z.w &&
              viewportY >= z.y && viewportY <= z.y + z.h
            );
            if (hit) {
              setGapHoveredElement(candidate);
              setGapHoveredAxis(hit.axis);
              setGapIsAuto(isAutoGap(candidate, hit.axis));
              // Clear padding and text hover
              if (handHoveredElement) setHandHoveredElement(null);
              if (handHoveredSide) setHandHoveredSide(null);
              if (textHoveredElement) setTextHoveredElement(null);
              if (textHoveredProperty) setTextHoveredProperty(null);
              return;
            }
          }
        }

        // Clear gap hover if not in gap zone
        if (gapHoveredElement) setGapHoveredElement(null);
        if (gapHoveredAxis) setGapHoveredAxis(null);
        setGapIsAuto(false);

        // Text handle detection — uses text bounding rect (not element rect)
        // so text handles and padding handles can coexist on the same element.
        // Handles appear when cursor is anywhere inside the text rect (closest handle wins)
        // or within HIT_RADIUS of a handle point when outside (sticky near edges).
        {
          const TEXT_HIT_RADIUS = 12;
          const textCandidates: Element[] = [];
          if (el) textCandidates.push(el);
          if (textHoveredElement && textHoveredElement !== el) textCandidates.push(textHoveredElement);

          let bestTextProp: TextHandleProperty | null = null;
          let bestTextDist = Infinity;
          let bestTextEl: Element | null = null;

          for (const candidate of textCandidates) {
            if (!isTextElement(candidate)) continue;
            const textRect = getTextBoundingRect(candidate);
            if (!textRect) continue;

            const inside = viewportX >= textRect.left && viewportX <= textRect.right &&
              viewportY >= textRect.top && viewportY <= textRect.bottom;

            const handlePoints: [TextHandleProperty, number, number][] = [
              ['font-size', textRect.right, textRect.top + textRect.height / 2],
              ['line-height', textRect.left + textRect.width / 2, textRect.bottom],
            ];
            for (const [prop, px, py] of handlePoints) {
              const dist = Math.hypot(viewportX - px, viewportY - py);
              // Inside text rect: any distance is fine (closest wins). Outside: must be within hit radius.
              if ((inside || dist < TEXT_HIT_RADIUS) && dist < bestTextDist) {
                bestTextDist = dist;
                bestTextProp = prop;
                bestTextEl = candidate;
              }
            }
          }

          if (bestTextProp && bestTextEl) {
            setTextHoveredElement(bestTextEl);
            setTextHoveredProperty(bestTextProp);
          } else {
            if (textHoveredElement) setTextHoveredElement(null);
            if (textHoveredProperty) setTextHoveredProperty(null);
          }
        }

        // Padding hover detection — runs independently of text handles
        if (el !== handHoveredElement) {
          setHandHoveredElement(el);
        }
        if (el) {
          const padding = getComputedPadding(el);
          const rect = el.getBoundingClientRect();
          const side = detectPaddingSide(viewportX, viewportY, rect, padding);
          setHandHoveredSide(side);
        } else {
          setHandHoveredSide(null);
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
    [isDrawing, state.isAnnotating, state.activeTool, dragState, resizeState, hoveredElement, handHoveredElement, handHoveredSide, radiusHoveredElement, radiusHoveredCorner, gapHoveredElement, gapHoveredAxis, textHoveredElement, textHoveredProperty, getPoint, dispatch, snapPadding, detectPaddingSide]
  );

  const handlePointerUp = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      // Handle end of text handle drag
      if (textDragRef.current.isDragging) {
        const drag = textDragRef.current;
        const el = drag.element;

        if (el && drag.selector && drag.elementInfo && textDragging) {
          if (el instanceof HTMLElement) {
            el.style.removeProperty('font-size');
            el.style.removeProperty('line-height');
            el.style.removeProperty('transition');
          }

          const changes: { property: string; original: string; modified: string }[] = [];
          if (drag.originalFontSize !== textDragging.fontSize) {
            applyInlineStyle(el, 'font-size', `${textDragging.fontSize}px`);
            changes.push({ property: 'font-size', original: `${drag.originalFontSize}px`, modified: `${textDragging.fontSize}px` });
          }
          if (drag.originalLineHeight !== textDragging.lineHeight) {
            const origRatio = drag.originalFontSize > 0 ? Math.round((drag.originalLineHeight / drag.originalFontSize) * 1000) / 1000 : 1.2;
            const modRatio = textDragging.fontSize > 0 ? Math.round((textDragging.lineHeight / textDragging.fontSize) * 1000) / 1000 : 1.2;
            applyInlineStyle(el, 'line-height', `${modRatio}`);
            changes.push({ property: 'line-height', original: `${origRatio}`, modified: `${modRatio}` });
          }

          if (changes.length > 0) {
            dispatch({ type: 'MODIFY_STYLES_BATCH', payload: { selector: drag.selector, durableSelector: drag.durableSelector ?? undefined, element: drag.elementInfo, changes } });
          }
        }

        textDragRef.current = { isDragging: false, property: null, startX: 0, startY: 0, originalFontSize: 0, originalLineHeight: 0, originalRatio: 1.2, element: null, elementInfo: null, selector: null, durableSelector: null };
        setTextDragging(null);
        return;
      }

      // Handle end of gap drag
      if (gapDragRef.current.isDragging) {
        const drag = gapDragRef.current;
        const el = drag.element;

        const isRightClick = 'button' in e && e.button === 2;
        if (!drag.hasMoved && !isRightClick && el && drag.selector && drag.elementInfo) {
          // LEFT CLICK — cycle justify-content: between → around → stretch → normal (fixed)
          if (el instanceof HTMLElement) {
            el.style.removeProperty('transition');
          }

          const JC_CYCLE = ['space-between', 'space-around', 'stretch', 'normal'] as const;
          const currentJc = drag.originalJustifyContent || 'normal';
          const currentIdx = JC_CYCLE.indexOf(currentJc as typeof JC_CYCLE[number]);
          const newJc = JC_CYCLE[(currentIdx + 1) % JC_CYCLE.length]!;

          const changes: { property: string; original: string; modified: string }[] = [];

          if (newJc === 'normal') {
            // Cycling into fixed mode: remove justify distribution, keep gaps as-is
            applyInlineStyle(el, 'justify-content', 'normal');
            changes.push({ property: 'justify-content', original: drag.originalJustifyContent, modified: 'normal' });
          } else if (newJc === 'stretch') {
            // Cycling into stretch: set justify-content + default 8px gaps
            applyInlineStyle(el, 'justify-content', newJc);
            applyInlineStyle(el, 'row-gap', '8px');
            applyInlineStyle(el, 'column-gap', '8px');
            changes.push({ property: 'justify-content', original: drag.originalJustifyContent || 'normal', modified: newJc });
            if (drag.originalRow !== 8) {
              changes.push({ property: 'row-gap', original: `${drag.originalRow}px`, modified: '8px' });
            }
            if (drag.originalColumn !== 8) {
              changes.push({ property: 'column-gap', original: `${drag.originalColumn}px`, modified: '8px' });
            }
          } else {
            // Cycling into space-between/space-around: set justify-content, remove explicit gaps
            if (el instanceof HTMLElement) {
              el.style.removeProperty('row-gap');
              el.style.removeProperty('column-gap');
            }
            applyInlineStyle(el, 'justify-content', newJc);
            changes.push({ property: 'justify-content', original: drag.originalJustifyContent || 'normal', modified: newJc });
            if (drag.originalRow > 0) {
              changes.push({ property: 'row-gap', original: `${drag.originalRow}px`, modified: '0px' });
            }
            if (drag.originalColumn > 0) {
              changes.push({ property: 'column-gap', original: `${drag.originalColumn}px`, modified: '0px' });
            }
          }

          if (changes.length > 0) {
            dispatch({
              type: 'MODIFY_STYLES_BATCH',
              payload: { selector: drag.selector, durableSelector: drag.durableSelector ?? undefined, element: drag.elementInfo, changes },
            });
          }
        } else if (drag.hasMoved && el && drag.selector && drag.elementInfo && gapDragging) {
          // DRAG — commit gap changes (justify-content stays as-is)
          if (el instanceof HTMLElement) {
            el.style.removeProperty('row-gap');
            el.style.removeProperty('column-gap');
            el.style.removeProperty('transition');
          }

          const changes: { property: string; original: string; modified: string }[] = [];

          if (drag.isAuto) {
            // Auto→fixed: reset justify-content and always re-apply both gaps
            if (el instanceof HTMLElement) {
              el.style.removeProperty('justify-content');
            }
            applyInlineStyle(el, 'justify-content', 'normal');
            applyInlineStyle(el, 'row-gap', `${gapDragging.row}px`);
            applyInlineStyle(el, 'column-gap', `${gapDragging.column}px`);
            changes.push({ property: 'justify-content', original: drag.originalJustifyContent, modified: 'normal' });
            changes.push({ property: 'row-gap', original: '0px', modified: `${gapDragging.row}px` });
            changes.push({ property: 'column-gap', original: '0px', modified: `${gapDragging.column}px` });
          } else {
            if (drag.originalRow !== gapDragging.row) {
              applyInlineStyle(el, 'row-gap', `${gapDragging.row}px`);
              changes.push({ property: 'row-gap', original: `${drag.originalRow}px`, modified: `${gapDragging.row}px` });
            }
            if (drag.originalColumn !== gapDragging.column) {
              applyInlineStyle(el, 'column-gap', `${gapDragging.column}px`);
              changes.push({ property: 'column-gap', original: `${drag.originalColumn}px`, modified: `${gapDragging.column}px` });
            }
          }

          if (changes.length > 0) {
            dispatch({
              type: 'MODIFY_STYLES_BATCH',
              payload: { selector: drag.selector, durableSelector: drag.durableSelector ?? undefined, element: drag.elementInfo, changes },
            });
          }
        }

        gapDragRef.current = { isDragging: false, hasMoved: false, axis: null, startX: 0, startY: 0, originalRow: 0, originalColumn: 0, element: null, elementInfo: null, selector: null, durableSelector: null, isAuto: false, originalJustifyContent: '', visualGap: 0 };
        setGapDragging(null);
        return;
      }

      // Handle end of border radius drag
      if (radiusDragRef.current.isDragging) {
        const drag = radiusDragRef.current;
        const el = drag.element;

        if (el && drag.selector && drag.elementInfo && radiusDragging) {
          if (el instanceof HTMLElement) {
            el.style.removeProperty('border-top-left-radius');
            el.style.removeProperty('border-top-right-radius');
            el.style.removeProperty('border-bottom-right-radius');
            el.style.removeProperty('border-bottom-left-radius');
            el.style.removeProperty('transition');
          }

          const CORNERS: BorderRadiusCorner[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
          const PROPS: Record<BorderRadiusCorner, string> = {
            'top-left': 'border-top-left-radius',
            'top-right': 'border-top-right-radius',
            'bottom-right': 'border-bottom-right-radius',
            'bottom-left': 'border-bottom-left-radius',
          };

          const changes: { property: string; original: string; modified: string }[] = [];
          for (const c of CORNERS) {
            if (drag.original[c] !== radiusDragging.radius[c]) {
              applyInlineStyle(el, PROPS[c], `${radiusDragging.radius[c]}px`);
              changes.push({ property: PROPS[c], original: `${drag.original[c]}px`, modified: `${radiusDragging.radius[c]}px` });
            }
          }

          if (changes.length > 0) {
            dispatch({ type: 'MODIFY_STYLES_BATCH', payload: { selector: drag.selector, durableSelector: drag.durableSelector ?? undefined, element: drag.elementInfo, changes } });
          }
        }

        radiusDragRef.current = { isDragging: false, corner: null, startY: 0, original: { 'top-left': 0, 'top-right': 0, 'bottom-right': 0, 'bottom-left': 0 }, maxRadius: 0, element: null, elementInfo: null, selector: null, durableSelector: null };
        setRadiusDragging(null);
        return;
      }

      // Handle end of hand tool drag
      if (handDragRef.current.isDragging) {
        const drag = handDragRef.current;
        const el = drag.element;
        const selector = drag.selector;
        const info = drag.elementInfo;

        if (el && selector && info && handDragging) {
          const orig = drag.original;
          const curr = handDragging.padding;

          // Replace the shorthand with individual properties to avoid flash
          if (el instanceof HTMLElement) {
            el.style.removeProperty('padding');
            el.style.removeProperty('transition');
          }

          // Build batch of changed sides and apply inline styles immediately
          const changes: { property: string; original: string; modified: string }[] = [];
          const sides: Array<{ prop: string; origVal: number; newVal: number }> = [
            { prop: 'padding-top', origVal: orig.top, newVal: curr.top },
            { prop: 'padding-right', origVal: orig.right, newVal: curr.right },
            { prop: 'padding-bottom', origVal: orig.bottom, newVal: curr.bottom },
            { prop: 'padding-left', origVal: orig.left, newVal: curr.left },
          ];

          for (const { prop, origVal, newVal } of sides) {
            if (origVal !== newVal) {
              applyInlineStyle(el, prop, `${newVal}px`);
              changes.push({ property: prop, original: `${origVal}px`, modified: `${newVal}px` });
            }
          }

          // Single dispatch — one undo entry for all changed sides
          if (changes.length > 0) {
            dispatch({
              type: 'MODIFY_STYLES_BATCH',
              payload: { selector, durableSelector: drag.durableSelector ?? undefined, element: info, changes },
            });
          }
        }

        // Clear drag state
        handDragRef.current = { isDragging: false, side: null, startX: 0, startY: 0, original: { top: 0, right: 0, bottom: 0, left: 0 }, element: null, elementInfo: null, selector: null, durableSelector: null };
        setHandDragging(null);
        return;
      }

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
    [isDrawing, dragState, resizeState, handDragging, radiusDragging, gapDragging, textDragging, getPoint, dispatch, state.activeTool, state.currentPath, state.strokeWidth]
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

  const handleTextPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!activeText) return;
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
      setActiveText(prev => prev ? {
        ...prev,
        images: [...(prev.images || []), ...imageBlobs],
      } : null);
    }
    // No images: let default text paste proceed
  }, [activeText]);

  // Hand tool right-click: open style panel
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (state.activeTool !== 'hand' || !state.isAnnotating) return;
    e.preventDefault();
    const target = handHoveredElement || gapHoveredElement || radiusHoveredElement || textHoveredElement;
    if (target && !isElementInFlight(target)) {
      const info = extractElementInfo(target);
      const selector = getUniqueSelector(target);
      dispatch({
        type: 'SELECT_ELEMENT',
        payload: { el: target, info: { ...info, selector } },
      });
    }
  }, [state.activeTool, state.isAnnotating, handHoveredElement, gapHoveredElement, radiusHoveredElement, textHoveredElement, dispatch, isElementInFlight]);

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
          try {
            el = document.querySelector(ann.elements[0].selector);
          } catch {
            // Selector may contain invalid characters (e.g. Tailwind's gap-1.5)
          }
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
    if (state.activeTool === 'hand') {
      // Gap cursor takes priority
      const gapAxis = gapDragging?.axis ?? gapHoveredAxis;
      if (gapAxis === 'row') return 'ns-resize';
      if (gapAxis === 'column') return 'ew-resize';
      // Border radius cursor
      if (radiusDragging || radiusHoveredCorner) return 'ns-resize';
      // Text handle cursor
      const textProp = textDragging?.property ?? textHoveredProperty;
      if (textProp === 'font-size') return 'ew-resize';
      if (textProp === 'line-height') return 'ns-resize';
      // Padding cursor
      const activeSide = handDragging?.side ?? handHoveredSide;
      if (activeSide === 'top' || activeSide === 'bottom') return 'ns-resize';
      if (activeSide === 'left' || activeSide === 'right') return 'ew-resize';
      return 'default';
    }
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
            onPaste={handleTextPaste}
            onBlur={commitActiveText}
            placeholder="Type here..."
            style={textInputStyle}
          />
          {activeText.images && activeText.images.length > 0 && (
            <div
              data-devtools
              style={{
                position: 'fixed',
                left: (activeText.point.x - PADDING - scroll.x),
                top: (activeText.point.y - PADDING - scroll.y) - 20,
                zIndex: 10000,
                fontSize: 11,
                fontFamily: 'system-ui, sans-serif',
                color: '#fff',
                backgroundColor: 'rgba(0,0,0,0.7)',
                padding: '2px 6px',
                borderRadius: 3,
                whiteSpace: 'nowrap',
              }}
            >
              {activeText.images.length} image{activeText.images.length > 1 ? 's' : ''} attached
            </div>
          )}
        </>
      )}

      {/* Badges for modified elements (shown when toolbar expanded, hidden during inspection and hand mode) */}
      {state.isAnnotating && state.activeTool !== 'hand' && state.styleModifications.length > 0 && (
        <ModifiedElementBadges
          styleModifications={state.styleModifications}
          isInspecting={!!state.inspectedElement}
          accentColor={state.activeColor}
          annotationGroupCount={new Set(state.annotations.map(a => a.groupId || a.id)).size}
          dispatch={dispatch}
          inFlightSelectors={inFlightStyleSelectors}
        />
      )}

      {/* Hand mode: soft border overlays on modified elements */}
      {state.activeTool === 'hand' && state.isAnnotating && state.styleModifications.length > 0 && (
        <ModifiedElementBorders
          styleModifications={state.styleModifications}
          accentColor={state.activeColor}
        />
      )}

      {/* Unified annotation badges: thinking spinner OR reply count, click opens thread */}
      {state.isAnnotating && (
        <AnnotationBadges
          annotations={state.annotations}
          supersededAnnotations={supersededAnnotations}
          inFlightIds={inFlightAnnotationIds}
          scrollX={scroll.x}
          scrollY={scroll.y}
          annotationGroupMap={annotationGroupMap}
          onViewThread={onViewThread}
          onSelectAnnotation={selectAnnotation}
        />
      )}

      {/* Plan badges for annotations with an active plan (planning or awaiting approval) */}
      {state.isAnnotating && (activePlan?.status === 'awaiting_approval' || activePlan?.status === 'planning') && activePlan.threadId && onViewThread && (
        <PlanWaitingBadges
          annotations={state.annotations}
          supersededAnnotations={supersededAnnotations}
          scrollX={scroll.x}
          scrollY={scroll.y}
          annotationGroupMap={annotationGroupMap}
          planThreadId={activePlan.threadId}
          taskCount={activePlan.tasks?.length ?? 0}
          planStatus={activePlan.status}
          onViewThread={onViewThread}
          onSelectAnnotation={selectAnnotation}
        />
      )}

      {/* Question badges for waiting_input annotations */}
      {state.isAnnotating && onReply && (
        <QuestionBadges
          annotations={state.annotations}
          supersededAnnotations={supersededAnnotations}
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

      {/* Dotted outlines for focused (selected) inspector-created elements */}
      {state.isAnnotating && focusedSelectorColors && (
        <MarchingAntsBorders inFlightSelectorColors={focusedSelectorColors} animated={false} />
      )}

      {/* Hand tool: Gap handles overlay */}
      {state.activeTool === 'hand' && state.isAnnotating && (gapDragging ? gapDragRef.current.element : gapHoveredElement) && (
        <GapHandles
          element={(gapDragging ? gapDragRef.current.element : gapHoveredElement)!}
          gap={gapDragging ? { row: gapDragging.row, column: gapDragging.column } : getComputedGap(gapHoveredElement!)}
          accentColor={state.activeColor}
          hoveredAxis={gapHoveredAxis}
          draggingAxis={gapDragging?.axis ?? null}
          cursorViewport={handCursorPos}
          isAutoGap={gapIsAuto}
          refreshKey={gapRefreshKey}
        />
      )}

      {/* Hand tool: Swipe direction hints */}
      {state.activeTool === 'hand' && state.isAnnotating && swipeHint && (
        <SwipeHints
          element={swipeHint.target}
          modifier={swipeHint.modifier}
          accentColor={state.activeColor}
          refreshKey={gapRefreshKey}
        />
      )}

      {/* Hand tool: Border radius handles */}
      {state.activeTool === 'hand' && state.isAnnotating && !swipeHint &&
        (radiusDragging ? radiusDragRef.current.element : radiusHoveredElement) && (
          <BorderRadiusHandles
            element={(radiusDragging ? radiusDragRef.current.element : radiusHoveredElement)!}
            radius={radiusDragging?.radius ?? getComputedBorderRadius(radiusHoveredElement!)}
            accentColor={state.activeColor}
            hoveredCorner={radiusHoveredCorner}
            draggingCorner={radiusDragging?.corner ?? null}
            cursorViewport={handCursorPos}
          />
      )}

      {/* Hand tool: Text handles (font-size / line-height) */}
      {state.activeTool === 'hand' && state.isAnnotating && !swipeHint &&
        (textDragging ? textDragRef.current.element : textHoveredElement) && (
        <TextHandles
          element={(textDragging ? textDragRef.current.element : textHoveredElement)!}
          fontSize={textDragging?.fontSize ?? getComputedTextProperties(textHoveredElement!).fontSize}
          lineHeight={textDragging?.lineHeight ?? getComputedTextProperties(textHoveredElement!).lineHeight}
          accentColor={state.activeColor}
          hoveredProperty={textHoveredProperty}
          draggingProperty={textDragging?.property ?? null}
          cursorViewport={handCursorPos}
        />
      )}

      {/* Hand tool: Padding handles overlay (hidden when swipe hints active) */}
      {state.activeTool === 'hand' && state.isAnnotating && !swipeHint && (handDragging ? handDragRef.current.element : handHoveredElement) && (
        <PaddingHandles
          element={(handDragging ? handDragRef.current.element : handHoveredElement)!}
          padding={handDragging?.padding ?? getComputedPadding(handHoveredElement!)}
          accentColor={state.activeColor}
          hoveredSide={handHoveredSide}
          draggingSide={handDragging?.side ?? null}
          cursorViewport={handCursorPos}
          refreshKey={textDragging ? textDragging.fontSize + textDragging.lineHeight * 1000 : 0}
        />
      )}

      {/* Inspector mode: Element hover highlight */}
      {state.activeTool === 'inspector' && state.isAnnotating && (
        <>
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
        </>
      )}

      {/* Hand tool: Selected element highlight + StylePanel (right-click inspect) */}
      {state.activeTool === 'hand' && state.isAnnotating && state.inspectedElement && (
        <>
          {stylePanelHint && stylePanelHint !== 'padding' && stylePanelHint !== 'gap' && (() => {
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

          {/* Panel field hover: show padding handles on inspected element */}
          {stylePanelHint === 'padding' && (
            <PaddingHandles
              element={state.inspectedElement.el}
              padding={getComputedPadding(state.inspectedElement.el)}
              accentColor={state.activeColor}
              hoveredSide={null}
              draggingSide={null}
            />
          )}

          {/* Panel field hover: show gap handles on inspected element */}
          {stylePanelHint === 'gap' && (
            <GapHandles
              element={state.inspectedElement.el}
              gap={getComputedGap(state.inspectedElement.el)}
              accentColor={state.activeColor}
              hoveredAxis={null}
              draggingAxis={null}
            />
          )}

          <StylePanel
            element={state.inspectedElement.el}
            elementInfo={state.inspectedElement.info}
            selector={state.inspectedElement.info.selector}
            styleModifications={state.styleModifications}
            dispatch={dispatch}
            onClose={() => dispatch({ type: 'SELECT_ELEMENT', payload: null })}
            onHover={setStylePanelHint}
            accentColor={state.activeColor}
          />
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

// Unified badge: shows thinking spinner when in-flight, reply count when resolved.
// Click always opens the thread panel.
function AnnotationBadges({
  annotations,
  supersededAnnotations,
  inFlightIds,
  scrollX,
  scrollY,
  annotationGroupMap,
  onViewThread,
  onSelectAnnotation,
}: {
  annotations: Annotation[];
  supersededAnnotations: Set<Annotation>;
  inFlightIds?: Set<string>;
  scrollX: number;
  scrollY: number;
  annotationGroupMap: Map<string, number>;
  onViewThread?: (threadId: string) => void;
  onSelectAnnotation?: (id: string) => void;
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
    const replyCount = groupAnns.reduce((n, a) => n + (a.replyCount ?? 0), 0) || 1;

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
    const maxWidth = Math.min(MAX_DISPLAY_WIDTH, Math.max(...displayLines.map((line) => ctx.measureText(line).width)));
    const totalHeight = displayLines.length * lineHeightPx;

    badges.push({
      id: annotation.id,
      threadId,
      x: point.x + maxWidth + PADDING,
      y: point.y - PADDING,
      size: totalHeight + PADDING * 2,
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
        <div
          key={pos.id}
          data-devtools="annotation-badge"
          onClick={clickable && pos.threadId ? () => {
            onSelectAnnotation?.(pos.id);
            onViewThread!(pos.threadId!);
          } : undefined}
          style={{
            position: 'fixed',
            left: pos.x - scrollX,
            top: pos.y - scrollY,
            height: pos.size,
            display: 'flex',
            alignItems: 'center',
            pointerEvents: clickable ? 'auto' : 'none',
            cursor: clickable && pos.threadId ? 'pointer' : undefined,
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
                {pos.replyCount} {pos.replyCount === 1 ? 'reply' : 'replies'}
              </span>
            </>
          )}
        </div>
      ))}
    </>
  );
}

// "Plan waiting" badge for annotations whose plan is planning or awaiting approval
function PlanWaitingBadges({
  annotations,
  supersededAnnotations,
  scrollX,
  scrollY,
  annotationGroupMap,
  planThreadId,
  taskCount,
  planStatus,
  onViewThread,
  onSelectAnnotation,
}: {
  annotations: Annotation[];
  supersededAnnotations: Set<Annotation>;
  scrollX: number;
  scrollY: number;
  annotationGroupMap: Map<string, number>;
  planThreadId: string;
  taskCount: number;
  planStatus: 'planning' | 'awaiting_approval';
  onViewThread: (threadId: string) => void;
  onSelectAnnotation?: (id: string) => void;
}) {
  // Find text annotations linked to the plan thread, or pending text annotations
  // that haven't been resolved yet (they triggered the plan)
  const badgePositions: { annotation: Annotation; x: number; y: number; size: number; groupNumber?: number }[] = [];

  for (const annotation of annotations) {
    if (annotation.type !== 'text' || !annotation.text || !annotation.points[0]) continue;
    if (supersededAnnotations.has(annotation)) continue;

    const status = annotation.status ?? 'pending';
    const groupAnns = annotation.groupId
      ? annotations.filter(a => a.groupId === annotation.groupId)
      : [annotation];
    const hasThread = groupAnns.some(a => a.threadId === planThreadId);
    // Fallback: captured/in_flight text annotations with no planId are likely the plan trigger
    const isPlanTrigger = !hasThread && !annotation.planId &&
      (status === 'in_flight' || status === 'pending' || annotation.captured) &&
      !groupAnns.some(a => a.status === 'resolved' || a.status === 'needs_review');

    if (!hasThread && !isPlanTrigger) continue;
    // Skip annotations that already have resolution badges
    if (status === 'resolved' || status === 'needs_review') continue;

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
    const maxWidth = Math.min(MAX_DISPLAY_WIDTH, Math.max(...displayLines.map((line) => ctx.measureText(line).width)));
    const totalHeight = displayLines.length * lineHeightPx;
    const annotationHeight = totalHeight + PADDING * 2;

    badgePositions.push({
      annotation,
      x: point.x + maxWidth + PADDING,
      y: point.y - PADDING,
      size: annotationHeight,
      groupNumber,
    });
  }

  if (badgePositions.length === 0) return null;

  const isPlanning = planStatus === 'planning';

  return (
    <>
      {badgePositions.map(({ annotation, x, y, size }) => (
        isPlanning
          ? <PlanningSpinner
              key={`plan-thinking-${annotation.id}`}
              x={x - scrollX}
              y={y - scrollY}
              size={size}
              color={annotation.color}
              onClick={() => {
                onSelectAnnotation?.(annotation.id);
                onViewThread(planThreadId);
              }}
            />
          : <div
              key={`plan-waiting-${annotation.id}`}
              data-devtools="plan-waiting-badge"
              onClick={() => {
                onSelectAnnotation?.(annotation.id);
                onViewThread(planThreadId);
              }}
              style={{
                position: 'fixed',
                left: x - scrollX,
                top: y - scrollY,
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
                zIndex: 9999,
                pointerEvents: 'auto',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span style={{ opacity: 0.7 }}>
                {taskCount} task{taskCount !== 1 ? 's' : ''} — approve?
              </span>
            </div>
      ))}
    </>
  );
}

function PlanningSpinner({ x, y, size, color, onClick }: { x: number; y: number; size: number; color: string; onClick?: () => void }) {
  const [charIndex, setCharIndex] = useState(0);
  const [wordIndex, setWordIndex] = useState(() => Math.floor(Math.random() * PLANNING_WORDS.length));

  useEffect(() => {
    const charTimer = setInterval(() => {
      setCharIndex((i) => (i + 1) % SPINNER_FRAME_COUNT);
    }, SPINNER_INTERVAL);
    const wordTimer = setInterval(() => {
      setWordIndex((i) => (i + 1) % PLANNING_WORDS.length);
    }, WORD_INTERVAL);
    return () => {
      clearInterval(charTimer);
      clearInterval(wordTimer);
    };
  }, []);

  return (
    <div
      data-devtools="plan-thinking-badge"
      onClick={onClick}
      style={{
        position: 'fixed',
        left: x,
        top: y,
        height: size,
        display: 'flex',
        alignItems: 'center',
        pointerEvents: onClick ? 'auto' : 'none',
        cursor: onClick ? 'pointer' : undefined,
        zIndex: 9999,
        backgroundColor: color,
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
      <span style={{ opacity: 0.7 }}>{PLANNING_WORDS[wordIndex]}</span>
    </div>
  );
}

const PLANNING_WORDS = [
  'planning', 'strategizing', 'scheming', 'mapping',
  'scoping', 'drafting', 'outlining', 'architecting',
];

// Marching ants border for in-flight style modifications
function MarchingAntsBorders({
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
function QuestionBadges({
  annotations,
  supersededAnnotations,
  scrollX,
  scrollY,
  onReply,
  annotationGroupMap,
}: {
  annotations: Annotation[];
  supersededAnnotations: Set<Annotation>;
  scrollX: number;
  scrollY: number;
  onReply: (threadId: string, reply: string) => void;
  annotationGroupMap: Map<string, number>;
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
      const maxWidth = Math.min(MAX_DISPLAY_WIDTH, Math.max(...displayLines.map((line) => ctx.measureText(line).width)));
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
        zIndex: expanded ? 10002 : 9999,
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
