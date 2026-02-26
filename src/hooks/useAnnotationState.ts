import { useEffect, useReducer } from 'react';

import type {
  Annotation,
  AnnotationAction,
  AnnotationLifecycleStatus,
  AnnotationResolution,
  AnnotationState,
  ElementInfo,
  InspectedElement,
  SpacingTokenChange,
  SpacingTokenMod,
  StyleModification,
  ToolType,
} from '../tools/types';

const initialState: AnnotationState = {
  isAnnotating: false,
  activeTool: 'inspector',
  activeColor: '#ff0000',
  strokeWidth: 3,
  annotations: [],
  undoStack: [],
  redoStack: [],
  currentPath: [],
  selectedAnnotationIds: [],
  lastSelectedId: null,
  // Inspector state
  inspectedElement: null,
  styleModifications: [],
  spacingTokenChanges: [],
  spacingTokenMods: [],
};

function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

// Migrate legacy captured boolean to status field (for localStorage restore)
function migrateAnnotation(a: Annotation): Annotation {
  if (a.status) return a; // Already has status
  if (a.captured) return { ...a, status: 'in_flight' as AnnotationLifecycleStatus };
  return { ...a, status: 'pending' as AnnotationLifecycleStatus };
}

// Helper to save current state to undo stack (saves both annotations and style modifications)
function pushToUndoStack(state: AnnotationState): AnnotationState {
  return {
    ...state,
    undoStack: [...state.undoStack, {
      annotations: state.annotations,
      styleModifications: state.styleModifications,
      spacingTokenMods: state.spacingTokenMods,
    }],
    redoStack: [], // Clear redo stack on new action
  };
}

// ---------------------------------------------------------------------------
// Handler functions — one per action type
// ---------------------------------------------------------------------------

function handleSetAnnotating(state: AnnotationState, payload: boolean): AnnotationState {
  return { ...state, isAnnotating: payload };
}

function handleSetTool(state: AnnotationState, payload: ToolType): AnnotationState {
  return { ...state, activeTool: payload, inspectedElement: null };
}

function handleSetColor(state: AnnotationState, payload: string): AnnotationState {
  return { ...state, activeColor: payload };
}

function handleSetStrokeWidth(state: AnnotationState, payload: number): AnnotationState {
  return { ...state, strokeWidth: payload };
}

function handleStartPath(state: AnnotationState, payload: { x: number; y: number }): AnnotationState {
  return { ...state, currentPath: [payload] };
}

function handleContinuePath(state: AnnotationState, payload: { x: number; y: number }): AnnotationState {
  return { ...state, currentPath: [...state.currentPath, payload] };
}

function handleCancelPath(state: AnnotationState): AnnotationState {
  return { ...state, currentPath: [] };
}

function handleFinishPath(state: AnnotationState, payload?: { groupId?: string; elements?: ElementInfo[] }): AnnotationState {
  if (state.currentPath.length < 2 && state.activeTool !== 'text') {
    return { ...state, currentPath: [] };
  }

  const newAnnotation: Annotation = {
    id: generateId(),
    type: state.activeTool,
    points: state.currentPath,
    color: state.activeColor,
    strokeWidth: state.strokeWidth,
    timestamp: Date.now(),
    status: 'pending',
    groupId: payload?.groupId,
    elements: payload?.elements,
  };

  const stateWithUndo = pushToUndoStack(state);
  return {
    ...stateWithUndo,
    annotations: [...state.annotations, newAnnotation],
    currentPath: [],
  };
}

function handleAddText(state: AnnotationState, payload: {
  point: { x: number; y: number };
  text: string;
  fontSize?: number;
  id?: string;
  groupId?: string;
  linkedSelector?: string;
  linkedAnchor?: 'top-left' | 'bottom-left';
  elements?: ElementInfo[];
  imageCount?: number;
}): AnnotationState {
  const textAnnotation: Annotation = {
    id: payload.id ?? generateId(),
    type: 'text',
    points: [payload.point],
    text: payload.text,
    fontSize: payload.fontSize || 12,
    color: state.activeColor,
    strokeWidth: state.strokeWidth,
    timestamp: Date.now(),
    status: 'pending',
    groupId: payload.groupId,
    linkedSelector: payload.linkedSelector,
    linkedAnchor: payload.linkedAnchor,
    elements: payload.elements,
    ...(payload.imageCount ? { imageCount: payload.imageCount } : {}),
  };

  // Skip undo for linked text (groupId) - the rectangle already saved the pre-creation state
  const baseState = payload.groupId ? state : pushToUndoStack(state);
  return {
    ...baseState,
    annotations: [...state.annotations, textAnnotation],
  };
}

