import type { CSSProperties } from 'react';

export type ToolbarSnapPosition =
  | 'bottom-right'
  | 'bottom-center'
  | 'bottom-left'
  | 'top-right'
  | 'top-center'
  | 'top-left';

export const EDGE_PAD = 16;
export const TOOLBAR_HEIGHT = 54; // 48 content + 6 border

const STORAGE_KEY = 'popmelt-toolbar-snap-position';

export function isToolbarOnTop(pos: ToolbarSnapPosition): boolean {
  return pos.startsWith('top-');
}

export function isToolbarOnRight(pos: ToolbarSnapPosition): boolean {
  return pos.endsWith('-right');
}

export function isToolbarCentered(pos: ToolbarSnapPosition): boolean {
  return pos.endsWith('-center');
}

export function loadSnapPosition(): ToolbarSnapPosition {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && isValidPosition(v)) return v as ToolbarSnapPosition;
  } catch {}
  return 'bottom-right';
}

export function saveSnapPosition(pos: ToolbarSnapPosition): void {
  try { localStorage.setItem(STORAGE_KEY, pos); } catch {}
}

function isValidPosition(v: string): boolean {
  return ['bottom-right', 'bottom-center', 'bottom-left', 'top-right', 'top-center', 'top-left'].includes(v);
}

/** Returns position-only styles (position, top/left/right). No transitions — caller owns that. */
export function getToolbarStyle(pos: ToolbarSnapPosition, vw: number, vh: number): CSSProperties {
  const top = isToolbarOnTop(pos) ? EDGE_PAD : vh - EDGE_PAD - TOOLBAR_HEIGHT;
  if (isToolbarCentered(pos)) {
    return { position: 'fixed', top, left: vw / 2, transform: 'translateX(-50%)' };
  }
  if (isToolbarOnRight(pos)) {
    return { position: 'fixed', top, right: EDGE_PAD, left: 'auto' };
  }
  return { position: 'fixed', top, left: EDGE_PAD, right: 'auto' };
}

/** Guidance panel: above toolbar when bottom, below toolbar when top. Same horizontal edge. */
export function getGuidanceStyle(pos: ToolbarSnapPosition, vw: number, vh: number): CSSProperties {
  const onTop = isToolbarOnTop(pos);
  const vertical = onTop
    ? { top: EDGE_PAD + TOOLBAR_HEIGHT + 12 }
    : { bottom: EDGE_PAD + TOOLBAR_HEIGHT + 12 };

  let horizontal: CSSProperties;
  if (isToolbarCentered(pos)) {
    horizontal = { left: vw / 2, transform: 'translateX(-50%)' };
  } else if (isToolbarOnRight(pos)) {
    horizontal = { right: EDGE_PAD };
  } else {
    horizontal = { left: EDGE_PAD };
  }

  return { position: 'fixed', ...vertical, ...horizontal };
}

/** Badge stack: grows away from toolbar. */
export function getStackStyle(pos: ToolbarSnapPosition, _vw: number, vh: number): CSSProperties & { flexDirection: 'column' | 'column-reverse' } {
  const onTop = isToolbarOnTop(pos);
  const vertical = onTop
    ? { top: EDGE_PAD + TOOLBAR_HEIGHT + 8 }
    : { bottom: EDGE_PAD + TOOLBAR_HEIGHT + 8 };

  let horizontal: CSSProperties;
  let alignItems: string;
  if (isToolbarCentered(pos)) {
    horizontal = { left: '50%', transform: 'translateX(-50%)' };
    alignItems = 'center';
  } else if (isToolbarOnRight(pos)) {
    horizontal = { right: EDGE_PAD };
    alignItems = 'flex-end';
  } else {
    horizontal = { left: EDGE_PAD };
    alignItems = 'flex-start';
  }

  return {
    position: 'fixed',
    ...vertical,
    ...horizontal,
    zIndex: 9999,
    display: 'flex',
    flexDirection: onTop ? 'column' : 'column',
    alignItems: alignItems as CSSProperties['alignItems'],
  };
}

/** Library panel: avoids toolbar corner. */
export function getLibraryPanelStyle(pos: ToolbarSnapPosition): CSSProperties {
  const onTop = isToolbarOnTop(pos);
  const onRight = isToolbarOnRight(pos) || isToolbarCentered(pos);

  const topPad = onTop && onRight ? EDGE_PAD + TOOLBAR_HEIGHT + 12 : EDGE_PAD;
  const bottomPad = !onTop && onRight ? EDGE_PAD + TOOLBAR_HEIGHT + 12 : EDGE_PAD;

  return {
    position: 'fixed',
    top: topPad,
    right: EDGE_PAD,
    bottom: bottomPad,
  };
}

/** Get the panel edge for the triangle prediction zone (replaces getPanelBottomEdge) */
export function getPanelEdge(pos: ToolbarSnapPosition, vw: number, vh: number): { left: number; right: number; y: number } {
  const panelWidth = 326; // 300 width + 24 padding + ~2 border
  const onTop = isToolbarOnTop(pos);

  let panelRight: number;
  let panelLeft: number;
  if (isToolbarOnRight(pos) || isToolbarCentered(pos)) {
    panelRight = vw - EDGE_PAD;
    panelLeft = panelRight - panelWidth;
  } else {
    panelLeft = EDGE_PAD;
    panelRight = panelLeft + panelWidth;
  }

  const panelY = onTop
    ? EDGE_PAD + TOOLBAR_HEIGHT + 12
    : vh - EDGE_PAD - TOOLBAR_HEIGHT - 12;

  return { left: panelLeft, right: panelRight, y: panelY };
}

/** All 6 snap positions in grid order (top row L→R, bottom row L→R) */
export const SNAP_POSITIONS: ToolbarSnapPosition[] = [
  'top-left', 'top-center', 'top-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];
