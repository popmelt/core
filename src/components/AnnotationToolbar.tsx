'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle,
  MousePointer2,
  Pen,
  Slash,
  Square,
  TextCursor,
  Undo2,
} from 'lucide-react';

import type { AnnotationAction, AnnotationState, ToolType } from '../tools/types';
import { applyStyleModifications, extractElementInfo, findElementBySelector, revertAllStyles } from '../utils/dom';
import { colors, ToolButton, ToolSeparator } from './ToolButton';

type AnnotationToolbarProps = {
  state: AnnotationState;
  dispatch: React.Dispatch<AnnotationAction>;
  onScreenshot: () => Promise<boolean>;
  onSendToClaude?: () => Promise<boolean>;
  hasActiveJobs?: boolean;
  activeJobColor?: string;
  onCrosshairHover?: (hovering: boolean) => void;
  onClear?: () => void;
  provider?: string;
  onProviderChange?: (provider: string) => void;
};

type ToolDef = { type: ToolType; icon: typeof Pen; label: string; shortcut: string };

const shapeTools: ToolDef[] = [
  { type: 'rectangle', icon: Square, label: 'Rectangle', shortcut: 'R' },
  { type: 'circle', icon: Circle, label: 'Circle', shortcut: 'O' },
  { type: 'line', icon: Slash, label: 'Line', shortcut: 'L' },
  { type: 'freehand', icon: Pen, label: 'Pen', shortcut: 'P' },
];

const shapeToolTypes = new Set(shapeTools.map(t => t.type));

const standaloneTools: ToolDef[] = [
  { type: 'text', icon: TextCursor, label: 'Text', shortcut: 'T' },
];

const baseToolbarStyle: CSSProperties = {
  position: 'fixed',
  bottom: 16,
  right: 16,
  zIndex: 9999,
  display: 'flex',
  alignItems: 'center',
  backgroundColor: 'rgba(255, 255, 255, 0.85)',
  border: '1px solid rgba(0, 0, 0, 0.1)',
  backdropFilter: 'blur(32px)',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  cursor: 'pointer',
  overflow: 'visible',
  transition: 'all 200ms cubic-bezier(0.4, 0, 0.2, 1)',
};

const STORAGE_KEY = 'devtools-toolbar-expanded';
const ANNOTATIONS_STORAGE_KEY = 'devtools-annotations';
const STYLE_MODS_STORAGE_KEY = 'devtools-style-modifications';
const TOOL_STORAGE_KEY = 'devtools-active-tool';
const COLOR_STORAGE_KEY = 'devtools-active-color';
const STROKE_STORAGE_KEY = 'devtools-stroke-width';
const INSPECTED_STORAGE_KEY = 'devtools-inspected-element';
const SPINNER_FRAME_COUNT = 3;
const SPINNER_INTERVAL = 250;

function ClaudeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 1200 1200" fill="currentColor" stroke="none">
      <path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z" />
    </svg>
  );
}

function CodexIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 158.7128 157.296" fill="currentColor" stroke="none">
      <path d="M60.8734,57.2556v-14.9432c0-1.2586.4722-2.2029,1.5728-2.8314l30.0443-17.3023c4.0899-2.3593,8.9662-3.4599,13.9988-3.4599,18.8759,0,30.8307,14.6289,30.8307,30.2006,0,1.1007,0,2.3593-.158,3.6178l-31.1446-18.2467c-1.8872-1.1006-3.7754-1.1006-5.6629,0l-39.4812,22.9651ZM131.0276,115.4561v-35.7074c0-2.2028-.9446-3.7756-2.8318-4.8763l-39.481-22.9651,12.8982-7.3934c1.1007-.6285,2.0453-.6285,3.1458,0l30.0441,17.3024c8.6523,5.0341,14.4708,15.7296,14.4708,26.1107,0,11.9539-7.0769,22.965-18.2461,27.527v.0021ZM51.593,83.9964l-12.8982-7.5497c-1.1007-.6285-1.5728-1.5728-1.5728-2.8314v-34.6048c0-16.8303,12.8982-29.5722,30.3585-29.5722,6.607,0,12.7403,2.2029,17.9324,6.1349l-30.987,17.9324c-1.8871,1.1007-2.8314,2.6735-2.8314,4.8764v45.6159l-.0014-.0015ZM79.3562,100.0403l-18.4829-10.3811v-22.0209l18.4829-10.3811,18.4812,10.3811v22.0209l-18.4812,10.3811ZM91.2319,147.8591c-6.607,0-12.7403-2.2031-17.9324-6.1344l30.9866-17.9333c1.8872-1.1005,2.8318-2.6728,2.8318-4.8759v-45.616l13.0564,7.5498c1.1005.6285,1.5723,1.5728,1.5723,2.8314v34.6051c0,16.8297-13.0564,29.5723-30.5147,29.5723v.001ZM53.9522,112.7822l-30.0443-17.3024c-8.652-5.0343-14.471-15.7296-14.471-26.1107,0-12.1119,7.2356-22.9652,18.403-27.5272v35.8634c0,2.2028.9443,3.7756,2.8314,4.8763l39.3248,22.8068-12.8982,7.3938c-1.1007.6287-2.045.6287-3.1456,0ZM52.2229,138.5791c-17.7745,0-30.8306-13.3713-30.8306-29.8871,0-1.2585.1578-2.5169.3143-3.7754l30.987,17.9323c1.8871,1.1005,3.7757,1.1005,5.6628,0l39.4811-22.807v14.9435c0,1.2585-.4721,2.2021-1.5728,2.8308l-30.0443,17.3025c-4.0898,2.359-8.9662,3.4605-13.9989,3.4605h.0014ZM91.2319,157.296c19.0327,0,34.9188-13.5272,38.5383-31.4594,17.6164-4.562,28.9425-21.0779,28.9425-37.908,0-11.0112-4.719-21.7066-13.2133-29.4143.7867-3.3035,1.2595-6.607,1.2595-9.909,0-22.4929-18.2471-39.3247-39.3251-39.3247-4.2461,0-8.3363.6285-12.4262,2.045-7.0792-6.9213-16.8318-11.3254-27.5271-11.3254-19.0331,0-34.9191,13.5268-38.5384,31.4591C11.3255,36.0212,0,52.5373,0,69.3675c0,11.0112,4.7184,21.7065,13.2125,29.4142-.7865,3.3035-1.2586,6.6067-1.2586,9.9092,0,22.4923,18.2466,39.3241,39.3248,39.3241,4.2462,0,8.3362-.6277,12.426-2.0441,7.0776,6.921,16.8302,11.3251,27.5271,11.3251Z" />
    </svg>
  );
}