function handleUpdateText(state: AnnotationState, payload: { id: string; text: string; imageCount?: number }): AnnotationState {
  const stateWithUndo = pushToUndoStack(state);
  return {
    ...stateWithUndo,
    annotations: state.annotations.map((a) =>
      a.id === payload.id
        ? { ...a, text: payload.text, ...(payload.imageCount != null ? { imageCount: payload.imageCount } : {}) }
        : a
    ),
  };
}

function handleUpdateTextSize(state: AnnotationState, payload: { id: string; fontSize: number }): AnnotationState {
  // Don't push to undo stack for size changes (too granular)
  return {
    ...state,
    annotations: state.annotations.map((a) =>
      a.id === payload.id
        ? { ...a, fontSize: Math.max(12, Math.min(72, payload.fontSize)) }
        : a
    ),
  };
}

function handleDeleteAnnotation(state: AnnotationState, payload: { id: string }): AnnotationState {
  const stateWithUndo = pushToUndoStack(state);
  // Find the annotation to check for groupId
  const toDelete = state.annotations.find((a) => a.id === payload.id);
  const groupId = toDelete?.groupId;

  return {
    ...stateWithUndo,
    // Delete the annotation and any linked annotations (same groupId)
    annotations: state.annotations.filter((a) =>
      a.id !== payload.id && !(groupId && a.groupId === groupId)
    ),
  };
}

function handleMoveAnnotation(state: AnnotationState, payload: { id: string; delta: { x: number; y: number }; saveUndo?: boolean }): AnnotationState {
  // Only save undo state on first move of a drag (to avoid flooding undo stack)
  const baseState = payload.saveUndo ? pushToUndoStack(state) : state;

  // Find the annotation being moved to check for groupId
  const movedAnnotation = state.annotations.find((a) => a.id === payload.id);
  const groupId = movedAnnotation?.groupId;

  return {
    ...baseState,
    annotations: state.annotations.map((a) => {
      // Move if it's the target annotation OR if it shares the same groupId
      const shouldMove = a.id === payload.id || (groupId && a.groupId === groupId);
      if (!shouldMove) return a;

      // Move all points by the delta
      const dx = payload.delta.x;
      const dy = payload.delta.y;
      return {
        ...a,
        points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      };
    }),
  };
}

function handleResizeAnnotation(state: AnnotationState, payload: { id: string; points: { x: number; y: number }[]; saveUndo?: boolean }): AnnotationState {
  const baseState = payload.saveUndo ? pushToUndoStack(state) : state;

  // Find the annotation being resized
  const annotation = state.annotations.find((a) => a.id === payload.id);
  if (!annotation || annotation.type === 'text' || annotation.points.length < 2) return state;

  // For rectangles with linked text, calculate text delta
  let textDeltaX = 0;
  let textDeltaY = 0;

  if (annotation.type === 'rectangle' && annotation.groupId) {
    const newPoints = payload.points;
    const newLeft = Math.min(newPoints[0]!.x, newPoints[1]!.x);
    const newBottom = Math.max(newPoints[0]!.y, newPoints[1]!.y);

    const oldStart = annotation.points[0]!;
    const oldEnd = annotation.points[annotation.points.length - 1]!;
    const oldLeft = Math.min(oldStart.x, oldEnd.x);
    const oldBottom = Math.max(oldStart.y, oldEnd.y);

    textDeltaX = newLeft - oldLeft;
    textDeltaY = newBottom - oldBottom;
  }

  return {
    ...baseState,
    annotations: state.annotations.map((a) => {
      if (a.id === payload.id) {
        return { ...a, points: payload.points };
      }
      // Move linked text annotation to follow bottom-left corner (rectangles only)
      if (annotation.groupId && a.groupId === annotation.groupId && a.type === 'text') {
        return {
          ...a,
          points: a.points.map((p) => ({
            x: p.x + textDeltaX,
            y: p.y + textDeltaY,
          })),
        };
      }
      return a;
    }),
  };
}

function handlePasteAnnotations(state: AnnotationState, payload: { annotations: Annotation[] }): AnnotationState {
  const stateWithUndo = pushToUndoStack(state);
  return {
    ...stateWithUndo,
    annotations: [...state.annotations, ...payload.annotations.map(migrateAnnotation)],
  };
}

