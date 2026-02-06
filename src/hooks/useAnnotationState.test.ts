import { describe, expect, it } from 'vitest';

import type {
  Annotation,
  AnnotationAction,
  AnnotationState,
  ElementInfo,
  Point,
} from '../tools/types';
import { annotationReducer, initialState } from './useAnnotationState';

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-' + Math.random().toString(36).slice(2, 7),
    type: 'freehand',
    points: [{ x: 10, y: 10 }, { x: 20, y: 20 }],
    color: '#ff0000',
    strokeWidth: 3,
    timestamp: Date.now(),
    ...overrides,
  };
}

function dispatch(state: AnnotationState, action: AnnotationAction): AnnotationState {
  return annotationReducer(state, action);
}

// ---- Tool state ----
describe('Tool state actions', () => {
  it('SET_ANNOTATING toggles isAnnotating', () => {
    const s = dispatch(initialState, { type: 'SET_ANNOTATING', payload: true });
    expect(s.isAnnotating).toBe(true);
    const s2 = dispatch(s, { type: 'SET_ANNOTATING', payload: false });
    expect(s2.isAnnotating).toBe(false);
  });

  it('SET_TOOL changes active tool', () => {
    const s = dispatch(initialState, { type: 'SET_TOOL', payload: 'rectangle' });
    expect(s.activeTool).toBe('rectangle');
  });

  it('SET_COLOR changes active color', () => {
    const s = dispatch(initialState, { type: 'SET_COLOR', payload: '#00ff00' });
    expect(s.activeColor).toBe('#00ff00');
  });

  it('SET_STROKE_WIDTH changes stroke width', () => {
    const s = dispatch(initialState, { type: 'SET_STROKE_WIDTH', payload: 5 });
    expect(s.strokeWidth).toBe(5);
  });
});

// ---- Path lifecycle ----
describe('Path lifecycle', () => {
  it('START_PATH initializes currentPath', () => {
    const s = dispatch(initialState, { type: 'START_PATH', payload: { x: 0, y: 0 } });
    expect(s.currentPath).toEqual([{ x: 0, y: 0 }]);
  });

  it('CONTINUE_PATH appends to currentPath', () => {
    let s = dispatch(initialState, { type: 'START_PATH', payload: { x: 0, y: 0 } });
    s = dispatch(s, { type: 'CONTINUE_PATH', payload: { x: 5, y: 5 } });
    expect(s.currentPath).toHaveLength(2);
  });

  it('FINISH_PATH creates annotation from path', () => {
    let s = dispatch(initialState, { type: 'START_PATH', payload: { x: 0, y: 0 } });
    s = dispatch(s, { type: 'CONTINUE_PATH', payload: { x: 10, y: 10 } });
    s = dispatch(s, { type: 'FINISH_PATH' });
    expect(s.annotations).toHaveLength(1);
    expect(s.currentPath).toEqual([]);
    expect(s.annotations[0]!.type).toBe('freehand');
  });

  it('FINISH_PATH pushes to undo stack and clears redo', () => {
    let s = dispatch(initialState, { type: 'START_PATH', payload: { x: 0, y: 0 } });
    s = dispatch(s, { type: 'CONTINUE_PATH', payload: { x: 10, y: 10 } });
    s = dispatch(s, { type: 'FINISH_PATH' });
    expect(s.undoStack).toHaveLength(1);
    expect(s.redoStack).toEqual([]);
  });

  it('FINISH_PATH with <2 points creates no annotation', () => {
    let s = dispatch(initialState, { type: 'START_PATH', payload: { x: 0, y: 0 } });
    s = dispatch(s, { type: 'FINISH_PATH' });
    expect(s.annotations).toHaveLength(0);
    expect(s.currentPath).toEqual([]);
  });

  it('CANCEL_PATH clears currentPath', () => {
    let s = dispatch(initialState, { type: 'START_PATH', payload: { x: 0, y: 0 } });
    s = dispatch(s, { type: 'CANCEL_PATH' });
    expect(s.currentPath).toEqual([]);
  });

  it('FINISH_PATH with groupId and elements stores them', () => {
    let s = dispatch(initialState, { type: 'START_PATH', payload: { x: 0, y: 0 } });
    s = dispatch(s, { type: 'CONTINUE_PATH', payload: { x: 10, y: 10 } });
    const elements: ElementInfo[] = [{ selector: 'div.test', tagName: 'div' }];
    s = dispatch(s, { type: 'FINISH_PATH', payload: { groupId: 'g1', elements } });
    expect(s.annotations[0]!.groupId).toBe('g1');
    expect(s.annotations[0]!.elements).toEqual(elements);
  });
});

