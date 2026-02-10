import { useEffect, useRef } from 'react';

import type { AnnotationState } from '../tools/types';

export type StorageKeys = {
  expanded: string;
  annotations: string;
  styleMods: string;
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

  useEffect(() => {
    // Guard: don't write until restore has completed (prevents overwriting saved state during mount)
    if (!hasRestoredAnnotations.current) return;

    // Always persist expanded state (even when collapsed)
    localStorage.setItem(storageKeys.expanded, String(isExpanded));

    // Only persist the rest when expanded
    if (!isExpanded) return;

    // Annotations: skip write if count shrank AND jobs are active (mid-resolution shrinkage)
    const count = state.annotations.length;
    if (count >= lastPersistedCount.current || count === 0 || !hasActiveJobs) {
      localStorage.setItem(storageKeys.annotations, JSON.stringify(state.annotations));
      lastPersistedCount.current = count;
    }

    // Style modifications
    localStorage.setItem(storageKeys.styleMods, JSON.stringify(state.styleModifications));

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
    state.annotations,
    state.styleModifications,
    state.activeTool,
    state.activeColor,
    state.strokeWidth,
    state.inspectedElement,
    hasActiveJobs,
    hasRestoredAnnotations,
    storageKeys,
  ]);
}