function handleRestoreAnnotations(state: AnnotationState, payload: { annotations: Annotation[] }): AnnotationState {
  // Replace (not append) + deduplicate by ID (keep first occurrence) + migrate
  const seen = new Set<string>();
  const deduped: Annotation[] = [];
  for (const a of payload.annotations) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    deduped.push(migrateAnnotation(a));
  }
  return {
    ...state,
    annotations: deduped,
  };
}

function handleUndo(state: AnnotationState): AnnotationState {
  if (state.undoStack.length === 0) return state;

  const previousEntry = state.undoStack[state.undoStack.length - 1];
  return {
    ...state,
    annotations: previousEntry?.annotations || [],
    styleModifications: previousEntry?.styleModifications || [],
    spacingTokenMods: previousEntry?.spacingTokenMods || [],
    undoStack: state.undoStack.slice(0, -1),
    redoStack: [...state.redoStack, {
      annotations: state.annotations,
      styleModifications: state.styleModifications,
      spacingTokenMods: state.spacingTokenMods,
    }],
  };
}

function handleRedo(state: AnnotationState): AnnotationState {
  if (state.redoStack.length === 0) return state;

  const nextEntry = state.redoStack[state.redoStack.length - 1];
  return {
    ...state,
    annotations: nextEntry?.annotations || [],
    styleModifications: nextEntry?.styleModifications || [],
    spacingTokenMods: nextEntry?.spacingTokenMods || [],
    redoStack: state.redoStack.slice(0, -1),
    undoStack: [...state.undoStack, {
      annotations: state.annotations,
      styleModifications: state.styleModifications,
      spacingTokenMods: state.spacingTokenMods,
    }],
  };
}

function handleSelectAnnotation(state: AnnotationState, payload: { id: string | null; addToSelection?: boolean }): AnnotationState {
  const { id, addToSelection } = payload;

  // Clear selection
  if (id === null) {
    return {
      ...state,
      selectedAnnotationIds: [],
      lastSelectedId: null,
    };
  }

  // Shift-click: toggle in selection
  if (addToSelection) {
    const isAlreadySelected = state.selectedAnnotationIds.includes(id);
    if (isAlreadySelected) {
      // Remove from selection
      const newIds = state.selectedAnnotationIds.filter(i => i !== id);
      return {
        ...state,
        selectedAnnotationIds: newIds,
        lastSelectedId: newIds.length > 0 ? newIds[newIds.length - 1]! : null,
      };
    } else {
      // Add to selection
      return {
        ...state,
        selectedAnnotationIds: [...state.selectedAnnotationIds, id],
        lastSelectedId: id,
      };
    }
  }

  // Regular click: replace selection
  return {
    ...state,
    selectedAnnotationIds: [id],
    lastSelectedId: id,
  };
}

function handleUpdateAnnotationColor(state: AnnotationState, payload: { id: string; color: string }): AnnotationState {
  // Collect all groupIds from selected annotations
  const selectedGroupIds = new Set<string>();
  for (const id of state.selectedAnnotationIds) {
    const annotation = state.annotations.find((a) => a.id === id);
    if (annotation?.groupId) {
      selectedGroupIds.add(annotation.groupId);
    }
  }

  // Don't push to undo stack for color changes (too granular for scroll)
  return {
    ...state,
    annotations: state.annotations.map((a) => {
      // Update if selected OR if shares a groupId with a selected annotation
      const isSelected = state.selectedAnnotationIds.includes(a.id);
      const isLinkedToSelected = a.groupId && selectedGroupIds.has(a.groupId);
      if (!isSelected && !isLinkedToSelected) return a;
      return { ...a, color: payload.color };
    }),
  };
}

function handleMarkCaptured(state: AnnotationState): AnnotationState {
  return {
    ...state,
    annotations: state.annotations.map(a => ({
      ...a,
      captured: true,
      status: (a.status === 'pending' || !a.status) ? 'in_flight' as AnnotationLifecycleStatus : a.status,
    })),
    styleModifications: state.styleModifications.map(m => ({ ...m, captured: true })),
    spacingTokenChanges: state.spacingTokenChanges.map(c => ({ ...c, captured: true })),
  };
}