// ---- Text ----
describe('Text actions', () => {
  it('ADD_TEXT creates text annotation', () => {
    const s = dispatch(initialState, {
      type: 'ADD_TEXT',
      payload: { point: { x: 10, y: 10 }, text: 'hello' },
    });
    expect(s.annotations).toHaveLength(1);
    expect(s.annotations[0]!.type).toBe('text');
    expect(s.annotations[0]!.text).toBe('hello');
  });

  it('ADD_TEXT with groupId skips undo push', () => {
    const s = dispatch(initialState, {
      type: 'ADD_TEXT',
      payload: { point: { x: 10, y: 10 }, text: 'hello', groupId: 'g1' },
    });
    expect(s.undoStack).toHaveLength(0);
  });

  it('ADD_TEXT without groupId pushes undo', () => {
    const s = dispatch(initialState, {
      type: 'ADD_TEXT',
      payload: { point: { x: 10, y: 10 }, text: 'hello' },
    });
    expect(s.undoStack).toHaveLength(1);
  });

  it('ADD_TEXT stores linkedSelector and linkedAnchor', () => {
    const s = dispatch(initialState, {
      type: 'ADD_TEXT',
      payload: {
        point: { x: 10, y: 10 },
        text: 'note',
        linkedSelector: 'div.card',
        linkedAnchor: 'bottom-left',
      },
    });
    expect(s.annotations[0]!.linkedSelector).toBe('div.card');
    expect(s.annotations[0]!.linkedAnchor).toBe('bottom-left');
  });

  it('UPDATE_TEXT changes annotation text', () => {
    const ann = makeAnnotation({ type: 'text', text: 'old' });
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, { type: 'UPDATE_TEXT', payload: { id: ann.id, text: 'new' } });
    expect(s.annotations[0]!.text).toBe('new');
    expect(s.undoStack).toHaveLength(1);
  });

  it('UPDATE_TEXT_SIZE clamps between 12 and 72', () => {
    const ann = makeAnnotation({ type: 'text', fontSize: 16 });
    const base: AnnotationState = { ...initialState, annotations: [ann] };

    const s1 = dispatch(base, { type: 'UPDATE_TEXT_SIZE', payload: { id: ann.id, fontSize: 5 } });
    expect(s1.annotations[0]!.fontSize).toBe(12);

    const s2 = dispatch(base, { type: 'UPDATE_TEXT_SIZE', payload: { id: ann.id, fontSize: 100 } });
    expect(s2.annotations[0]!.fontSize).toBe(72);

    const s3 = dispatch(base, { type: 'UPDATE_TEXT_SIZE', payload: { id: ann.id, fontSize: 24 } });
    expect(s3.annotations[0]!.fontSize).toBe(24);
  });
});

