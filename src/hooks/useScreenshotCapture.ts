import { useCallback } from 'react';

import { captureScreenshot, copyToClipboard, downloadBlob } from '../utils/screenshot';

export function useScreenshotCapture(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const capture = useCallback(async (): Promise<Blob[] | null> => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const target = document.body;
    return captureScreenshot(target, canvas);
  }, [canvasRef]);

  const captureAndCopy = useCallback(async (): Promise<boolean> => {
    const blobs = await capture();
    if (!blobs || blobs.length === 0) return false;
    return copyToClipboard(blobs);
  }, [capture]);

  const captureAndDownload = useCallback(
    async (filename?: string): Promise<void> => {
      const blobs = await capture();
      if (!blobs || blobs.length === 0) return;

      // Download first blob (or could stitch them)
      const name = filename || `annotation-${Date.now()}.png`;
      downloadBlob(blobs[0]!, name);
    },
    [capture]
  );

  return {
    capture,
    captureAndCopy,
    captureAndDownload,
  };
}