function handleClear(state: AnnotationState): AnnotationState {
  return {
    ...state,
    annotations: [],
    undoStack: [],
    redoStack: [],
    currentPath: [],
    selectedAnnotationIds: [],
    lastSelectedId: null,
    spacingTokenChanges: [],
    spacingTokenMods: [],
  };
}

function handleSelectElement(state: AnnotationState, payload: InspectedElement | null): AnnotationState {
  return {
    ...state,
    inspectedElement: payload,
  };
}

function handleModifyStyle(state: AnnotationState, payload: {
  selector: string;
  element: ElementInfo;
  property: string;
  original: string;
  modified: string;
}): AnnotationState {
  const { selector, element, property, original, modified } = payload;

  // Find existing modification for this selector
  const existingModIndex = state.styleModifications.findIndex(m => m.selector === selector);

  // Skip if value hasn't actually changed AND there's no existing modification to potentially remove
  if (original === modified && existingModIndex < 0) {
    return state;
  }

  if (existingModIndex >= 0) {
    // Update existing modification
    const existingMod = state.styleModifications[existingModIndex]!;

    // If element was captured, start fresh with only the new change
    if (existingMod.captured) {
      const baseState = pushToUndoStack(state);
      const newModifications = baseState.styleModifications.map((m, i) =>
        i === existingModIndex
          ? { ...m, changes: [{ property, original, modified }], captured: false }
          : m
      );
      return {
        ...baseState,
        styleModifications: newModifications,
      };
    }

    const existingChangeIndex = existingMod.changes.findIndex(c => c.property === property);

    let newChanges;
    let baseState = state;

    if (existingChangeIndex >= 0) {
      const existingChange = existingMod.changes[existingChangeIndex]!;
      // If modified value equals the ORIGINAL value, remove the change entirely
      if (modified === existingChange.original) {
        newChanges = existingMod.changes.filter((_, i) => i !== existingChangeIndex);
      } else {
        // Update existing property change - no undo save (too granular)
        newChanges = existingMod.changes.map((c, i) =>
          i === existingChangeIndex ? { ...c, modified } : c
        );
      }
    } else {
      // Add new property change - but skip if original === modified
      if (original === modified) {
        return state;
      }
      baseState = pushToUndoStack(state);
      newChanges = [...existingMod.changes, { property, original, modified }];
    }

    // If no changes left, remove the modification entirely
    if (newChanges.length === 0) {
      return {
        ...baseState,
        styleModifications: baseState.styleModifications.filter((_, i) => i !== existingModIndex),
      };
    }

    const newModifications = baseState.styleModifications.map((m, i) =>
      i === existingModIndex ? { ...m, changes: newChanges } : m
    );

    return {
      ...baseState,
      styleModifications: newModifications,
    };
  } else {
    // Add new modification - save undo before adding
    const baseState = pushToUndoStack(state);
    const newMod: StyleModification = {
      selector,
      element,
      changes: [{ property, original, modified }],
    };

    return {
      ...baseState,
      styleModifications: [...baseState.styleModifications, newMod],
    };
  }
}

function handleModifyStylesBatch(state: AnnotationState, payload: {
  selector: string;
  durableSelector?: string;
  element: ElementInfo;
  changes: { property: string; original: string; modified: string }[];
}): AnnotationState {
  const { selector, durableSelector, element, changes } = payload;
  // Filter to only actually-changed properties
  const realChanges = changes.filter(c => c.original !== c.modified);
  if (realChanges.length === 0) return state;

  const baseState = pushToUndoStack(state);
  const existingModIndex = baseState.styleModifications.findIndex(m => m.selector === selector);

  if (existingModIndex >= 0) {
    const existingMod = baseState.styleModifications[existingModIndex]!;
    let mergedChanges = existingMod.captured ? [] : [...existingMod.changes];

    for (const change of realChanges) {
      const idx = mergedChanges.findIndex(c => c.property === change.property);
      if (idx >= 0) {
        // If new value matches the original recorded value, remove the change
        if (change.modified === mergedChanges[idx]!.original) {
          mergedChanges = mergedChanges.filter((_, i) => i !== idx);
        } else {
          mergedChanges = mergedChanges.map((c, i) => i === idx ? { ...c, modified: change.modified } : c);
        }
      } else {
        mergedChanges.push(change);
      }
    }

    if (mergedChanges.length === 0) {
      return {
        ...baseState,
        styleModifications: baseState.styleModifications.filter((_, i) => i !== existingModIndex),
      };
    }

    return {
      ...baseState,
      styleModifications: baseState.styleModifications.map((m, i) =>
        i === existingModIndex ? { ...m, changes: mergedChanges, captured: false } : m
      ),
    };
  } else {
    return {
      ...baseState,
      styleModifications: [...baseState.styleModifications, { selector, durableSelector, element, changes: realChanges }],
    };
  }
}

