import type { CanvasAction, CanvasState, PlacedComponent, ViewportState } from './types';

const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
const STORAGE_KEY = 'popmelt-canvas';
export const GRID_SIZE = 24;

function snap(v: number): number {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

export const initialCanvasState: CanvasState = {
  viewport: { offsetX: 0, offsetY: 0, scale: 1 },
  components: [],
  selectedId: null,
  highlightedName: null,
  dragState: null,
};

type PersistedState = {
  components: PlacedComponent[];
  viewport: ViewportState;
};

export function loadPersistedState(): Partial<CanvasState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data: PersistedState = JSON.parse(raw);
    return { components: data.components ?? [], viewport: data.viewport ?? initialCanvasState.viewport };
  } catch {
    return {};
  }
}

export function saveCanvasState(state: CanvasState) {
  try {
    const data: PersistedState = { components: state.components, viewport: state.viewport };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* quota exceeded — ignore */ }
}

export function canvasReducer(state: CanvasState, action: CanvasAction): CanvasState {
  switch (action.type) {
    case 'PLACE_COMPONENT': {
      const c = action.component;
      const snapped = { ...c, x: snap(c.x), y: snap(c.y), width: snap(c.width), height: snap(c.height) };
      return { ...state, components: [...state.components, snapped], selectedId: snapped.id };
    }

    case 'REMOVE_COMPONENT':
      return {
        ...state,
        components: state.components.filter(c => c.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      };

    case 'MOVE_COMPONENT':
      return {
        ...state,
        components: state.components.map(c =>
          c.id === action.id ? { ...c, x: snap(action.x), y: snap(action.y) } : c,
        ),
      };

    case 'RESIZE_COMPONENT':
      return {
        ...state,
        components: state.components.map(c =>
          c.id === action.id
            ? { ...c, width: Math.max(MIN_WIDTH, action.width), height: Math.max(MIN_HEIGHT, action.height) }
            : c,
        ),
      };

    case 'SELECT':
      return { ...state, selectedId: action.id };

    case 'SET_VIEWPORT':
      return { ...state, viewport: action.viewport };

    case 'PAN':
      return {
        ...state,
        viewport: {
          ...state.viewport,
          offsetX: state.viewport.offsetX + action.deltaX,
          offsetY: state.viewport.offsetY + action.deltaY,
        },
      };

    case 'START_DRAG':
      return { ...state, dragState: action.dragState };

    case 'END_DRAG':
      return { ...state, dragState: null };

    case 'HIGHLIGHT':
      return { ...state, highlightedName: action.name };

    default:
      return state;
  }
}

export function screenToCanvas(screenX: number, screenY: number, viewport: ViewportState) {
  return {
    x: (screenX - viewport.offsetX) / viewport.scale,
    y: (screenY - viewport.offsetY) / viewport.scale,
  };
}

export function canvasToScreen(canvasX: number, canvasY: number, viewport: ViewportState) {
  return {
    x: canvasX * viewport.scale + viewport.offsetX,
    y: canvasY * viewport.scale + viewport.offsetY,
  };
}
