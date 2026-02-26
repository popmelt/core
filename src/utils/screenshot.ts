import { domToCanvas } from 'modern-screenshot';

import type { Annotation, ElementInfo, SpacingTokenChange, StyleModification } from '../tools/types';

/** Convert any CSS color (including OKLCH) to a #rrggbb hex string via canvas. */
export function cssColorToHex(color: string): string {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return '#888888';
  ctx.fillStyle = color;
  return ctx.fillStyle;
}

type Region = {
  top: number;
  bottom: number;
  annotations: Annotation[];
};

// Structured data types for AI consumption
type AnnotationData = {
  id: string;
  type: string;
  instruction?: string;
  linkedSelector?: string;
  elements: ElementInfo[];
  imageCount?: number;
};

export type FeedbackData = {
  timestamp: string;
  url: string;
  viewport: { width: number; height: number };
  scrollPosition: { x: number; y: number };
  annotations: AnnotationData[];
  styleModifications: StyleModification[];
  inspectedElement?: ElementInfo;
  spacingTokenChanges?: SpacingTokenChange[];
};

// Build structured feedback data from annotations
export function buildFeedbackData(
  annotations: Annotation[],
  styleModifications: StyleModification[] = [],
  inspectedElement?: ElementInfo,
  spacingTokenChanges?: SpacingTokenChange[],
): FeedbackData {
  // Group annotations by groupId to find linked text instructions
  const groupedAnnotations = new Map<string, Annotation[]>();
  const standaloneAnnotations: Annotation[] = [];

  for (const annotation of annotations) {
    if (annotation.groupId) {
      const group = groupedAnnotations.get(annotation.groupId) || [];
      group.push(annotation);
      groupedAnnotations.set(annotation.groupId, group);
    } else {
      standaloneAnnotations.push(annotation);
    }
  }

  const annotationDataList: AnnotationData[] = [];

  // Process grouped annotations (shape + text pairs)
  for (const [_groupId, group] of groupedAnnotations) {
    const shape = group.find(a => a.type !== 'text');
    const text = group.find(a => a.type === 'text');

    if (shape) {
      const linkedSelector = shape.linkedSelector || text?.linkedSelector;
      const imageCount = text?.imageCount || shape.imageCount;
      annotationDataList.push({
        id: shape.id,
        type: shape.type,
        instruction: text?.text,
        ...(linkedSelector ? { linkedSelector } : {}),
        // Use stored elements (captured at creation time) or empty array
        elements: shape.elements || [],
        ...(imageCount ? { imageCount } : {}),
      });
    }
  }

  // Process standalone annotations
  for (const annotation of standaloneAnnotations) {
    annotationDataList.push({
      id: annotation.id,
      type: annotation.type,
      instruction: annotation.type === 'text' ? annotation.text : undefined,
      ...(annotation.linkedSelector ? { linkedSelector: annotation.linkedSelector } : {}),
      // Use stored elements (captured at creation time) or empty array
      elements: annotation.elements || [],
      ...(annotation.imageCount ? { imageCount: annotation.imageCount } : {}),
    });
  }

  return {
    timestamp: new Date().toISOString(),
    url: window.location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollPosition: { x: window.scrollX, y: window.scrollY },
    annotations: annotationDataList,
    styleModifications,
    ...(inspectedElement ? { inspectedElement } : {}),
    ...(spacingTokenChanges && spacingTokenChanges.length > 0 ? { spacingTokenChanges } : {}),
  };
}