function handleClearStyle(state: AnnotationState, payload: { selector: string; property: string }): AnnotationState {
  const { selector, property } = payload;

  // Save undo before clearing
  const baseState = pushToUndoStack(state);

  const newModifications = baseState.styleModifications
    .map(m => {
      if (m.selector !== selector) return m;
      return {
        ...m,
        changes: m.changes.filter(c => c.property !== property),
      };
    })
    .filter(m => m.changes.length > 0); // Remove modifications with no changes left

  return {
    ...baseState,
    styleModifications: newModifications,
  };
}

function handleClearAllStyles(state: AnnotationState): AnnotationState {
  // Only save undo if there are modifications to clear
  if (state.styleModifications.length === 0) {
    return {
      ...state,
      inspectedElement: null,
    };
  }
  const baseState = pushToUndoStack(state);
  return {
    ...baseState,
    styleModifications: [],
    inspectedElement: null,
  };
}

function handleRestoreStyleModifications(state: AnnotationState, payload: StyleModification[]): AnnotationState {
  return {
    ...state,
    styleModifications: payload,
  };
}

function handleUpdateLinkedPositions(state: AnnotationState, payload: {
  updates: { id: string; point: { x: number; y: number }; linkedAnchor?: 'top-left' | 'bottom-left' }[];
}): AnnotationState {
  const { updates } = payload;
  const updateMap = new Map(updates.map(u => [u.id, u]));
  return {
    ...state,
    annotations: state.annotations.map(a => {
      const update = updateMap.get(a.id);
      if (!update) return a;
      return {
        ...a,
        points: [update.point, ...a.points.slice(1)],
        ...(update.linkedAnchor ? { linkedAnchor: update.linkedAnchor } : {}),
      };
    }),
  };
}

function handleSetAnnotationStatus(state: AnnotationState, payload: { ids: string[]; status: AnnotationLifecycleStatus }): AnnotationState {
  const idSet = new Set(payload.ids);
  return {
    ...state,
    annotations: state.annotations.map(a =>
      idSet.has(a.id) ? { ...a, status: payload.status } : a
    ),
  };
}

function handleSetAnnotationThread(state: AnnotationState, payload: { ids: string[]; threadId: string }): AnnotationState {
  const idSet = new Set(payload.ids);
  // Build groupId set so group mates (e.g. text annotations paired with shapes) also get the threadId
  const groupIds = new Set<string>();
  for (const a of state.annotations) {
    if (idSet.has(a.id) && a.groupId) groupIds.add(a.groupId);
  }
  return {
    ...state,
    annotations: state.annotations.map(a =>
      (idSet.has(a.id) || (a.groupId && groupIds.has(a.groupId)))
        ? { ...a, threadId: payload.threadId }
        : a
    ),
  };
}

function handleSetAnnotationQuestion(state: AnnotationState, payload: { ids: string[]; question: string; threadId: string }): AnnotationState {
  const idSet = new Set(payload.ids);
  // Build groupId set so group mates (e.g. text annotations paired with shapes) also get the question state
  const groupIds = new Set<string>();
  for (const a of state.annotations) {
    if (idSet.has(a.id) && a.groupId) groupIds.add(a.groupId);
  }
  return {
    ...state,
    annotations: state.annotations.map(a =>
      (idSet.has(a.id) || (a.groupId && groupIds.has(a.groupId)))
        ? { ...a, status: 'waiting_input' as const, question: payload.question, threadId: payload.threadId }
        : a
    ),
  };
}