export function AnnotationToolbar({
  state,
  dispatch,
  onScreenshot,
  onSendToClaude,
  hasActiveJobs,
  activeJobColor,
  onCrosshairHover,
  onClear,
  provider = 'claude',
  onProviderChange,
}: AnnotationToolbarProps) {
  const [isExpanded, setIsExpanded] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });
  const [activeShapeIndex, setActiveShapeIndex] = useState(0);
  const lastCmdTapTime = useRef<number>(0);
  const cmdTapCount = useRef<number>(0);
  const prevIsAnnotatingRef = useRef(state.isAnnotating);
  const hasRestoredAnnotations = useRef(false);

  // Spinner animation for crosshair when jobs are active
  const [spinnerCharIndex, setSpinnerCharIndex] = useState(0);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => {
      setSpinnerCharIndex(i => (i + 1) % SPINNER_FRAME_COUNT);
    }, SPINNER_INTERVAL);
    return () => clearInterval(timer);
  }, [hasActiveJobs]);

  // Persist expanded state to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(isExpanded));
  }, [isExpanded]);

  // Persist annotations to localStorage when they change (only when expanded).
  // Guard: don't persist a smaller list while jobs are in-flight — HMR from Claude's
  // edits can trigger orphan cleanup that temporarily removes annotations.
  const lastPersistedCount = useRef(0);
  useEffect(() => {
    if (!isExpanded || !hasRestoredAnnotations.current) return;

    // Allow saving when: count grew/unchanged, count is 0 (explicit clear), or no active jobs
    const count = state.annotations.length;
    if (count >= lastPersistedCount.current || count === 0 || !hasActiveJobs) {
      localStorage.setItem(ANNOTATIONS_STORAGE_KEY, JSON.stringify(state.annotations));
      lastPersistedCount.current = count;
    }
  }, [state.annotations, isExpanded, hasActiveJobs]);

  // Persist style modifications to localStorage when they change
  useEffect(() => {
    if (isExpanded && hasRestoredAnnotations.current) {
      localStorage.setItem(STYLE_MODS_STORAGE_KEY, JSON.stringify(state.styleModifications));
    }
  }, [state.styleModifications, isExpanded]);

  // Persist active tool, color, and stroke width
  useEffect(() => {
    if (isExpanded && hasRestoredAnnotations.current) {
      localStorage.setItem(TOOL_STORAGE_KEY, state.activeTool);
    }
  }, [state.activeTool, isExpanded]);

  useEffect(() => {
    if (isExpanded && hasRestoredAnnotations.current) {
      localStorage.setItem(COLOR_STORAGE_KEY, state.activeColor);
    }
  }, [state.activeColor, isExpanded]);

  useEffect(() => {
    if (isExpanded && hasRestoredAnnotations.current) {
      localStorage.setItem(STROKE_STORAGE_KEY, String(state.strokeWidth));
    }
  }, [state.strokeWidth, isExpanded]);

  // Persist inspected element selector (for style panel visibility)
  useEffect(() => {
    if (isExpanded && hasRestoredAnnotations.current) {
      if (state.inspectedElement) {
        localStorage.setItem(INSPECTED_STORAGE_KEY, JSON.stringify({
          selector: state.inspectedElement.info.selector,
          info: state.inspectedElement.info,
        }));
      } else {
        localStorage.removeItem(INSPECTED_STORAGE_KEY);
      }
    }
  }, [state.inspectedElement, isExpanded]);

  // Initialize annotation mode and restore annotations if restored as expanded
  useEffect(() => {
    if (isExpanded && !state.isAnnotating) {
      // Restore active tool (default to rectangle if not stored)
      const savedTool = localStorage.getItem(TOOL_STORAGE_KEY) as ToolType | null;
      dispatch({ type: 'SET_TOOL', payload: savedTool || 'inspector' });
      dispatch({ type: 'SET_ANNOTATING', payload: true });

      // Restore active color
      const savedColor = localStorage.getItem(COLOR_STORAGE_KEY);
      if (savedColor) {
        dispatch({ type: 'SET_COLOR', payload: savedColor });
      }

      // Restore stroke width
      const savedStroke = localStorage.getItem(STROKE_STORAGE_KEY);
      if (savedStroke) {
        const width = parseFloat(savedStroke);
        if (!isNaN(width)) {
          dispatch({ type: 'SET_STROKE_WIDTH', payload: width });
        }
      }

      // Restore annotations from localStorage
      const stored = localStorage.getItem(ANNOTATIONS_STORAGE_KEY);
      if (stored) {
        try {
          const annotations = JSON.parse(stored);
          if (Array.isArray(annotations) && annotations.length > 0) {
            dispatch({ type: 'PASTE_ANNOTATIONS', payload: { annotations } });
          }
        } catch {
          // Invalid JSON, ignore
        }
      }

      // Restore style modifications from localStorage
      const storedStyles = localStorage.getItem(STYLE_MODS_STORAGE_KEY);
      if (storedStyles) {
        try {
          const styleModifications = JSON.parse(storedStyles);
          if (Array.isArray(styleModifications) && styleModifications.length > 0) {
            dispatch({ type: 'RESTORE_STYLE_MODIFICATIONS', payload: styleModifications });
            // Apply styles to DOM
            applyStyleModifications(styleModifications);
          }
        } catch {
          // Invalid JSON, ignore
        }
      }

      // Restore inspected element (style panel visibility)
      const savedInspected = localStorage.getItem(INSPECTED_STORAGE_KEY);
      if (savedInspected) {
        try {
          const { selector, info } = JSON.parse(savedInspected);
          if (selector) {
            const el = findElementBySelector(selector);
            if (el) {
              const restoredInfo = info || { ...extractElementInfo(el), selector };
              dispatch({ type: 'SELECT_ELEMENT', payload: { el, info: restoredInfo } });
            }
          }
        } catch {
          // Invalid JSON, ignore
        }
      }
    }
    hasRestoredAnnotations.current = true;
  }, []); // Only on mount

  // Track previous styleModifications for undo/redo DOM sync
  const prevStyleModsRef = useRef(state.styleModifications);

  // Sync DOM with styleModifications on undo/redo
  useEffect(() => {
    const prevMods = prevStyleModsRef.current;
    const currentMods = state.styleModifications;

    // Skip if same reference (no change)
    if (prevMods === currentMods) return;

    // Revert all previous styles, then apply current ones
    // This handles undo/redo where the entire styleModifications array changes
    revertAllStyles(prevMods);
    applyStyleModifications(currentMods);

    prevStyleModsRef.current = currentMods;
  }, [state.styleModifications]);

  // Sync isExpanded when isAnnotating is turned OFF externally (e.g., from canvas escape handler)
  useEffect(() => {
    const wasAnnotating = prevIsAnnotatingRef.current;
    prevIsAnnotatingRef.current = state.isAnnotating;

    // Only collapse if annotation mode was just turned OFF (not when turning on)
    if (wasAnnotating && !state.isAnnotating && isExpanded) {
      setIsExpanded(false);
    }
  }, [state.isAnnotating, isExpanded]);

  // Track expanded state in ref for use in event handlers
  const isExpandedRef = useRef(isExpanded);
  isExpandedRef.current = isExpanded;

  // Double-tap cmd/ctrl to toggle toolbar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only respond to cmd/ctrl key itself (not when used with other keys)
      if (e.key === 'Meta' || e.key === 'Control') {
        const now = Date.now();
        const timeSinceLastTap = now - lastCmdTapTime.current;

        if (timeSinceLastTap < 300) {
          cmdTapCount.current++;
          if (cmdTapCount.current >= 2) {
            // Double-tap detected - toggle toolbar
            const wasExpanded = isExpandedRef.current;
            if (wasExpanded) {
              // Collapsing - keep annotations
              dispatch({ type: 'SET_ANNOTATING', payload: false });
              setIsExpanded(false);
            } else {
              // Expanding - restore persisted tool or default to inspector
              const savedTool = localStorage.getItem(TOOL_STORAGE_KEY) as ToolType | null;
              dispatch({ type: 'SET_TOOL', payload: savedTool || 'inspector' });
              dispatch({ type: 'SET_ANNOTATING', payload: true });
              setIsExpanded(true);
            }
            cmdTapCount.current = 0;
          }
        } else {
          cmdTapCount.current = 1;
        }
        lastCmdTapTime.current = now;
      } else {
        // Any non-modifier key pressed while Cmd is held = not a clean double-tap
        // Reset to prevent Cmd+Backspace from counting as a Cmd tap
        cmdTapCount.current = 0;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Reset if another key is released (not cmd/ctrl itself)
      if (e.key !== 'Meta' && e.key !== 'Control') {
        cmdTapCount.current = 0;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [dispatch]);

  const handleToolSelect = useCallback((tool: ToolType) => {
    dispatch({ type: 'SET_TOOL', payload: tool });
    if (!state.isAnnotating) {
      dispatch({ type: 'SET_ANNOTATING', payload: true });
    }
  }, [dispatch, state.isAnnotating]);

  const handleUndo = useCallback(() => {
    dispatch({ type: 'UNDO' });
  }, [dispatch]);

  const handleScreenshot = useCallback(async () => {
    window.focus();
    await onScreenshot();
  }, [onScreenshot]);

  const handleSendToClaude = useCallback(async () => {
    if (!onSendToClaude) return;
    await onSendToClaude();
  }, [onSendToClaude]);

  const handleCollapse = useCallback(() => {
    dispatch({ type: 'SET_ANNOTATING', payload: false });
    setIsExpanded(false);
  }, [dispatch]);

  const handleClear = useCallback(() => {
    // Revert all style modifications in DOM before clearing
    revertAllStyles(state.styleModifications);
    // Remove data-pm tracking attributes from DOM
    document.querySelectorAll('[data-pm]').forEach(el => el.removeAttribute('data-pm'));
    dispatch({ type: 'CLEAR' });
    dispatch({ type: 'CLEAR_ALL_STYLES' });
    localStorage.removeItem(ANNOTATIONS_STORAGE_KEY);
    localStorage.removeItem(STYLE_MODS_STORAGE_KEY);
    setFocusedGroupIndex(null);
    onClear?.();
  }, [dispatch, state.styleModifications, onClear]);

  // Color hue state (OKLCH hue, 0-360, red ≈ 29)
  const [hue, setHue] = useState(29);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const counterRef = useRef<HTMLButtonElement>(null);
  const isInternalColorChange = useRef(false);

  // Parse hue from OKLCH color string (defined early for use in effects)
  const parseHueFromColor = useCallback((color: string): number | null => {
    const match = color.match(/oklch\([^)]*\s+([\d.]+)\s*\)/);
    if (match && match[1]) {
      return parseFloat(match[1]);
    }
    return null;
  }, []);

  // Update activeColor when hue changes (mark as internal to avoid feedback loop)
  useEffect(() => {
    isInternalColorChange.current = true;
    const color = `oklch(0.628 0.258 ${hue})`;
    dispatch({ type: 'SET_COLOR', payload: color });
    // Reset flag after a tick
    requestAnimationFrame(() => {
      isInternalColorChange.current = false;
    });
  }, [hue, dispatch]);

  // Sync hue from activeColor when it changes externally (e.g., from canvas selection)
  useEffect(() => {
    if (isInternalColorChange.current) return;
    const parsedHue = parseHueFromColor(state.activeColor);
    if (parsedHue !== null && Math.abs(parsedHue - hue) > 0.5) {
      setHue(parsedHue);
    }
  }, [state.activeColor, parseHueFromColor, hue]);

  // Handle wheel on counter to change hue (native listener for passive: false)
  const hasAnnotations = state.annotations.length > 0;
  useEffect(() => {
    const counter = counterRef.current;
    if (!counter || !hasAnnotations) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const delta = e.deltaY > 0 ? -1 : 1;
      const newHue = ((hue + delta) % 360 + 360) % 360;
      const newColor = `oklch(0.628 0.258 ${newHue})`;

      setHue(newHue);

      // If annotations are selected, update their colors (uses lastSelectedId internally)
      if (state.selectedAnnotationIds.length > 0) {
        dispatch({ type: 'UPDATE_ANNOTATION_COLOR', payload: { id: state.lastSelectedId || state.selectedAnnotationIds[0]!, color: newColor } });
      }
    };

    counter.addEventListener('wheel', handleWheel, { passive: false });
    return () => counter.removeEventListener('wheel', handleWheel);
  }, [hasAnnotations, state.selectedAnnotationIds, state.lastSelectedId, hue, dispatch]);

  // Long press to reset to red
  const longPressTriggeredRef = useRef(false);

  const handleCounterMouseDown = useCallback(() => {
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      setHue(29); // Reset to red
    }, 500);
  }, []);

  const handleCounterMouseUp = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // Cleanup long press timer
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  // Compute superseded annotation IDs (older rounds on the same element)
  const supersededIds = useMemo(() => {
    const ids = new Set<string>();
    const bySelector = new Map<string, typeof state.annotations>();
    for (const a of state.annotations) {
      if (!a.linkedSelector) continue;
      const group = bySelector.get(a.linkedSelector) || [];
      group.push(a);
      bySelector.set(a.linkedSelector, group);
    }
    for (const group of bySelector.values()) {
      if (group.length <= 1) continue;
      group.sort((a, b) => b.timestamp - a.timestamp);
      for (let i = 1; i < group.length; i++) {
        const old = group[i]!;
        ids.add(old.id);
        if (old.groupId) {
          for (const mate of state.annotations) {
            if (mate.groupId === old.groupId) ids.add(mate.id);
          }
        }
      }
    }
    return ids;
  }, [state.annotations]);

  // Group annotations by groupId (linked annotations count as one), excluding superseded
  const annotationGroups = useMemo(() => {
    const groups: { id: string; annotations: typeof state.annotations }[] = [];
    const seenGroupIds = new Set<string>();

    for (const annotation of state.annotations) {
      if (supersededIds.has(annotation.id)) continue;
      if (annotation.groupId) {
        if (!seenGroupIds.has(annotation.groupId)) {
          seenGroupIds.add(annotation.groupId);
          const groupAnnotations = state.annotations.filter(a => a.groupId === annotation.groupId && !supersededIds.has(a.id));
          const primary = groupAnnotations.find(a => a.type !== 'text') || groupAnnotations[0]!;
          groups.push({ id: primary.id, annotations: groupAnnotations });
        }
      } else {
        groups.push({ id: annotation.id, annotations: [annotation] });
      }
    }
    return groups;
  }, [state.annotations, supersededIds]);

  // Track focused item index (null = showing total, 0+ = focused on that item)
  // Items are: annotation groups first, then style modifications
  const [focusedGroupIndex, setFocusedGroupIndex] = useState<number | null>(null);

  // Total focusable items count
  const totalFocusableItems = annotationGroups.length + state.styleModifications.length;

  // Reset focused index when items change significantly or selection is cleared
  useEffect(() => {
    if (totalFocusableItems === 0) {
      setFocusedGroupIndex(null);
    } else if (focusedGroupIndex !== null && focusedGroupIndex >= totalFocusableItems) {
      setFocusedGroupIndex(null);
    }
  }, [totalFocusableItems, focusedGroupIndex]);

  // Reset to total when selection is cleared and no element is inspected
  useEffect(() => {
    if (state.selectedAnnotationIds.length === 0 && !state.inspectedElement) {
      setFocusedGroupIndex(null);
    }
  }, [state.selectedAnnotationIds, state.inspectedElement]);

  // Cycle through annotations and style modifications
  const handleCycleAnnotation = useCallback(() => {
    if (totalFocusableItems === 0) return;

    let nextIndex: number;
    if (focusedGroupIndex === null) {
      // Currently showing total, go to first
      nextIndex = 0;
    } else {
      // Go to next, or wrap to first
      nextIndex = (focusedGroupIndex + 1) % totalFocusableItems;
    }

    setFocusedGroupIndex(nextIndex);

    // Check if this is an annotation group or a style modification
    if (nextIndex < annotationGroups.length) {
      // Focus on annotation group
      const group = annotationGroups[nextIndex];
      if (!group) return;

      // Clear inspected element when switching to annotation
      dispatch({ type: 'SELECT_ELEMENT', payload: null });

      // Select the primary annotation
      dispatch({ type: 'SELECT_ANNOTATION', payload: { id: group.id } });

      // Get the primary (non-text) annotation for tool and color
      const primaryAnnotation = group.annotations.find(a => a.type !== 'text') || group.annotations[0];

      // Switch to the annotation's tool type
      if (primaryAnnotation?.type && primaryAnnotation.type !== 'inspector') {
        dispatch({ type: 'SET_TOOL', payload: primaryAnnotation.type });
        const shapeIdx = shapeTools.findIndex(s => s.type === primaryAnnotation.type);
        if (shapeIdx >= 0) setActiveShapeIndex(shapeIdx);
      }

      // Set active color to match the selected annotation's color
      if (primaryAnnotation?.color) {
        dispatch({ type: 'SET_COLOR', payload: primaryAnnotation.color });
        // Also update hue state if it's an OKLCH color
        const parsedHue = parseHueFromColor(primaryAnnotation.color);
        if (parsedHue !== null) {
          setHue(parsedHue);
        }
      }

      // Calculate center point of all annotations in group
      const allPoints = group.annotations.flatMap(a => a.points);
      if (allPoints.length === 0) return;

      const minX = Math.min(...allPoints.map(p => p.x));
      const maxX = Math.max(...allPoints.map(p => p.x));
      const minY = Math.min(...allPoints.map(p => p.y));
      const maxY = Math.max(...allPoints.map(p => p.y));
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      // Scroll to center the annotation in the viewport
      window.scrollTo({
        left: centerX - window.innerWidth / 2,
        top: centerY - window.innerHeight / 2,
        behavior: 'smooth',
      });
    } else {
      // Focus on style modification
      const modIndex = nextIndex - annotationGroups.length;
      const modification = state.styleModifications[modIndex];
      if (!modification) return;

      // Find the element
      const el = findElementBySelector(modification.selector);
      if (!el) return;

      // Clear annotation selection when switching to style modification
      dispatch({ type: 'SELECT_ANNOTATION', payload: { id: null } });

      // Switch to inspector tool and select the element (use stored info to preserve selector)
      dispatch({ type: 'SET_TOOL', payload: 'inspector' });
      dispatch({
        type: 'SELECT_ELEMENT',
        payload: { el, info: modification.element },
      });

      // Scroll element into view
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2 + window.scrollX;
      const centerY = rect.top + rect.height / 2 + window.scrollY;

      window.scrollTo({
        left: centerX - window.innerWidth / 2,
        top: centerY - window.innerHeight / 2,
        behavior: 'smooth',
      });
    }
  }, [annotationGroups, state.styleModifications, totalFocusableItems, focusedGroupIndex, dispatch, parseHueFromColor]);

  // Keyboard shortcuts for tools (only when expanded and not editing text)
  useEffect(() => {
    if (!isExpanded) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if editing text (input/textarea focused)
      const activeEl = document.activeElement;
      if (activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA') {
        return;
      }

      // Cmd/Ctrl+Enter to send to Claude (when bridge connected and annotations exist)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (onSendToClaude && (state.annotations.length > 0 || state.styleModifications.length > 0)) {
          e.preventDefault();
          handleSendToClaude();
        }
        return;
      }

      // Cmd/Ctrl+C for screenshot (when annotations or style modifications exist)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC')) {
        if (state.annotations.length > 0 || state.styleModifications.length > 0) {
          e.preventDefault();
          window.focus();
          handleScreenshot();
        }
        return;
      }

      // Cmd/Ctrl+Backspace/Delete to clear all annotations
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault();
        handleClear();
        return;
      }

      // Tool shortcuts (no modifiers)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const toolMap: Record<string, ToolType> = {
        p: 'freehand',
        l: 'line',
        r: 'rectangle',
        o: 'circle',
        t: 'text',
        i: 'inspector',
      };

      const tool = toolMap[e.key.toLowerCase()];
      if (tool) {
        e.preventDefault();
        // If it's a shape tool, also update the active shape index
        const shapeIdx = shapeTools.findIndex(s => s.type === tool);
        if (shapeIdx >= 0) {
          setActiveShapeIndex(shapeIdx);
        }
        handleToolSelect(tool);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExpanded, handleToolSelect, handleScreenshot, handleSendToClaude, onSendToClaude, handleClear, state.annotations.length, state.styleModifications.length]);

  const canUndo = state.undoStack.length > 0;

  // Dynamic styles based on expanded state
  const toolbarStyle: CSSProperties = {
    ...baseToolbarStyle,
    borderRadius: 0,
    padding: isExpanded ? '0 8px' : '0',
    width: isExpanded ? 'auto' : 48,
    height: 48,
    gap: 0,
    justifyContent: isExpanded ? 'flex-start' : 'center',
  };

  // Corner dot style
  const cornerDotStyle: CSSProperties = {
    position: 'absolute',
    width: 2,
    height: 2,
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    pointerEvents: 'none',
  };

  // Crosshair icon color based on job state
  const crosshairColor = hasActiveJobs && activeJobColor ? activeJobColor : colors.iconActive;

  // Collapsed state content
  if (!isExpanded) {
    return (
      <>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        <div
          id="devtools-toolbar"
          style={{ ...toolbarStyle, overflow: 'visible' }}
        >
          {/* Corner dots */}
          <div style={{ ...cornerDotStyle, top: -1, left: -1 }} />
          <div style={{ ...cornerDotStyle, top: -1, right: -1 }} />
          <div style={{ ...cornerDotStyle, bottom: -1, left: -1 }} />
          <div style={{ ...cornerDotStyle, bottom: -1, right: -1 }} />
          <button
            type="button"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 48,
              height: 48,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
            onClick={() => {
              setIsExpanded(true);
              dispatch({ type: 'SET_TOOL', payload: 'inspector' });
              dispatch({ type: 'SET_ANNOTATING', payload: true });
            }}
            onMouseEnter={() => onCrosshairHover?.(true)}
            onMouseLeave={() => onCrosshairHover?.(false)}
            title="Open annotation toolbar (⌘⌘)"
          >
            {hasActiveJobs ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill={crosshairColor}>
                {spinnerCharIndex === 1 ? (
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
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={crosshairColor} strokeWidth="1.5" strokeLinecap="round">
                <line x1="12" y1="3" x2="12" y2="9" />
                <line x1="12" y1="15" x2="12" y2="21" />
                <line x1="3" y1="12" x2="9" y2="12" />
                <line x1="15" y1="12" x2="21" y2="12" />
              </svg>
            )}
          </button>
        </div>
      </>
    );
  }

  // Expanded state content
  return (
    <>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      {/* Scrim overlay */}
      <div
        id="devtools-scrim"
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.06)',
          zIndex: 9997,
          pointerEvents: 'none',
        }}
      />
      <div
        id="devtools-toolbar"
        style={toolbarStyle}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'rgba(0, 0, 0, 0.1)';
        }}
      >
        {/* Corner dots */}
        <div style={{ ...cornerDotStyle, top: -1, left: -1 }} />
        <div style={{ ...cornerDotStyle, top: -1, right: -1 }} />
        <div style={{ ...cornerDotStyle, bottom: -1, left: -1 }} />
        <div style={{ ...cornerDotStyle, bottom: -1, right: -1 }} />
        <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
          <ToolButton
            onClick={handleUndo}
            title="Undo (⌘Z)"
            disabled={!canUndo}
          >
            <Undo2 size={17} strokeWidth={1.5} />
          </ToolButton>
        </div>

        <ToolSeparator />

        <div style={{ display: 'flex', flexDirection: 'row', gap: 4, alignItems: 'center' }}>
          {/* Inspector tool (first position) */}
          <ToolButton
            active={state.isAnnotating && state.activeTool === 'inspector'}
            siblingActive={state.isAnnotating}
            onClick={() => handleToolSelect('inspector')}
            title="Inspector (I)"
          >
            <MousePointer2 size={20} strokeWidth={1.5} />
          </ToolButton>

          {/* Shape tool combo: icon button + dot cycle in a tight wrapper */}
          {(() => {
            const currentShape = shapeTools[activeShapeIndex]!;
            const ShapeIcon = currentShape.icon;
            const isShapeActive = state.isAnnotating && shapeToolTypes.has(state.activeTool);
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                <ToolButton
                  active={isShapeActive}
                  siblingActive={state.isAnnotating}
                  onClick={() => handleToolSelect(currentShape.type)}
                  title={`${currentShape.label} (${currentShape.shortcut})`}
                >
                  <ShapeIcon size={20} strokeWidth={1.5} />
                </ToolButton>
                <button
                  type="button"
                  onClick={() => {
                    const nextIndex = (activeShapeIndex + 1) % shapeTools.length;
                    setActiveShapeIndex(nextIndex);
                    handleToolSelect(shapeTools[nextIndex]!.type);
                  }}
                  title="Cycle shape tool"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                    width: 12,
                    height: 32,
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    padding: '0 2px',
                    opacity: state.isAnnotating && !isShapeActive ? 0.5 : 1,
                    transition: 'opacity 150ms ease',
                  }}
                >
                  {shapeTools.map((_, i) => (
                    <div
                      key={i}
                      style={{
                        width: 3,
                        height: 3,
                        borderRadius: '50%',
                        backgroundColor: i === activeShapeIndex ? colors.iconDefault : 'rgba(0,0,0,0.2)',
                        transition: 'background-color 150ms ease',
                      }}
                    />
                  ))}
                </button>
              </div>
            );
          })()}

          {/* Standalone tools (Text) */}
          {standaloneTools.map(({ type, icon: Icon, label, shortcut }) => (
            <ToolButton
              key={type}
              active={state.isAnnotating && state.activeTool === type}
              siblingActive={state.isAnnotating}
              onClick={() => handleToolSelect(type)}
              title={`${label} (${shortcut})`}
            >
              <Icon size={20} strokeWidth={1.5} />
            </ToolButton>
          ))}
        </div>

        <ToolSeparator />

        <div style={{ display: 'flex', flexDirection: 'row', gap: 4, alignItems: 'center' }}>
          {(annotationGroups.length > 0 || state.styleModifications.length > 0) && (() => {
            // Check if focused on an annotation group (vs style modification)
            const focusedGroup = focusedGroupIndex !== null && focusedGroupIndex < annotationGroups.length
              ? annotationGroups[focusedGroupIndex]
              : null;
            const allCaptured = state.annotations.every(a => a.status !== 'pending');
            // Style modifications are never "captured", only annotations
            const isCaptured = focusedGroupIndex !== null
              ? focusedGroup?.annotations.some(a => a.status !== 'pending') ?? false
              : allCaptured;
            const activeColor = `oklch(0.628 0.258 ${hue})`;

            return (
              <button
                ref={counterRef}
                type="button"
                onClick={() => {
                  // Skip cycling if this was a long press (color reset)
                  if (longPressTriggeredRef.current) {
                    longPressTriggeredRef.current = false;
                    return;
                  }
                  handleCycleAnnotation();
                }}
                onMouseDown={handleCounterMouseDown}
                onMouseUp={handleCounterMouseUp}
                onMouseLeave={handleCounterMouseUp}
                title="Cycle through annotations • Scroll to change color • Long press to reset"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 20,
                  height: 20,
                  padding: 0,
                  marginRight: 4,
                  border: 'none',
                  borderRadius: 0,
                  background: isCaptured ? '#999999' : activeColor,
                  cursor: 'pointer',
                  fontFamily: 'system-ui, -apple-system, sans-serif',
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#ffffff',
                  transition: 'background 150ms ease',
                }}
              >
                {focusedGroupIndex !== null ? focusedGroupIndex + 1 : annotationGroups.length + state.styleModifications.length}
              </button>
            );
          })()}
          {onProviderChange && (
            <ToolButton
              onClick={() => onProviderChange(provider === 'claude' ? 'codex' : 'claude')}
              title={`Provider: ${provider === 'claude' ? 'Claude' : 'Codex'} (click to switch)`}
            >
              {provider === 'claude' ? <ClaudeIcon /> : <CodexIcon />}
            </ToolButton>
          )}
          <div
            onMouseEnter={() => onCrosshairHover?.(true)}
            onMouseLeave={() => onCrosshairHover?.(false)}
            style={{ display: 'inline-flex' }}
          >
            <ToolButton onClick={handleCollapse} title="Collapse (⌘⌘)">
              {hasActiveJobs ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill={crosshairColor}>
                  {spinnerCharIndex === 1 ? (
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
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={crosshairColor} strokeWidth="1.5" strokeLinecap="round">
                  <line x1="12" y1="3" x2="12" y2="9" />
                  <line x1="12" y1="15" x2="12" y2="21" />
                  <line x1="3" y1="12" x2="9" y2="12" />
                  <line x1="15" y1="12" x2="21" y2="12" />
                </svg>
              )}
            </ToolButton>
          </div>
        </div>
      </div>
    </>
  );
}