// Get bounding box for an annotation (in document coordinates)
function getAnnotationBounds(annotation: Annotation): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!annotation.points || annotation.points.length === 0) {
    return null;
  }
  const xs = annotation.points.map(p => p.x);
  const ys = annotation.points.map(p => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

// Group annotations into viewport-height regions
function groupAnnotationsIntoRegions(annotations: Annotation[], viewportHeight: number): Region[] {
  if (annotations.length === 0) return [];

  // Get all annotation bounds, filtering out any without valid bounds
  const annotationsWithBounds = annotations
    .map(a => ({
      annotation: a,
      bounds: getAnnotationBounds(a),
    }))
    .filter((a): a is { annotation: Annotation; bounds: NonNullable<ReturnType<typeof getAnnotationBounds>> } =>
      a.bounds !== null
    );

  if (annotationsWithBounds.length === 0) return [];

  // Sort by vertical position
  annotationsWithBounds.sort((a, b) => a.bounds.minY - b.bounds.minY);

  // Find overall vertical extent
  const minY = Math.min(...annotationsWithBounds.map(a => a.bounds.minY));
  const maxY = Math.max(...annotationsWithBounds.map(a => a.bounds.maxY));

  // If all annotations fit in one viewport, return single region
  if (maxY - minY <= viewportHeight) {
    // Center the region on the annotations
    const centerY = (minY + maxY) / 2;
    const regionTop = Math.max(0, centerY - viewportHeight / 2);
    return [{
      top: regionTop,
      bottom: regionTop + viewportHeight,
      annotations,
    }];
  }

  // Otherwise, create multiple regions
  const regions: Region[] = [];
  const padding = 50; // Padding around annotation groups

  let currentRegionStart = Math.max(0, minY - padding);
  let currentRegionAnnotations: Annotation[] = [];
  let currentRegionMaxY = currentRegionStart;

  for (const { annotation, bounds } of annotationsWithBounds) {
    // Check if this annotation fits in current region
    const annotationBottom = bounds.maxY + padding;

    if (annotationBottom - currentRegionStart <= viewportHeight) {
      // Fits in current region
      currentRegionAnnotations.push(annotation);
      currentRegionMaxY = Math.max(currentRegionMaxY, annotationBottom);
    } else {
      // Need to start a new region
      if (currentRegionAnnotations.length > 0) {
        // Center the region on its annotations
        const regionCenter = (currentRegionStart + currentRegionMaxY) / 2;
        const regionTop = Math.max(0, regionCenter - viewportHeight / 2);
        regions.push({
          top: regionTop,
          bottom: regionTop + viewportHeight,
          annotations: currentRegionAnnotations,
        });
      }

      // Start new region with this annotation
      currentRegionStart = Math.max(0, bounds.minY - padding);
      currentRegionAnnotations = [annotation];
      currentRegionMaxY = bounds.maxY + padding;
    }
  }

  // Don't forget the last region
  if (currentRegionAnnotations.length > 0) {
    const regionCenter = (currentRegionStart + currentRegionMaxY) / 2;
    const regionTop = Math.max(0, regionCenter - viewportHeight / 2);
    regions.push({
      top: regionTop,
      bottom: regionTop + viewportHeight,
      annotations: currentRegionAnnotations,
    });
  }

  return regions;
}

// Draw annotations onto a canvas at a specific scroll offset
function drawAnnotationsToCanvas(
  ctx: CanvasRenderingContext2D,
  annotations: Annotation[],
  scrollY: number,
  dpr: number
): void {
  ctx.save();
  ctx.scale(dpr, dpr);

  for (const annotation of annotations) {
    // Offset points by scroll position
    const offsetPoints = annotation.points.map(p => ({
      x: p.x,
      y: p.y - scrollY,
    }));

    ctx.strokeStyle = annotation.color;
    ctx.fillStyle = annotation.color;
    ctx.lineWidth = annotation.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (annotation.type) {
      case 'freehand':
        if (offsetPoints.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(offsetPoints[0]!.x, offsetPoints[0]!.y);
        for (let i = 1; i < offsetPoints.length; i++) {
          ctx.lineTo(offsetPoints[i]!.x, offsetPoints[i]!.y);
        }
        ctx.stroke();
        break;

      case 'line':
        if (offsetPoints.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(offsetPoints[0]!.x, offsetPoints[0]!.y);
        ctx.lineTo(offsetPoints[offsetPoints.length - 1]!.x, offsetPoints[offsetPoints.length - 1]!.y);
        ctx.stroke();
        break;

      case 'rectangle': {
        if (offsetPoints.length < 2) break;
        const start = offsetPoints[0]!;
        const end = offsetPoints[offsetPoints.length - 1]!;
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const width = Math.abs(end.x - start.x);
        const height = Math.abs(end.y - start.y);
        ctx.strokeRect(x, y, width, height);
        break;
      }

      case 'circle': {
        if (offsetPoints.length < 2) break;
        const start = offsetPoints[0]!;
        const end = offsetPoints[offsetPoints.length - 1]!;
        const centerX = (start.x + end.x) / 2;
        const centerY = (start.y + end.y) / 2;
        const radiusX = Math.abs(end.x - start.x) / 2;
        const radiusY = Math.abs(end.y - start.y) / 2;
        ctx.beginPath();
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }

      case 'text': {
        if (!annotation.text || offsetPoints.length < 1) break;
        const pos = offsetPoints[0]!;
        const fontSize = annotation.fontSize || 16;
        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.fillStyle = annotation.color;

        // Prepend image count indicator if images are attached
        const displayText = annotation.imageCount && annotation.imageCount > 0
          ? `[${annotation.imageCount} image${annotation.imageCount > 1 ? 's' : ''}] ${annotation.text}`
          : annotation.text;

        // Draw background
        const lines = displayText.split('\n');
        const lineHeight = fontSize * 1.2;
        const padding = 4;
        let maxWidth = 0;
        for (const line of lines) {
          maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
        }

        ctx.fillRect(
          pos.x - padding,
          pos.y - padding,
          maxWidth + padding * 2,
          lines.length * lineHeight + padding * 2
        );

        // Draw text
        ctx.fillStyle = '#ffffff';
        lines.forEach((line, i) => {
          ctx.fillText(line, pos.x, pos.y + fontSize + i * lineHeight);
        });
        break;
      }
    }
  }

  ctx.restore();
}

export async function captureScreenshot(
  targetElement: HTMLElement,
  annotationCanvas: HTMLCanvasElement,
  annotations: Annotation[] = [],
): Promise<Blob[]> {
  try {
    const dpr = window.devicePixelRatio || 1;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Filter out non-pending annotations - they shouldn't appear in new screenshots
    const activeAnnotations = annotations.filter(a => (a.status ?? 'pending') === 'pending');

    console.log('[Screenshot] Starting capture with', activeAnnotations.length, 'active annotations (filtered', annotations.length - activeAnnotations.length, 'captured)');

    // Group annotations into viewport-height regions
    const regions = groupAnnotationsIntoRegions(activeAnnotations, viewportHeight);

    // If no regions (no annotations), capture current viewport
    if (regions.length === 0) {
      const blob = await captureSingleRegion(
        targetElement,
        [],
        window.scrollY,
        viewportWidth,
        viewportHeight,
        dpr
      );
      return blob ? [blob] : [];
    }

    // Capture each region
    const blobs: Blob[] = [];
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i]!;
      const blob = await captureSingleRegion(
        targetElement,
        region.annotations,
        region.top,
        viewportWidth,
        viewportHeight,
        dpr
      );
      if (blob) {
        blobs.push(blob);
      } else {
        console.warn(`[Screenshot] Region ${i + 1} failed to capture`);
      }
    }

    console.log('[Screenshot] Capture complete');
    return blobs;
  } catch (error) {
    console.error('[Screenshot] Capture failed:', error);
    return [];
  }
}

async function captureSingleRegion(
  targetElement: HTMLElement,
  annotations: Annotation[],
  scrollY: number,
  viewportWidth: number,
  viewportHeight: number,
  dpr: number
): Promise<Blob | null> {
  try {
    // Capture DOM at this scroll position
    const domCanvas = await domToCanvas(targetElement, {
      filter: (el) => {
        if (el instanceof HTMLElement) {
          // Hide devtools elements (canvas, toolbar, scrim, panels, badges, highlights)
          if (el.id === 'devtools-canvas' || el.id === 'devtools-toolbar' || el.id === 'devtools-scrim') {
            return false;
          }
          // Hide any element with data-devtools attribute (library skips children of filtered nodes)
          if (el.dataset.devtools !== undefined) {
            return false;
          }
        }
        return true;
      },
      scale: dpr,
      backgroundColor: '#ffffff',
      width: viewportWidth,
      height: viewportHeight,
      style: {
        transform: `translate(${-window.scrollX}px, ${-scrollY}px)`,
      },
    });
    // Create composite canvas
    const composite = document.createElement('canvas');
    composite.width = viewportWidth * dpr;
    composite.height = viewportHeight * dpr;
    const ctx = composite.getContext('2d');

    if (!ctx) return null;

    // Draw DOM
    ctx.drawImage(
      domCanvas,
      0,
      0,
      viewportWidth * dpr,
      viewportHeight * dpr,
      0,
      0,
      viewportWidth * dpr,
      viewportHeight * dpr
    );

    // Draw annotations for this region
    drawAnnotationsToCanvas(ctx, annotations, scrollY, dpr);

    // Export as blob
    return new Promise((resolve) => {
      composite.toBlob((blob) => resolve(blob), 'image/png');
    });
  } catch (error) {
    console.error('Region capture failed:', error);
    return null;
  }
}

// Stitch multiple blobs into a single tall image
export async function stitchBlobs(blobs: Blob[]): Promise<Blob | null> {
  if (blobs.length === 0) return null;
  if (blobs.length === 1) return blobs[0]!;

  // Load all blobs as images
  const images = await Promise.all(
    blobs.map(blob => {
      return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
      });
    })
  );

  // Calculate total dimensions (same width, stacked height)
  const width = images[0]!.width;
  const totalHeight = images.reduce((sum, img) => sum + img.height, 0);

  // Create composite canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = totalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Draw each image stacked vertically
  let y = 0;
  for (const img of images) {
    ctx.drawImage(img, 0, y);
    y += img.height;
    // Clean up object URL
    URL.revokeObjectURL(img.src);
  }

  // Export as blob
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