function handleApplyResolutions(state: AnnotationState, payload: { resolutions: AnnotationResolution[]; threadId?: string }): AnnotationState {
  const resolutionMap = new Map(
    payload.resolutions.map(r => [r.annotationId, r])
  );
  // Build a groupId -> resolution map so group mates inherit the resolution
  const groupResolutionMap = new Map<string, AnnotationResolution>();
  for (const a of state.annotations) {
    const resolution = resolutionMap.get(a.id);
    if (resolution && a.groupId) {
      groupResolutionMap.set(a.groupId, resolution);
    }
  }
  return {
    ...state,
    annotations: state.annotations.map(a => {
      const resolution = resolutionMap.get(a.id) ||
        (a.groupId ? groupResolutionMap.get(a.groupId) : undefined);
      if (!resolution) return a;
      return {
        ...a,
        status: resolution.status as AnnotationLifecycleStatus,
        resolutionSummary: resolution.summary,
        scope: resolution.finalScope ?? resolution.inferredScope ?? null,
        replyCount: (a.replyCount ?? 0) + 1,
        question: undefined,
        threadId: a.threadId || payload.threadId,
      };
    }),
  };
}

function handleCleanupOrphaned(state: AnnotationState, payload: { linkedSelectors: string[]; styleSelectors: string[] }): AnnotationState {
  const { linkedSelectors, styleSelectors } = payload;
  const linkedSet = new Set(linkedSelectors);
  const styleSet = new Set(styleSelectors);

  // Collect annotation IDs and their groups for removal
  const idsToRemove = new Set<string>();
  const groupIdsToRemove = new Set<string>();

  for (const ann of state.annotations) {
    if (ann.linkedSelector && linkedSet.has(ann.linkedSelector)) {
      idsToRemove.add(ann.id);
      if (ann.groupId) groupIdsToRemove.add(ann.groupId);
    }
  }

  // Also remove group mates of orphaned annotations
  for (const ann of state.annotations) {
    if (ann.groupId && groupIdsToRemove.has(ann.groupId)) {
      idsToRemove.add(ann.id);
    }
  }

  const newAnnotations = state.annotations.filter(a => !idsToRemove.has(a.id));
  const newStyleMods = state.styleModifications.filter(m => !styleSet.has(m.selector));

  // Nothing to clean up
  if (newAnnotations.length === state.annotations.length &&
      newStyleMods.length === state.styleModifications.length) {
    return state;
  }

  // Clean up selection if any removed annotations were selected
  const newSelectedIds = state.selectedAnnotationIds.filter(id => !idsToRemove.has(id));

  // Clear inspected element if its element was removed
  const inspectedCleared = state.inspectedElement &&
    styleSet.has(state.inspectedElement.info.selector)
      ? null
      : state.inspectedElement;

  return {
    ...state,
    annotations: newAnnotations,
    styleModifications: newStyleMods,
    selectedAnnotationIds: newSelectedIds,
    lastSelectedId: newSelectedIds.length > 0 ? newSelectedIds[newSelectedIds.length - 1]! : null,
    inspectedElement: inspectedCleared,
  };
}

function handleAddSpacingTokenChange(state: AnnotationState, payload: SpacingTokenChange): AnnotationState {
  // Replace if same tokenPath already exists (user re-dragged the same token)
  const existingIdx = state.spacingTokenChanges.findIndex(c => c.tokenPath === payload.tokenPath);
  if (existingIdx >= 0) {
    return {
      ...state,
      spacingTokenChanges: state.spacingTokenChanges.map((c, i) => i === existingIdx ? payload : c),
    };
  }
  return {
    ...state,
    spacingTokenChanges: [...state.spacingTokenChanges, payload],
  };
}

function handleRestoreSpacingTokenChanges(state: AnnotationState, payload: SpacingTokenChange[]): AnnotationState {
  return {
    ...state,
    spacingTokenChanges: payload,
  };
}

function handleModifySpacingToken(state: AnnotationState, payload: SpacingTokenMod): AnnotationState {
  const stateWithUndo = pushToUndoStack(state);
  // Upsert: replace existing mod for the same tokenPath, or append
  const existingIdx = state.spacingTokenMods.findIndex(m => m.tokenPath === payload.tokenPath);
  let newMods: SpacingTokenMod[];
  if (existingIdx >= 0) {
    // Keep the original originalValue from the first modification
    const existing = state.spacingTokenMods[existingIdx]!;
    const merged: SpacingTokenMod = {
      ...payload,
      originalValue: existing.originalValue,
      originalPx: existing.originalPx,
    };
    newMods = state.spacingTokenMods.map((m, i) => i === existingIdx ? merged : m);
  } else {
    newMods = [...state.spacingTokenMods, payload];
  }
  return {
    ...stateWithUndo,
    spacingTokenMods: newMods,
  };
}