// ---- Delete / Move / Resize ----
describe('Delete, Move, Resize', () => {
  it('DELETE_ANNOTATION removes the annotation', () => {
    const ann = makeAnnotation();
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, { type: 'DELETE_ANNOTATION', payload: { id: ann.id } });
    expect(s.annotations).toHaveLength(0);
    expect(s.undoStack).toHaveLength(1);
  });

  it('DELETE_ANNOTATION removes group mates', () => {
    const a1 = makeAnnotation({ groupId: 'g1', type: 'rectangle' });
    const a2 = makeAnnotation({ groupId: 'g1', type: 'text', text: 'note' });
    const a3 = makeAnnotation(); // no group
    const base: AnnotationState = { ...initialState, annotations: [a1, a2, a3] };
    const s = dispatch(base, { type: 'DELETE_ANNOTATION', payload: { id: a1.id } });
    expect(s.annotations).toHaveLength(1);
    expect(s.annotations[0]!.id).toBe(a3.id);
  });

  it('MOVE_ANNOTATION offsets all points', () => {
    const ann = makeAnnotation({ points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] });
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, {
      type: 'MOVE_ANNOTATION',
      payload: { id: ann.id, delta: { x: 5, y: -3 } },
    });
    expect(s.annotations[0]!.points).toEqual([{ x: 15, y: 7 }, { x: 25, y: 17 }]);
  });

  it('MOVE_ANNOTATION moves group mates together', () => {
    const a1 = makeAnnotation({ groupId: 'g1', points: [{ x: 0, y: 0 }] });
    const a2 = makeAnnotation({ groupId: 'g1', points: [{ x: 100, y: 100 }] });
    const base: AnnotationState = { ...initialState, annotations: [a1, a2] };
    const s = dispatch(base, {
      type: 'MOVE_ANNOTATION',
      payload: { id: a1.id, delta: { x: 10, y: 10 } },
    });
    expect(s.annotations[0]!.points[0]).toEqual({ x: 10, y: 10 });
    expect(s.annotations[1]!.points[0]).toEqual({ x: 110, y: 110 });
  });

  it('MOVE_ANNOTATION with saveUndo pushes to undo stack', () => {
    const ann = makeAnnotation();
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, {
      type: 'MOVE_ANNOTATION',
      payload: { id: ann.id, delta: { x: 1, y: 1 }, saveUndo: true },
    });
    expect(s.undoStack).toHaveLength(1);
  });

  it('RESIZE_ANNOTATION updates points', () => {
    const ann = makeAnnotation({
      type: 'rectangle',
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    });
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const newPoints: Point[] = [{ x: 0, y: 0 }, { x: 20, y: 20 }];
    const s = dispatch(base, {
      type: 'RESIZE_ANNOTATION',
      payload: { id: ann.id, points: newPoints },
    });
    expect(s.annotations[0]!.points).toEqual(newPoints);
  });

  it('RESIZE_ANNOTATION skips text annotations', () => {
    const ann = makeAnnotation({ type: 'text', points: [{ x: 0, y: 0 }] });
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, {
      type: 'RESIZE_ANNOTATION',
      payload: { id: ann.id, points: [{ x: 5, y: 5 }] },
    });
    // Returns original state since text type is skipped
    expect(s).toBe(base);
  });
});

// ---- Selection ----
describe('Selection', () => {
  it('SELECT_ANNOTATION replaces selection', () => {
    const ann = makeAnnotation();
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, { type: 'SELECT_ANNOTATION', payload: { id: ann.id } });
    expect(s.selectedAnnotationIds).toEqual([ann.id]);
    expect(s.lastSelectedId).toBe(ann.id);
  });

  it('SELECT_ANNOTATION with null clears selection', () => {
    const ann = makeAnnotation();
    const base: AnnotationState = {
      ...initialState,
      annotations: [ann],
      selectedAnnotationIds: [ann.id],
      lastSelectedId: ann.id,
    };
    const s = dispatch(base, { type: 'SELECT_ANNOTATION', payload: { id: null } });
    expect(s.selectedAnnotationIds).toEqual([]);
    expect(s.lastSelectedId).toBeNull();
  });

  it('SELECT_ANNOTATION with addToSelection toggles', () => {
    const a1 = makeAnnotation();
    const a2 = makeAnnotation();
    const base: AnnotationState = {
      ...initialState,
      annotations: [a1, a2],
      selectedAnnotationIds: [a1.id],
      lastSelectedId: a1.id,
    };
    // Add a2
    const s1 = dispatch(base, {
      type: 'SELECT_ANNOTATION',
      payload: { id: a2.id, addToSelection: true },
    });
    expect(s1.selectedAnnotationIds).toEqual([a1.id, a2.id]);
    // Remove a1
    const s2 = dispatch(s1, {
      type: 'SELECT_ANNOTATION',
      payload: { id: a1.id, addToSelection: true },
    });
    expect(s2.selectedAnnotationIds).toEqual([a2.id]);
    expect(s2.lastSelectedId).toBe(a2.id);
  });

  it('UPDATE_ANNOTATION_COLOR updates selected and group mates', () => {
    const a1 = makeAnnotation({ groupId: 'g1', color: '#ff0000' });
    const a2 = makeAnnotation({ groupId: 'g1', color: '#ff0000' });
    const a3 = makeAnnotation({ color: '#ff0000' });
    const base: AnnotationState = {
      ...initialState,
      annotations: [a1, a2, a3],
      selectedAnnotationIds: [a1.id],
    };
    const s = dispatch(base, {
      type: 'UPDATE_ANNOTATION_COLOR',
      payload: { id: a1.id, color: '#00ff00' },
    });
    expect(s.annotations[0]!.color).toBe('#00ff00');
    expect(s.annotations[1]!.color).toBe('#00ff00'); // group mate
    expect(s.annotations[2]!.color).toBe('#ff0000'); // not in group
  });
});

