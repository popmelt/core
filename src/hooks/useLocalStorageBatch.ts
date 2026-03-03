import { useEffect, useRef } from 'react';

import type { AnnotationState } from '../tools/types';

export type StorageKeys = {
  expanded: string;
  annotations: string;
  styleMods: string;
  spacingChanges: string;
  tool: string;
  color: string;
  stroke: string;
  inspected: string;
};

/**
 * Batch-persists toolbar state to localStorage in a single effect.
 * All keys are written atomically (in one tick) to avoid partial saves.
 */
export function useLocalStorageBatch(
  isExpanded: boolean,
  state: AnnotationState,
  hasRestoredAnnotations: React.MutableRefObject<boolean>,
  hasActiveJobs: boolean,
  storageKeys: StorageKeys,
) {
  const lastPersistedCount = useRef(0);
  const lastAnnotationsRef = useRef(state.annotations);

  // Dedicated effect for annotations — only runs when the annotations array
  // reference actually changes, preventing stale writes from other deps.
  useEffect(() => {
    if (!hasRestoredAnnotations.current || !isExpanded) return;
    lastAnnotationsRef.current = state.annotations;

    const count = state.annotations.length;
    // Never write [] here — handleClear does its own localStorage.removeItem.
    // Writing [] from the effect causes data loss when state transiently empties
    // (orphan cleanup, strict mode, navigation race conditions).
    if (count > 0 && (count >= lastPersistedCount.current || !hasActiveJobs)) {
      localStorage.setItem(storageKeys.annotations, JSON.stringify(state.annotations));
      lastPersistedCount.current = count;
    }
  }, [state.annotations, isExpanded, hasActiveJobs, hasRestoredAnnotations, storageKeys]);

  // Persist everything else (tool, color, styles, etc.)
  useEffect(() => {
    if (!hasRestoredAnnotations.current) return;

    localStorage.setItem(storageKeys.expanded, String(isExpanded));

    if (!isExpanded) return;

    // Style modifications
    localStorage.setItem(storageKeys.styleMods, JSON.stringify(state.styleModifications));

    // Spacing token changes
    localStorage.setItem(storageKeys.spacingChanges, JSON.stringify(state.spacingTokenChanges));

    // Tool, color, stroke
    localStorage.setItem(storageKeys.tool, state.activeTool);
    localStorage.setItem(storageKeys.color, state.activeColor);
    localStorage.setItem(storageKeys.stroke, String(state.strokeWidth));

    // Inspected element: remove key when null, set when truthy
    if (state.inspectedElement) {
      localStorage.setItem(storageKeys.inspected, JSON.stringify({
        selector: state.inspectedElement.info.selector,
        info: state.inspectedElement.info,
      }));
    } else {
      localStorage.removeItem(storageKeys.inspected);
    }
  }, [
    isExpanded,
    state.styleModifications,
    state.spacingTokenChanges,
    state.activeTool,
    state.activeColor,
    state.strokeWidth,
    state.inspectedElement,
    hasRestoredAnnotations,
    storageKeys,
  ]);
}