function handleDeleteSpacingToken(state: AnnotationState, payload: { tokenPath: string; originalValue: string }): AnnotationState {
  const stateWithUndo = pushToUndoStack(state);
  // Check if there's an existing mod for this path (user dragged then deleted)
  const existingIdx = state.spacingTokenMods.findIndex(m => m.tokenPath === payload.tokenPath);
  const originalValue = existingIdx >= 0
    ? state.spacingTokenMods[existingIdx]!.originalValue
    : payload.originalValue;
  const originalPx = existingIdx >= 0
    ? state.spacingTokenMods[existingIdx]!.originalPx
    : (parseFloat(payload.originalValue) || 0);

  const deleteMod: SpacingTokenMod = {
    tokenPath: payload.tokenPath,
    originalValue,
    currentValue: '__deleted__',
    targets: existingIdx >= 0 ? state.spacingTokenMods[existingIdx]!.targets : [],
    originalPx,
    currentPx: 0,
  };

  let newMods: SpacingTokenMod[];
  if (existingIdx >= 0) {
    newMods = state.spacingTokenMods.map((m, i) => i === existingIdx ? deleteMod : m);
  } else {
    newMods = [...state.spacingTokenMods, deleteMod];
  }
  return {
    ...stateWithUndo,
    spacingTokenMods: newMods,
  };
}

// ---------------------------------------------------------------------------
// Handler map — maps action type strings to handler functions
// ---------------------------------------------------------------------------

type Handler = (state: AnnotationState, payload: any) => AnnotationState;

const handlers: Record<string, Handler> = {
  SET_ANNOTATING: handleSetAnnotating,
  SET_TOOL: handleSetTool,
  SET_COLOR: handleSetColor,
  SET_STROKE_WIDTH: handleSetStrokeWidth,
  START_PATH: handleStartPath,
  CONTINUE_PATH: handleContinuePath,
  CANCEL_PATH: handleCancelPath,
  FINISH_PATH: handleFinishPath,
  ADD_TEXT: handleAddText,
  UPDATE_TEXT: handleUpdateText,
  UPDATE_TEXT_SIZE: handleUpdateTextSize,
  DELETE_ANNOTATION: handleDeleteAnnotation,
  MOVE_ANNOTATION: handleMoveAnnotation,
  RESIZE_ANNOTATION: handleResizeAnnotation,
  PASTE_ANNOTATIONS: handlePasteAnnotations,
  RESTORE_ANNOTATIONS: handleRestoreAnnotations,
  UNDO: handleUndo,
  REDO: handleRedo,
  SELECT_ANNOTATION: handleSelectAnnotation,
  UPDATE_ANNOTATION_COLOR: handleUpdateAnnotationColor,
  MARK_CAPTURED: handleMarkCaptured,
  CLEAR: handleClear,
  SELECT_ELEMENT: handleSelectElement,
  MODIFY_STYLE: handleModifyStyle,
  MODIFY_STYLES_BATCH: handleModifyStylesBatch,
  CLEAR_STYLE: handleClearStyle,
  CLEAR_ALL_STYLES: handleClearAllStyles,
  RESTORE_STYLE_MODIFICATIONS: handleRestoreStyleModifications,
  UPDATE_LINKED_POSITIONS: handleUpdateLinkedPositions,
  CLEANUP_ORPHANED: handleCleanupOrphaned,
  SET_ANNOTATION_STATUS: handleSetAnnotationStatus,
  SET_ANNOTATION_THREAD: handleSetAnnotationThread,
  SET_ANNOTATION_QUESTION: handleSetAnnotationQuestion,
  APPLY_RESOLUTIONS: handleApplyResolutions,
  ADD_SPACING_TOKEN_CHANGE: handleAddSpacingTokenChange,
  RESTORE_SPACING_TOKEN_CHANGES: handleRestoreSpacingTokenChanges,
  MODIFY_SPACING_TOKEN: handleModifySpacingToken,
  DELETE_SPACING_TOKEN: handleDeleteSpacingToken,
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function annotationReducer(
  state: AnnotationState,
  action: AnnotationAction
): AnnotationState {
  const handler = handlers[action.type];
  if (handler) return handler(state, (action as any).payload);
  return state;
}

export function useAnnotationState() {
  const [state, dispatch] = useReducer(annotationReducer, initialState);

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          dispatch({ type: 'REDO' });
        } else {
          dispatch({ type: 'UNDO' });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return [state, dispatch] as const;
}

export { annotationReducer, generateId, initialState };