// ---- Undo / Redo ----
describe('Undo / Redo', () => {
  it('UNDO restores from stack', () => {
    const ann = makeAnnotation();
    let s: AnnotationState = { ...initialState };
    s = dispatch(s, { type: 'ADD_TEXT', payload: { point: { x: 0, y: 0 }, text: 'hello' } });
    expect(s.annotations).toHaveLength(1);
    s = dispatch(s, { type: 'UNDO' });
    expect(s.annotations).toHaveLength(0);
    expect(s.redoStack).toHaveLength(1);
  });

  it('UNDO on empty stack is no-op', () => {
    const s = dispatch(initialState, { type: 'UNDO' });
    expect(s).toBe(initialState);
  });

  it('REDO restores from redo stack', () => {
    let s: AnnotationState = { ...initialState };
    s = dispatch(s, { type: 'ADD_TEXT', payload: { point: { x: 0, y: 0 }, text: 'hello' } });
    s = dispatch(s, { type: 'UNDO' });
    s = dispatch(s, { type: 'REDO' });
    expect(s.annotations).toHaveLength(1);
    expect(s.annotations[0]!.text).toBe('hello');
  });

  it('REDO on empty stack is no-op', () => {
    const s = dispatch(initialState, { type: 'REDO' });
    expect(s).toBe(initialState);
  });

  it('UNDO/REDO preserves styleModifications', () => {
    const elem: ElementInfo = { selector: 'div', tagName: 'div' };
    let s: AnnotationState = { ...initialState };
    s = dispatch(s, {
      type: 'MODIFY_STYLE',
      payload: { selector: 'div', element: elem, property: 'color', original: 'red', modified: 'blue' },
    });
    expect(s.styleModifications).toHaveLength(1);
    s = dispatch(s, { type: 'UNDO' });
    expect(s.styleModifications).toHaveLength(0);
    s = dispatch(s, { type: 'REDO' });
    expect(s.styleModifications).toHaveLength(1);
  });
});

// ---- Lifecycle ----
describe('Lifecycle actions', () => {
  it('MARK_CAPTURED sets pending→in_flight', () => {
    const ann = makeAnnotation({ status: 'pending' });
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, { type: 'MARK_CAPTURED' });
    expect(s.annotations[0]!.status).toBe('in_flight');
    expect(s.annotations[0]!.captured).toBe(true);
  });

  it('MARK_CAPTURED preserves non-pending status', () => {
    const ann = makeAnnotation({ status: 'resolved' });
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, { type: 'MARK_CAPTURED' });
    expect(s.annotations[0]!.status).toBe('resolved');
  });

  it('SET_ANNOTATION_STATUS updates matching IDs', () => {
    const a1 = makeAnnotation();
    const a2 = makeAnnotation();
    const base: AnnotationState = { ...initialState, annotations: [a1, a2] };
    const s = dispatch(base, {
      type: 'SET_ANNOTATION_STATUS',
      payload: { ids: [a1.id], status: 'resolved' },
    });
    expect(s.annotations[0]!.status).toBe('resolved');
    expect(s.annotations[1]!.status).toBeUndefined();
  });

  it('SET_ANNOTATION_THREAD sets threadId', () => {
    const ann = makeAnnotation();
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, {
      type: 'SET_ANNOTATION_THREAD',
      payload: { ids: [ann.id], threadId: 't1' },
    });
    expect(s.annotations[0]!.threadId).toBe('t1');
  });

  it('SET_ANNOTATION_QUESTION sets question and status', () => {
    const ann = makeAnnotation();
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, {
      type: 'SET_ANNOTATION_QUESTION',
      payload: { ids: [ann.id], question: 'Which one?', threadId: 't1' },
    });
    expect(s.annotations[0]!.status).toBe('waiting_input');
    expect(s.annotations[0]!.question).toBe('Which one?');
    expect(s.annotations[0]!.threadId).toBe('t1');
  });

  it('APPLY_RESOLUTIONS sets status and summary', () => {
    const ann = makeAnnotation();
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, {
      type: 'APPLY_RESOLUTIONS',
      payload: {
        resolutions: [{ annotationId: ann.id, status: 'resolved', summary: 'Fixed it' }],
      },
    });
    expect(s.annotations[0]!.status).toBe('resolved');
    expect(s.annotations[0]!.resolutionSummary).toBe('Fixed it');
    expect(s.annotations[0]!.replyCount).toBe(1);
    expect(s.annotations[0]!.question).toBeUndefined();
  });

  it('APPLY_RESOLUTIONS propagates to group mates', () => {
    const a1 = makeAnnotation({ groupId: 'g1' });
    const a2 = makeAnnotation({ groupId: 'g1' });
    const base: AnnotationState = { ...initialState, annotations: [a1, a2] };
    const s = dispatch(base, {
      type: 'APPLY_RESOLUTIONS',
      payload: {
        resolutions: [{ annotationId: a1.id, status: 'resolved', summary: 'Done' }],
      },
    });
    expect(s.annotations[0]!.status).toBe('resolved');
    expect(s.annotations[1]!.status).toBe('resolved');
    expect(s.annotations[1]!.resolutionSummary).toBe('Done');
  });

  it('APPLY_RESOLUTIONS increments replyCount', () => {
    const ann = makeAnnotation({ replyCount: 2 });
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, {
      type: 'APPLY_RESOLUTIONS',
      payload: {
        resolutions: [{ annotationId: ann.id, status: 'resolved', summary: 'Again' }],
      },
    });
    expect(s.annotations[0]!.replyCount).toBe(3);
  });
});

