import { useCallback, useRef } from 'react';

import { drawCircle } from '../tools/circle';
import { drawFreehand } from '../tools/freehand';
import { drawLine } from '../tools/line';
import { drawRectangle } from '../tools/rectangle';
import { drawText } from '../tools/text';
import type { Annotation, Point, ToolType } from '../tools/types';

// Badge styling constants
const BADGE_FONT_SIZE = 11;
const BADGE_PADDING = 4;
const BADGE_FONT = `600 ${BADGE_FONT_SIZE}px system-ui, -apple-system, sans-serif`;

// Helper to offset points by scroll position
function offsetPoints(points: Point[], scrollX: number, scrollY: number): Point[] {
  return points.map(p => ({ x: p.x - scrollX, y: p.y - scrollY }));
}

function offsetPoint(point: Point, scrollX: number, scrollY: number): Point {
  return { x: point.x - scrollX, y: point.y - scrollY };
}

// Draw a number badge centered horizontally on a point, below it
function drawNumberBadge(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  topY: number,
  number: number,
  color: string,
  handleSize: number
): void {
  const text = String(number);
  ctx.font = BADGE_FONT;
  const textWidth = ctx.measureText(text).width;
  const badgeWidth = textWidth + BADGE_PADDING * 2;
  const badgeHeight = BADGE_FONT_SIZE + BADGE_PADDING * 2;

  // Position badge centered on handle, just below it
  const x = centerX - badgeWidth / 2;
  const y = topY + handleSize / 2 + 2; // 2px gap below handle

  // Draw background
  ctx.fillStyle = color;
  ctx.fillRect(x, y, badgeWidth, badgeHeight);

  // Draw number (white, centered)
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + BADGE_PADDING, y + badgeHeight / 2);
}

// Get bottom-left handle position for badge alignment
// Returns the center point of where the bottom-left handle would be
function getBottomLeftHandleCenter(annotation: Annotation, handleSize: number): Point | null {
  if (annotation.points.length < 2 && annotation.type !== 'text') return null;

  switch (annotation.type) {
    case 'rectangle':
    case 'freehand': {
      let left: number, bottom: number;
      if (annotation.type === 'freehand') {
        left = Math.min(...annotation.points.map(p => p.x));
        bottom = Math.max(...annotation.points.map(p => p.y));
      } else {
        const start = annotation.points[0]!;
        const end = annotation.points[annotation.points.length - 1]!;
        left = Math.min(start.x, end.x);
        bottom = Math.max(start.y, end.y);
      }
      return { x: left, y: bottom };
    }
    case 'circle': {
      // Circle has cardinal handles - use left handle position
      const start = annotation.points[0]!;
      const end = annotation.points[annotation.points.length - 1]!;
      const left = Math.min(start.x, end.x);
      const centerY = (Math.min(start.y, end.y) + Math.max(start.y, end.y)) / 2;
      return { x: left, y: centerY };
    }
    case 'line': {
      // Use the lower endpoint
      const start = annotation.points[0]!;
      const end = annotation.points[annotation.points.length - 1]!;
      const lowerPoint = start.y > end.y ? start : end;
      return { x: lowerPoint.x, y: lowerPoint.y };
    }
    default:
      return null;
  }
}