/** Capture the full page (top to bottom) as a single stitched image.
 *  Optionally overlays annotations (e.g., the triggering annotation for a plan). */
export async function captureFullPage(targetElement: HTMLElement, annotations: Annotation[] = []): Promise<Blob | null> {
  // Capture at 1x so image pixel coordinates = CSS pixel coordinates.
  // The planner outputs region bounding boxes based on what it sees in the image,
  // and we use those coordinates directly for elementFromPoint in CSS pixel space.
  const dpr = 1;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const pageHeight = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight,
  );

  // Save current scroll position
  const savedScrollX = window.scrollX;
  const savedScrollY = window.scrollY;

  const blobs: Blob[] = [];

  try {
    const steps = Math.ceil(pageHeight / viewportHeight);

    for (let i = 0; i < steps; i++) {
      const scrollY = i * viewportHeight;

      // Scroll to position
      window.scrollTo(savedScrollX, scrollY);

      // Double rAF for paint settle
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

      // Filter annotations that overlap this viewport region
      const regionTop = scrollY;
      const regionBottom = scrollY + viewportHeight;
      const regionAnnotations = annotations.filter(a => {
        const bounds = getAnnotationBounds(a);
        if (!bounds) return false;
        return bounds.maxY >= regionTop && bounds.minY <= regionBottom;
      });

      const blob = await captureSingleRegion(
        targetElement,
        regionAnnotations,
        scrollY,
        viewportWidth,
        Math.min(viewportHeight, pageHeight - scrollY),
        dpr,
      );
      if (blob) blobs.push(blob);
    }
  } finally {
    // Restore scroll position
    window.scrollTo(savedScrollX, savedScrollY);
  }

  return stitchBlobs(blobs);
}