// ---- Inspector / Style ----
describe('Inspector actions', () => {
  const elem: ElementInfo = { selector: 'div.card', tagName: 'div' };

  it('MODIFY_STYLE adds new modification', () => {
    const s = dispatch(initialState, {
      type: 'MODIFY_STYLE',
      payload: { selector: 'div.card', element: elem, property: 'color', original: 'red', modified: 'blue' },
    });
    expect(s.styleModifications).toHaveLength(1);
    expect(s.styleModifications[0]!.changes[0]!.modified).toBe('blue');
    expect(s.undoStack).toHaveLength(1);
  });

  it('MODIFY_STYLE updates existing property', () => {
    let s = dispatch(initialState, {
      type: 'MODIFY_STYLE',
      payload: { selector: 'div.card', element: elem, property: 'color', original: 'red', modified: 'blue' },
    });
    s = dispatch(s, {
      type: 'MODIFY_STYLE',
      payload: { selector: 'div.card', element: elem, property: 'color', original: 'red', modified: 'green' },
    });
    expect(s.styleModifications).toHaveLength(1);
    expect(s.styleModifications[0]!.changes[0]!.modified).toBe('green');
  });

  it('MODIFY_STYLE removes change when modified equals original', () => {
    let s = dispatch(initialState, {
      type: 'MODIFY_STYLE',
      payload: { selector: 'div.card', element: elem, property: 'color', original: 'red', modified: 'blue' },
    });
    s = dispatch(s, {
      type: 'MODIFY_STYLE',
      payload: { selector: 'div.card', element: elem, property: 'color', original: 'red', modified: 'red' },
    });
    // Modification removed entirely since no changes left
    expect(s.styleModifications).toHaveLength(0);
  });

  it('MODIFY_STYLE skips when original === modified and no existing mod', () => {
    const s = dispatch(initialState, {
      type: 'MODIFY_STYLE',
      payload: { selector: 'div.card', element: elem, property: 'color', original: 'red', modified: 'red' },
    });
    expect(s).toBe(initialState);
  });

  it('CLEAR_STYLE removes specific property', () => {
    let s = dispatch(initialState, {
      type: 'MODIFY_STYLE',
      payload: { selector: 'div.card', element: elem, property: 'color', original: 'red', modified: 'blue' },
    });
    s = dispatch(s, {
      type: 'MODIFY_STYLE',
      payload: { selector: 'div.card', element: elem, property: 'font-size', original: '12px', modified: '16px' },
    });
    s = dispatch(s, {
      type: 'CLEAR_STYLE',
      payload: { selector: 'div.card', property: 'color' },
    });
    expect(s.styleModifications).toHaveLength(1);
    expect(s.styleModifications[0]!.changes).toHaveLength(1);
    expect(s.styleModifications[0]!.changes[0]!.property).toBe('font-size');
  });

  it('CLEAR_ALL_STYLES removes all modifications', () => {
    let s = dispatch(initialState, {
      type: 'MODIFY_STYLE',
      payload: { selector: 'div.card', element: elem, property: 'color', original: 'red', modified: 'blue' },
    });
    s = dispatch(s, { type: 'CLEAR_ALL_STYLES' });
    expect(s.styleModifications).toEqual([]);
    expect(s.inspectedElement).toBeNull();
  });

  it('CLEAR_ALL_STYLES with no modifications does not push undo', () => {
    const s = dispatch(initialState, { type: 'CLEAR_ALL_STYLES' });
    expect(s.undoStack).toHaveLength(0);
  });
});

