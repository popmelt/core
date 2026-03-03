import type { ComponentEntry } from '../scanner/types';

export type PlacedComponent = {
  id: string;
  entry: ComponentEntry;
  x: number;
  y: number;
  width: number;
  height: number;
  iframeUrl: string;
};

export type ViewportState = {
  offsetX: number;
  offsetY: number;
  scale: number;
};

export type DragState =
  | { type: 'move'; componentId: string; startX: number; startY: number; originX: number; originY: number }
  | { type: 'resize'; componentId: string; startX: number; startY: number; originW: number; originH: number }
  | { type: 'pan'; startX: number; startY: number; originOffsetX: number; originOffsetY: number };

export type CanvasState = {
  viewport: ViewportState;
  components: PlacedComponent[];
  selectedId: string | null;
  highlightedName: string | null;
  dragState: DragState | null;
};

export type CanvasAction =
  | { type: 'PLACE_COMPONENT'; component: PlacedComponent }
  | { type: 'REMOVE_COMPONENT'; id: string }
  | { type: 'MOVE_COMPONENT'; id: string; x: number; y: number }
  | { type: 'RESIZE_COMPONENT'; id: string; width: number; height: number }
  | { type: 'SELECT'; id: string | null }
  | { type: 'SET_VIEWPORT'; viewport: ViewportState }
  | { type: 'PAN'; deltaX: number; deltaY: number }
  | { type: 'START_DRAG'; dragState: DragState }
  | { type: 'END_DRAG' }
  | { type: 'HIGHLIGHT'; name: string | null };