export async function copyToClipboard(
  blobs: Blob | Blob[],
  annotations?: Annotation[],
  styleModifications?: StyleModification[]
): Promise<boolean> {
  try {
    const blobArray = Array.isArray(blobs) ? blobs : [blobs];

    if (blobArray.length === 0) return false;

    // Stitch multiple blobs into one tall image
    const stitchedBlob = await stitchBlobs(blobArray);
    if (!stitchedBlob) return false;

    // Build structured feedback data if annotations or style modifications provided
    const clipboardItems: Record<string, Blob> = {
      'image/png': stitchedBlob,
    };

    const hasAnnotations = annotations && annotations.length > 0;
    const hasStyleMods = styleModifications && styleModifications.length > 0;

    if (hasAnnotations || hasStyleMods) {
      // Filter out non-pending annotations
      const activeAnnotations = annotations ? annotations.filter(a => (a.status ?? 'pending') === 'pending') : [];
      if (activeAnnotations.length > 0 || hasStyleMods) {
        const feedbackData = buildFeedbackData(activeAnnotations, styleModifications || []);
        const jsonBlob = new Blob([JSON.stringify(feedbackData, null, 2)], { type: 'text/plain' });
        clipboardItems['text/plain'] = jsonBlob;
      }
    }

    await navigator.clipboard.write([
      new ClipboardItem(clipboardItems),
    ]);
    return true;
  } catch (error) {
    console.warn('Clipboard write failed:', error);
    return false;
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