// ---- Cleanup ----
describe('Cleanup', () => {
  it('CLEANUP_ORPHANED removes by linkedSelector', () => {
    const ann = makeAnnotation({ linkedSelector: 'div.gone' });
    const kept = makeAnnotation({ linkedSelector: 'div.still-here' });
    const base: AnnotationState = { ...initialState, annotations: [ann, kept] };
    const s = dispatch(base, {
      type: 'CLEANUP_ORPHANED',
      payload: { linkedSelectors: ['div.gone'], styleSelectors: [] },
    });
    expect(s.annotations).toHaveLength(1);
    expect(s.annotations[0]!.id).toBe(kept.id);
  });

  it('CLEANUP_ORPHANED removes group mates of orphaned annotations', () => {
    const a1 = makeAnnotation({ linkedSelector: 'div.gone', groupId: 'g1' });
    const a2 = makeAnnotation({ groupId: 'g1' }); // no linkedSelector but same group
    const base: AnnotationState = { ...initialState, annotations: [a1, a2] };
    const s = dispatch(base, {
      type: 'CLEANUP_ORPHANED',
      payload: { linkedSelectors: ['div.gone'], styleSelectors: [] },
    });
    expect(s.annotations).toHaveLength(0);
  });

  it('CLEANUP_ORPHANED removes style modifications', () => {
    const elem: ElementInfo = { selector: 'div.card', tagName: 'div' };
    const base: AnnotationState = {
      ...initialState,
      styleModifications: [{ selector: 'div.card', element: elem, changes: [{ property: 'color', original: 'red', modified: 'blue' }] }],
    };
    const s = dispatch(base, {
      type: 'CLEANUP_ORPHANED',
      payload: { linkedSelectors: [], styleSelectors: ['div.card'] },
    });
    expect(s.styleModifications).toHaveLength(0);
  });

  it('CLEANUP_ORPHANED returns same state when nothing to clean', () => {
    const ann = makeAnnotation({ linkedSelector: 'div.ok' });
    const base: AnnotationState = { ...initialState, annotations: [ann] };
    const s = dispatch(base, {
      type: 'CLEANUP_ORPHANED',
      payload: { linkedSelectors: ['div.nope'], styleSelectors: [] },
    });
    expect(s).toBe(base);
  });

  it('CLEAR resets state', () => {
    const ann = makeAnnotation();
    const base: AnnotationState = {
      ...initialState,
      annotations: [ann],
      undoStack: [{ annotations: [], styleModifications: [] }],
      selectedAnnotationIds: [ann.id],
    };
    const s = dispatch(base, { type: 'CLEAR' });
    expect(s.annotations).toEqual([]);
    expect(s.undoStack).toEqual([]);
    expect(s.redoStack).toEqual([]);
    expect(s.selectedAnnotationIds).toEqual([]);
  });
});

// ---- Migration ----
describe('PASTE_ANNOTATIONS migration', () => {
  it('migrates legacy captured boolean to status', () => {
    const legacyAnn = makeAnnotation({ captured: true }) as Annotation;
    // Remove status to simulate legacy data
    delete (legacyAnn as Partial<Annotation>).status;
    const s = dispatch(initialState, {
      type: 'PASTE_ANNOTATIONS',
      payload: { annotations: [legacyAnn] },
    });
    expect(s.annotations[0]!.status).toBe('in_flight');
  });

  it('preserves existing status over captured', () => {
    const ann = makeAnnotation({ status: 'resolved', captured: true });
    const s = dispatch(initialState, {
      type: 'PASTE_ANNOTATIONS',
      payload: { annotations: [ann] },
    });
    expect(s.annotations[0]!.status).toBe('resolved');
  });

  it('defaults to pending when no captured and no status', () => {
    const ann = makeAnnotation() as Annotation;
    delete (ann as Partial<Annotation>).status;
    const s = dispatch(initialState, {
      type: 'PASTE_ANNOTATIONS',
      payload: { annotations: [ann] },
    });
    expect(s.annotations[0]!.status).toBe('pending');
  });
});
