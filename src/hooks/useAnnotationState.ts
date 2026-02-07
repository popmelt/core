import { useEffect, useReducer } from 'react';

import type {
  Annotation,
  AnnotationAction,
  AnnotationLifecycleStatus,
  AnnotationResolution,
  AnnotationState,
  StyleModification,
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
    }],
    redoStack: [], // Clear redo stack on new action
  };
}

function annotationReducer(
  state: AnnotationState,
  action: AnnotationAction
): AnnotationState {
  switch (action.type) {
    case 'SET_ANNOTATING':
      return { ...state, isAnnotating: action.payload };

    case 'SET_TOOL':
      return { ...state, activeTool: action.payload };

    case 'SET_COLOR':
      return { ...state, activeColor: action.payload };

    case 'SET_STROKE_WIDTH':
      return { ...state, strokeWidth: action.payload };

    case 'START_PATH':
      return { ...state, currentPath: [action.payload] };

    case 'CONTINUE_PATH':
      return { ...state, currentPath: [...state.currentPath, action.payload] };

    case 'CANCEL_PATH':
      return { ...state, currentPath: [] };

    case 'FINISH_PATH': {
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
        groupId: action.payload?.groupId,
        elements: action.payload?.elements,
      };

      const stateWithUndo = pushToUndoStack(state);
      return {
        ...stateWithUndo,
        annotations: [...state.annotations, newAnnotation],
        currentPath: [],
      };
    }

    case 'ADD_TEXT': {
      const textAnnotation: Annotation = {
        id: generateId(),
        type: 'text',
        points: [action.payload.point],
        text: action.payload.text,
        fontSize: action.payload.fontSize || 12,
        color: state.activeColor,
        strokeWidth: state.strokeWidth,
        timestamp: Date.now(),
        groupId: action.payload.groupId,
        linkedSelector: action.payload.linkedSelector,
        linkedAnchor: action.payload.linkedAnchor,
        elements: action.payload.elements,
      };

      // Skip undo for linked text (groupId) - the rectangle already saved the pre-creation state
      const baseState = action.payload.groupId ? state : pushToUndoStack(state);
      return {
        ...baseState,
        annotations: [...state.annotations, textAnnotation],
      };
    }

    case 'UPDATE_TEXT': {
      const stateWithUndo = pushToUndoStack(state);
      return {
        ...stateWithUndo,
        annotations: state.annotations.map((a) =>
          a.id === action.payload.id ? { ...a, text: action.payload.text } : a
        ),
      };
    }

    case 'UPDATE_TEXT_SIZE': {
      // Don't push to undo stack for size changes (too granular)
      return {
        ...state,
        annotations: state.annotations.map((a) =>
          a.id === action.payload.id
            ? { ...a, fontSize: Math.max(12, Math.min(72, action.payload.fontSize)) }
            : a
        ),
      };
    }

    case 'DELETE_ANNOTATION': {
      const stateWithUndo = pushToUndoStack(state);
      // Find the annotation to check for groupId
      const toDelete = state.annotations.find((a) => a.id === action.payload.id);
      const groupId = toDelete?.groupId;

      return {
        ...stateWithUndo,
        // Delete the annotation and any linked annotations (same groupId)
        annotations: state.annotations.filter((a) =>
          a.id !== action.payload.id && !(groupId && a.groupId === groupId)
        ),
      };
    }

    case 'MOVE_ANNOTATION': {
      // Only save undo state on first move of a drag (to avoid flooding undo stack)
      const baseState = action.payload.saveUndo ? pushToUndoStack(state) : state;

      // Find the annotation being moved to check for groupId
      const movedAnnotation = state.annotations.find((a) => a.id === action.payload.id);
      const groupId = movedAnnotation?.groupId;

      return {
        ...baseState,
        annotations: state.annotations.map((a) => {
          // Move if it's the target annotation OR if it shares the same groupId
          const shouldMove = a.id === action.payload.id || (groupId && a.groupId === groupId);
          if (!shouldMove) return a;

          // Move all points by the delta
          const dx = action.payload.delta.x;
          const dy = action.payload.delta.y;
          return {
            ...a,
            points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
          };
        }),
      };
    }

    case 'RESIZE_ANNOTATION': {
      const baseState = action.payload.saveUndo ? pushToUndoStack(state) : state;

      // Find the annotation being resized
      const annotation = state.annotations.find((a) => a.id === action.payload.id);
      if (!annotation || annotation.type === 'text' || annotation.points.length < 2) return state;

      // For rectangles with linked text, calculate text delta
      let textDeltaX = 0;
      let textDeltaY = 0;

      if (annotation.type === 'rectangle' && annotation.groupId) {
        const newPoints = action.payload.points;
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
          if (a.id === action.payload.id) {
            return { ...a, points: action.payload.points };
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

    case 'PASTE_ANNOTATIONS': {
      const stateWithUndo = pushToUndoStack(state);
      return {
        ...stateWithUndo,
        annotations: [...state.annotations, ...action.payload.annotations.map(migrateAnnotation)],
      };
    }

    case 'UNDO': {
      if (state.undoStack.length === 0) return state;

      const previousEntry = state.undoStack[state.undoStack.length - 1];
      return {
        ...state,
        annotations: previousEntry?.annotations || [],
        styleModifications: previousEntry?.styleModifications || [],
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, {
          annotations: state.annotations,
          styleModifications: state.styleModifications,
        }],
      };
    }

    case 'REDO': {
      if (state.redoStack.length === 0) return state;

      const nextEntry = state.redoStack[state.redoStack.length - 1];
      return {
        ...state,
        annotations: nextEntry?.annotations || [],
        styleModifications: nextEntry?.styleModifications || [],
        redoStack: state.redoStack.slice(0, -1),
        undoStack: [...state.undoStack, {
          annotations: state.annotations,
          styleModifications: state.styleModifications,
        }],
      };
    }

    case 'SELECT_ANNOTATION': {
      const { id, addToSelection } = action.payload;

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

    case 'UPDATE_ANNOTATION_COLOR': {
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
          return { ...a, color: action.payload.color };
        }),
      };
    }

    case 'MARK_CAPTURED':
      return {
        ...state,
        annotations: state.annotations.map(a => ({
          ...a,
          captured: true,
          status: (a.status === 'pending' || !a.status) ? 'in_flight' as AnnotationLifecycleStatus : a.status,
        })),
        styleModifications: state.styleModifications.map(m => ({ ...m, captured: true })),
      };

    case 'CLEAR':
      return {
        ...state,
        annotations: [],
        undoStack: [],
        redoStack: [],
        currentPath: [],
        selectedAnnotationIds: [],
        lastSelectedId: null,
      };

    // Inspector actions
    case 'SELECT_ELEMENT':
      return {
        ...state,
        inspectedElement: action.payload,
      };

    case 'MODIFY_STYLE': {
      const { selector, element, property, original, modified } = action.payload;

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

    case 'CLEAR_STYLE': {
      const { selector, property } = action.payload;

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

    case 'CLEAR_ALL_STYLES': {
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

    case 'RESTORE_STYLE_MODIFICATIONS':
      return {
        ...state,
        styleModifications: action.payload,
      };

    case 'UPDATE_LINKED_POSITIONS': {
      const { updates } = action.payload;
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

    case 'SET_ANNOTATION_STATUS': {
      const idSet = new Set(action.payload.ids);
      return {
        ...state,
        annotations: state.annotations.map(a =>
          idSet.has(a.id) ? { ...a, status: action.payload.status } : a
        ),
      };
    }

    case 'SET_ANNOTATION_THREAD': {
      const idSet = new Set(action.payload.ids);
      return {
        ...state,
        annotations: state.annotations.map(a =>
          idSet.has(a.id) ? { ...a, threadId: action.payload.threadId } : a
        ),
      };
    }

    case 'SET_ANNOTATION_QUESTION': {
      const idSet = new Set(action.payload.ids);
      return {
        ...state,
        annotations: state.annotations.map(a =>
          idSet.has(a.id)
            ? { ...a, status: 'waiting_input' as const, question: action.payload.question, threadId: action.payload.threadId }
            : a
        ),
      };
    }

    case 'APPLY_RESOLUTIONS': {
      const resolutionMap = new Map(
        action.payload.resolutions.map(r => [r.annotationId, r])
      );
      // Build a groupId → resolution map so group mates inherit the resolution
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
            replyCount: (a.replyCount ?? 0) + 1,
            question: undefined,
            threadId: a.threadId || action.payload.threadId,
          };
        }),
      };
    }

    case 'ADD_PLAN_ANNOTATION': {
      const { groupId, planId, planTaskId, instruction, region, color, linkedSelector, elements } = action.payload;

      // Create a rectangle annotation for the region
      const rectAnnotation: Annotation = {
        id: generateId(),
        type: 'rectangle',
        points: [
          { x: region.x, y: region.y },
          { x: region.x + region.width, y: region.y + region.height },
        ],
        color,
        strokeWidth: 2,
        timestamp: Date.now(),
        groupId,
        linkedSelector,
        elements,
        planId,
        planTaskId,
        status: 'pending' as AnnotationLifecycleStatus,
      };

      // Create a text annotation with the instruction
      const textAnnotation: Annotation = {
        id: generateId(),
        type: 'text',
        points: [{ x: region.x, y: region.y + region.height + 4 }],
        text: instruction,
        fontSize: 12,
        color,
        strokeWidth: 2,
        timestamp: Date.now(),
        groupId,
        linkedSelector,
        elements,
        planId,
        planTaskId,
      };

      return {
        ...state,
        annotations: [...state.annotations, rectAnnotation, textAnnotation],
      };
    }

    case 'CLEANUP_ORPHANED': {
      const { linkedSelectors, styleSelectors } = action.payload;
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

    default:
      return state;
  }
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

export { annotationReducer, initialState };