export function useCanvasDrawing() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const drawAnnotation = useCallback((annotation: Annotation, groupNumber?: number, highlighted?: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Status-aware color: only pending shows own color; everything sent stays gray.
    // Highlighted annotations (hovered badge) restore their original color.
    const status = annotation.status ?? (annotation.captured ? 'in_flight' : 'pending');
    const color = (status === 'pending' || highlighted) ? annotation.color : '#999999';

    switch (annotation.type) {
      case 'freehand':
        drawFreehand(ctx, annotation.points, color, annotation.strokeWidth);
        break;
      case 'line':
        drawLine(ctx, annotation.points, color, annotation.strokeWidth);
        break;
      case 'rectangle':
        drawRectangle(ctx, annotation.points, color, annotation.strokeWidth);
        break;
      case 'circle':
        drawCircle(ctx, annotation.points, color, annotation.strokeWidth);
        break;
      case 'text':
        if (annotation.text && annotation.points[0]) {
          // Pass viewport-relative X so drawText can wrap near the right edge
          drawText(ctx, annotation.points[0], annotation.text, color, annotation.fontSize, groupNumber, annotation.points[0].x);
        }
        break;
    }
  }, []);

  const drawCurrentPath = useCallback(
    (points: Point[], tool: ToolType, color: string, strokeWidth: number) => {
      const canvas = canvasRef.current;
      if (!canvas || points.length < 2) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      switch (tool) {
        case 'freehand':
          drawFreehand(ctx, points, color, strokeWidth);
          break;
        case 'line':
          drawLine(ctx, points, color, strokeWidth);
          break;
        case 'rectangle':
          drawRectangle(ctx, points, color, strokeWidth);
          break;
        case 'circle':
          drawCircle(ctx, points, color, strokeWidth);
          break;
      }
    },
    []
  );

  const drawSelectionHandles = useCallback((annotation: Annotation, handleSize: number) => {
    const canvas = canvasRef.current;
    if (!canvas || annotation.points.length < 2) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = annotation.color;
    ctx.lineWidth = 1.5;

    // Lines have endpoint handles
    if (annotation.type === 'line') {
      const start = annotation.points[0]!;
      const end = annotation.points[annotation.points.length - 1]!;

      [start, end].forEach((point) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, handleSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
      return;
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

      const cardinals = [
        { x: centerX, y: top },
        { x: centerX, y: bottom },
        { x: left, y: centerY },
        { x: right, y: centerY },
      ];

      cardinals.forEach((point) => {
        ctx.beginPath();
        ctx.rect(
          point.x - handleSize / 2,
          point.y - handleSize / 2,
          handleSize,
          handleSize
        );
        ctx.fill();
        ctx.stroke();
      });
      return;
    }

    // Rectangle and freehand have corner handles
    if (annotation.type === 'rectangle' || annotation.type === 'freehand') {
      let left: number, right: number, top: number, bottom: number;

      if (annotation.type === 'freehand') {
        // Calculate bounding box from all points
        left = Math.min(...annotation.points.map(p => p.x));
        right = Math.max(...annotation.points.map(p => p.x));
        top = Math.min(...annotation.points.map(p => p.y));
        bottom = Math.max(...annotation.points.map(p => p.y));
      } else {
        const start = annotation.points[0]!;
        const end = annotation.points[annotation.points.length - 1]!;
        left = Math.min(start.x, end.x);
        right = Math.max(start.x, end.x);
        top = Math.min(start.y, end.y);
        bottom = Math.max(start.y, end.y);
      }

      const corners = [
        { x: left, y: top },
        { x: right, y: top },
        { x: left, y: bottom },
        { x: right, y: bottom },
      ];

      corners.forEach((corner) => {
        ctx.beginPath();
        ctx.rect(
          corner.x - handleSize / 2,
          corner.y - handleSize / 2,
          handleSize,
          handleSize
        );
        ctx.fill();
        ctx.stroke();
      });
    }
  }, []);

  const redrawAll = useCallback(
    (
      annotations: Annotation[],
      currentPath: Point[],
      activeTool: ToolType,
      activeColor: string,
      strokeWidth: number,
      selectedAnnotationIds?: string[],
      handleSize?: number,
      scrollX: number = 0,
      scrollY: number = 0,
      annotationGroupMap?: Map<string, number>,
      highlightedAnnotationIds?: Set<string> | null
    ) => {
      clearCanvas();

      // Draw annotations offset by scroll position
      annotations.forEach(annotation => {
        const offsetAnnotation: Annotation = {
          ...annotation,
          points: offsetPoints(annotation.points, scrollX, scrollY),
        };
        const groupNumber = annotationGroupMap?.get(annotation.id);
        const highlighted = highlightedAnnotationIds?.has(annotation.id) ?? false;
        drawAnnotation(offsetAnnotation, groupNumber, highlighted);
      });

      // Draw current path offset by scroll position
      if (currentPath.length > 0) {
        const offsetPath = offsetPoints(currentPath, scrollX, scrollY);
        drawCurrentPath(offsetPath, activeTool, activeColor, strokeWidth);
      }

      // Draw selection handles and number badges on all selected annotations
      if (selectedAnnotationIds && selectedAnnotationIds.length > 0 && handleSize) {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');

        for (const selectedId of selectedAnnotationIds) {
          const selected = annotations.find((a) => a.id === selectedId);
          if (selected) {
            const offsetSelected: Annotation = {
              ...selected,
              points: offsetPoints(selected.points, scrollX, scrollY),
            };
            drawSelectionHandles(offsetSelected, handleSize);

            // Draw number badge for non-text annotations (skip if linked to a text annotation)
            if (ctx && selected.type !== 'text' && annotationGroupMap) {
              // Check if this annotation has a linked text annotation in its group
              const hasLinkedText = selected.groupId && annotations.some(
                a => a.groupId === selected.groupId && a.type === 'text'
              );

              if (!hasLinkedText) {
                const groupNumber = annotationGroupMap.get(selected.id);
                if (groupNumber !== undefined) {
                  const handleCenter = getBottomLeftHandleCenter(offsetSelected, handleSize);
                  if (handleCenter) {
                    const badgeStatus = selected.status ?? (selected.captured ? 'in_flight' : 'pending');
                    const color = badgeStatus === 'pending' ? selected.color : '#999999';
                    drawNumberBadge(ctx, handleCenter.x, handleCenter.y, groupNumber, color, handleSize);
                  }
                }
              }
            }
          }
        }
      }
    },
    [clearCanvas, drawAnnotation, drawCurrentPath, drawSelectionHandles]
  );

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
    }
  }, []);

  return {
    canvasRef,
    clearCanvas,
    drawAnnotation,
    drawCurrentPath,
    redrawAll,
    resizeCanvas,
  };
}
